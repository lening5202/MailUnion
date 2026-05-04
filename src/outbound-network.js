const { execFileSync } = require('node:child_process');
const { Agent, ProxyAgent, fetch: undiciFetch } = require('undici');

const NETWORK_FAILURE_PATTERNS = [
  'fetch failed',
  'econnreset',
  'enotfound',
  'eai_again',
  'etimedout',
  'timeout',
  'socket hang up',
  'networkerror',
];

const NETWORK_FAILURE_CODES = [
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
];

const proxyAgentCache = new Map();
const directAgent = new Agent({
  connect: {
    autoSelectFamily: true,
    timeout: 30000,
  },
});

const ORIGINAL_PROXY_ENV = Object.freeze({
  HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || '',
  HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || '',
  ALL_PROXY: process.env.ALL_PROXY || process.env.all_proxy || '',
  NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || '',
});

let windowsProxyConfigCache = null;

function trimString(value) {
  return String(value || '').trim();
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => trimString(value)).filter(Boolean))];
}

function normalizeOutboundProxyMode(value, fallback = 'system') {
  const normalized = trimString(value || fallback || 'system').toLowerCase();
  return ['direct', 'system', 'custom'].includes(normalized) ? normalized : 'system';
}

function normalizeProxyUrl(value = '') {
  const trimmed = trimString(value);
  if (!trimmed) {
    return '';
  }

  if (/^[a-z]+:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

function normalizeOutboundProxyBypass(value = '') {
  return uniqueStrings(
    String(value || '')
      .split(/[\r\n,;]+/)
      .map((item) => item.replace(/\s+/g, ' ').trim().toLowerCase()),
  ).join('\n');
}

function normalizeOutboundProxySettings(input = {}, fallback = {}) {
  return {
    outboundProxyMode:
      input.outboundProxyMode !== undefined
        ? normalizeOutboundProxyMode(input.outboundProxyMode)
        : normalizeOutboundProxyMode(fallback.outboundProxyMode),
    outboundProxyUrl:
      input.outboundProxyUrl !== undefined
        ? normalizeProxyUrl(input.outboundProxyUrl)
        : normalizeProxyUrl(fallback.outboundProxyUrl),
    outboundProxyBypass:
      input.outboundProxyBypass !== undefined
        ? normalizeOutboundProxyBypass(input.outboundProxyBypass)
        : normalizeOutboundProxyBypass(fallback.outboundProxyBypass),
  };
}

function getSystemSettingsUnsafe() {
  try {
    return require('./db').getSystemSettings();
  } catch (_) {
    return {};
  }
}

function resolveOutboundProxySettings(settings = null) {
  const persistedSettings = getSystemSettingsUnsafe();
  return normalizeOutboundProxySettings(settings || {}, persistedSettings);
}

function parseBypassPatterns(value = '') {
  return normalizeOutboundProxyBypass(value)
    .split('\n')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function matchesBypass(hostname = '', patterns = []) {
  const normalizedHost = trimString(hostname).toLowerCase();
  if (!normalizedHost) {
    return false;
  }

  return patterns.some((pattern) => {
    const normalizedPattern = trimString(pattern).toLowerCase();
    if (!normalizedPattern) {
      return false;
    }

    if (normalizedPattern === '*') {
      return true;
    }

    if (normalizedPattern.startsWith('*.')) {
      const suffix = normalizedPattern.slice(1);
      return normalizedHost === suffix.slice(1) || normalizedHost.endsWith(suffix);
    }

    if (normalizedPattern.startsWith('.')) {
      return normalizedHost === normalizedPattern.slice(1) || normalizedHost.endsWith(normalizedPattern);
    }

    return normalizedHost === normalizedPattern || normalizedHost.endsWith(`.${normalizedPattern}`);
  });
}

function parseWindowsProxyServer(proxyServer = '', protocol = 'https') {
  const normalized = trimString(proxyServer);
  if (!normalized) {
    return [];
  }

  if (!normalized.includes('=')) {
    return [normalizeProxyUrl(normalized)];
  }

  const entries = new Map();
  normalized
    .split(';')
    .map((item) => trimString(item))
    .filter(Boolean)
    .forEach((item) => {
      const [key, ...rest] = item.split('=');
      if (!key || !rest.length) {
        return;
      }

      entries.set(trimString(key).toLowerCase(), normalizeProxyUrl(rest.join('=')));
    });

  return uniqueStrings([
    entries.get(protocol),
    protocol === 'https' ? entries.get('http') : '',
    entries.get('all'),
    entries.get('socks'),
  ]);
}

function readWindowsProxyConfig() {
  if (process.platform !== 'win32') {
    return { enabled: false, proxyServer: '' };
  }

  if (windowsProxyConfigCache) {
    return windowsProxyConfigCache;
  }

  try {
    const output = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const proxyEnableMatch = output.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    const proxyServerMatch = output.match(/ProxyServer\s+REG_\w+\s+([^\r\n]+)/i);
    windowsProxyConfigCache = {
      enabled: proxyEnableMatch ? Number.parseInt(proxyEnableMatch[1], 16) === 1 : false,
      proxyServer: proxyServerMatch ? trimString(proxyServerMatch[1]) : '',
    };
  } catch (_) {
    windowsProxyConfigCache = { enabled: false, proxyServer: '' };
  }

  return windowsProxyConfigCache;
}

function resolveProxyCandidates(targetUrl = '', options = {}) {
  let protocol = 'https';
  let hostname = '';

  try {
    const parsed = new URL(targetUrl);
    protocol = parsed.protocol === 'http:' ? 'http' : 'https';
    hostname = trimString(parsed.hostname).toLowerCase();
  } catch (_) {
    protocol = 'https';
    hostname = '';
  }

  const runtimeSettings = resolveOutboundProxySettings(options.proxySettings);
  const bypassPatterns = parseBypassPatterns(runtimeSettings.outboundProxyBypass);
  if (hostname && matchesBypass(hostname, bypassPatterns)) {
    return [];
  }

  const extraProxyUrls = Array.isArray(options.extraProxyUrls)
    ? options.extraProxyUrls.map((item) => normalizeProxyUrl(item))
    : [];

  if (runtimeSettings.outboundProxyMode === 'custom') {
    return uniqueStrings([runtimeSettings.outboundProxyUrl, ...extraProxyUrls]);
  }

  if (runtimeSettings.outboundProxyMode === 'direct') {
    return [];
  }

  const systemProxy = readWindowsProxyConfig();
  return uniqueStrings([
    ...extraProxyUrls,
    protocol === 'https' ? process.env.HTTPS_PROXY || process.env.https_proxy : '',
    process.env.HTTP_PROXY || process.env.http_proxy,
    process.env.ALL_PROXY || process.env.all_proxy,
    ...(systemProxy.enabled ? parseWindowsProxyServer(systemProxy.proxyServer, protocol) : []),
  ]);
}

function getProxyAgent(proxyUrl) {
  if (!proxyAgentCache.has(proxyUrl)) {
    proxyAgentCache.set(proxyUrl, new ProxyAgent(proxyUrl));
  }

  return proxyAgentCache.get(proxyUrl);
}

function normalizeErrorCode(error) {
  return trimString(error?.code || error?.cause?.code).toUpperCase();
}

function isLikelyNetworkFailure(error) {
  const code = normalizeErrorCode(error);
  if (NETWORK_FAILURE_CODES.includes(code)) {
    return true;
  }

  const message = trimString(error?.message || error).toLowerCase();
  return NETWORK_FAILURE_PATTERNS.some((pattern) => message.includes(pattern));
}

function decorateResponse(response, proxyUrl) {
  try {
    Object.defineProperty(response, 'mailUnionProxyUrl', {
      configurable: true,
      enumerable: false,
      writable: false,
      value: proxyUrl || '',
    });
  } catch (_) {
    response.mailUnionProxyUrl = proxyUrl || '';
  }

  return response;
}

function requiresHalfDuplex(body) {
  if (!body) {
    return false;
  }

  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    return false;
  }

  if (body instanceof URLSearchParams || body instanceof ArrayBuffer) {
    return false;
  }

  if (ArrayBuffer.isView(body)) {
    return false;
  }

  return (
    typeof body.pipe === 'function' ||
    typeof body.getReader === 'function' ||
    typeof body[Symbol.asyncIterator] === 'function'
  );
}

async function fetchWithOutboundProxy(targetUrl, options = {}, requestOptions = {}) {
  const timeoutMs = Math.max(Number(requestOptions.timeoutMs) || 15000, 1000);
  const allowDirectFallback = requestOptions.allowDirectFallback !== false;
  const proxyCandidates = resolveProxyCandidates(targetUrl, requestOptions);
  const attempts = [
    ...proxyCandidates.map((proxyUrl) => ({
      dispatcher: getProxyAgent(proxyUrl),
      proxyUrl,
    })),
    ...(allowDirectFallback || !proxyCandidates.length
      ? [
          {
            dispatcher: directAgent,
            proxyUrl: '',
          },
        ]
      : []),
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const requestInit = {
        ...options,
        dispatcher: attempt.dispatcher,
        ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? { signal: AbortSignal.timeout(timeoutMs) }
          : {}),
      };

      if (requiresHalfDuplex(requestInit.body)) {
        requestInit.duplex = 'half';
      }

      const response = await undiciFetch(targetUrl, {
        ...requestInit,
      });
      return decorateResponse(response, attempt.proxyUrl);
    } catch (error) {
      if (!isLikelyNetworkFailure(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError || new Error('fetch failed');
}

function maskProxyUrl(proxyUrl = '') {
  const value = normalizeProxyUrl(proxyUrl);
  if (!value) {
    return '';
  }

  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) {
      return value;
    }

    parsed.username = parsed.username ? '***' : '';
    parsed.password = parsed.password ? '***' : '';
    return parsed.toString();
  } catch (_) {
    return value;
  }
}

function setManagedProxyEnv(key, value) {
  if (value) {
    process.env[key] = value;
    process.env[key.toLowerCase()] = value;
    return;
  }

  delete process.env[key];
  delete process.env[key.toLowerCase()];
}

function applyRuntimeProxyEnvironment(settings = null) {
  const runtimeSettings = resolveOutboundProxySettings(settings);
  const bypassValue = normalizeOutboundProxyBypass(runtimeSettings.outboundProxyBypass);

  if (runtimeSettings.outboundProxyMode === 'custom' && runtimeSettings.outboundProxyUrl) {
    setManagedProxyEnv('HTTP_PROXY', runtimeSettings.outboundProxyUrl);
    setManagedProxyEnv('HTTPS_PROXY', runtimeSettings.outboundProxyUrl);
    setManagedProxyEnv('ALL_PROXY', runtimeSettings.outboundProxyUrl);
    setManagedProxyEnv('NO_PROXY', bypassValue || ORIGINAL_PROXY_ENV.NO_PROXY);
    return runtimeSettings;
  }

  if (runtimeSettings.outboundProxyMode === 'direct') {
    setManagedProxyEnv('HTTP_PROXY', '');
    setManagedProxyEnv('HTTPS_PROXY', '');
    setManagedProxyEnv('ALL_PROXY', '');
    setManagedProxyEnv('NO_PROXY', bypassValue);
    return runtimeSettings;
  }

  setManagedProxyEnv('HTTP_PROXY', ORIGINAL_PROXY_ENV.HTTP_PROXY);
  setManagedProxyEnv('HTTPS_PROXY', ORIGINAL_PROXY_ENV.HTTPS_PROXY);
  setManagedProxyEnv('ALL_PROXY', ORIGINAL_PROXY_ENV.ALL_PROXY);
  setManagedProxyEnv('NO_PROXY', bypassValue || ORIGINAL_PROXY_ENV.NO_PROXY);
  return runtimeSettings;
}

async function probeEndpoint(target, settings = null) {
  try {
    const response = await fetchWithOutboundProxy(
      target.url,
      {
        method: target.method || 'HEAD',
        headers: target.headers || {},
      },
      {
        timeoutMs: target.timeoutMs || 10000,
        proxySettings: settings,
        allowDirectFallback:
          normalizeOutboundProxyMode(
            (settings || getSystemSettingsUnsafe()).outboundProxyMode,
          ) === 'direct',
      },
    );

    return {
      id: target.id,
      label: target.label,
      url: target.url,
      reachable: true,
      status: Number(response.status || 0),
      statusText: trimString(response.statusText),
      proxyUsed: trimString(response.mailUnionProxyUrl),
      error: '',
    };
  } catch (error) {
    return {
      id: target.id,
      label: target.label,
      url: target.url,
      reachable: false,
      status: 0,
      statusText: '',
      proxyUsed: '',
      error: trimString(error?.cause?.message || error?.message || error || 'Network probe failed.'),
    };
  }
}

async function testOutboundConnectivity(settings = null) {
  const runtimeSettings = resolveOutboundProxySettings(settings);
  const targets = [
    {
      id: 'google',
      label: 'Google OAuth',
      url: 'https://oauth2.googleapis.com/token',
      method: 'HEAD',
    },
    {
      id: 'microsoft',
      label: 'Microsoft OAuth',
      url: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
      method: 'HEAD',
    },
    {
      id: 'telegram',
      label: 'Telegram API',
      url: 'https://api.telegram.org',
      method: 'HEAD',
    },
    {
      id: 'feishu',
      label: '飞书开放平台',
      url: 'https://open.feishu.cn',
      method: 'HEAD',
    },
  ];

  const results = [];
  for (const target of targets) {
    results.push(await probeEndpoint(target, runtimeSettings));
  }

  return {
    mode: runtimeSettings.outboundProxyMode,
    proxyUrl: maskProxyUrl(runtimeSettings.outboundProxyUrl),
    bypass: parseBypassPatterns(runtimeSettings.outboundProxyBypass),
    successCount: results.filter((item) => item.reachable).length,
    totalCount: results.length,
    targets: results,
  };
}

module.exports = {
  applyRuntimeProxyEnvironment,
  fetchWithOutboundProxy,
  maskProxyUrl,
  normalizeOutboundProxyBypass,
  normalizeOutboundProxyMode,
  normalizeOutboundProxySettings,
  normalizeProxyUrl,
  resolveOutboundProxySettings,
  testOutboundConnectivity,
};
