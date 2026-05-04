const { WSClient } = require('@wecom/aibot-node-sdk');

const DISCOVERY_LIMIT = 20;

function createDeferred() {
  let settled = false;
  let resolve;
  let reject;

  const promise = new Promise((nextResolve, nextReject) => {
    resolve = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      nextResolve(value);
    };

    reject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      nextReject(error);
    };
  });

  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}

function createSilentLogger() {
  return {
    debug() {},
    info() {},
    warn(message, ...args) {
      console.warn('[wecom-smartbot]', message, ...args);
    },
    error(message, ...args) {
      console.error('[wecom-smartbot]', message, ...args);
    },
  };
}

function normalizeTimestamp(value) {
  const numeric = Number(value || 0);
  if (!numeric) {
    return new Date().toISOString();
  }

  const milliseconds = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function clipPreview(value, maxLength = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }

  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function extractPreview(body) {
  if (body?.text?.content) {
    return clipPreview(body.text.content);
  }

  if (body?.mixed?.items?.length) {
    const firstText = body.mixed.items.find((item) => item?.msgtype === 'text');
    return clipPreview(firstText?.text?.content || '');
  }

  if (body?.event?.event_type) {
    return `事件: ${body.event.event_type}`;
  }

  if (body?.event?.type) {
    return `事件: ${body.event.type}`;
  }

  if (body?.msgtype) {
    return `消息类型: ${body.msgtype}`;
  }

  return '';
}

function normalizeDiscoveryEntry(frame) {
  const body = frame?.body || {};
  const fromUserId = String(body?.from?.userid || '').trim();
  const chatId = String(body?.chatid || '').trim();
  const chatType = String(body?.chattype || (chatId ? 'group' : fromUserId ? 'single' : ''))
    .trim()
    .toLowerCase();
  const targetType = chatType === 'group' && chatId ? 'group' : fromUserId ? 'single' : chatId ? 'group' : '';
  const targetId = targetType === 'group' ? chatId : fromUserId;

  if (!targetId) {
    return null;
  }

  return {
    targetId,
    targetType,
    userId: fromUserId,
    chatId,
    actorUserId: fromUserId,
    source: String(body?.msgtype || frame?.cmd || 'callback'),
    preview: extractPreview(body),
    lastSeenAt: normalizeTimestamp(body?.create_time),
  };
}

class WecomSmartBotClientPool {
  constructor() {
    this.clients = new Map();
    this.shutdownBound = false;
    this.bindShutdown();
  }

  bindShutdown() {
    if (this.shutdownBound) {
      return;
    }

    const cleanup = () => {
      this.closeAll();
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    this.shutdownBound = true;
  }

  getKey(botId, secret) {
    return `${botId}::${secret}`;
  }

  recordDiscovery(state, frame) {
    const entry = normalizeDiscoveryEntry(frame);
    if (!entry) {
      return;
    }

    const existingIndex = state.recentTargets.findIndex(
      (item) => item.targetId === entry.targetId && item.targetType === entry.targetType,
    );

    if (existingIndex >= 0) {
      state.recentTargets.splice(existingIndex, 1);
    }

    state.recentTargets.unshift(entry);
    state.recentTargets = state.recentTargets.slice(0, DISCOVERY_LIMIT);
  }

  ensureState(botId, secret) {
    const key = this.getKey(botId, secret);
    const existing = this.clients.get(key);
    if (existing) {
      return existing;
    }

    const client = new WSClient({
      botId,
      secret,
      maxReconnectAttempts: -1,
      logger: createSilentLogger(),
    });

    const state = {
      key,
      botId,
      secret,
      client,
      authenticated: false,
      connectStarted: false,
      ready: createDeferred(),
      lastError: null,
      recentTargets: [],
    };

    client.on('authenticated', () => {
      state.authenticated = true;
      state.lastError = null;
      state.ready.resolve(client);
    });

    client.on('disconnected', (reason) => {
      state.authenticated = false;
      if (reason) {
        state.lastError = new Error(String(reason));
      }
      if (state.ready.settled) {
        state.ready = createDeferred();
      }
    });

    client.on('error', (error) => {
      state.lastError = error;
      if (!state.authenticated) {
        console.error('[wecom-smartbot]', error.message || error);
      }
    });

    client.on('message', (frame) => {
      this.recordDiscovery(state, frame);
    });

    client.on('event.enter_chat', (frame) => {
      this.recordDiscovery(state, frame);
    });

    client.on('event', (frame) => {
      this.recordDiscovery(state, frame);
    });

    this.clients.set(key, state);
    return state;
  }

  start(state) {
    if (state.connectStarted) {
      return;
    }

    state.connectStarted = true;
    state.client.connect();
  }

  async waitForReady(state, timeoutMs = 20000) {
    if (state.authenticated && state.client.isConnected) {
      return state.client;
    }

    this.start(state);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('企业微信智能机器人连接超时，请检查 Bot ID、Secret 和网络状态。'));
      }, timeoutMs);

      state.ready.promise.then(
        (client) => {
          clearTimeout(timer);
          resolve(client);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async ensureListening({ botId, secret, timeoutMs = 12000 }) {
    const state = this.ensureState(botId, secret);
    await this.waitForReady(state, timeoutMs);
    return this.getStatus(botId, secret);
  }

  getStatus(botId, secret) {
    const key = this.getKey(botId, secret);
    const state = this.clients.get(key);
    if (!state) {
      return {
        connected: false,
        connectStarted: false,
        lastError: '',
        recentTargets: [],
      };
    }

    return {
      connected: Boolean(state.authenticated && state.client.isConnected),
      connectStarted: state.connectStarted,
      lastError: state.lastError ? String(state.lastError.message || state.lastError) : '',
      recentTargets: state.recentTargets.map((entry) => ({ ...entry })),
    };
  }

  reset(botId, secret) {
    const key = this.getKey(botId, secret);
    const state = this.clients.get(key);
    if (!state) {
      return;
    }

    try {
      state.client.disconnect();
    } catch (_) {
      // Ignore disconnect cleanup errors.
    }

    this.clients.delete(key);
  }

  async sendMarkdown({ botId, secret, targetId, markdown, timeoutMs = 20000 }) {
    const state = this.ensureState(botId, secret);

    try {
      const client = await this.waitForReady(state, timeoutMs);
      const result = await client.sendMessage(targetId, {
        msgtype: 'markdown',
        markdown: {
          content: markdown,
        },
      });

      if (result?.errcode && Number(result.errcode) !== 0) {
        throw new Error(result.errmsg || '企业微信智能机器人发送失败。');
      }

      return result;
    } catch (error) {
      if (String(error.message || error).includes('连接超时')) {
        throw error;
      }

      this.reset(botId, secret);
      const freshState = this.ensureState(botId, secret);
      const client = await this.waitForReady(freshState, timeoutMs);
      const result = await client.sendMessage(targetId, {
        msgtype: 'markdown',
        markdown: {
          content: markdown,
        },
      });

      if (result?.errcode && Number(result.errcode) !== 0) {
        throw new Error(result.errmsg || '企业微信智能机器人发送失败。');
      }

      return result;
    }
  }

  closeAll() {
    for (const [key, state] of this.clients.entries()) {
      try {
        state.client.disconnect();
      } catch (_) {
        // Ignore disconnect cleanup errors.
      }
      this.clients.delete(key);
    }
  }
}

module.exports = {
  WecomSmartBotClientPool,
};
