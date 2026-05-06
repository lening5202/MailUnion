const { createHmac, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ProxyAgent, fetch: undiciFetch } = require('undici');
const { createSignedToken, decrypt, encrypt } = require('./crypto');
const { getSystemSettings, listMessages, listNotificationTargets, upsertNotificationTarget } = require('./db');
const { translateMessage } = require('./translation-service');
const { WecomSmartBotClientPool } = require('./wecom-smartbot');
const { fetchWithOutboundProxy } = require('./outbound-network');
const {
  STORAGE_ROOT,
  downloadAssetFromUrl,
  publicAssetPath,
  writeBufferAsset,
  writeDataUrlAsset,
} = require('./storage');

let sharp = null;
try {
  sharp = require('sharp');
} catch (_) {
  sharp = null;
}

const DELIVERY_CHANNELS = ['telegram', 'wecom', 'feishu'];
const SETTINGS_CHANNELS = [...DELIVERY_CHANNELS, 'template'];

const TELEGRAM_TEXT_LIMIT = 3900;
const TELEGRAM_CAPTION_LIMIT = 900;
const TELEGRAM_SUMMARY_LIMIT = 2800;
const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const TELEGRAM_COMMON_PROXY_URLS = [
  'http://127.0.0.1:10808',
  'http://127.0.0.1:10809',
  'http://127.0.0.1:7890',
  'http://127.0.0.1:7897',
];
const WECOM_APP_API_BASE_URL = 'https://qyapi.weixin.qq.com/cgi-bin';
const WECOM_PREVIEW_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WECOM_TEXT_LIMIT = 3600;
const FEISHU_TEXT_LIMIT = 4500;
const DEFAULT_TEMPLATE_PRESET_ID = 'default';
const TEMPLATE_TEXT_MAX_LENGTH = 2400;
const NOTIFICATION_COVER_CATEGORIES = ['verification', 'order', 'subscription', 'marketing', 'junk', 'standard'];
const NOTIFICATION_COVER_MODES = ['builtin', 'url', 'upload', 'none'];
const NOTIFICATION_COVER_CHANNELS = ['telegram', 'wecomApp'];
const NOTIFICATION_COVER_DELIVERY_MODES = ['cover', 'plain'];
const BUILTIN_NOTIFICATION_COVER_ASSET_PATH_PREFIX = 'builtin/notification-covers';
const BUILTIN_NOTIFICATION_COVER_FILENAMES = Object.freeze({
  verification: 'verification-mail.png',
  order: 'order-mail.png',
  subscription: 'subscription-mail.png',
  marketing: 'marketing-mail.png',
  junk: 'junk-mail.png',
  standard: 'standard-mail.png',
});

function builtinNotificationCoverAssetFilename(category = 'standard') {
  const normalized = NOTIFICATION_COVER_CATEGORIES.includes(String(category || '').trim())
    ? String(category || '').trim()
    : 'standard';
  return BUILTIN_NOTIFICATION_COVER_FILENAMES[normalized] || BUILTIN_NOTIFICATION_COVER_FILENAMES.standard;
}

function builtinNotificationCoverAssetPath(category = 'standard') {
  return `${BUILTIN_NOTIFICATION_COVER_ASSET_PATH_PREFIX}/${builtinNotificationCoverAssetFilename(category)}`;
}

function resolveBuiltinNotificationCoverAssetByPath(relativePath = '') {
  const normalized = String(relativePath || '').trim().replace(/\\/g, '/');
  if (!normalized.startsWith(`${BUILTIN_NOTIFICATION_COVER_ASSET_PATH_PREFIX}/`)) {
    return null;
  }

  const filename = path.posix.basename(normalized);
  if (!Object.values(BUILTIN_NOTIFICATION_COVER_FILENAMES).includes(filename)) {
    return null;
  }

  return {
    assetPath: normalized,
    assetUrl: `/assets/notification-covers/${filename}`,
    assetLocalPath: path.join(process.cwd(), 'public', 'assets', 'notification-covers', filename),
    contentType: assetContentTypeFromPath(filename) || 'image/png',
  };
}

function resolveBuiltinNotificationCoverAsset(category = 'standard') {
  return resolveBuiltinNotificationCoverAssetByPath(builtinNotificationCoverAssetPath(category));
}

function isBuiltinNotificationCoverAssetPath(relativePath = '') {
  return Boolean(resolveBuiltinNotificationCoverAssetByPath(relativePath));
}

function createDefaultTemplateCoverConfig(category = 'standard') {
  const builtinAsset = resolveBuiltinNotificationCoverAsset(category);
  return {
    mode: 'builtin',
    url: '',
    assetPath: builtinAsset?.assetPath || '',
    assetUrl: builtinAsset?.assetUrl || '',
    assetLocalPath: builtinAsset?.assetLocalPath || '',
    contentType: builtinAsset?.contentType || 'image/png',
    uploadFilename: '',
    uploadDataUrl: '',
  };
}

function createDefaultTemplateCoverConfigs() {
  return Object.fromEntries(
    NOTIFICATION_COVER_CATEGORIES.map((category) => [category, createDefaultTemplateCoverConfig(category)]),
  );
}

function createDefaultTemplateCoverChannelModes() {
  return {
    telegram: 'cover',
    wecomApp: 'cover',
  };
}

const DEFAULT_TEMPLATE_OPTIONS = Object.freeze({
  translateToChinese: false,
  previewBaseUrl: '',
  coverEnabled: true,
  coverChannels: Object.freeze(createDefaultTemplateCoverChannelModes()),
  covers: Object.freeze(createDefaultTemplateCoverConfigs()),
});

const MARKETING_KEYWORDS = [
  'unsubscribe',
  'unsubscribe from',
  'email preferences',
  'manage preferences',
  'view in browser',
  'view online',
  'promotion',
  'promo',
  'marketing',
  'campaign',
  'sale',
  'flash sale',
  'discount',
  'coupon',
  'voucher',
  'deal',
  'deals',
  'offer',
  'special offer',
  'exclusive offer',
  'limited-time',
  'limited time',
  'pricing',
  'upgrade',
  'try pro',
  'more usage',
  '退订',
  '取消订阅',
  '邮件偏好',
  '在浏览器中查看',
  '营销',
  '促销',
  '优惠',
  '折扣',
  '特价',
  '秒杀',
  '大促',
  '满减',
  '活动',
  '限时',
  '升级套餐',
];

const ORDER_KEYWORDS = [
  'order',
  'ordered',
  'order confirmed',
  'order confirmation',
  'order update',
  'order status',
  'order number',
  'order no',
  'order id',
  'purchase',
  'purchased',
  'payment received',
  'payment successful',
  'payment confirmation',
  'shipment',
  'shipping',
  'shipped',
  'delivery',
  'delivered',
  'tracking',
  'track package',
  'invoice',
  'receipt',
  'tax invoice',
  'booking',
  'reservation',
  'ticket',
  '订单',
  '订单号',
  '订单编号',
  '订单确认',
  '订单通知',
  '订单状态',
  '订单更新',
  '订单详情',
  '下单',
  '已下单',
  '发货',
  '已发货',
  '物流',
  '运单',
  '配送',
  '派送',
  '签收',
  '交易',
  '购买',
  '付款',
  '支付',
  '支付成功',
  '付款成功',
  '收据',
  '发票',
  '票据',
  '预订',
  '预约',
  '订票',
  '门票',
  '订单已生成',
];

const SUBSCRIPTION_KEYWORDS = [
  'subscription',
  'subscribe',
  'subscribed',
  'subscriber',
  'subscription renewed',
  'subscription renewal',
  'subscription update',
  'subscription reminder',
  'subscription expiring',
  'subscription expired',
  'membership',
  'member',
  'premium',
  'renewal',
  'renew',
  'renewed',
  'auto renew',
  'auto-renew',
  'billing cycle',
  'billing period',
  'plan',
  'plan changed',
  'trial',
  'free trial',
  'trial ending',
  'newsletter',
  'digest',
  'weekly digest',
  'monthly digest',
  '订阅',
  '订阅通知',
  '订阅提醒',
  '订阅成功',
  '订阅更新',
  '订阅续费',
  '订阅即将到期',
  '订阅已到期',
  '会员',
  '会员服务',
  '会员到期',
  '会员续费',
  '续费',
  '自动续费',
  '到期',
  '服务到期',
  '套餐',
  '账期',
  '月度账单',
  '邮件列表',
  '简报',
];

const JUNK_KEYWORDS = [
  'spam',
  'phishing',
  'scam',
  'fraud',
  'malware',
  'virus',
  'lottery',
  'winner',
  'you won',
  'claim prize',
  'free money',
  'investment opportunity',
  'guaranteed income',
  'urgent action required',
  'casino',
  'betting',
  'loan offer',
  '博彩',
  '中奖',
  '大奖',
  '领奖',
  '领取奖金',
  '钓鱼',
  '诈骗',
  '病毒',
  '木马',
  '低息贷款',
  '贷款秒批',
  '免费领取',
  '兼职刷单',
  '刷单',
  '高薪兼职',
  '成人',
  '色情',
  '垃圾邮件',
];

const TEMPLATE_TOKEN_MAP = {
  subject: '{subject}',
  from: '{from}',
  mailbox: '{mailbox}',
  time: '{time}',
  summary: '{summary}',
};

const TEMPLATE_TOKENS = [
  {
    token: TEMPLATE_TOKEN_MAP.subject,
    label: '邮件主题',
    description: '替换成当前邮件的主题',
  },
  {
    token: TEMPLATE_TOKEN_MAP.from,
    label: '发件人',
    description: '替换成发件人名称或地址',
  },
  {
    token: TEMPLATE_TOKEN_MAP.mailbox,
    label: '收件邮箱',
    description: '替换成当前同步到的邮箱',
  },
  {
    token: TEMPLATE_TOKEN_MAP.time,
    label: '收件时间',
    description: '替换成邮件接收时间',
  },
  {
    token: TEMPLATE_TOKEN_MAP.summary,
    label: '正文摘要',
    description: '替换成正文预览摘要',
  },
];

const TEMPLATE_SAMPLE = {
  subject: '登录验证码已送达',
  from: 'Acme Security <no-reply@acme.test>',
  mailbox: 'alerts@example.com',
  time: '2026/03/30 14:05:12',
  summary:
    '这是一封用于预览通知模板效果的示例邮件。你可以修改模板文案、段落顺序和强调方式；如果正文里出现链接 https://example.com/preview ，Telegram 和企业微信会自动渲染成可点击的“网址”跳转。',
};

const TEMPLATE_PRESETS = [
  {
    id: 'default',
    name: '默认清爽',
    accent: 'Classic',
    description: '结构清晰、信息完整，适合作为长期默认模板。',
    templates: {
      telegram:
        '<b>【新邮件通知】</b>\n<b>主题：</b>{subject}\n<b>发件人：</b>{from}\n<b>邮箱：</b>{mailbox}\n<b>时间：</b>{time}\n\n<blockquote>{summary}</blockquote>',
      wecom:
        '# 新邮件通知\n> 主题：{subject}\n> 发件人：{from}\n> 邮箱：{mailbox}\n> 时间：{time}\n>\n> 正文摘要\n> {summary}',
      feishu:
        '新邮件到达\n主题：{subject}\n发件人：{from}\n邮箱：{mailbox}\n时间：{time}\n\n正文摘要\n{summary}',
    },
  },
  {
    id: 'emoji-pop',
    name: '表情增强',
    accent: 'Emoji',
    description: '更醒目、更有提醒感，适合需要第一眼就看到的新邮件通知。',
    templates: {
      telegram:
        '<b>📮 新邮件提醒</b>\n<b>✨ 主题：</b>{subject}\n<b>👤 发件人：</b>{from}\n<b>📥 邮箱：</b>{mailbox}\n<b>⏰ 时间：</b>{time}\n\n<blockquote>💬 {summary}</blockquote>',
      wecom:
        '# 📮 邮件提醒\n> ✨ {subject}\n> 👤 发件人：{from}\n> 📥 邮箱：{mailbox}\n> ⏰ 时间：{time}\n>\n> 💬 正文摘要\n> {summary}',
      feishu:
        '📮 邮件提醒\n✨ 主题：{subject}\n👤 发件人：{from}\n📥 邮箱：{mailbox}\n⏰ 时间：{time}\n\n💬 正文摘要\n{summary}',
    },
  },
  {
    id: 'alert-card',
    name: '告警雷达',
    accent: 'Alert',
    description: '适合验证码、安全、风控、异常工单等更重要的邮件提醒。',
    templates: {
      telegram:
        '<b>🚨 重点邮件提醒</b>\n<b>{subject}</b>\n<code>FROM</code> {from}\n<code>BOX</code> {mailbox}\n<code>TIME</code> {time}\n\n<blockquote>⚠️ 请优先查看\n{summary}</blockquote>',
      wecom:
        '# 🚨 重点邮件提醒\n> 主题：{subject}\n> 发件人：{from}\n> 邮箱：{mailbox}\n> 时间：{time}\n>\n> ⚠️ 请优先查看\n> {summary}',
      feishu:
        '🚨 重点邮件提醒\n主题：{subject}\n发件人：{from}\n邮箱：{mailbox}\n时间：{time}\n\n⚠️ 请优先查看\n{summary}',
    },
  },
  {
    id: 'mini-card',
    name: '小卡片',
    accent: 'Card',
    description: '用紧凑分组做出卡片感，适合移动端快速扫读。',
    templates: {
      telegram:
        '<b>【邮件卡片】</b>\n<b>{subject}</b>\n<code>├ 发件人</code> {from}\n<code>├ 邮箱</code> {mailbox}\n<code>└ 时间</code> {time}\n\n<blockquote>📝 {summary}</blockquote>',
      wecom:
        '# 邮件卡片\n> {subject}\n> ├ 发件人：{from}\n> ├ 邮箱：{mailbox}\n> └ 时间：{time}\n>\n> 📝 正文摘要\n> {summary}',
      feishu:
        '【邮件卡片】\n主题：{subject}\n├ 发件人：{from}\n├ 邮箱：{mailbox}\n└ 时间：{time}\n\n📝 正文摘要\n{summary}',
    },
  },
  {
    id: 'executive',
    name: '商务摘要',
    accent: 'Brief',
    description: '重点前置、语气简洁，适合运营和管理消息。',
    templates: {
      telegram:
        '<b>📊 商务摘要</b>\n<b>{subject}</b>\n<code>FROM</code> {from}\n<code>BOX</code> {mailbox}\n<code>AT</code> {time}\n\n<blockquote>{summary}</blockquote>',
      wecom:
        '# 📊 商务摘要\n## {subject}\n> 来自：{from}\n> 邮箱：{mailbox}\n> 时间：{time}\n>\n> 摘要\n> {summary}',
      feishu:
        '📊 邮件摘要\n【{subject}】\n来自：{from}\n邮箱：{mailbox}\n时间：{time}\n\n摘要：\n{summary}',
    },
  },
  {
    id: 'warm-service',
    name: '轻暖服务',
    accent: 'Friendly',
    description: '语气更柔和，适合客服、订阅、平台提醒等高频但不紧急的通知。',
    templates: {
      telegram:
        '<b>🌤️ 收件箱有新动态</b>\n<i>{subject}</i>\n<b>发件人：</b>{from}\n<b>到达邮箱：</b>{mailbox}\n<b>接收时间：</b>{time}\n\n<blockquote>{summary}</blockquote>',
      wecom:
        '# 🌤️ 收件箱有新动态\n> {subject}\n> 发件人：{from}\n> 到达邮箱：{mailbox}\n> 接收时间：{time}\n>\n> 正文摘要\n> {summary}',
      feishu:
        '🌤️ 收件箱有新动态\n标题：{subject}\n发件人：{from}\n到达邮箱：{mailbox}\n接收时间：{time}\n\n{summary}',
    },
  },
  {
    id: 'terminal',
    name: '终端风格',
    accent: 'Mono',
    description: '更偏工程控制台视觉，适合技术类通知频道、系统日志或脚本告警。',
    templates: {
      telegram:
        '<b>[MAIL EVENT]</b>\n<code>SUBJECT</code> {subject}\n<code>FROM</code> {from}\n<code>BOX</code> {mailbox}\n<code>TIME</code> {time}\n\n<blockquote>{summary}</blockquote>',
      wecom:
        '# [MAIL EVENT]\n> {subject}\n> `FROM` {from}\n> `BOX` {mailbox}\n> `TIME` {time}\n>\n> {summary}',
      feishu:
        '[MAIL] {subject}\nFROM: {from}\nBOX: {mailbox}\nTIME: {time}\n\n{summary}',
    },
  },
  {
    id: 'editorial',
    name: '杂志排版',
    accent: 'Editorial',
    description: '标题感更强，适合强调主题和阅读体验。',
    templates: {
      telegram:
        '<b>📰 今日邮件速览</b>\n<b>{subject}</b>\n<i>{from}</i>\n收件箱：{mailbox}\n时间：{time}\n\n<blockquote>{summary}</blockquote>',
      wecom:
        '# 📰 今日邮件速览\n## {subject}\n> 发件人：{from}\n> 收件箱：{mailbox}\n> 时间：{time}\n>\n> {summary}',
      feishu:
        '📰 邮件速览\n{subject}\n\n发件人：{from}\n收件箱：{mailbox}\n时间：{time}\n\n{summary}',
    },
  },
];

const wecomClientPool = new WecomSmartBotClientPool();
const proxyAgentCache = new Map();

function channelLabel(channel) {
  if (channel === 'telegram') return 'Telegram';
  if (channel === 'wecom') return '企业微信';
  if (channel === 'feishu') return '飞书';
  if (channel === 'template') return '通知模板';
  return channel;
}

function safeDecrypt(cipherText) {
  if (!cipherText) {
    return '';
  }

  try {
    return decrypt(cipherText);
  } catch (_) {
    return '';
  }
}

function parseWecomSecretBundle(secretEncrypted) {
  const raw = safeDecrypt(secretEncrypted);
  if (!raw) {
    return {
      secret: '',
      botSecret: '',
      appSecret: '',
      callbackToken: '',
      encodingAesKey: '',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const legacySecret = String(parsed.secret || '').trim();
      const botSecret = String(parsed.botSecret || legacySecret || '').trim();
      const appSecret = String(parsed.appSecret || legacySecret || '').trim();
      return {
        secret: legacySecret || botSecret || appSecret,
        botSecret,
        appSecret,
        callbackToken: String(parsed.callbackToken || '').trim(),
        encodingAesKey: String(parsed.encodingAesKey || '').trim(),
      };
    }
  } catch (_) {
    // Fall back to the legacy single-secret format.
  }

  const legacySecret = String(raw || '').trim();
  return {
    secret: legacySecret,
    botSecret: legacySecret,
    appSecret: legacySecret,
    callbackToken: '',
    encodingAesKey: '',
  };
}

function buildWecomSecretBundle({ botSecret = '', appSecret = '', callbackToken = '', encodingAesKey = '' } = {}) {
  const normalizedBotSecret = String(botSecret || '').trim();
  const normalizedAppSecret = String(appSecret || '').trim();
  const normalizedToken = String(callbackToken || '').trim();
  const normalizedEncodingAesKey = String(encodingAesKey || '').trim();

  if (!normalizedBotSecret && !normalizedAppSecret && !normalizedToken && !normalizedEncodingAesKey) {
    return '';
  }

  return encrypt(
    JSON.stringify({
      secret: normalizedAppSecret || normalizedBotSecret,
      botSecret: normalizedBotSecret,
      appSecret: normalizedAppSecret,
      callbackToken: normalizedToken,
      encodingAesKey: normalizedEncodingAesKey,
    }),
  );
}

function generateWecomCallbackToken() {
  return randomBytes(12).toString('hex');
}

function generateWecomEncodingAesKey() {
  return randomBytes(32).toString('base64').replace(/=+$/g, '');
}

function buildWecomCallbackPath(userId = '') {
  const resolvedUserId = String(userId || '').trim();
  if (!resolvedUserId) {
    return '';
  }

  return `/api/notifications/wecom/callback/${encodeURIComponent(resolvedUserId)}`;
}

function buildWecomCallbackUrl(userId = '', appBaseUrl = '') {
  const callbackPath = buildWecomCallbackPath(userId);
  const resolvedBaseUrl = normalizeUrl(appBaseUrl || process.env.PUBLIC_BASE_URL || '');
  if (!callbackPath || !resolvedBaseUrl) {
    return '';
  }

  return `${resolvedBaseUrl}${callbackPath}`;
}

function maskValue(value, visibleLength = 46) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  return text.length <= visibleLength ? text : `${text.slice(0, visibleLength)}...`;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeUrl(value, fallback = '') {
  const text = String(value || fallback || '').trim();
  if (!text) {
    return '';
  }

  return text.replace(/\/+$/, '');
}

function clipText(text, maxLength, options = {}) {
  const value = String(text || '').trim();
  if (!value) {
    return '';
  }

  if (value.length <= maxLength) {
    return value;
  }

  const indicator = options.showIndicator === false ? '…' : '\n\n[已截断]';
  const sliceLength = Math.max(0, maxLength - indicator.length);
  if (sliceLength <= 0) {
    return indicator.trim();
  }

  const sliced = value.slice(0, sliceLength);
  const preferredBreakpoints = [
    sliced.lastIndexOf('\n\n'),
    sliced.lastIndexOf('\n'),
    Math.max(sliced.lastIndexOf('。'), sliced.lastIndexOf('！'), sliced.lastIndexOf('？')),
    Math.max(sliced.lastIndexOf('. '), sliced.lastIndexOf('! '), sliced.lastIndexOf('? ')),
    sliced.lastIndexOf('；'),
    sliced.lastIndexOf('; '),
    sliced.lastIndexOf('，'),
    sliced.lastIndexOf(', '),
  ];
  const breakIndex = preferredBreakpoints.find((index) => index >= Math.max(40, Math.floor(sliceLength * 0.45)));
  const clipped = breakIndex >= 0 ? sliced.slice(0, breakIndex + 1) : sliced;
  return `${clipped.trimEnd()}${indicator}`;
}

function formatBodyPreview(message, maxLength) {
  return clipText(message.textBody || message.preview || '', maxLength);
}

function formatTimestamp(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) {
    return String(value || '');
  }

  return date.toLocaleString('zh-CN', { hour12: false });
}

function escapeTelegramHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function decodeHtmlEntities(text = '') {
  const namedEntities = {
    nbsp: ' ',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
  };

  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalized = String(entity || '').trim().toLowerCase();
    if (!normalized) {
      return match;
    }

    if (normalized.startsWith('#x')) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (normalized.startsWith('#')) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return Object.prototype.hasOwnProperty.call(namedEntities, normalized) ? namedEntities[normalized] : match;
  });
}

function stripHtmlTags(value = '') {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function normalizeNotificationText(text = '') {
  return decodeHtmlEntities(String(text || ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitSentenceLikeSegments(text = '') {
  const source = String(text || '').trim();
  if (!source) {
    return [];
  }

  const segments = source.match(/[^。！？!?；;]+(?:[。！？!?；;]+|$)/g);
  if (!segments?.length) {
    return [source];
  }

  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function isStructuredNotificationLine(text = '') {
  const line = String(text || '').trim();
  if (!line) {
    return false;
  }

  return (
    /^([\-•*—–]|[0-9]+\.)\s+/.test(line) ||
    line.includes(' | ') ||
    /^https?:\/\//i.test(line) ||
    /^\[[^\]]+\]\(https?:\/\//i.test(line) ||
    /^[A-Z][A-Z0-9 _-]{2,20}:\s*/.test(line)
  );
}

function paragraphizeNotificationText(text = '', options = {}) {
  const normalized = normalizeNotificationText(text);
  if (!normalized) {
    return '';
  }

  const sentenceGroupSoftLimit = Math.max(Number(options.sentenceGroupSoftLimit) || 88, 48);
  const sentenceGroupHardLimit = Math.max(Number(options.sentenceGroupHardLimit) || 140, sentenceGroupSoftLimit + 12);
  const paragraphBlocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const formattedBlocks = [];

  for (const block of paragraphBlocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) {
      continue;
    }

    if (lines.length > 1 && lines.every((line) => isStructuredNotificationLine(line))) {
      formattedBlocks.push(lines.join('\n'));
      continue;
    }

    const mergedBlock = lines.join(' ');
    if (isStructuredNotificationLine(mergedBlock)) {
      formattedBlocks.push(mergedBlock);
      continue;
    }

    const sentences = splitSentenceLikeSegments(mergedBlock);
    if (sentences.length <= 1 && mergedBlock.length <= sentenceGroupHardLimit) {
      formattedBlocks.push(mergedBlock);
      continue;
    }

    const paragraphParts = [];
    let currentPart = '';

    for (const sentence of sentences) {
      if (!currentPart) {
        currentPart = sentence;
        continue;
      }

      const joined = `${currentPart} ${sentence}`.trim();
      if (
        joined.length <= sentenceGroupSoftLimit ||
        (currentPart.length < Math.floor(sentenceGroupSoftLimit * 0.55) && joined.length <= sentenceGroupHardLimit)
      ) {
        currentPart = joined;
      } else {
        paragraphParts.push(currentPart);
        currentPart = sentence;
      }
    }

    if (currentPart) {
      paragraphParts.push(currentPart);
    }

    formattedBlocks.push(paragraphParts.join('\n\n'));
  }

  return formattedBlocks.join('\n\n').trim();
}

function htmlInlineToText(html = '') {
  return paragraphizeNotificationText(
    String(html || '')
      .replace(/<(?:strong|b)\b[^>]*>/gi, '')
      .replace(/<\/(?:strong|b)>/gi, '')
      .replace(/<(?:em|i)\b[^>]*>/gi, '')
      .replace(/<\/(?:em|i)>/gi, '')
      .replace(/<br\b[^>]*\/?>/gi, '\n')
      .replace(/<img\b[^>]*alt=(["'])(.*?)\1[^>]*>/gi, ' [$2] ')
      .replace(/<img\b[^>]*>/gi, ' [图片] ')
      .replace(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, __, href, inner) => {
        const label = normalizeNotificationText(stripHtmlTags(inner));
        const url = String(href || '').trim();
        if (!url) {
          return label;
        }
        if (!label || label === url) {
          return url;
        }
        return `${label} ${url}`;
      })
      .replace(/<[^>]+>/g, ' '),
  );
}

function htmlBodyToText(html = '') {
  const source = String(html || '').trim();
  if (!source) {
    return '';
  }

  let normalized = source
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|noscript|svg|canvas|head|title|meta|link)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(style|script|noscript|svg|canvas|meta|link)\b[^>]*\/?>/gi, ' ');

  normalized = normalized.replace(
    /<table\b[^>]*>([\s\S]*?)<\/table>/gi,
    (_, tableHtml) => {
      const rows = [];
      const rowMatches = String(tableHtml || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);

      for (const rowMatch of rowMatches) {
        const cells = [];
        const cellMatches = String(rowMatch[1] || '').matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi);
        for (const cellMatch of cellMatches) {
          const cellText = htmlInlineToText(cellMatch[2]);
          if (cellText) {
            cells.push(cellText);
          }
        }

        if (cells.length) {
          rows.push(cells.join(' | '));
        }
      }

      return rows.length ? `\n${rows.join('\n')}\n` : '\n';
    },
  );

  normalized = normalized
    .replace(/<(ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<\/(ul|ol)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<(blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<\/(blockquote|pre)>/gi, '\n')
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<\/(h[1-6])>/gi, '\n')
    .replace(/<(p|div|section|article|header|footer|aside|main|figure|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|aside|main|figure|figcaption)>/gi, '\n')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<img\b[^>]*alt=(["'])(.*?)\1[^>]*>/gi, '\n[图片] $2\n')
    .replace(/<img\b[^>]*>/gi, '\n[图片]\n')
    .replace(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, __, href, inner) => {
      const label = normalizeNotificationText(stripHtmlTags(inner));
      const url = String(href || '').trim();
      if (!url) {
        return label;
      }
      if (!label || label === url) {
        return url;
      }
      return `${label} ${url}`;
    })
    .replace(/<[^>]+>/g, ' ');

  return paragraphizeNotificationText(normalized);
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_URL_PUNCTUATION = '.,!?;:)]}>,，。！？；：）》】」';

function splitUrlSuffix(rawUrl) {
  let url = String(rawUrl || '');
  let suffix = '';

  while (url) {
    const lastCharacter = url.slice(-1);
    if (!TRAILING_URL_PUNCTUATION.includes(lastCharacter)) {
      break;
    }

    if (lastCharacter === ')') {
      const openCount = (url.match(/\(/g) || []).length;
      const closeCount = (url.match(/\)/g) || []).length;
      if (closeCount <= openCount) {
        break;
      }
    }

    suffix = `${lastCharacter}${suffix}`;
    url = url.slice(0, -1);
  }

  return { url, suffix };
}

function replaceUrls(text, handlers) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  const formatText = typeof handlers?.formatText === 'function' ? handlers.formatText : (value) => String(value || '');
  const formatUrl = typeof handlers?.formatUrl === 'function' ? handlers.formatUrl : (value) => String(value || '');
  let result = '';
  let lastIndex = 0;

  for (const match of source.matchAll(URL_PATTERN)) {
    const fullMatch = String(match[0] || '');
    const startIndex = Number(match.index || 0);
    if (startIndex > lastIndex) {
      result += formatText(source.slice(lastIndex, startIndex));
    }

    const { url, suffix } = splitUrlSuffix(fullMatch);
    result += formatUrl(url);
    if (suffix) {
      result += formatText(suffix);
    }
    lastIndex = startIndex + fullMatch.length;
  }

  if (lastIndex < source.length) {
    result += formatText(source.slice(lastIndex));
  }

  return result || formatText(source);
}

function formatTelegramTemplateValue(value) {
  return replaceUrls(value, {
    formatText: escapeTelegramHtml,
    formatUrl: (url) => `<a href="${escapeTelegramHtml(url)}">网址</a>`,
  });
}

function formatWecomTemplateValue(value) {
  return replaceUrls(value, {
    formatText: (text) => String(text || ''),
    formatUrl: (url) => `[网址](${url})`,
  });
}

function clipTelegramHtml(text, maxVisibleLength = TELEGRAM_TEXT_LIMIT) {
  const source = String(text || '');
  if (!source) {
    return '';
  }

  const tagPattern = /<\/?[a-z][^>]*>/gi;
  const openTags = [];
  let result = '';
  let visibleLength = 0;
  let lastIndex = 0;
  let truncated = false;

  const appendTextSegment = (segment) => {
    if (!segment || truncated) {
      return;
    }

    const remaining = maxVisibleLength - visibleLength;
    if (remaining <= 0) {
      truncated = true;
      return;
    }

    if (segment.length <= remaining) {
      result += segment;
      visibleLength += segment.length;
      return;
    }

    const clippedLength = Math.max(0, remaining - 1);
    result += clippedLength > 0 ? `${segment.slice(0, clippedLength)}…` : '…';
    visibleLength = maxVisibleLength;
    truncated = true;
  };

  for (const match of source.matchAll(tagPattern)) {
    const index = Number(match.index || 0);
    appendTextSegment(source.slice(lastIndex, index));
    if (truncated) {
      lastIndex = index;
      break;
    }

    const tag = String(match[0] || '');
    result += tag;

    const tagNameMatch = tag.match(/^<\/?\s*([a-z0-9]+)/i);
    const tagName = String(tagNameMatch?.[1] || '').toLowerCase();
    const isClosingTag = /^<\//.test(tag);
    const isSelfClosingTag = /\/>$/.test(tag);

    if (tagName && !isSelfClosingTag) {
      if (isClosingTag) {
        const stackIndex = openTags.lastIndexOf(tagName);
        if (stackIndex >= 0) {
          openTags.splice(stackIndex, 1);
        }
      } else {
        openTags.push(tagName);
      }
    }

    lastIndex = index + tag.length;
  }

  if (!truncated) {
    appendTextSegment(source.slice(lastIndex));
  }

  if (!truncated) {
    return source;
  }

  while (openTags.length) {
    result += `</${openTags.pop()}>`;
  }

  return result;
}

const VERIFICATION_KEYWORDS = [
  '验证码',
  '校验码',
  '动态码',
  '提取码',
  '确认码',
  '登录码',
  '安全码',
  'verification code',
  'security code',
  'one-time code',
  'one time code',
  'one-time password',
  'one time password',
  'passcode',
  'otp',
];

const VERIFICATION_PATTERNS = [
  /(?:验证码|校验码|动态码|提取码|确认码|登录码|安全码|verification code|security code|one[- ]?time (?:code|password)|passcode|otp)[^A-Z0-9]{0,20}([A-Z0-9-]{4,10})/i,
  /([A-Z0-9-]{4,10})[^A-Z0-9]{0,20}(?:验证码|校验码|动态码|提取码|确认码|登录码|安全码|verification code|security code|one[- ]?time (?:code|password)|passcode|otp)/i,
  /\b(\d{4,8})\b/g,
];

function formatTemplateValue(value, channel) {
  if (channel === 'telegram') {
    return formatTelegramTemplateValue(value);
  }

  if (channel === 'wecom') {
    return formatWecomTemplateValue(value);
  }

  return String(value || '');
}

function formatQuotedTemplateValue(value, channel) {
  const formatted = formatTemplateValue(value, channel);
  if (channel !== 'wecom') {
    return formatted;
  }

  return String(formatted || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n> ');
}

function extractUrlsInOrder(text = '') {
  return Array.from(String(text || '').matchAll(URL_PATTERN))
    .map((match) => splitUrlSuffix(match[0]).url)
    .filter(Boolean);
}

function restoreTranslatedUrls(value = '', urls = []) {
  let index = 0;
  return String(value || '').replace(/\[(?:链接|链接已省略)\]/g, () => urls[index++] || '网址');
}

function messageBodyText(message = {}) {
  const textBody = String(message.textBody || '').trim();
  const htmlText = htmlBodyToText(message.htmlBody || '');
  const normalizedTextBody = paragraphizeNotificationText(textBody);
  if (htmlText && (!normalizedTextBody || htmlText.length > normalizedTextBody.length * 0.75)) {
    return htmlText;
  }

  return normalizedTextBody || htmlText || paragraphizeNotificationText(String(message.preview || '').trim());
}

function containsVerificationKeyword(text = '') {
  const normalized = String(text || '').toLowerCase();
  return VERIFICATION_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function detectMarketingMessage(message = {}, body = '') {
  const fromAddress = String(message.fromAddress || '').trim().toLowerCase();
  const fromName = String(message.fromName || '').trim().toLowerCase();
  const subject = String(message.subject || '').trim().toLowerCase();
  const combined = [subject, fromName, fromAddress, body]
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)
    .join('\n');

  if (!combined) {
    return false;
  }

  let score = 0;
  for (const keyword of MARKETING_KEYWORDS) {
    if (combined.includes(keyword)) {
      score += ['unsubscribe', '退订', 'newsletter', '订阅'].includes(keyword) ? 2 : 1;
    }
  }

  if (/(no-?reply|newsletter|marketing|promo|announcement)/i.test(fromAddress)) {
    score += 1;
  }

  if (String(body || '').trim().length >= 1200) {
    score += 1;
  }

  return score >= 2;
}

function detectJunkMessage(message = {}, body = '') {
  const folderKind = String(message.folderKind || '').trim().toLowerCase();
  if (folderKind === 'junk' || folderKind === 'trash') {
    return true;
  }

  const combined = [
    message.subject,
    message.fromName,
    message.fromAddress,
    body,
  ]
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)
    .join('\n');

  if (!combined) {
    return false;
  }

  return JUNK_KEYWORDS.some((keyword) => combined.includes(keyword));
}

function normalizeCategoryMatchText(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function countKeywordOccurrences(text = '', keyword = '') {
  const source = normalizeCategoryMatchText(text);
  const needle = normalizeCategoryMatchText(keyword);
  if (!source || !needle) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (offset < source.length) {
    const index = source.indexOf(needle, offset);
    if (index < 0) {
      break;
    }
    count += 1;
    offset = index + Math.max(needle.length, 1);
  }
  return count;
}

function scoreNotificationCategoryKeywords(text = '', keywords = [], weight = 1) {
  if (!text || !Array.isArray(keywords) || !keywords.length) {
    return 0;
  }

  return keywords.reduce((total, keyword) => {
    const hits = countKeywordOccurrences(text, keyword);
    return total + (hits * weight);
  }, 0);
}

function categoryTextBundle(message = {}, body = '') {
  const subject = normalizeCategoryMatchText(message.subject);
  const from = normalizeCategoryMatchText([message.fromName, message.fromAddress].filter(Boolean).join(' '));
  const preview = normalizeCategoryMatchText(message.preview);
  const textBody = normalizeCategoryMatchText(message.textBody);
  const htmlBody = normalizeCategoryMatchText(htmlBodyToText(message.htmlBody || ''));
  const bodyText = normalizeCategoryMatchText(body);
  const all = [subject, from, preview, bodyText, textBody, htmlBody]
    .filter(Boolean)
    .join('\n');

  return {
    all,
    bodyText,
    from,
    htmlBody,
    preview,
    subject,
    textBody,
  };
}

function scoreNotificationCategory(texts = {}, keywords = [], weights = {}) {
  return scoreNotificationCategoryKeywords(texts.subject, keywords, weights.subject ?? 5)
    + scoreNotificationCategoryKeywords(texts.from, keywords, weights.from ?? 2)
    + scoreNotificationCategoryKeywords(texts.preview, keywords, weights.preview ?? 3)
    + scoreNotificationCategoryKeywords(texts.bodyText, keywords, weights.body ?? 1)
    + scoreNotificationCategoryKeywords(texts.textBody, keywords, weights.textBody ?? 1)
    + scoreNotificationCategoryKeywords(texts.htmlBody, keywords, weights.htmlBody ?? 0.6);
}

function resolveNotificationMessageCategory(message = {}, body = '', verification = null) {
  const texts = categoryTextBundle(message, body);
  if (verification || containsVerificationKeyword(`${texts.subject}\n${texts.preview}\n${texts.bodyText}`)) {
    return 'verification';
  }

  const scores = {
    order: scoreNotificationCategory(texts, ORDER_KEYWORDS, {
      subject: 6,
      preview: 4,
      body: 1.3,
      textBody: 1,
      htmlBody: 0.7,
    }),
    subscription: scoreNotificationCategory(texts, SUBSCRIPTION_KEYWORDS, {
      subject: 6,
      preview: 4,
      body: 1.2,
      textBody: 1,
      htmlBody: 0.7,
    }),
    marketing: scoreNotificationCategory(texts, MARKETING_KEYWORDS, {
      subject: 4,
      from: 2,
      preview: 2,
      body: 0.8,
      textBody: 0.7,
      htmlBody: 0.5,
    }),
    junk: scoreNotificationCategory(texts, JUNK_KEYWORDS, {
      subject: 7,
      from: 3,
      preview: 4,
      body: 1,
      textBody: 1,
      htmlBody: 0.6,
    }),
  };

  if (detectJunkMessage(message, body)) {
    scores.junk += 7;
  }
  if (detectMarketingMessage(message, body)) {
    scores.marketing += 4;
  }
  if (/(订单号|订单编号|订单确认|order\s*(?:id|number|no\.?)|order confirmation|order confirmed|receipt|invoice|收据|发票)/iu.test(texts.all)) {
    scores.order += 7;
  }
  if (/(物流|运单|tracking|shipment|shipping|delivery|发货|已发货|配送|签收)/iu.test(texts.all)) {
    scores.order += 4;
  }
  if (/(订阅|subscription|renewal|auto[- ]?renew|续费|会员|服务到期|billing cycle|trial ending|订阅即将到期|会员到期)/iu.test(texts.all)) {
    scores.subscription += 6;
  }
  if (/(unsubscribe|退订|取消订阅|manage preferences|email preferences|view in browser|在浏览器中查看)/iu.test(texts.all)) {
    scores.marketing += 4;
  }
  if (/(x-spam|spam score|phishing|scam|fraud|钓鱼|诈骗|垃圾邮件)/iu.test(texts.all)) {
    scores.junk += 6;
  }

  const folderKind = String(message.folderKind || '').trim().toLowerCase();
  if (folderKind === 'junk') {
    return 'junk';
  }

  const candidates = ['order', 'subscription', 'junk', 'marketing']
    .map((category) => ({ category, score: scores[category] || 0 }))
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const second = candidates[1];
  if (!best || best.score < 4) {
    return 'standard';
  }
  if (second && best.score - second.score < 2) {
    return 'standard';
  }
  if (best.category === 'marketing' && best.score < 6) {
    return 'standard';
  }
  if (best.category === 'junk' && best.score < 6) {
    return 'standard';
  }

  return best.category;
}

const NOTIFICATION_IMPORTANT_FACT_PATTERNS = Object.freeze({
  order: [
    /(?:订单号|订单编号|订单|order(?:\s*(?:id|number|no\.?))?)[^A-Z0-9]{0,12}([A-Z0-9-]{5,32})/i,
  ],
  amount: [
    /((?:USD|CNY|RMB|EUR|GBP|HKD|JPY|\$|¥|￥|€|£)\s?\d[\d,]*(?:\.\d{1,2})?)/i,
    /(\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|CNY|RMB|EUR|GBP|HKD|JPY|元|美元|人民币|欧元|英镑))/i,
  ],
  time: [
    /((?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?))/i,
    /((?:\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?))/i,
  ],
});

const MARKETING_FILTER_KEYWORDS = [
  'unsubscribe',
  'manage preferences',
  'view in browser',
  'privacy policy',
  'terms of service',
  'copyright',
  'all rights reserved',
  '退订',
  '取消订阅',
  '隐私政策',
  '服务条款',
  '在浏览器中查看',
];

function collectImportantFacts(body = '', options = {}) {
  const normalizedBody = String(body || '').trim();
  if (!normalizedBody) {
    return [];
  }

  const facts = [];
  const pushFact = (label, value) => {
    const normalizedValue = normalizeNotificationText(value);
    if (!normalizedValue) {
      return;
    }
    const entry = `${label}：${normalizedValue}`;
    if (!facts.includes(entry)) {
      facts.push(entry);
    }
  };

  if (options.verificationCode) {
    pushFact('验证码', options.verificationCode);
  }

  for (const pattern of NOTIFICATION_IMPORTANT_FACT_PATTERNS.order) {
    const match = normalizedBody.match(pattern);
    if (match?.[1]) {
      pushFact('订单号', match[1]);
      break;
    }
  }

  for (const pattern of NOTIFICATION_IMPORTANT_FACT_PATTERNS.amount) {
    const match = normalizedBody.match(pattern);
    if (match?.[1]) {
      pushFact('金额', match[1]);
      break;
    }
  }

  for (const pattern of NOTIFICATION_IMPORTANT_FACT_PATTERNS.time) {
    const match = normalizedBody.match(pattern);
    if (match?.[1]) {
      pushFact('时间', match[1]);
      break;
    }
  }

  return facts.slice(0, 4);
}

function splitNotificationParagraphs(text = '') {
  return paragraphizeNotificationText(text, {
    sentenceGroupSoftLimit: 72,
    sentenceGroupHardLimit: 118,
  })
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function countChineseCharacters(text = '') {
  return (String(text || '').match(/[\u4e00-\u9fff]/gu) || []).length;
}

function stripNotificationSummaryArtifacts(text = '') {
  return String(text || '')
    .replace(/\[\[([^\]]+)\]\]\((https?:\/\/[^)\s]+)\)/gi, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, '$1')
    .replace(URL_PATTERN, ' ')
    .replace(/\bwww\.[^\s<>"'）】]+/gi, ' ')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, ' ')
    .replace(/\b(?:cid|data):[^\s]+/gi, ' ')
    .replace(/\b\S+\.(?:png|jpg|jpeg|gif|webp|svg|css|js)\b/gi, ' ')
    .replace(/\b[A-Za-z0-9][A-Za-z0-9_:/?&=%#+.,-]{24,}\b/g, ' ')
    .replace(/\[\[(?:图片|image|网址|链接|link|url)\]\]/gi, ' ')
    .replace(/\[(?:图片|image|网址|链接|link|url)\]/gi, ' ')
    .replace(/(?:^|[\s(])(?:class|style|font-family|line-height|background(?:-color)?|padding|margin|border|width|height)\s*[:=][^\s]+/gi, ' ')
    .replace(/[<>{}\[\]]/g, ' ')
    .replace(/[_=~]{3,}/g, ' ')
    .replace(/[|]{2,}/g, ' ');
}

function cleanNotificationSummaryText(text = '') {
  return normalizeNotificationText(stripNotificationSummaryArtifacts(text));
}

function isLowValueSummaryParagraph(paragraph = '') {
  const text = cleanNotificationSummaryText(paragraph);
  if (!text) {
    return true;
  }

  const lower = text.toLowerCase();
  if (text.length < 8) {
    return true;
  }

  if (MARKETING_FILTER_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    return true;
  }

  if (
    /(click\?|upn=|oaistatic|utm_|javascript:|display\s*:\s*none|font-family|all rights reserved|privacy policy|terms of service|view in browser|mailto:)/i.test(lower)
  ) {
    return true;
  }

  if (/\b(?:https?|www)\b/i.test(lower) || /(?:^|[\s.])(?:com|net|org|cn|io)\//i.test(lower)) {
    return true;
  }

  if (
    /[A-Za-z0-9_-]{20,}/.test(text)
    && countChineseCharacters(text) < 2
    && !/[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(text)
  ) {
    return true;
  }

  const compact = text.replace(/[\s.-]/g, '');
  if (compact.length >= 36 && /^[a-z0-9_%/=+:-]+$/i.test(compact)) {
    return true;
  }

  return /^(?:图片|image|link|url|网址|链接)$/i.test(text);
}

function collectNotificationSummaryParagraphs(body = '', options = {}) {
  const paragraphLimit = Math.max(
    1,
    Number(options.maxParagraphs)
      || (options.verificationCode ? 2 : options.isMarketing ? 2 : 3),
  );
  const clipLimit = Math.max(48, Number(options.clipLimit) || (options.verificationCode ? 84 : 118));
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (value) => {
    const clipped = clipText(cleanNotificationSummaryText(value), clipLimit, { showIndicator: false });
    const normalized = normalizeNotificationText(clipped);
    if (!normalized || isLowValueSummaryParagraph(normalized)) {
      return;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    candidates.push({
      text: normalized,
      chineseCount: countChineseCharacters(normalized),
    });
  };

  splitNotificationParagraphs(body).forEach(pushCandidate);

  if (!candidates.length) {
    splitSentenceLikeSegments(cleanNotificationSummaryText(body)).forEach(pushCandidate);
  }

  const preferred = candidates.filter((item) => item.chineseCount >= 2);
  return (preferred.length ? preferred : candidates)
    .slice(0, paragraphLimit)
    .map((item) => item.text);
}

function detectStructuredSummaryKind(content = {}, facts = []) {
  const factLabels = facts.map((item) => String(item || '').split(/[:：]/u)[0].trim());
  if (String(content.category || '').trim() === 'verification' || factLabels.includes('验证码')) {
    return 'verification';
  }

  const combined = [
    content.subject,
    content.summary,
    content.fullBody,
  ]
    .map((item) => String(item || '').toLowerCase())
    .join('\n');

  const hasOrderFact = factLabels.includes('订单号');
  const hasAmountFact = factLabels.includes('金额');
  const paymentMatched = /(支付|付款|扣款|退款|账单|发票|pay(?:ment)?|charged|invoice|receipt|billing|refund)/i.test(combined);
  const orderMatched = /(订单|下单|发货|物流|运单|order|shipment|tracking|delivery)/i.test(combined);

  if (hasAmountFact && paymentMatched) {
    return 'payment';
  }
  if (hasOrderFact || orderMatched) {
    return 'order';
  }
  if (String(content.category || '').trim() === 'order') {
    return 'order';
  }
  if (String(content.category || '').trim() === 'subscription') {
    return 'subscription';
  }
  if (String(content.category || '').trim() === 'marketing') {
    return 'marketing';
  }
  return 'standard';
}

function normalizeVerificationCandidate(value = '') {
  const normalized = String(value || '')
    .trim()
    .replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gi, '')
    .replace(/\s+/g, '');

  if (!/^[A-Z0-9-]{4,10}$/i.test(normalized)) {
    return '';
  }

  return normalized.toUpperCase();
}

const VERIFICATION_STOPWORDS_V2 = new Set([
  'YOUR',
  'CODE',
  'PASSCODE',
  'OTP',
  'LOGIN',
  'VERIFY',
  'VERIFICATION',
  'SECURITY',
]);

function extractVerificationCodeV2(message = {}) {
  const subject = String(message.subject || '').trim();
  const body = messageBodyText(message);
  const combined = [subject, body].filter(Boolean).join('\n');
  if (!combined) {
    return null;
  }

  const keywordMatched = containsVerificationKeyword(combined);
  for (let patternIndex = 0; patternIndex < VERIFICATION_PATTERNS.length; patternIndex += 1) {
    const pattern = VERIFICATION_PATTERNS[patternIndex];
    if (!keywordMatched && patternIndex === VERIFICATION_PATTERNS.length - 1) {
      continue;
    }

    const matches = pattern.global ? combined.matchAll(pattern) : [combined.match(pattern)].filter(Boolean);
    for (const match of matches) {
      const candidate = normalizeVerificationCandidate(match?.[1] || match?.[0] || '');
      if (!candidate) {
        continue;
      }

      if (!keywordMatched && !/^\d{4,8}$/.test(candidate)) {
        continue;
      }

      if (!keywordMatched && /^\d{4,8}$/.test(candidate) && candidate.startsWith('20')) {
        continue;
      }

      if (VERIFICATION_STOPWORDS_V2.has(candidate)) {
        continue;
      }

      return {
        code: candidate,
        keywordMatched,
      };
    }
  }

  return null;
}

function buildTranslationFallbackNote(channel) {
  const note = '提示：自动翻译失败，本次已回退原文。';
  if (channel === 'telegram') {
    return `\n\n<i>${note}</i>`;
  }

  if (channel === 'wecom') {
    return `\n\n> ${note}`;
  }

  return `\n\n${note}`;
}

function getMessageMeta(mailbox, message) {
  return {
    subject: String(message.subject || '(无主题)'),
    from: String(message.fromName || message.fromAddress || '未知发件人'),
    mailboxEmail: String(mailbox.email || ''),
    receivedAt: formatTimestamp(message.receivedAt),
  };
}

function getTemplatePreset(presetId) {
  const preset = TEMPLATE_PRESETS.find((item) => item.id === presetId) || TEMPLATE_PRESETS[0];
  if (!preset || preset.id !== 'default') {
    return preset;
  }

  return {
    ...preset,
    name: '默认清爽',
    description: '结构清楚、留白稳定，适合长期作为默认通知模板。',
    templates: {
      ...preset.templates,
      telegram:
        '<b>📬 新邮件通知</b>\n<b>主题</b>：{subject}\n<b>发件人</b>：{from}\n<b>收件邮箱</b>：{mailbox}\n<b>接收时间</b>：{time}\n\n<b>邮件正文</b>\n<blockquote>{summary}</blockquote>',
      wecom:
        '# 📬 新邮件通知\n> 主题：<font color="info">{subject}</font>\n> 发件人：{from}\n> 收件邮箱：{mailbox}\n> 接收时间：{time}\n>\n> 正文摘要\n> {summary}',
      feishu:
        '📬 新邮件通知\n主题：{subject}\n发件人：{from}\n收件邮箱：{mailbox}\n接收时间：{time}\n\n正文摘要\n{summary}',
    },
  };
}

function sanitizeTemplateText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').slice(0, TEMPLATE_TEXT_MAX_LENGTH);
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return Boolean(fallback);
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return Boolean(fallback);
}

function notificationCoverCategoryLabel(category = 'standard') {
  if (category === 'verification') return '验证码邮件';
  if (category === 'order') return '订单通知';
  if (category === 'subscription') return '订阅提醒';
  if (category === 'marketing') return '广告邮件';
  if (category === 'junk') return '垃圾邮件';
  return '普通邮件';
}

function normalizeTemplateCoverMode(value, fallback = 'builtin') {
  const normalized = String(value || fallback || 'builtin').trim().toLowerCase();
  if (normalized === 'auto') {
    return 'builtin';
  }

  const resolvedFallback = String(fallback || 'builtin').trim().toLowerCase() === 'auto'
    ? 'builtin'
    : String(fallback || 'builtin').trim().toLowerCase();
  return NOTIFICATION_COVER_MODES.includes(normalized)
    ? normalized
    : NOTIFICATION_COVER_MODES.includes(resolvedFallback)
      ? resolvedFallback
      : 'builtin';
}

function normalizeTemplateCoverChannelMode(value, fallback = 'cover') {
  const normalized = String(value || fallback || 'cover').trim().toLowerCase();
  return NOTIFICATION_COVER_DELIVERY_MODES.includes(normalized) ? normalized : 'cover';
}

function normalizeTemplateCoverChannelId(channel = 'telegram') {
  const normalized = String(channel || '').trim();
  return NOTIFICATION_COVER_CHANNELS.includes(normalized) ? normalized : 'telegram';
}

function normalizeHttpAssetUrl(value, fallback = '') {
  const text = String(value || fallback || '').trim();
  if (!text) {
    return '';
  }

  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }

    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function assetContentTypeFromPath(filePath = '') {
  const extension = path.extname(String(filePath || '')).trim().toLowerCase();
  if (['.jpg', '.jpeg'].includes(extension)) return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function resolveStoredAssetMetadata(relativePath = '') {
  const assetPath = String(relativePath || '').trim().replace(/\\/g, '/');
  if (!assetPath) {
    return {
      assetPath: '',
      assetUrl: '',
      assetLocalPath: '',
      contentType: '',
    };
  }

  const builtinAsset = resolveBuiltinNotificationCoverAssetByPath(assetPath);
  if (builtinAsset) {
    return builtinAsset;
  }

  let assetLocalPath = '';
  try {
    assetLocalPath = path.resolve(STORAGE_ROOT, assetPath);
  } catch (_) {
    assetLocalPath = '';
  }

  return {
    assetPath,
    assetUrl: publicAssetPath(assetPath),
    assetLocalPath,
    contentType: assetContentTypeFromPath(assetPath),
  };
}

function normalizeTemplateCoverConfig(input = {}, fallback = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const fallbackConfig = fallback && typeof fallback === 'object' ? fallback : {};
  const assetMeta = resolveStoredAssetMetadata(
    Object.prototype.hasOwnProperty.call(source, 'assetPath')
      ? source.assetPath
      : fallbackConfig.assetPath || '',
  );

  return {
    ...createDefaultTemplateCoverConfig(),
    mode: normalizeTemplateCoverMode(source.mode, fallbackConfig.mode || 'builtin'),
    url: Object.prototype.hasOwnProperty.call(source, 'url')
      ? normalizeHttpAssetUrl(source.url)
      : normalizeHttpAssetUrl(fallbackConfig.url),
    assetPath: assetMeta.assetPath,
    assetUrl: assetMeta.assetUrl,
    assetLocalPath: assetMeta.assetLocalPath,
    contentType: assetMeta.contentType,
    uploadFilename: String(
      Object.prototype.hasOwnProperty.call(source, 'uploadFilename')
        ? source.uploadFilename
        : fallbackConfig.uploadFilename || '',
    ).trim(),
    uploadDataUrl: String(source.uploadDataUrl || '').trim(),
  };
}

function normalizeTemplateOptions(input = {}, fallback = {}) {
  const normalizedFallback =
    fallback && typeof fallback === 'object' ? fallback : DEFAULT_TEMPLATE_OPTIONS;
  const inputCovers = input?.covers && typeof input.covers === 'object' ? input.covers : {};
  const inputCoverChannels =
    input?.coverChannels && typeof input.coverChannels === 'object' ? input.coverChannels : {};
  const fallbackCovers =
    normalizedFallback?.covers && typeof normalizedFallback.covers === 'object'
      ? normalizedFallback.covers
      : DEFAULT_TEMPLATE_OPTIONS.covers;
  const fallbackCoverChannels =
    normalizedFallback?.coverChannels && typeof normalizedFallback.coverChannels === 'object'
      ? normalizedFallback.coverChannels
      : DEFAULT_TEMPLATE_OPTIONS.coverChannels;
  const covers = {};
  const coverChannels = {};

  for (const category of NOTIFICATION_COVER_CATEGORIES) {
    covers[category] = normalizeTemplateCoverConfig(inputCovers[category], fallbackCovers[category]);
  }

  for (const channel of NOTIFICATION_COVER_CHANNELS) {
    coverChannels[channel] = normalizeTemplateCoverChannelMode(
      inputCoverChannels[channel],
      fallbackCoverChannels[channel],
    );
  }

  return {
    translateToChinese: normalizeBoolean(
      input.translateToChinese,
      normalizedFallback.translateToChinese ?? DEFAULT_TEMPLATE_OPTIONS.translateToChinese,
    ),
    previewBaseUrl: normalizeUrl(
      input.previewBaseUrl,
      normalizedFallback.previewBaseUrl ?? process.env.PUBLIC_BASE_URL ?? DEFAULT_TEMPLATE_OPTIONS.previewBaseUrl,
    ),
    coverEnabled: normalizeBoolean(
      input.coverEnabled,
      normalizedFallback.coverEnabled ?? DEFAULT_TEMPLATE_OPTIONS.coverEnabled,
    ),
    coverChannels,
    covers,
  };
}

function readTemplateConfig(target) {
  const config = target?.config || {};
  const presetId = getTemplatePreset(String(config.presetId || DEFAULT_TEMPLATE_PRESET_ID).trim()).id;
  const templates = {};
  const options = normalizeTemplateOptions(config.options || {});

  for (const channel of DELIVERY_CHANNELS) {
    templates[channel] = sanitizeTemplateText(config.templates?.[channel] || config[channel] || '');
  }

  return { presetId, templates, options };
}

function getTemplateSetting(target) {
  const { presetId, templates, options } = readTemplateConfig(target);

  return {
    channel: 'template',
    presetId,
    templates,
    options,
    presets: TEMPLATE_PRESETS.map((preset) => {
      const resolvedPreset = getTemplatePreset(preset.id);
      return {
        id: resolvedPreset.id,
        name: resolvedPreset.name,
        accent: resolvedPreset.accent,
        description: resolvedPreset.description,
        templates: resolvedPreset.templates,
      };
    }),
    tokens: TEMPLATE_TOKENS,
    sample: TEMPLATE_SAMPLE,
  };
}

function clipInlineText(text = '', maxLength = 60) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) {
    return '';
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(maxLength - 1, 0)).trimEnd()}…`;
}

async function ensureNotificationCoverDeliveryAsset(relativePath = '', category = 'standard') {
  const assetMeta = resolveStoredAssetMetadata(relativePath);
  if (
    !assetMeta.assetPath ||
    assetMeta.contentType !== 'image/svg+xml' ||
    !sharp ||
    !assetMeta.assetLocalPath ||
    !fs.existsSync(assetMeta.assetLocalPath)
  ) {
    return assetMeta;
  }

  try {
    const pngBuffer = await sharp(assetMeta.assetLocalPath)
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    const rasterAsset = writeBufferAsset(pngBuffer, {
      category: 'images',
      filename: `${category}-cover.png`,
      contentType: 'image/png',
      prefix: `notification-cover-${category}`,
      key: assetMeta.assetPath,
    });
    return resolveStoredAssetMetadata(rasterAsset.relativePath);
  } catch (_) {
    return assetMeta;
  }
}

async function prepareNotificationCoverConfig(category, input = {}, fallback = {}) {
  const normalized = normalizeTemplateCoverConfig(input, fallback);
  const previous = normalizeTemplateCoverConfig({}, fallback);
  const label = notificationCoverCategoryLabel(category);
  const builtinAsset = resolveBuiltinNotificationCoverAsset(category);

  if (normalized.mode === 'builtin') {
    normalized.url = '';
    normalized.assetPath = builtinAsset?.assetPath || '';
    normalized.assetUrl = builtinAsset?.assetUrl || '';
    normalized.assetLocalPath = builtinAsset?.assetLocalPath || '';
    normalized.contentType = builtinAsset?.contentType || 'image/png';
    normalized.uploadFilename = '';
    normalized.uploadDataUrl = '';
  }

  if (normalized.mode === 'none') {
    normalized.url = '';
    normalized.assetPath = '';
    normalized.assetUrl = '';
    normalized.assetLocalPath = '';
    normalized.contentType = '';
    normalized.uploadFilename = '';
    normalized.uploadDataUrl = '';
  }

  if (normalized.mode === 'url') {
    if (!normalized.url) {
      throw new Error(`${label}封面的图片直链不能为空。`);
    }

    const shouldRefreshAsset = normalized.url !== previous.url || !previous.assetPath;
    if (shouldRefreshAsset) {
      try {
        const downloaded = await downloadAssetFromUrl(normalized.url, {
          category: 'images',
          filename: normalized.uploadFilename || `${category}-cover`,
          prefix: `notification-cover-${category}`,
        });
        const assetMeta = await ensureNotificationCoverDeliveryAsset(downloaded.relativePath, category);
        normalized.assetPath = assetMeta.assetPath;
        normalized.assetUrl = assetMeta.assetUrl;
        normalized.assetLocalPath = assetMeta.assetLocalPath;
        normalized.contentType = assetMeta.contentType || downloaded.contentType;
      } catch (error) {
        throw new Error(`${label}封面图片下载失败：${String(error.message || error)}`);
      }
    }
  }

  if (normalized.mode === 'upload') {
    const hasExistingUploadedAsset =
      previous.mode === 'upload'
      && Boolean(previous.assetPath)
      && !isBuiltinNotificationCoverAssetPath(previous.assetPath);
    if (normalized.uploadDataUrl) {
      try {
        const uploaded = writeDataUrlAsset(normalized.uploadDataUrl, {
          category: 'images',
          filename: normalized.uploadFilename || `${category}-cover`,
          prefix: `notification-cover-${category}`,
        });
        const assetMeta = await ensureNotificationCoverDeliveryAsset(uploaded.relativePath, category);
        normalized.assetPath = assetMeta.assetPath;
        normalized.assetUrl = assetMeta.assetUrl;
        normalized.assetLocalPath = assetMeta.assetLocalPath;
        normalized.contentType = assetMeta.contentType || uploaded.contentType;
      } catch (error) {
        throw new Error(`${label}封面上传失败：${String(error.message || error)}`);
      }
    } else if (!normalized.assetPath || !hasExistingUploadedAsset || normalized.assetPath !== previous.assetPath) {
      throw new Error(`${label}当前使用“本地上传”模式，请先选择一张图片再保存。`);
    }
  }

  return {
    mode: normalized.mode,
    url: normalized.url,
    assetPath: normalized.assetPath,
    uploadFilename: normalized.uploadFilename,
  };
}

async function prepareNotificationTemplateOptions(input = {}, fallback = {}) {
  const normalized = normalizeTemplateOptions(input, fallback);
  const inputCovers = input?.covers && typeof input.covers === 'object' ? input.covers : {};
  const fallbackOptions = normalizeTemplateOptions({}, fallback);
  const covers = {};

  for (const category of NOTIFICATION_COVER_CATEGORIES) {
    covers[category] = await prepareNotificationCoverConfig(
      category,
      inputCovers[category],
      fallbackOptions.covers?.[category],
    );
  }

  return {
    translateToChinese: normalized.translateToChinese,
    previewBaseUrl: normalized.previewBaseUrl,
    coverEnabled: normalized.coverEnabled,
    coverChannels: normalized.coverChannels,
    covers,
  };
}

function resolveNotificationCoverChannelMode(options = {}, channel = 'telegram') {
  const normalizedOptions = normalizeTemplateOptions(options);
  const normalizedChannel = normalizeTemplateCoverChannelId(channel);
  return normalizeTemplateCoverChannelMode(
    normalizedOptions.coverChannels?.[normalizedChannel],
    DEFAULT_TEMPLATE_OPTIONS.coverChannels[normalizedChannel],
  );
}

function shouldUseNotificationCover(options = {}, channel = 'telegram') {
  const normalizedOptions = normalizeTemplateOptions(options);
  if (!normalizedOptions.coverEnabled) {
    return false;
  }

  return resolveNotificationCoverChannelMode(normalizedOptions, channel) === 'cover';
}

function resolveTemplateCoverConfigForCategory(options = {}, category = 'standard') {
  const normalizedOptions = normalizeTemplateOptions(options);
  const normalizedCategory = NOTIFICATION_COVER_CATEGORIES.includes(String(category || '').trim())
    ? String(category || '').trim()
    : 'standard';
  return normalizedOptions.covers?.[normalizedCategory] || normalizedOptions.covers.standard;
}

async function resolveNotificationCover(options = {}, mailbox, message, content = {}, context = {}) {
  const normalizedOptions = normalizeTemplateOptions(options);
  if (!normalizedOptions.coverEnabled) {
    return null;
  }

  const category = NOTIFICATION_COVER_CATEGORIES.includes(String(content.category || '').trim())
    ? String(content.category || '').trim()
    : 'standard';
  const coverConfig = resolveTemplateCoverConfigForCategory(normalizedOptions, category);
  if (!coverConfig || coverConfig.mode === 'none') {
    return null;
  }

  let assetMeta = resolveStoredAssetMetadata(coverConfig.assetPath);
  assetMeta = await ensureNotificationCoverDeliveryAsset(assetMeta.assetPath, category);

  const previewBaseUrl = normalizeUrl(context.previewBaseUrl || normalizedOptions.previewBaseUrl || '');
  const publicUrl =
    assetMeta.assetUrl && previewBaseUrl && assetMeta.assetUrl.startsWith('/')
      ? `${previewBaseUrl}${assetMeta.assetUrl}`
      : /^https?:\/\//i.test(String(assetMeta.assetUrl || '').trim())
        ? String(assetMeta.assetUrl || '').trim()
        : coverConfig.mode === 'url'
          ? coverConfig.url
          : '';

  return {
    category,
    mode: coverConfig.mode,
    title: clipInlineText(content.subject || '邮件通知', 48),
    localFilePath: assetMeta.assetLocalPath,
    publicUrl,
    sourceUrl: coverConfig.url,
    assetPath: assetMeta.assetPath,
    contentType: assetMeta.contentType,
  };
}

function buildTemplateTokens(mailbox, message, channel, content = null) {
  const meta = getMessageMeta(mailbox, message);
  const summaryLimit = channel === 'telegram' ? TELEGRAM_SUMMARY_LIMIT : channel === 'wecom' ? 1200 : 1600;
  const fallbackSummary = '暂无正文摘要';
  const resolvedContent = content || {
    subject: meta.subject,
    from: meta.from,
    mailbox: meta.mailboxEmail,
    time: meta.receivedAt,
    summary: formatBodyPreview(message, summaryLimit) || fallbackSummary,
    fullBody: messageBodyText(message),
    summaryOnly: true,
  };
  const summaryText =
    renderStructuredSummaryForChannel(channel, resolvedContent) ||
    formatTemplateValue(resolvedContent.summary || fallbackSummary, channel);

  return {
    subject: formatTemplateValue(resolvedContent.subject || meta.subject, channel),
    from: formatTemplateValue(resolvedContent.from || meta.from, channel),
    mailbox: formatTemplateValue(resolvedContent.mailbox || meta.mailboxEmail, channel),
    time: formatTemplateValue(resolvedContent.time || meta.receivedAt, channel),
    summary:
      channel === 'wecom'
        ? formatQuotedTemplateValue(summaryText, channel)
        : summaryText,
  };
}

function renderTemplateText(template, mailbox, message, channel, content = null) {
  const tokens = buildTemplateTokens(mailbox, message, channel, content);
  if (content) {
    tokens.summary = renderStructuredSummaryForChannel(channel, content) || tokens.summary;
  }
  return String(template || '').replace(
    /\{(subject|from|mailbox|time|summary)\}/g,
    (_, key) => tokens[key] ?? '',
  );
}

function parseFeishuSecretBundle(secretEncrypted) {
  const raw = safeDecrypt(secretEncrypted);
  if (!raw) {
    return {
      webhookUrl: '',
      signSecret: '',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      webhookUrl: String(parsed?.webhookUrl || '').trim(),
      signSecret: String(parsed?.signSecret || '').trim(),
    };
  } catch (_) {
    return {
      webhookUrl: raw.trim(),
      signSecret: '',
    };
  }
}

function buildFeishuSecretBundle(input) {
  const webhookUrl = String(input.webhookUrl || '').trim();
  const signSecret = String(input.signSecret || '').trim();
  if (!webhookUrl && !signSecret) {
    return undefined;
  }

  return encrypt(
    JSON.stringify({
      webhookUrl,
      signSecret,
    }),
  );
}

async function readResponsePayload(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return { message: text };
  }
}

function getTelegramConfig(target) {
  return {
    token: safeDecrypt(target?.secretEncrypted),
    chatId: String(target?.config?.chatId || '').trim(),
    apiBaseUrl: normalizeUrl(
      target?.config?.apiBaseUrl,
      process.env.TELEGRAM_API_BASE_URL || TELEGRAM_API_BASE_URL,
    ),
    proxyUrl: String(target?.config?.proxyUrl || '').trim(),
  };
}

function getTelegramProxyUrls(target) {
  return uniqueStrings([
    target?.config?.proxyUrl,
    process.env.TELEGRAM_PROXY_URL,
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY,
    ...TELEGRAM_COMMON_PROXY_URLS,
  ]);
}

function getProxyAgent(proxyUrl) {
  if (!proxyAgentCache.has(proxyUrl)) {
    proxyAgentCache.set(proxyUrl, new ProxyAgent(proxyUrl));
  }

  return proxyAgentCache.get(proxyUrl);
}

function isRetryableTelegramNetworkError(error) {
  const code = String(error?.code || error?.cause?.code || '').trim();
  return [
    'UND_ERR_CONNECT_TIMEOUT',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENETUNREACH',
    'EHOSTUNREACH',
  ].includes(code);
}

function formatTelegramNetworkError(error, proxyUrls) {
  const details = String(error?.cause?.message || error?.message || error || '').trim();
  const triedProxyText = proxyUrls.length ? ` Tried proxies: ${proxyUrls.join(', ')}.` : '';
  return `Telegram API connection failed. Please confirm the network or proxy can reach api.telegram.org.${triedProxyText}${details ? ` Details: ${details}` : ''}`;
}

async function requestTelegram(url, payload, proxyUrls, requestOptions = {}) {
  const attempts = [...proxyUrls.map((proxyUrl) => ({ proxyUrl })), { proxyUrl: '' }];
  let lastNetworkError = null;

  for (const attempt of attempts) {
    try {
      const headers = {
        ...(requestOptions.headers || {}),
      };
      const body = requestOptions.body !== undefined ? requestOptions.body : JSON.stringify(payload);
      if (
        requestOptions.body === undefined &&
        !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
      ) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await undiciFetch(url, {
        method: requestOptions.method || 'POST',
        headers,
        body,
        dispatcher: attempt.proxyUrl ? getProxyAgent(attempt.proxyUrl) : undefined,
        headersTimeout: 10000,
        bodyTimeout: 10000,
      });

      const responsePayload = await readResponsePayload(response);
      if (!response.ok || responsePayload.ok !== true) {
        throw new Error(responsePayload.description || responsePayload.message || 'Telegram notification failed.');
      }

      return responsePayload;
    } catch (error) {
      if (!isRetryableTelegramNetworkError(error)) {
        throw error;
      }

      lastNetworkError = error;
    }
  }

  throw new Error(formatTelegramNetworkError(lastNetworkError, proxyUrls));
}

function resolveNotificationPreviewBaseUrl(templateTarget, fallback = '') {
  const options = readTemplateConfig(templateTarget).options || {};
  return normalizeUrl(options.previewBaseUrl || fallback || process.env.PUBLIC_BASE_URL || '');
}

function buildPreviewAccessPayload(mailbox, message, channel = '') {
  const messageId = String(message?.id || '').trim();
  const ownerUserId = String(message?.ownerUserId || mailbox?.ownerUserId || '').trim();
  if (!messageId || !ownerUserId) {
    return null;
  }

  return {
    type: 'mail-preview',
    channel: String(channel || '').trim(),
    messageId,
    userId: ownerUserId,
    expiresAt: Date.now() + WECOM_PREVIEW_TOKEN_TTL_MS,
  };
}

function buildPreviewEntryToken(accessPayload) {
  if (!accessPayload) {
    return '';
  }

  return createSignedToken({
    m: String(accessPayload.messageId || '').trim(),
    u: String(accessPayload.userId || '').trim(),
    e: Number(accessPayload.expiresAt || 0),
    c: String(accessPayload.channel || '').trim(),
  });
}

function buildNotificationPreviewUrl(baseUrl, mailbox, message, channel = '') {
  const resolvedBaseUrl = normalizeUrl(baseUrl || process.env.PUBLIC_BASE_URL || '');
  if (!resolvedBaseUrl) {
    return '';
  }

  const accessPayload = buildPreviewAccessPayload(mailbox, message, channel);
  if (!accessPayload) {
    return '';
  }

  const entryToken = buildPreviewEntryToken(accessPayload);
  if (!entryToken) {
    return '';
  }

  return `${resolvedBaseUrl}/m/${encodeURIComponent(entryToken)}`;
}

async function buildNotificationSummaryBundle(channel, templateTarget, mailbox, message, options = {}) {
  const templateConfig = readTemplateConfig(templateTarget);
  const content = await buildNotificationContentV2(mailbox, message, channel, templateConfig.options);
  const previewBaseUrl = resolveNotificationPreviewBaseUrl(templateTarget, options.previewBaseUrl || '');
  const previewUrl = buildNotificationPreviewUrl(
    previewBaseUrl,
    mailbox,
    message,
    channel,
  );
  return {
    content,
    options: templateConfig.options,
    previewBaseUrl,
    previewUrl,
    cover: options.includeCover
      ? await resolveNotificationCover(templateConfig.options, mailbox, message, content, {
          previewBaseUrl,
        })
      : null,
  };
}

function appendPreviewLinkToTemplateMessage(channel, rendered = '', previewUrl = '') {
  const text = String(rendered || '').trim();
  const url = String(previewUrl || '').trim();
  if (!text || !url) {
    return text;
  }

  if (channel === 'wecom') {
    return `${text}\n>\n> [查看完整内容](${url})`;
  }

  return text;
}

function renderChannelTemplateMessage(channel, templateTarget, mailbox, message, content = {}, previewUrl = '') {
  const { presetId, templates } = readTemplateConfig(templateTarget);

  const preset = getTemplatePreset(presetId);
  const customTemplate = String(templates[channel] || '');
  const sourceTemplate = customTemplate.trim() ? customTemplate : String(preset.templates?.[channel] || '');
  let rendered = renderTemplateText(sourceTemplate, mailbox, message, channel, content);

  rendered = appendPreviewLinkToTemplateMessage(channel, rendered, previewUrl);

  if (content.translationFailed) {
    rendered += buildTranslationFallbackNote(channel);
  }

  if (channel === 'telegram') {
    return clipTelegramHtml(rendered, TELEGRAM_TEXT_LIMIT);
  }

  if (channel === 'wecom') {
    return finalizeWecomMarkdown(clipText(rendered, WECOM_TEXT_LIMIT));
  }

  return clipText(rendered, FEISHU_TEXT_LIMIT);
}

function renderChannelTemplateMessageRaw(channel, templateTarget, mailbox, message, content = {}, previewUrl = '') {
  const { presetId, templates } = readTemplateConfig(templateTarget);

  const preset = getTemplatePreset(presetId);
  const customTemplate = String(templates[channel] || '');
  const sourceTemplate = customTemplate.trim() ? customTemplate : String(preset.templates?.[channel] || '');
  let rendered = renderTemplateText(sourceTemplate, mailbox, message, channel, content);

  rendered = appendPreviewLinkToTemplateMessage(channel, rendered, previewUrl);

  if (content.translationFailed) {
    rendered += buildTranslationFallbackNote(channel);
  }

  if (channel === 'telegram') {
    return clipTelegramHtml(rendered, TELEGRAM_TEXT_LIMIT);
  }

  if (channel === 'wecom') {
    return clipText(rendered, WECOM_TEXT_LIMIT);
  }

  return clipText(rendered, FEISHU_TEXT_LIMIT);
}

function stripNoisySummaryArtifacts(text = '') {
  return cleanNotificationSummaryText(text);
}

function buildCleanSummaryParagraphs(content = {}) {
  const sourceText = Array.isArray(content.summaryParagraphs) && content.summaryParagraphs.length
    ? content.summaryParagraphs.join('\n\n')
    : String(content.summary || '');

  return collectNotificationSummaryParagraphs(sourceText, {
    verificationCode: String(content.verificationCode || '').trim(),
    isMarketing: String(content.category || '').trim() === 'marketing',
    maxParagraphs: 3,
    clipLimit: 118,
  });
}

function buildFeishuSummaryCard(content = {}, previewUrl = '', renderedText = '') {
  const summary = clipText(String(renderedText || content.summary || '暂无摘要'), 420, { showIndicator: true });
  const card = {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: content.verificationCode ? 'orange' : 'turquoise',
      title: {
        tag: 'plain_text',
        content: clipText(content.subject || '邮件摘要', 90, { showIndicator: true }),
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: summary,
        },
      },
    ],
  };

  if (previewUrl) {
    card.elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: '查看完整内容',
          },
          type: 'primary',
          url: previewUrl,
        },
      ],
    });
  }

  return card;
}

function buildTelegramReplyMarkup(previewUrl = '') {
  const url = String(previewUrl || '').trim();
  if (!url) {
    return null;
  }

  return {
    inline_keyboard: [[{ text: '查看完整内容', url }]],
  };
}

function buildTelegramMultipartPayload(fields = {}, fileFieldName = 'photo', fileOptions = {}) {
  const boundary = `----mailunion-${randomBytes(12).toString('hex')}`;
  const chunks = [];
  const appendTextField = (name, value) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${String(name)}"\r\n\r\n${String(value)}\r\n`,
        'utf8',
      ),
    );
  };

  Object.entries(fields || {}).forEach(([name, value]) => {
    appendTextField(name, value);
  });

  const fileBuffer = Buffer.isBuffer(fileOptions.buffer)
    ? fileOptions.buffer
    : Buffer.from(fileOptions.buffer || '');
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${String(fileFieldName)}"; filename="${String(fileOptions.filename || 'cover.png')}"\r\nContent-Type: ${String(fileOptions.contentType || 'image/png')}\r\n\r\n`,
      'utf8',
    ),
  );
  chunks.push(fileBuffer);
  chunks.push(Buffer.from('\r\n', 'utf8'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function sendTelegramPhoto(target, config, renderedText = '', bundle = {}) {
  const photoUrl = String(bundle?.cover?.publicUrl || bundle?.cover?.sourceUrl || '').trim();
  const localFilePath = String(bundle?.cover?.localFilePath || '').trim();
  const replyMarkup = buildTelegramReplyMarkup(bundle?.previewUrl);
  const caption = clipTelegramHtml(renderedText, TELEGRAM_CAPTION_LIMIT);

  if (localFilePath && fs.existsSync(localFilePath)) {
    const multipartPayload = buildTelegramMultipartPayload(
      {
        chat_id: config.chatId,
        ...(caption ? { caption, parse_mode: 'HTML' } : {}),
        ...(replyMarkup ? { reply_markup: JSON.stringify(replyMarkup) } : {}),
      },
      'photo',
      {
        filename: path.basename(localFilePath),
        contentType: String(bundle?.cover?.contentType || assetContentTypeFromPath(localFilePath) || 'image/png'),
        buffer: fs.readFileSync(localFilePath),
      },
    );

    await requestTelegram(
      `${config.apiBaseUrl}/bot${config.token}/sendPhoto`,
      null,
      getTelegramProxyUrls(target),
      {
        body: multipartPayload.body,
        headers: {
          'Content-Type': multipartPayload.contentType,
        },
      },
    );
    return true;
  }

  if (!photoUrl) {
    return false;
  }

  const payload = {
    chat_id: config.chatId,
    photo: photoUrl,
  };
  if (caption) {
    payload.caption = caption;
    payload.parse_mode = 'HTML';
  }
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  await requestTelegram(
    `${config.apiBaseUrl}/bot${config.token}/sendPhoto`,
    payload,
    getTelegramProxyUrls(target),
  );
  return true;
}

async function sendTelegram(target, templateTarget, mailbox, message) {
  const config = getTelegramConfig(target);
  if (!config.token || !config.chatId) {
    throw new Error('Telegram notification is not configured completely.');
  }

  const templateOptions = readTemplateConfig(templateTarget).options || {};
  const bundle = await buildNotificationSummaryBundle('telegram', templateTarget, mailbox, message, {
    includeCover: shouldUseNotificationCover(templateOptions, 'telegram'),
  });
  if (!bundle) {
    return false;
  }
  const renderedText = renderChannelTemplateMessage(
    'telegram',
    templateTarget,
    mailbox,
    message,
    bundle.content,
    bundle.previewUrl,
  );
  if (!renderedText) {
    return false;
  }

  if (bundle.cover) {
    try {
      const photoSent = await sendTelegramPhoto(target, config, renderedText, bundle);
      if (photoSent) {
        return true;
      }
    } catch (error) {
      console.warn('[telegram-cover-fallback]', String(error?.message || error));
    }
  }

  const payload = {
    chat_id: config.chatId,
    text: renderedText,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  const replyMarkup = buildTelegramReplyMarkup(bundle.previewUrl);
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  await requestTelegram(
    `${config.apiBaseUrl}/bot${config.token}/sendMessage`,
    payload,
    getTelegramProxyUrls(target),
  );

  return true;
}

function normalizeWecomMode(value, fallback = 'bot') {
  const normalized = String(value || fallback || 'bot').trim().toLowerCase();
  return ['bot', 'app'].includes(normalized) ? normalized : 'bot';
}

function normalizeWecomReceiverType(value, fallback = 'user') {
  const normalized = String(value || fallback || 'user').trim().toLowerCase();
  return ['user', 'party', 'tag'].includes(normalized) ? normalized : 'user';
}

function getWecomConfig(target) {
  const targetConfig = target?.config || {};
  const secrets = parseWecomSecretBundle(target?.secretEncrypted);
  const inferredMode =
    targetConfig.mode
    || (targetConfig.corpId || targetConfig.agentId || targetConfig.receiverId || targetConfig.appBaseUrl
      ? 'app'
      : 'bot');
  const mode = normalizeWecomMode(inferredMode);
  const botSecret = String(secrets.botSecret || '').trim();
  const appSecret = String(secrets.appSecret || '').trim();

  return {
    mode,
    botId: String(targetConfig.botId || '').trim(),
    targetId: String(targetConfig.targetId || '').trim(),
    corpId: String(targetConfig.corpId || '').trim(),
    agentId: String(targetConfig.agentId || '').trim(),
    receiverType: normalizeWecomReceiverType(targetConfig.receiverType || 'user'),
    receiverId: String(targetConfig.receiverId || '').trim(),
    appBaseUrl: normalizeUrl(targetConfig.appBaseUrl || process.env.PUBLIC_BASE_URL || ''),
    callbackToken: String(targetConfig.callbackToken || secrets.callbackToken || '').trim(),
    encodingAesKey: String(targetConfig.encodingAesKey || secrets.encodingAesKey || '').trim(),
    botSecret,
    appSecret,
    secret: mode === 'app' ? appSecret : botSecret,
  };
}

function escapeWecomTextcardHtml(text = '') {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const WECOM_TEXTCARD_HIGHLIGHT_TOKEN = '@@MAILUNIONWECOMHIGHLIGHT@@';

function normalizeWecomTextcardTemplateSource(renderedTemplate = '') {
  const preservedLiterals = [];
  const preserveLiteral = (value) => {
    const token = `@@MAILUNIONWECOMLITERAL${preservedLiterals.length}@@`;
    preservedLiterals.push(String(value || ''));
    return token;
  };

  const normalized = decodeHtmlEntities(String(renderedTemplate || ''))
    .replace(/<([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>/gi, (_, email) => preserveLiteral(`<${email}>`))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(?:p|div|section|article|header|footer|aside|main|figure|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|aside|main|figure|figcaption)>/gi, '\n')
    .replace(/<(?:ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:ul|ol)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, __, ___, inner) => {
      const label = normalizeNotificationText(stripHtmlTags(inner));
      if (!label || /^https?:\/\//i.test(label)) {
        return '网址';
      }
      return label;
    })
    .replace(/<font\b[^>]*>/gi, WECOM_TEXTCARD_HIGHLIGHT_TOKEN)
    .replace(/<\/font>/gi, WECOM_TEXTCARD_HIGHLIGHT_TOKEN)
    .replace(/<(?:strong|b)\b[^>]*>/gi, WECOM_TEXTCARD_HIGHLIGHT_TOKEN)
    .replace(/<\/(?:strong|b)>/gi, WECOM_TEXTCARD_HIGHLIGHT_TOKEN)
    .replace(/<\/?(?:em|i|code|span|blockquote|pre)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_, label) => {
      const cleaned = String(label || '').trim();
      if (!cleaned || /^https?:\/\//i.test(cleaned)) {
        return '网址';
      }
      return cleaned;
    });

  return replaceUrls(normalized, {
    formatText: (text) => String(text || ''),
    formatUrl: () => '网址',
  }).replace(/@@MAILUNIONWECOMLITERAL(\d+)@@/g, (_, index) => preservedLiterals[Number(index)] || '');
}

function isWecomTextcardSectionLabel(text = '') {
  const value = String(text || '').trim();
  if (!value || value.length > 18) {
    return false;
  }

  if (/[:：。！？!?；;,.，]/u.test(value)) {
    return false;
  }

  return /^[\p{L}\p{N}\u4e00-\u9fff\s\-_/()（）【】《》"'“”‘’·•]+$/u.test(value);
}

function buildWecomFallbackTextcardDescription(content = {}) {
  const facts = Array.isArray(content.summaryFacts)
    ? content.summaryFacts.filter(Boolean).slice(0, 3)
    : [];
  const paragraphs = buildCleanSummaryParagraphs(content).slice(0, 2);
  const sanitizeFallbackText = (value, maxLength) =>
    escapeWecomTextcardHtml(
      clipText(normalizeWecomTextcardTemplateSource(String(value || '')), maxLength, { showIndicator: true }),
    );
  const lines = [
    `<div class="gray">发件人</div><div class="normal">${sanitizeFallbackText(content.from, 120)}</div>`,
    `<div class="gray">邮箱</div><div class="normal">${sanitizeFallbackText(content.mailbox, 120)}</div>`,
    `<div class="gray">时间</div><div class="normal">${sanitizeFallbackText(content.time, 80)}</div>`,
  ];

  if (facts.length) {
    lines.push(
      `<div class="gray">关键信息</div><div class="normal">${facts
        .map((item) => sanitizeFallbackText(stripNoisySummaryArtifacts(item), 180))
        .join('<br/>')}</div>`,
    );
  }

  if (paragraphs.length) {
    lines.push(
      `<div class="gray">摘要</div><div class="normal">${paragraphs
        .map((paragraph) => sanitizeFallbackText(paragraph, 260))
        .join('<br/><br/>')}</div>`,
    );
  }

  return lines.join('\n');
}

function collectWecomTextcardTemplateBlocks(content = {}, renderedTemplate = '') {
  const templateText = clipText(normalizeWecomTextcardTemplateSource(renderedTemplate), 720, { showIndicator: true });
  const verificationCode = String(content.verificationCode || '').trim();
  const blocks = [];
  let blankPending = false;

  for (const rawLine of String(templateText || '').split('\n')) {
    let line = String(rawLine || '').trim();
    if (!line) {
      blankPending = true;
      continue;
    }

    const headingMatch = line.match(/^#{1,6}\s*(.+)$/u);
    const quoteMatch = line.match(/^>\s*(.*)$/u);
    const bulletMatch = line.match(/^[-*•]\s+(.+)$/u);
    let className = 'normal';

    if (headingMatch) {
      className = 'highlight';
      line = headingMatch[1].trim();
    } else if (quoteMatch) {
      line = quoteMatch[1].trim();
      if (!line) {
        blankPending = true;
        continue;
      }
      className = isWecomTextcardSectionLabel(line) ? 'gray' : 'normal';
    } else if (bulletMatch) {
      line = `• ${bulletMatch[1].trim()}`;
    } else if (isWecomTextcardSectionLabel(line)) {
      className = 'gray';
    }

    const containsInlineHighlight = line.includes(WECOM_TEXTCARD_HIGHLIGHT_TOKEN);
    if (containsInlineHighlight) {
      line = line.split(WECOM_TEXTCARD_HIGHLIGHT_TOKEN).join('');
    }

    line = normalizeNotificationText(line);
    if (!line) {
      blankPending = true;
      continue;
    }

    if (containsInlineHighlight && className === 'normal') {
      className = 'highlight';
    }

    if (verificationCode && line.includes(verificationCode) && /(?:验证码|校验码|动态码|提取码|确认码|登录码|安全码|code|otp)/iu.test(line)) {
      className = 'highlight';
    }

    if (blankPending && blocks.length && blocks[blocks.length - 1] !== '<br/>') {
      blocks.push({
        type: 'break',
      });
    }
    blankPending = false;

    blocks.push({
      type: 'line',
      className,
      text: clipText(line, 220, { showIndicator: false }),
      isHeading: Boolean(headingMatch),
    });
    if (blocks.filter((item) => item.type === 'line').length >= 14) {
      blocks.push({
        type: 'break',
      });
      blocks.push({
        type: 'line',
        className: 'gray',
        text: '更多内容请点击下方按钮查看',
        isHeading: false,
      });
      break;
    }
  }

  return blocks;
}

function stringifyWecomTextcardBlocks(blocks = []) {
  return blocks
    .map((block) => {
      if (block?.type === 'break') {
        return '<br/>';
      }

      if (block?.type === 'line' && block.text) {
        return `<div class="${block.className || 'normal'}">${escapeWecomTextcardHtml(block.text)}</div>`;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n')
    .replace(/(?:<br\/>\n){3,}/g, '<br/>\n')
    .replace(/^(?:<br\/>\n)+/g, '')
    .trim();
}

function buildWecomTextcardPayload(content = {}, renderedTemplate = '') {
  const blocks = collectWecomTextcardTemplateBlocks(content, renderedTemplate);
  const lineBlocks = blocks.filter((block) => block?.type === 'line' && block.text);
  const fallbackTitle = clipText(content.subject || '邮件摘要', 112, { showIndicator: true });

  if (!lineBlocks.length) {
    return {
      title: fallbackTitle,
      description: buildWecomFallbackTextcardDescription(content),
    };
  }

  const firstLineIndex = blocks.findIndex((block) => block?.type === 'line' && block.text);
  let title = fallbackTitle;
  let descriptionBlocks = [...blocks];

  if (firstLineIndex >= 0) {
    const firstLine = blocks[firstLineIndex];
    const hasMoreContent = lineBlocks.length > 1;
    const shouldPromoteFirstLineToTitle =
      Boolean(firstLine?.isHeading)
      || (firstLineIndex === 0 && hasMoreContent);

    if (shouldPromoteFirstLineToTitle) {
      title = clipText(firstLine.text || fallbackTitle, 112, { showIndicator: true });
      descriptionBlocks.splice(firstLineIndex, 1);
      while (descriptionBlocks[0]?.type === 'break') {
        descriptionBlocks.shift();
      }
    } else if (firstLine?.text) {
      title = clipText(firstLine.text, 112, { showIndicator: true });
    }
  }

  const description = stringifyWecomTextcardBlocks(descriptionBlocks);

  return {
    title,
    description: description || buildWecomFallbackTextcardDescription(content),
  };
}

function buildWecomTextcardDescription(content = {}, renderedTemplate = '') {
  const payload = buildWecomTextcardPayload(content, renderedTemplate);

  return payload.description;
}

function buildWecomAppArticleDescription(content = {}, renderedTemplate = '') {
  const descriptionSource =
    buildWecomTextcardDescription(content, renderedTemplate)
    || renderStructuredSummaryForChannel('wecom', content)
    || content.summary
    || '暂无摘要';
  return clipInlineText(normalizeNotificationText(stripHtmlTags(descriptionSource)).replace(/\n+/g, ' '), 150);
}

function buildWecomAppNewsPayload(content = {}, renderedTemplate = '', previewUrl = '', coverUrl = '') {
  const textcard = buildWecomTextcardPayload(content, renderedTemplate);
  return {
    articles: [
      {
        title: clipInlineText(textcard.title || content.subject || '邮件摘要', 44),
        description: buildWecomAppArticleDescription(content, renderedTemplate),
        url: previewUrl,
        picurl: coverUrl,
      },
    ],
  };
}

function normalizeWecomAppDiagnosticValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean).join('|');
  }

  return String(value || '').trim();
}

function listWecomAppDeliveryWarnings(payload = {}) {
  const fieldLabels = [
    ['invaliduser', '成员 ID 无效'],
    ['invalidparty', '部门 ID 无效'],
    ['invalidtag', '标签 ID 无效'],
    ['unlicenseduser', '未授权成员'],
  ];

  return fieldLabels
    .map(([field, label]) => ({
      field,
      label,
      value: normalizeWecomAppDiagnosticValue(payload?.[field]),
    }))
    .filter((entry) => entry.value);
}

function buildWecomAppSendResult(config, payload = {}) {
  const msgId = String(payload?.msgid || '').trim();
  const warnings = listWecomAppDeliveryWarnings(payload);
  const diagnostics = {
    mode: 'app',
    receiverType: String(config?.receiverType || 'user').trim() || 'user',
    receiverId: String(config?.receiverId || '').trim(),
    msgid: msgId,
    invaliduser: normalizeWecomAppDiagnosticValue(payload?.invaliduser),
    invalidparty: normalizeWecomAppDiagnosticValue(payload?.invalidparty),
    invalidtag: normalizeWecomAppDiagnosticValue(payload?.invalidtag),
    unlicenseduser: normalizeWecomAppDiagnosticValue(payload?.unlicenseduser),
  };

  if (warnings.length) {
    return {
      ok: true,
      channel: 'wecom',
      status: 'warning',
      message: `企业微信接口已接受请求，但存在投递警告：${warnings.map((item) => `${item.label}：${item.value}`).join('；')}。`,
      diagnostics,
    };
  }

  return {
    ok: true,
    channel: 'wecom',
    status: 'sent',
    message: `企业微信接口已接受请求${msgId ? `（msgid: ${msgId}）` : ''}。如果应用里仍未看到消息，请检查该成员是否在应用可见范围内，并在企业微信客户端“工作台”里查看对应应用。`,
    diagnostics,
  };
}

async function requestWecomAppApi(endpoint, searchParams = {}, options = {}) {
  const query = new URLSearchParams(
    Object.entries(searchParams)
      .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
      .map(([key, value]) => [key, String(value)]),
  );
  const requestUrl = `${WECOM_APP_API_BASE_URL}${endpoint}${query.toString() ? `?${query.toString()}` : ''}`;
  const response = await fetchWithOutboundProxy(
    requestUrl,
    {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    {
      timeoutMs: options.timeoutMs || 20000,
    },
  );
  const payload = await readResponsePayload(response);
  if (!response.ok || Number(payload.errcode || 0) !== 0) {
    throw new Error(payload.errmsg || payload.message || 'WeCom app notification failed.');
  }
  return payload;
}

function buildFeishuSign(secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const stringToSign = `${timestamp}\n${secret}`;
  return {
    timestamp,
    sign: createHmac('sha256', stringToSign).update('').digest('base64'),
  };
}

// Unified summary-first delivery: all channels send摘要 + 完整内容预览链接。
async function sendWecomAppMessage(config, templateTarget, mailbox, message) {
  if (!config.corpId || !config.agentId || !config.appSecret) {
    throw new Error('企业微信应用模式需要填写 Corp ID（企业 ID）、Agent ID（应用 ID）和 App Secret（应用密钥）。');
  }

  if (!config.receiverId) {
    throw new Error('启用企业微信应用模式前，请先填写 Receiver ID（接收对象 ID）。');
  }

  const templateOptions = readTemplateConfig(templateTarget).options || {};
  const bundle = await buildNotificationSummaryBundle('wecom', templateTarget, mailbox, message, {
    previewBaseUrl: config.appBaseUrl,
    includeCover: shouldUseNotificationCover(templateOptions, 'wecomApp'),
  });
  if (!bundle) {
    return false;
  }
  if (!bundle.previewUrl) {
    throw new Error('Please provide the public Mail Union URL for full-content preview jumps.');
  }

  const accessTokenPayload = await requestWecomAppApi('/gettoken', {
    corpid: config.corpId,
    corpsecret: config.appSecret,
  });
  const accessToken = String(accessTokenPayload.access_token || '').trim();
  if (!accessToken) {
    throw new Error('Failed to obtain WeCom app access token.');
  }

  const renderedTemplate = renderChannelTemplateMessageRaw('wecom', templateTarget, mailbox, message, bundle.content, '');
  const textcard = buildWecomTextcardPayload(bundle.content, renderedTemplate);
  const coverUrl = String(bundle?.cover?.publicUrl || '').trim();
  const messageBody = {
    touser: config.receiverType === 'user' ? config.receiverId : '',
    toparty: config.receiverType === 'party' ? config.receiverId : '',
    totag: config.receiverType === 'tag' ? config.receiverId : '',
    agentid: config.agentId,
    msgtype: coverUrl ? 'news' : 'textcard',
    ...(coverUrl
      ? {
          news: buildWecomAppNewsPayload(bundle.content, renderedTemplate, bundle.previewUrl, coverUrl),
        }
      : {
          textcard: {
            title: textcard.title,
            description: textcard.description,
            url: bundle.previewUrl,
            btntxt: '查看完整内容',
          },
        }),
    enable_id_trans: 0,
    safe: 0,
  };

  const sendPayload = await requestWecomAppApi(
    '/message/send',
    { access_token: accessToken },
    {
      method: 'POST',
      body: messageBody,
    },
  );

  return buildWecomAppSendResult(config, sendPayload);
}

async function sendWecom(target, templateTarget, mailbox, message) {
  const config = getWecomConfig(target);
  if (config.mode === 'app') {
    return sendWecomAppMessage(config, templateTarget, mailbox, message);
  }

  if (!config.botId || !config.botSecret) {
    throw new Error('企业微信机器人模式缺少 Bot ID（机器人 ID）或 Bot Secret（机器人密钥）。');
  }

  if (!config.targetId) {
    throw new Error('请先选择 UserID（成员 ID）或 ChatID（群聊 ID）。');
  }

  const bundle = await buildNotificationSummaryBundle('wecom', templateTarget, mailbox, message, {
    previewBaseUrl: config.appBaseUrl,
  });
  if (!bundle) {
    return false;
  }
  const renderedText = renderChannelTemplateMessage(
    'wecom',
    templateTarget,
    mailbox,
    message,
    bundle.content,
    bundle.previewUrl,
  );
  if (!renderedText) {
    return false;
  }

  await wecomClientPool.sendMarkdown({
    botId: config.botId,
    secret: config.botSecret,
    targetId: config.targetId,
    markdown: renderedText,
  });

  return true;
}

async function sendFeishu(target, templateTarget, mailbox, message) {
  const secrets = parseFeishuSecretBundle(target.secretEncrypted);
  if (!secrets.webhookUrl) {
    throw new Error('Feishu webhook is missing.');
  }

  const bundle = await buildNotificationSummaryBundle('feishu', templateTarget, mailbox, message);
  if (!bundle) {
    return false;
  }
  const renderedText = renderChannelTemplateMessage(
    'feishu',
    templateTarget,
    mailbox,
    message,
    bundle.content,
    bundle.previewUrl,
  );
  if (!renderedText) {
    return false;
  }

  const body = {
    msg_type: 'interactive',
    card: JSON.stringify(buildFeishuSummaryCard(bundle.content, bundle.previewUrl, renderedText)),
  };

  if (secrets.signSecret) {
    Object.assign(body, buildFeishuSign(secrets.signSecret));
  }

  const response = await fetchWithOutboundProxy(
    secrets.webhookUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    {
      timeoutMs: 20000,
    },
  );

  const payload = await readResponsePayload(response);
  const statusCode =
    payload.StatusCode !== undefined
      ? Number(payload.StatusCode)
      : payload.code !== undefined
        ? Number(payload.code)
        : 0;

  if (!response.ok || statusCode !== 0) {
    throw new Error(payload.msg || payload.StatusMessage || payload.message || 'Feishu notification failed.');
  }

  return true;
}

function splitSentenceLikeSegments(text = '') {
  const source = String(text || '').trim();
  if (!source) {
    return [];
  }

  const segments = source.match(/[^.!?;\u3002\uff01\uff1f\uff1b]+(?:[.!?;\u3002\uff01\uff1f\uff1b]+|$)/gu);
  if (!segments?.length) {
    return [source];
  }

  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function looksLikeStandaloneParagraphLine(text = '') {
  const line = String(text || '').trim();
  if (!line) {
    return false;
  }

  if (isStructuredNotificationLine(line)) {
    return true;
  }

  if (/[.!?:\u3002\uff01\uff1f\uff1a]$/u.test(line)) {
    return true;
  }

  return /^(第[一二三四五六七八九十百千万0-9]+[段章节部分项]|[0-9]+[.)、])/u.test(line);
}

function shouldPreserveSingleLineBreakParagraphs(lines = []) {
  const meaningfulLines = lines.map((line) => String(line || '').trim()).filter(Boolean);
  if (meaningfulLines.length < 3) {
    return false;
  }

  const standaloneCount = meaningfulLines.filter((line) => looksLikeStandaloneParagraphLine(line)).length;
  return standaloneCount >= Math.max(2, Math.ceil(meaningfulLines.length * 0.6));
}

function paragraphizeNotificationText(text = '', options = {}) {
  const normalized = normalizeNotificationText(text);
  if (!normalized) {
    return '';
  }

  const sentenceGroupSoftLimit = Math.max(Number(options.sentenceGroupSoftLimit) || 88, 48);
  const sentenceGroupHardLimit = Math.max(Number(options.sentenceGroupHardLimit) || 140, sentenceGroupSoftLimit + 12);
  const paragraphBlocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const formattedBlocks = [];

  for (const block of paragraphBlocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.length) {
      continue;
    }

    if (lines.length > 1 && lines.every((line) => isStructuredNotificationLine(line))) {
      formattedBlocks.push(lines.join('\n'));
      continue;
    }

    if (shouldPreserveSingleLineBreakParagraphs(lines)) {
      formattedBlocks.push(lines.join('\n\n'));
      continue;
    }

    const mergedBlock = lines.join(' ');
    if (isStructuredNotificationLine(mergedBlock)) {
      formattedBlocks.push(mergedBlock);
      continue;
    }

    const sentences = splitSentenceLikeSegments(mergedBlock);
    if (sentences.length <= 1 && mergedBlock.length <= sentenceGroupHardLimit) {
      formattedBlocks.push(mergedBlock);
      continue;
    }

    const paragraphParts = [];
    let currentPart = '';

    for (const sentence of sentences) {
      if (!currentPart) {
        currentPart = sentence;
        continue;
      }

      const joined = `${currentPart} ${sentence}`.trim();
      if (
        joined.length <= sentenceGroupSoftLimit ||
        (currentPart.length < Math.floor(sentenceGroupSoftLimit * 0.55) && joined.length <= sentenceGroupHardLimit)
      ) {
        currentPart = joined;
      } else {
        paragraphParts.push(currentPart);
        currentPart = sentence;
      }
    }

    if (currentPart) {
      paragraphParts.push(currentPart);
    }

    formattedBlocks.push(paragraphParts.join('\n\n'));
  }

  return formattedBlocks.join('\n\n').trim();
}

function finalizeWecomMarkdown(markdown = '') {
  const lines = String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  return lines
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed) {
        return '<br/>';
      }

      if (/^#{1,6}\s/u.test(trimmed)) {
        return trimmed;
      }

      if (/^>\s*$/u.test(trimmed)) {
        return '> <br/>';
      }

      return `${trimmed}<br/>`;
    })
    .join('\n')
    .replace(/(?:<br\/>\n){3,}/g, '<br/><br/>\n')
    .trim();
}

function buildWecomVerificationHighlightMessage(content = {}) {
  const code = String(content.verificationCode || '').trim();
  if (!code) {
    return '';
  }

  const paragraphs = Array.isArray(content.summaryParagraphs)
    ? content.summaryParagraphs.filter(Boolean).slice(0, 2)
    : [];

  const lines = [
    '## 验证码通知',
    `# ${formatTemplateValue(code, 'wecom')}`,
    '请尽快使用上方验证码',
    `> 主题：${formatTemplateValue(content.subject || '', 'wecom')}`,
    `> 发件人：${formatTemplateValue(content.from || '', 'wecom')}`,
    `> 收件箱：${formatTemplateValue(content.mailbox || '', 'wecom')}`,
    `> 时间：${formatTemplateValue(content.time || '', 'wecom')}`,
  ];

  if (paragraphs.length) {
    lines.push('>');
    lines.push('> 正文摘要');
    paragraphs.forEach((paragraph, index) => {
      if (index > 0) {
        lines.push('>');
      }
      lines.push(`> ${formatTemplateValue(paragraph, 'wecom')}`);
    });
  }

  return lines.join('\n');
}

function buildWecomStandardMessage(content = {}) {
  const facts = Array.isArray(content.summaryFacts) ? content.summaryFacts.filter(Boolean) : [];
  const paragraphs = Array.isArray(content.summaryParagraphs)
    ? content.summaryParagraphs.filter(Boolean).slice(0, 4)
    : [];
  const verificationCode = String(content.verificationCode || '').trim();

  if (verificationCode) {
    return buildWecomVerificationHighlightMessage(content);
  }

  const lines = [
    '## 新邮件',
    `# ${formatTemplateValue(content.subject || '', 'wecom') || '无主题邮件'}`,
    `> 发件人：${formatTemplateValue(content.from || '', 'wecom')}`,
    `> 收件箱：${formatTemplateValue(content.mailbox || '', 'wecom')}`,
    `> 时间：${formatTemplateValue(content.time || '', 'wecom')}`,
  ];

  if (facts.length) {
    lines.push('>');
    lines.push('> 关键信息');
    facts.forEach((item) => {
      lines.push(`> • ${formatTemplateValue(item, 'wecom')}`);
    });
  }

  if (paragraphs.length) {
    lines.push('>');
    lines.push('> 正文摘要');
    paragraphs.forEach((paragraph, index) => {
      if (index > 0) {
        lines.push('>');
      }
      lines.push(`> ${formatTemplateValue(paragraph, 'wecom')}`);
    });
  }

  return lines.join('\n');
}

async function resolveChannelTemplate(channel, templateTarget, mailbox, message) {
  const { presetId, templates, options } = readTemplateConfig(templateTarget);
  const content = await buildNotificationContentV2(mailbox, message, channel, options);

  if (channel === 'wecom') {
    let wecomRendered = buildWecomStandardMessage(content);
    if (content.translationFailed) {
      wecomRendered += buildTranslationFallbackNote(channel);
    }
    return finalizeWecomMarkdown(clipText(wecomRendered, WECOM_TEXT_LIMIT));
  }

  const preset = getTemplatePreset(presetId);
  const customTemplate = String(templates[channel] || '');
  const sourceTemplate = customTemplate.trim() ? customTemplate : preset.templates[channel];
  let rendered = renderTemplateText(sourceTemplate, mailbox, message, channel, content);

  if (content.translationFailed) {
    rendered += buildTranslationFallbackNote(channel);
  }

  if (channel === 'telegram') {
    return clipTelegramHtml(rendered, TELEGRAM_TEXT_LIMIT);
  }

  if (channel === 'wecom') {
    return finalizeWecomMarkdown(clipText(rendered, WECOM_TEXT_LIMIT));
  }

  return clipText(rendered, FEISHU_TEXT_LIMIT);
}

function renderTelegramVerificationFact(label, value) {
  return [
    `• <b>验证码 ${formatTemplateValue(label, 'telegram')}</b>`,
    `<code>${formatTemplateValue(value, 'telegram')}</code>`,
  ].join('\n');
}

function renderWecomVerificationFact(label, value) {
  return [
    `• <font color="warning">${formatTemplateValue(label, 'wecom')}</font>`,
    `<font color="warning">${formatTemplateValue(value, 'wecom')}</font>`,
  ].join('\n');
}

function isVerificationFactLabel(label) {
  return String(label || '').trim() === '\u9a8c\u8bc1\u7801';
}

function splitFactLabelValue(text = '') {
  const value = String(text || '');
  const separatorIndex = value.search(/[:\uFF1A]/u);
  if (separatorIndex < 0) {
    return [value.trim(), ''];
  }

  return [
    value.slice(0, separatorIndex).trim(),
    value.slice(separatorIndex + 1).trim(),
  ];
}

function renderStructuredSummaryForChannel(channel, content = {}) {
  const fallbackText = String(content.summary || '').trim();
  const parsed = parseSummaryFactsAndParagraphs(fallbackText);
  const facts = Array.isArray(content.summaryFacts) && content.summaryFacts.length
    ? content.summaryFacts.filter(Boolean)
    : parsed.facts;
  const paragraphs = Array.isArray(content.summaryParagraphs) && content.summaryParagraphs.length
    ? content.summaryParagraphs.filter(Boolean)
    : parsed.paragraphs;
  const summaryKind = detectStructuredSummaryKind(content, facts);

  if (channel === 'telegram') {
    const sections = [];
    if (facts.length) {
      const factLabel = factsBlockLabel(summaryKind);
      sections.push([
        `<b>${factLabel}</b>`,
        ...facts.map((item) => {
          const [label, value] = splitFactLabelValue(item);
          if (!value) {
            return `• ${formatTemplateValue(label, channel)}`;
          }
          if (summaryKind === 'verification' && isVerificationFactLabel(label)) {
            return renderTelegramVerificationFact(label, value);
          }
          if ((summaryKind === 'payment' || summaryKind === 'order') && ['金额', '订单号', '时间'].includes(label.trim())) {
            return `• <b>${formatTemplateValue(label, channel)}</b>：<code>${formatTemplateValue(value, channel)}</code>`;
          }
          return `• <b>${formatTemplateValue(label, channel)}</b>：${formatTemplateValue(value, channel)}`;
        }),
      ].join('\n'));
    }
    if (paragraphs.length) {
      const paragraphLimit = summaryKind === 'marketing' ? 3 : summaryKind === 'verification' ? 2 : 4;
      sections.push(
        paragraphs
          .slice(0, paragraphLimit)
          .map((paragraph) => formatTemplateValue(paragraph, channel))
          .join('\n\n'),
      );
    }
    return sections.join('\n\n').trim() || formatTemplateValue(fallbackText, channel);
  }

  if (channel === 'wecom') {
    const lines = [];
    if (facts.length) {
      lines.push(factsBlockLabel(summaryKind));
      facts.forEach((item) => {
        const [label, value] = splitFactLabelValue(item);
        if (summaryKind === 'verification' && isVerificationFactLabel(label) && value) {
          lines.push(renderWecomVerificationFact(label, value));
          return;
        }
        lines.push(value ? `• ${label}：${value}` : `• ${label}`);
      });
      if (paragraphs.length) {
        lines.push('');
      }
    }
    const paragraphLimit = summaryKind === 'marketing' ? 3 : summaryKind === 'verification' ? 2 : 4;
    paragraphs.slice(0, paragraphLimit).forEach((paragraph, index) => {
      if (index > 0) {
        lines.push('');
      }
      lines.push(paragraph);
    });
    return formatQuotedTemplateValue(lines.join('\n').trim() || fallbackText, channel);
  }

  const plainSections = [];
  if (facts.length) {
    plainSections.push(['关键信息', ...facts.map((item) => `• ${item}`)].join('\n'));
  }
  if (paragraphs.length) {
    plainSections.push(paragraphs.join('\n\n'));
  }
  return plainSections.join('\n\n').trim() || fallbackText;
}

function htmlInlineToText(html = '') {
  return paragraphizeNotificationText(
    String(html || '')
      .replace(/<(?:strong|b)\b[^>]*>/gi, '')
      .replace(/<\/(?:strong|b)>/gi, '')
      .replace(/<(?:em|i)\b[^>]*>/gi, '')
      .replace(/<\/(?:em|i)>/gi, '')
      .replace(/<br\b[^>]*\/?>/gi, '\n')
      .replace(/<img\b[^>]*alt=(["'])(.*?)\1[^>]*>/gi, ' [$2] ')
      .replace(/<img\b[^>]*>/gi, ' [图片] ')
      .replace(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, __, ___, inner) => {
        const label = normalizeNotificationLinkLabel(inner);
        return label || '';
      })
      .replace(/<[^>]+>/g, ' '),
  );
}

function htmlBodyToText(html = '') {
  const source = String(html || '').trim();
  if (!source) {
    return '';
  }

  let normalized = source
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|noscript|svg|canvas|head|title|meta|link)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(style|script|noscript|svg|canvas|meta|link)\b[^>]*\/?>/gi, ' ');

  normalized = normalized.replace(
    /<table\b[^>]*>([\s\S]*?)<\/table>/gi,
    (_, tableHtml) => {
      const rows = [];
      const rowMatches = String(tableHtml || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);

      for (const rowMatch of rowMatches) {
        const cells = [];
        const cellMatches = String(rowMatch[1] || '').matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi);
        for (const cellMatch of cellMatches) {
          const cellText = htmlInlineToText(cellMatch[2]);
          if (cellText) {
            cells.push(cellText);
          }
        }

        if (cells.length) {
          rows.push(cells.join(' | '));
        }
      }

      return rows.length ? `\n${rows.join('\n')}\n` : '\n';
    },
  );

  normalized = normalized
    .replace(/<(ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<\/(ul|ol)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<(blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<\/(blockquote|pre)>/gi, '\n')
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<\/(h[1-6])>/gi, '\n')
    .replace(/<(p|div|section|article|header|footer|aside|main|figure|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|aside|main|figure|figcaption)>/gi, '\n')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<img\b[^>]*alt=(["'])(.*?)\1[^>]*>/gi, '\n[图片] $2\n')
    .replace(/<img\b[^>]*>/gi, '\n[图片]\n')
    .replace(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, __, ___, inner) => {
      const label = normalizeNotificationLinkLabel(inner);
      return label || '';
    })
    .replace(/<[^>]+>/g, ' ');

  return paragraphizeNotificationText(normalized);
}

function normalizeNotificationLinkLabel(value = '') {
  const label = normalizeNotificationText(stripHtmlTags(value))
    .replace(/\s+/g, ' ')
    .trim();
  if (!label) {
    return '';
  }

  const compact = label.replace(/\s+/g, '');
  if (/^\[(?:图片|image)\]$/i.test(label)) {
    return '';
  }
  if (/^https?:\/\//i.test(label)) {
    return '';
  }
  if (compact.length > 48 && /[/?=&_%.-]/.test(compact)) {
    return '';
  }

  return label;
}

function formatTelegramTemplateValue(value) {
  return replaceUrls(value, {
    formatText: escapeTelegramHtml,
    formatUrl: (url) => `<a href="${escapeTelegramHtml(url)}">网址</a>`,
  });
}

function formatWecomTemplateValue(value) {
  return replaceUrls(value, {
    formatText: (text) => String(text || ''),
    formatUrl: (url) => `[网址](${String(url || '').trim()})`,
  });
}

function restoreTranslatedUrls(value = '', urls = []) {
  let index = 0;
  return String(value || '').replace(/\[(?:链接|链接已省略|link|url)\]/gi, () => urls[index++] || '');
}

function buildPrettyNotificationSummary(body = '', options = {}) {
  const normalizedBody = paragraphizeNotificationText(body);
  if (!normalizedBody) {
    return '';
  }

  const facts = collectImportantFacts(normalizedBody, options);
  const paragraphs = collectNotificationSummaryParagraphs(normalizedBody, {
    ...options,
    maxParagraphs: options.isMarketing ? 2 : options.verificationCode ? 2 : 3,
  });
  const sections = [];

  if (facts.length) {
    sections.push(['关键信息', ...facts.map((item) => `- ${item}`)].join('\n'));
  }

  if (paragraphs.length) {
    sections.push(paragraphs.join('\n\n'));
  }

  return sections.join('\n\n').trim();
}

function buildPrettyNotificationSummaryParts(body = '', options = {}) {
  const normalizedBody = paragraphizeNotificationText(body);
  if (!normalizedBody) {
    return {
      facts: [],
      paragraphs: [],
      text: '',
    };
  }

  const facts = collectImportantFacts(normalizedBody, options);
  const paragraphs = collectNotificationSummaryParagraphs(normalizedBody, {
    ...options,
    maxParagraphs: options.isMarketing ? 2 : options.verificationCode ? 2 : 3,
  });

  return {
    facts,
    paragraphs,
    text: buildPrettyNotificationSummary(normalizedBody, options),
  };
}

function parseSummaryFactsAndParagraphs(summaryText = '') {
  const normalized = String(summaryText || '').trim();
  if (!normalized) {
    return {
      facts: [],
      paragraphs: [],
    };
  }

  const parts = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) {
    return {
      facts: [],
      paragraphs: [],
    };
  }

  const facts = [];
  let bodyStartIndex = 0;

  if (/^关键信息$/i.test(parts[0].split('\n')[0]?.trim() || '')) {
    const factLines = parts[0]
      .split('\n')
      .slice(1)
      .map((line) => line.replace(/^(?:-|•)\s*/, '').trim())
      .filter(Boolean);
    facts.push(...factLines);
    bodyStartIndex = 1;
  }

  return {
    facts,
    paragraphs: parts.slice(bodyStartIndex),
  };
}

function factsBlockLabel(kind = 'standard') {
  if (kind === 'verification') return '关键信息';
  if (kind === 'payment') return '交易重点';
  if (kind === 'order') return '订单重点';
  if (kind === 'subscription') return '订阅重点';
  if (kind === 'marketing') return '摘要重点';
  return '关键信息';
}

function renderTelegramVerificationFact(label, value) {
  return `• <b>${formatTemplateValue(label, 'telegram')}</b>：<code>${formatTemplateValue(value, 'telegram')}</code>`;
}

function renderWecomVerificationFact(label, value) {
  return `- <font color="warning">${formatTemplateValue(label, 'wecom')}</font>：<font color="info">${formatTemplateValue(value, 'wecom')}</font>`;
}

async function buildNotificationContentV2(mailbox, message, channel, options = {}) {
  const meta = getMessageMeta(mailbox, message);
  const body = messageBodyText(message);
  const verification = extractVerificationCodeV2(message);
  const category = resolveNotificationMessageCategory(message, body, verification);
  const isMarketing = category === 'marketing';
  const summaryLimit = Number(options.summaryLimit) > 0
    ? Number(options.summaryLimit)
    : verification
      ? 180
      : isMarketing
        ? 220
        : 260;

  const buildSummaryParts = (sourceBody) =>
    buildPrettyNotificationSummaryParts(sourceBody, {
      verificationCode: String(verification?.code || '').trim(),
      isMarketing,
    });
  const buildSummary = (summaryParts) =>
    clipText(summaryParts?.text || '', summaryLimit, { showIndicator: !isMarketing }) || '暂无正文摘要';
  const initialSummaryParts = buildSummaryParts(body);

  const content = {
    subject: meta.subject,
    from: meta.from,
    mailbox: meta.mailboxEmail,
    time: meta.receivedAt,
    summary: buildSummary(initialSummaryParts),
    summaryFacts: initialSummaryParts.facts,
    summaryParagraphs: initialSummaryParts.paragraphs,
    fullBody: body,
    translationFailed: false,
    category,
    summaryOnly: true,
    verificationCode: String(verification?.code || '').trim(),
  };

  if (!options.translateToChinese) {
    return content;
  }

  try {
    const settings = getSystemSettings();
    const translation = await translateMessage(
      {
        subject: meta.subject,
        textBody: body,
      },
      {
        ...settings,
        translationTargetLanguage: 'zh-CN',
      },
    );

    content.subject =
      restoreTranslatedUrls(translation.translatedSubject, extractUrlsInOrder(meta.subject)) || meta.subject;
    const translatedBody = restoreTranslatedUrls(translation.translatedBody, extractUrlsInOrder(body)).trim();
    const translatedSummaryParts = buildSummaryParts(translatedBody);
    content.summary = buildSummary(translatedSummaryParts) || content.summary;
    content.summaryFacts = translatedSummaryParts.facts;
    content.summaryParagraphs = translatedSummaryParts.paragraphs;
    content.fullBody = translatedBody || content.fullBody;
  } catch (_) {
    content.translationFailed = true;
  }

  return content;
}

function renderStructuredSummaryForChannel(channel, content = {}) {
  const fallbackText = String(content.summary || '').trim();
  const parsed = parseSummaryFactsAndParagraphs(fallbackText);
  const facts = Array.isArray(content.summaryFacts) && content.summaryFacts.length
    ? content.summaryFacts.filter(Boolean)
    : parsed.facts;
  const paragraphs = Array.isArray(content.summaryParagraphs) && content.summaryParagraphs.length
    ? content.summaryParagraphs.filter(Boolean)
    : parsed.paragraphs;
  const summaryKind = detectStructuredSummaryKind(content, facts);
  const paragraphLimit = summaryKind === 'marketing' ? 2 : summaryKind === 'verification' ? 2 : 3;

  if (channel === 'telegram') {
    const sections = [];

    if (facts.length) {
      const factLabel = factsBlockLabel(summaryKind);
      sections.push([
        `<b>${factLabel}</b>`,
        ...facts.map((item) => {
          const [label, value] = splitFactLabelValue(item);
          if (!value) {
            return `• ${formatTemplateValue(label, channel)}`;
          }
          if (summaryKind === 'verification' && isVerificationFactLabel(label)) {
            return renderTelegramVerificationFact(label, value);
          }
          if ((summaryKind === 'payment' || summaryKind === 'order') && ['金额', '订单号', '时间'].includes(label.trim())) {
            return `• <b>${formatTemplateValue(label, channel)}</b>：<code>${formatTemplateValue(value, channel)}</code>`;
          }
          return `• <b>${formatTemplateValue(label, channel)}</b>：${formatTemplateValue(value, channel)}`;
        }),
      ].join('\n'));
    }

    if (paragraphs.length) {
      sections.push(
        paragraphs
          .slice(0, paragraphLimit)
          .map((paragraph) => formatTemplateValue(paragraph, channel))
          .join('\n\n'),
      );
    }

    return sections.join('\n\n').trim() || formatTemplateValue(fallbackText, channel);
  }

  if (channel === 'wecom') {
    const lines = [];

    if (facts.length) {
      lines.push(factsBlockLabel(summaryKind));
      facts.forEach((item) => {
        const [label, value] = splitFactLabelValue(item);
        if (summaryKind === 'verification' && isVerificationFactLabel(label) && value) {
          lines.push(renderWecomVerificationFact(label, value));
          return;
        }
        lines.push(value ? `- ${label}：${value}` : `- ${label}`);
      });
      if (paragraphs.length) {
        lines.push('');
      }
    }

    paragraphs.slice(0, paragraphLimit).forEach((paragraph, index) => {
      if (index > 0) {
        lines.push('');
      }
      lines.push(paragraph);
    });

    return formatQuotedTemplateValue(lines.join('\n').trim() || fallbackText, channel);
  }

  const plainSections = [];
  if (facts.length) {
    plainSections.push(['关键信息', ...facts.map((item) => `- ${item}`)].join('\n'));
  }
  if (paragraphs.length) {
    plainSections.push(paragraphs.slice(0, paragraphLimit).join('\n\n'));
  }
  return plainSections.join('\n\n').trim() || fallbackText;
}

function buildWecomVerificationHighlightMessage(content = {}) {
  const code = String(content.verificationCode || '').trim();
  if (!code) {
    return '';
  }

  const paragraphs = Array.isArray(content.summaryParagraphs)
    ? content.summaryParagraphs.filter(Boolean)
    : [];

  const lines = [
    '## 验证码通知',
    `# ${formatTemplateValue(code, 'wecom')}`,
    '请尽快使用上方验证码',
    `> 主题：${formatTemplateValue(content.subject || '', 'wecom')}`,
    `> 发件人：${formatTemplateValue(content.from || '', 'wecom')}`,
    `> 收件箱：${formatTemplateValue(content.mailbox || '', 'wecom')}`,
    `> 时间：${formatTemplateValue(content.time || '', 'wecom')}`,
  ];

  if (paragraphs.length) {
    lines.push('>');
    lines.push('> 正文内容');
    paragraphs.forEach((paragraph, index) => {
      if (index > 0) {
        lines.push('>');
      }
      lines.push(`> ${formatTemplateValue(paragraph, 'wecom')}`);
    });
  }

  return lines.join('\n');
}

function buildWecomStandardMessage(content = {}) {
  const facts = Array.isArray(content.summaryFacts) ? content.summaryFacts.filter(Boolean) : [];
  const paragraphs = Array.isArray(content.summaryParagraphs)
    ? content.summaryParagraphs.filter(Boolean)
    : [];
  const verificationCode = String(content.verificationCode || '').trim();

  if (verificationCode) {
    return buildWecomVerificationHighlightMessage(content);
  }

  const lines = [
    '## 新邮件',
    `# ${formatTemplateValue(content.subject || '', 'wecom') || '无主题邮件'}`,
    `> 发件人：${formatTemplateValue(content.from || '', 'wecom')}`,
    `> 收件箱：${formatTemplateValue(content.mailbox || '', 'wecom')}`,
    `> 时间：${formatTemplateValue(content.time || '', 'wecom')}`,
  ];

  if (facts.length) {
    lines.push('>');
    lines.push('> 关键信息');
    facts.forEach((item) => {
      lines.push(`> - ${formatTemplateValue(item, 'wecom')}`);
    });
  }

  if (paragraphs.length) {
    lines.push('>');
    lines.push('> 正文内容');
    paragraphs.forEach((paragraph, index) => {
      if (index > 0) {
        lines.push('>');
      }
      lines.push(`> ${formatTemplateValue(paragraph, 'wecom')}`);
    });
  }

  return lines.join('\n');
}

async function resolveChannelTemplate(channel, templateTarget, mailbox, message) {
  const { presetId, templates, options } = readTemplateConfig(templateTarget);
  const content = await buildNotificationContentV2(mailbox, message, channel, options);

  if (channel === 'wecom') {
    let wecomRendered = buildWecomStandardMessage(content);
    if (content.translationFailed) {
      wecomRendered += buildTranslationFallbackNote(channel);
    }
    return finalizeWecomMarkdown(clipText(wecomRendered, WECOM_TEXT_LIMIT));
  }

  const preset = getTemplatePreset(presetId);
  const customTemplate = String(templates[channel] || '');
  const sourceTemplate = customTemplate.trim() ? customTemplate : preset.templates[channel];
  let rendered = renderTemplateText(sourceTemplate, mailbox, message, channel, content);

  if (content.translationFailed) {
    rendered += buildTranslationFallbackNote(channel);
  }

  if (channel === 'telegram') {
    return clipTelegramHtml(rendered, TELEGRAM_TEXT_LIMIT);
  }

  if (channel === 'wecom') {
    return finalizeWecomMarkdown(clipText(rendered, WECOM_TEXT_LIMIT));
  }

  return clipText(rendered, FEISHU_TEXT_LIMIT);
}

class NotificationService {
  getTargetsByChannel(userId) {
    return Object.fromEntries(listNotificationTargets(userId).map((target) => [target.channel, target]));
  }

  getWecomTarget(userId) {
    return this.getTargetsByChannel(userId).wecom || null;
  }

  getWecomCallbackSetting(userId) {
    const target = this.getWecomTarget(userId);
    const config = getWecomConfig(target);
    return {
      userId: String(userId || '').trim(),
      enabled: Boolean(target?.enabled),
      mode: config.mode,
      corpId: config.corpId,
      callbackToken: config.callbackToken,
      encodingAesKey: config.encodingAesKey,
      callbackUrl: buildWecomCallbackUrl(userId, config.appBaseUrl),
    };
  }

  async warmupWecomListener(userId) {
    const target = this.getWecomTarget(userId);
    const config = getWecomConfig(target);

    if (config.mode !== 'bot') {
      return {
        available: false,
        connected: false,
        lastError: '',
        recentTargets: [],
      };
    }

    if (!config.botId || !config.botSecret) {
      return {
        available: false,
        connected: false,
        lastError: '',
        recentTargets: [],
      };
    }

    try {
      return {
        available: true,
        ...await wecomClientPool.ensureListening({
          botId: config.botId,
          secret: config.botSecret,
          timeoutMs: 5000,
        }),
      };
    } catch (error) {
      return {
        available: true,
        ...wecomClientPool.getStatus(config.botId, config.botSecret),
        lastError: String(error.message || error),
      };
    }
  }

  async getWecomDiscovery(userId) {
    const target = this.getWecomTarget(userId);
    const config = getWecomConfig(target);

    if (config.mode !== 'bot') {
      return {
        available: false,
        connected: false,
        botId: '',
        currentTargetId: '',
        lastError: '',
        recentTargets: [],
      };
    }

    if (!config.botId || !config.botSecret) {
      return {
        available: false,
        connected: false,
        botId: '',
        currentTargetId: config.targetId || '',
        lastError: '',
        recentTargets: [],
      };
    }

    const status = await this.warmupWecomListener(userId);
    return {
      available: true,
      connected: Boolean(status.connected),
      botId: config.botId,
      currentTargetId: config.targetId,
      lastError: status.lastError || '',
      recentTargets: status.recentTargets || [],
    };
  }

  listSettingsForUser(userId) {
    const merged = {
      telegram: {
        channel: 'telegram',
        enabled: false,
        configured: false,
        chatId: '',
      },
      wecom: {
        channel: 'wecom',
        enabled: false,
        configured: false,
        botConfigured: false,
        botSecretConfigured: false,
        appConfigured: false,
        appSecretConfigured: false,
        mode: 'bot',
        botId: '',
        targetId: '',
        botReady: false,
        corpId: '',
        agentId: '',
        receiverType: 'user',
        receiverId: '',
        appBaseUrl: '',
        callbackToken: '',
        encodingAesKey: '',
        callbackUrl: '',
      },
      feishu: {
        channel: 'feishu',
        enabled: false,
        configured: false,
        webhookHint: '',
        signatureEnabled: false,
      },
      template: getTemplateSetting(null),
    };

    for (const target of listNotificationTargets(userId)) {
      if (target.channel === 'telegram') {
        merged.telegram = {
          channel: 'telegram',
          enabled: target.enabled,
          configured: Boolean(safeDecrypt(target.secretEncrypted) && target.config.chatId),
          chatId: target.config.chatId || '',
        };
      }

      if (target.channel === 'wecom') {
        const config = getWecomConfig(target);
        merged.wecom = {
          channel: 'wecom',
          enabled: target.enabled,
          configured:
            Boolean(config.botId && config.botSecret)
            || Boolean(config.corpId && config.agentId && config.appSecret && config.receiverId && config.appBaseUrl),
          botConfigured: Boolean(config.botId && config.botSecret),
          botSecretConfigured: Boolean(config.botSecret),
          appConfigured: Boolean(config.corpId && config.agentId && config.appSecret && config.receiverId && config.appBaseUrl),
          appSecretConfigured: Boolean(config.appSecret),
          mode: config.mode,
          botId: config.botId,
          targetId: config.targetId,
          botReady: Boolean(config.botId && config.botSecret),
          corpId: config.corpId,
          agentId: config.agentId,
          receiverType: config.receiverType,
          receiverId: config.receiverId,
          appBaseUrl: config.appBaseUrl,
          callbackToken: config.callbackToken,
          encodingAesKey: config.encodingAesKey,
          callbackUrl: buildWecomCallbackUrl(userId, config.appBaseUrl),
        };
      }

      if (target.channel === 'feishu') {
        const secrets = parseFeishuSecretBundle(target.secretEncrypted);
        merged.feishu = {
          channel: 'feishu',
          enabled: target.enabled,
          configured: Boolean(secrets.webhookUrl),
          webhookHint: maskValue(secrets.webhookUrl, 52),
          signatureEnabled: Boolean(secrets.signSecret),
        };
      }

      if (target.channel === 'template') {
        merged.template = getTemplateSetting(target);
      }
    }

    return merged;
  }

  getEditableSetting(userId, channel) {
    if (!DELIVERY_CHANNELS.includes(channel)) {
      throw new Error('Unsupported notification channel.');
    }

    const target = this.getTargetsByChannel(userId)[channel] || null;

    if (channel === 'telegram') {
      const config = getTelegramConfig(target);
      return {
        channel,
        enabled: Boolean(target?.enabled),
        configured: Boolean(config.token && config.chatId),
        botToken: config.token,
        chatId: config.chatId,
      };
    }

    if (channel === 'wecom') {
      const config = getWecomConfig(target);
      return {
        channel,
        enabled: Boolean(target?.enabled),
        configured:
          Boolean(config.botId && config.botSecret)
          || Boolean(config.corpId && config.agentId && config.appSecret && config.receiverId && config.appBaseUrl),
        botConfigured: Boolean(config.botId && config.botSecret),
        botSecretConfigured: Boolean(config.botSecret),
        appConfigured: Boolean(config.corpId && config.agentId && config.appSecret && config.receiverId && config.appBaseUrl),
        appSecretConfigured: Boolean(config.appSecret),
        mode: config.mode,
        botId: config.botId,
        botSecret: config.botSecret,
        targetId: config.targetId,
        corpId: config.corpId,
        agentId: config.agentId,
        receiverType: config.receiverType,
        receiverId: config.receiverId,
        appBaseUrl: config.appBaseUrl,
        callbackToken: config.callbackToken,
        encodingAesKey: config.encodingAesKey,
        callbackUrl: buildWecomCallbackUrl(userId, config.appBaseUrl),
        appSecret: config.appSecret,
      };
    }

    const secrets = parseFeishuSecretBundle(target?.secretEncrypted);
    return {
      channel,
      enabled: Boolean(target?.enabled),
      configured: Boolean(secrets.webhookUrl),
      webhookUrl: secrets.webhookUrl,
      signSecret: secrets.signSecret,
    };
  }

  async saveSetting(userId, channel, payload) {
    if (!SETTINGS_CHANNELS.includes(channel)) {
      throw new Error('Unsupported notification channel.');
    }

    const existingTarget = this.getTargetsByChannel(userId)[channel] || null;

    if (channel === 'template') {
      const current = readTemplateConfig(existingTarget);
      const nextPresetId = getTemplatePreset(String(payload.presetId || current.presetId).trim()).id;
      const presetTemplates = getTemplatePreset(nextPresetId).templates || {};
      const incomingTemplates =
        payload.templates && typeof payload.templates === 'object'
          ? payload.templates
          : {
              telegram: payload.telegram,
              wecom: payload.wecom,
              feishu: payload.feishu,
            };

      const templates = {};
      for (const deliveryChannel of DELIVERY_CHANNELS) {
        const normalizedTemplate = sanitizeTemplateText(
          incomingTemplates?.[deliveryChannel] ?? current.templates[deliveryChannel] ?? '',
        );
        const normalizedPresetTemplate = sanitizeTemplateText(presetTemplates?.[deliveryChannel] || '');
        templates[deliveryChannel] =
          normalizedTemplate === normalizedPresetTemplate ? '' : normalizedTemplate;
      }
      const options = normalizeTemplateOptions(
        await prepareNotificationTemplateOptions(payload.options || {}, current.options),
        current.options,
      );

      upsertNotificationTarget({
        userId,
        channel,
        enabled: false,
        config: {
          presetId: nextPresetId,
          templates,
          options,
        },
      });

      return this.listSettingsForUser(userId).template;
    }

    if (channel === 'telegram') {
      const existingConfig = getTelegramConfig(existingTarget);
      const chatId = String(payload.chatId || existingTarget?.config?.chatId || '').trim();
      const botToken = String(payload.botToken || '').trim();
      const apiBaseUrl = normalizeUrl(
        payload.apiBaseUrl || existingTarget?.config?.apiBaseUrl,
        process.env.TELEGRAM_API_BASE_URL || TELEGRAM_API_BASE_URL,
      );
      const proxyUrl = String(
        payload.proxyUrl || existingTarget?.config?.proxyUrl || process.env.TELEGRAM_PROXY_URL || '',
      ).trim();
      const hasSavedToken = Boolean(existingConfig.token);

      if (payload.enabled && (!chatId || (!botToken && !hasSavedToken))) {
        throw new Error('启用 Telegram 前，请先填写 Bot Token（机器人令牌）和 Chat ID（会话 ID）。');
      }

      upsertNotificationTarget({
        userId,
        channel,
        enabled: Boolean(payload.enabled),
        secretEncrypted: botToken ? encrypt(botToken) : undefined,
        config: {
          chatId,
          apiBaseUrl,
          proxyUrl,
        },
      });

      return this.listSettingsForUser(userId).telegram;
    }

    if (channel === 'wecom') {
      const previousConfig = getWecomConfig(existingTarget);
      const mode = normalizeWecomMode(payload.mode || previousConfig.mode || 'bot');
      const botId = String(payload.botId || existingTarget?.config?.botId || '').trim();
      const targetId = String(payload.targetId || existingTarget?.config?.targetId || '').trim();
      const corpId = String(payload.corpId || existingTarget?.config?.corpId || '').trim();
      const agentId = String(payload.agentId || existingTarget?.config?.agentId || '').trim();
      const receiverType = normalizeWecomReceiverType(payload.receiverType || previousConfig.receiverType || 'user');
      const receiverId = String(payload.receiverId || existingTarget?.config?.receiverId || '').trim();
      const appBaseUrl = normalizeUrl(
        payload.appBaseUrl || existingTarget?.config?.appBaseUrl || process.env.PUBLIC_BASE_URL || '',
      );
      const callbackToken = String(
        payload.callbackToken || previousConfig.callbackToken || (mode === 'app' ? generateWecomCallbackToken() : ''),
      ).trim();
      const encodingAesKey = String(
        payload.encodingAesKey
          || previousConfig.encodingAesKey
          || (mode === 'app' ? generateWecomEncodingAesKey() : ''),
      ).trim();
      const botSecret = String(payload.botSecret || (mode === 'bot' ? payload.secret || '' : '')).trim();
      const appSecret = String(payload.appSecret || (mode === 'app' ? payload.secret || '' : '')).trim();
      const resolvedBotSecret = botSecret || previousConfig.botSecret;
      const resolvedAppSecret = appSecret || previousConfig.appSecret;

      if (payload.enabled && mode === 'bot' && (!botId || !resolvedBotSecret)) {
        throw new Error('启用企业微信机器人前，请先填写 Bot ID（机器人 ID）和 Bot Secret（机器人密钥）。');
      }

      if (payload.enabled && mode === 'app' && (!corpId || !agentId || !resolvedAppSecret || !receiverId || !appBaseUrl)) {
        const missingFields = [];
        if (!corpId) {
          missingFields.push('Corp ID（企业 ID）');
        }
        if (!agentId) {
          missingFields.push('Agent ID（应用 ID）');
        }
        if (!resolvedAppSecret) {
          missingFields.push('App Secret（应用密钥）');
        }
        if (!receiverId) {
          missingFields.push('Receiver ID（接收对象 ID）');
        }
        if (!appBaseUrl) {
          missingFields.push('Public Base URL（系统公网地址）');
        }

        throw new Error(
          `企业微信应用模式启用前还缺少：${missingFields.join('、')}。如果你现在只是先拿 Callback URL（接收消息 URL）/ Callback Token（回调令牌）/ EncodingAESKey（消息加解密密钥），请先取消勾选“启用企业微信新邮件通知”，先保存一次基础配置。`,
        );
      }

      if (
        previousConfig.mode === 'bot' &&
        previousConfig.botId &&
        previousConfig.botSecret &&
        (mode !== 'bot' || previousConfig.botId !== botId || (botSecret && previousConfig.botSecret !== botSecret))
      ) {
        wecomClientPool.reset(previousConfig.botId, previousConfig.botSecret);
      }

      upsertNotificationTarget({
        userId,
        channel,
        enabled: Boolean(payload.enabled),
        secretEncrypted: buildWecomSecretBundle({
          botSecret: resolvedBotSecret,
          appSecret: resolvedAppSecret,
          callbackToken,
          encodingAesKey,
        }),
        config: {
          mode,
          botId,
          targetId,
          corpId,
          agentId,
          receiverType,
          receiverId,
          appBaseUrl,
        },
      });

      if (botId && resolvedBotSecret) {
        this.warmupWecomListener(userId).catch((error) => {
          console.error('[wecom-discovery]', error.message || error);
        });
      }

      return this.listSettingsForUser(userId).wecom;
    }

    const existingSecrets = parseFeishuSecretBundle(existingTarget?.secretEncrypted);
    const webhookUrl = String(payload.webhookUrl || existingSecrets.webhookUrl || '').trim();
    const signSecret = String(payload.signSecret || existingSecrets.signSecret || '').trim();

    if (payload.enabled && !webhookUrl) {
        throw new Error('启用飞书前，请先填写 Webhook URL（机器人地址）。');
    }

    upsertNotificationTarget({
      userId,
      channel,
      enabled: Boolean(payload.enabled),
      secretEncrypted: buildFeishuSecretBundle({ webhookUrl, signSecret }),
      config: {},
    });

    return this.listSettingsForUser(userId).feishu;
  }

  async dispatch(target, templateTarget, mailbox, message) {
    if (target.channel === 'telegram') {
      return sendTelegram(target, templateTarget, mailbox, message);
    }

    if (target.channel === 'wecom') {
      return sendWecom(target, templateTarget, mailbox, message);
    }

    if (target.channel === 'feishu') {
      return sendFeishu(target, templateTarget, mailbox, message);
    }

    throw new Error(`Unsupported notification channel: ${target.channel}`);
  }

  async sendTest(userId, channel) {
    const targetsByChannel = this.getTargetsByChannel(userId);
    const target = targetsByChannel[channel] || null;
    if (!target) {
      throw new Error(`${channelLabel(channel)} has not been configured yet.`);
    }
    const templateTarget = targetsByChannel.template || null;
    const wecomConfig = channel === 'wecom' ? getWecomConfig(target) : null;

    const latestMessage = listMessages({
      ownerUserId: userId,
      includeAllFolders: true,
      limit: 1,
    })[0] || null;
    const mailbox = latestMessage
      ? {
          email: latestMessage.mailboxEmail || 'demo@mail-union.local',
          ownerUserId: latestMessage.ownerUserId || userId,
        }
      : {
          email: 'demo@mail-union.local',
          ownerUserId: userId,
        };
    const demoBody = [
      '这是一条用于测试通知排版效果的完整正文示例。',
      '为了让段落效果更明显，这里故意拆成多段内容，方便检查通知里的换行、层次和摘要展示是否正常。',
      '第一段：验证码内容示例为 842613，系统会自动识别并做增强展示。',
      '第二段：如果你开启了自动翻译成中文，英文邮件会先翻译，再生成通知。',
      '第三段：如果邮件里带有链接，系统会尽量保留为可点击的“网址”跳转。',
      '示例链接：https://example.com/mail-union-demo',
      '最后一段：点击“查看完整内容”后，会打开 Mail Union 里的完整邮件预览页。',
    ].join('\n');
    let message = latestMessage
      ? latestMessage
      : {
          subject: '你的登录验证码是 842613',
          fromName: 'Mail Union',
          fromAddress: 'no-reply@mail-union.local',
          receivedAt: new Date().toISOString(),
          preview: demoBody,
          textBody: demoBody,
          ownerUserId: userId,
        };

    if (!latestMessage && channel === 'wecom' && wecomConfig?.mode === 'app') {
      throw new Error('企业微信应用卡片模式测试需要系统里至少已有一封同步邮件，才能生成“查看完整内容”链接。请先同步一封邮件后再测试。');
    }

    const result = await this.dispatch(target, templateTarget, mailbox, message);
    return normalizeNotificationDispatchResult(channel, result);
  }

  async notifyNewMessages(mailbox, newMessages) {
    if (!mailbox?.ownerUserId || !Array.isArray(newMessages) || !newMessages.length) {
      return;
    }

    const deliverableMessages = newMessages.filter((message) => {
      const folderKind = String(message?.folderKind || 'inbox').trim().toLowerCase();
      return folderKind !== 'trash' && folderKind !== 'junk';
    });
    if (!deliverableMessages.length) {
      return;
    }

    const targetsByChannel = this.getTargetsByChannel(mailbox.ownerUserId);
    const templateTarget = targetsByChannel.template || null;
    const targets = Object.values(targetsByChannel).filter(
      (target) => target.enabled && DELIVERY_CHANNELS.includes(target.channel),
    );
    if (!targets.length) {
      return;
    }

    for (const message of deliverableMessages) {
      for (const target of targets) {
        try {
          const result = await this.dispatch(target, templateTarget, mailbox, message);
          if (result?.status === 'warning' && result.message) {
            console.warn(`[notify:${target.channel}]`, result.message);
          }
        } catch (error) {
          console.error(`[notify:${target.channel}]`, error.message || error);
        }
      }
    }
  }
}

function normalizeNotificationDispatchResult(channel, result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const status = String(result.status || 'sent').trim().toLowerCase() || 'sent';
    const fallbackMessage =
      status === 'skipped'
        ? `${channelLabel(channel)}没有生成可发送的测试内容。`
        : `${channelLabel(channel)}测试消息已发送。`;
    return {
      ok: result.ok !== false,
      channel,
      status,
      message: String(result.message || '').trim() || fallbackMessage,
      diagnostics:
        result.diagnostics && typeof result.diagnostics === 'object'
          ? result.diagnostics
          : {},
    };
  }

  if (result === false) {
    return {
      ok: true,
      channel,
      status: 'skipped',
      message: `${channelLabel(channel)}没有生成可发送的测试内容。`,
      diagnostics: {},
    };
  }

  return {
    ok: true,
    channel,
    status: 'sent',
    message: `${channelLabel(channel)}测试消息已发送。`,
    diagnostics: {},
  };
}

module.exports = {
  NotificationService,
};
