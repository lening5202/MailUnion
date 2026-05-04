const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createDecipheriv, createHash, randomInt, randomUUID } = require('node:crypto');
const { URL } = require('node:url');

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(process.cwd(), '.env'));
  } catch (_) {
    // Ignore missing .env in environments that inject vars differently.
  }
}

const {
  clearSessionCookie,
  createSessionCookie,
  createSessionExpiry,
  createSessionToken,
  hashPassword,
  normalizeEmail,
  normalizeUsername,
  parseCookies,
  validatePassword,
  verifyPassword,
  SESSION_COOKIE_NAME,
} = require('./auth');
const { createSignedToken, DEFAULT_SECRET, decrypt, encrypt, verifySignedToken } = require('./crypto');
const {
  bootstrapAdmin,
  clearMailboxMessages,
  consumeEmailAuthCode,
  createBackupRecord,
  createEmailAuthCode,
  createMailbox,
  createSession,
  createUser,
  databaseFile,
  deleteExpiredEmailAuthCodes,
  deleteBackupRecord,
  deleteMailbox,
  deleteSessionByToken,
  getDashboardSummary,
  getBackupRecordById,
  getLatestEmailAuthCode,
  getMailboxById,
  getMessageById,
  getMessageFolderStats,
  getMessagesByIds,
  getSystemSettings,
  getSessionUserByToken,
  getUserAuthByEmail,
  getUserAuthByUsername,
  getUserById,
  getUserByEmail,
  getUserByUsername,
  listAttachmentMetadata,
  listBackupRecords,
  listMailboxes,
  listMessages,
  listUsers,
  markUserLoggedIn,
  normalizeGoogleClientId,
  normalizeStorageSyncPolicy,
  updateMessageState,
  updateMessagesState,
  updateMailbox,
  updateMailboxDisplay,
  updateMailboxSortOrders,
  updateMailboxSyncInterval,
  updateBackupRecord,
  updateMessageAttachments,
  updateSystemSettings,
  updateUser,
} = require('./db');
const {
  buildGoogleAuthorizeUrl,
  decodeGoogleIdToken,
  exchangeGoogleCode,
} = require('./google-oauth');
const {
  buildMicrosoftAuthorizeUrl,
  decodeMicrosoftIdToken,
  exchangeMicrosoftCode,
  normalizeMicrosoftTenantId,
} = require('./microsoft-oauth');
const { NotificationService } = require('./notification-service');
const { PROVIDER_PRESETS, PROVIDER_PRESET_MAP } = require('./providers');
const {
  downloadAssetFromUrl,
  publicAssetPath,
  resolveStorageRequestPath,
  saveGeneratedSiteIcon,
  writeDataUrlAsset,
} = require('./storage');
const { BackupService } = require('./backup-service');
const {
  isAuthMailConfigured,
  sendAuthCodeMail,
  sendAuthMailTest,
  verifyAuthMailConnection,
} = require('./auth-mail');
const { normalizeStorageProvider, testRemoteStorageConnection } = require('./remote-storage');
const { testTranslationConfig, translateMessage, translateTextContent } = require('./translation-service');
const { MailSyncService } = require('./sync-service');
const {
  applyRuntimeProxyEnvironment,
  normalizeOutboundProxyBypass,
  normalizeOutboundProxyMode,
  normalizeProxyUrl,
  testOutboundConnectivity,
} = require('./outbound-network');

const PORT = Number(process.env.PORT) || 52080;
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const notificationService = new NotificationService();
const backupService = new BackupService();
const syncService = new MailSyncService({
  onNewMessages: async (mailbox, messages) => {
    await notificationService.notifyNewMessages(mailbox, messages);
  },
});

const DEFAULT_ADMIN_NAME = process.env.ADMIN_NAME || 'admin';
const DEFAULT_ADMIN_USERNAME = normalizeUsername(process.env.ADMIN_USERNAME || 'admin');
const DEFAULT_ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL || 'admin@mail-union.local');
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const MIN_SYNC_INTERVAL_SECONDS = 1;
const MAX_SYNC_INTERVAL_SECONDS = 3600;
const BACKUP_RESTORE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MICROSOFT_PERSONAL_DOMAINS = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com']);
const GOOGLE_OAUTH_REQUEST_TTL_MS = 15 * 60 * 1000;
const MICROSOFT_OAUTH_REQUEST_TTL_MS = 15 * 60 * 1000;
const googleOAuthRequests = new Map();
const microsoftOAuthRequests = new Map();

const bootstrapResult = bootstrapAdmin({
  name: DEFAULT_ADMIN_NAME,
  username: DEFAULT_ADMIN_USERNAME,
  email: DEFAULT_ADMIN_EMAIL,
  avatarUrl: String(process.env.ADMIN_AVATAR_URL || '').trim(),
  passwordHash: hashPassword(DEFAULT_ADMIN_PASSWORD),
});

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    avatarUrl: user.avatarUrl || '',
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    mailboxCount: user.mailboxCount ?? 0,
  };
}

function sanitizeMailbox(mailbox) {
  if (!mailbox) {
    return null;
  }

  return {
    id: mailbox.id,
    ownerUserId: mailbox.ownerUserId,
    ownerName: mailbox.ownerName,
    ownerEmail: mailbox.ownerEmail,
    name: mailbox.name,
    provider: mailbox.provider,
    email: mailbox.email,
    username: mailbox.username,
    authType: mailbox.authType || 'password',
    oauthEmail: mailbox.oauthEmail || '',
    oauthConfigured: Boolean(mailbox.oauthConfigured),
    oauthClientId: mailbox.oauthClientId || '',
    oauthTenantId: mailbox.oauth?.tenantId || '',
    oauthProtocolMode: mailbox.oauthProtocolMode || 'graph_imap_dual',
    oauthGraphReady: Boolean(mailbox.oauthGraphReady),
    oauthImapReady: Boolean(mailbox.oauthImapReady),
    oauthSource: mailbox.oauthSource || '',
    imapHost: mailbox.imap_host,
    imapPort: mailbox.imap_port,
    secure: mailbox.secure,
    syncAttachments: mailbox.syncAttachments !== undefined ? Boolean(mailbox.syncAttachments) : true,
    syncIntervalSeconds: mailbox.syncIntervalSeconds,
    sortOrder: Number(mailbox.sortOrder ?? 100),
    isPinned: Boolean(mailbox.isPinned),
    status: mailbox.status,
    lastError: mailbox.lastError,
    lastSyncedAt: mailbox.lastSyncedAt,
    lastUid: mailbox.lastUid,
    uidValidity: mailbox.uidValidity,
    createdAt: mailbox.createdAt,
    updatedAt: mailbox.updatedAt,
    messageCount: mailbox.messageCount,
    unreadCount: mailbox.unreadCount,
    trashCount: mailbox.trashCount,
    junkCount: mailbox.junkCount,
    latestMessageAt: mailbox.latestMessageAt,
  };
}

function sanitizeMessageListItem(message) {
  return {
    id: message.id,
    mailboxId: message.mailboxId,
    mailboxName: message.mailboxName,
    mailboxEmail: message.mailboxEmail,
    provider: message.provider,
    ownerUserId: message.ownerUserId,
    ownerName: message.ownerName,
    ownerEmail: message.ownerEmail,
    folderPath: message.folderPath,
    folderKind: message.folderKind,
    remoteUid: message.remoteUid,
    remoteId: message.remoteId || '',
    remoteSource: message.remoteSource || 'imap',
    messageId: message.messageId,
    subject: message.subject,
    fromName: message.fromName,
    fromAddress: message.fromAddress,
    to: message.to,
    receivedAt: message.receivedAt,
    preview: message.preview,
    isRead: message.isRead,
    isStarred: message.isStarred,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function sanitizeDashboard(summary) {
  return {
    stats: summary.stats,
    recentMessages: (summary.recentMessages || []).map(sanitizeMessageListItem),
    recentMailboxes: (summary.recentMailboxes || []).map(sanitizeMailbox),
  };
}

function trimString(value) {
  return String(value || '').trim();
}

function clampSyncIntervalSeconds(value, fallback = MIN_SYNC_INTERVAL_SECONDS) {
  return Math.min(
    Math.max(Number(value) || fallback || MIN_SYNC_INTERVAL_SECONDS, MIN_SYNC_INTERVAL_SECONDS),
    MAX_SYNC_INTERVAL_SECONDS,
  );
}

function normalizeMailboxSortOrder(value, fallback = 100) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.max(Math.round(numeric), 0);
  }

  const fallbackNumeric = Number(fallback);
  if (Number.isFinite(fallbackNumeric)) {
    return Math.max(Math.round(fallbackNumeric), 0);
  }

  return 100;
}

function normalizeBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return Boolean(fallback);
  }
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'off', 'no'].includes(normalized)) {
    return false;
  }

  return Boolean(fallback);
}

const PAGINATION_PAGE_SIZES = [10, 20, 50, 100, 500];

function normalizePaginationPageSize(value, fallback = 10) {
  const numeric = Number(value);
  if (PAGINATION_PAGE_SIZES.includes(numeric)) {
    return numeric;
  }
  return PAGINATION_PAGE_SIZES.includes(Number(fallback)) ? Number(fallback) : 10;
}

function normalizePaginationPage(value, fallback = 1) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 1) {
    return Math.floor(numeric);
  }
  return Math.max(Number(fallback) || 1, 1);
}

function buildAttachmentMetadataPage(viewer, options = {}) {
  const pageSize = normalizePaginationPageSize(options.pageSize || 10, 10);
  const requestedPage = normalizePaginationPage(options.page || 1, 1);
  const attachmentPage = listAttachmentMetadata({
    viewer,
    ownerUserId: viewer?.role === 'admin' ? options.ownerUserId || null : null,
    mailboxId: options.mailboxId || null,
    offset: (requestedPage - 1) * pageSize,
    limit: pageSize,
  });
  const totalItems = Number(attachmentPage?.totalItems || 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const resolvedAttachmentPage =
    page === requestedPage
      ? attachmentPage
      : listAttachmentMetadata({
          viewer,
          ownerUserId: viewer?.role === 'admin' ? options.ownerUserId || null : null,
          mailboxId: options.mailboxId || null,
          offset: (page - 1) * pageSize,
          limit: pageSize,
        });

  return {
    attachments: resolvedAttachmentPage.items,
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
    },
  };
}

function resolveAttachmentLocalStoragePath(attachment = {}) {
  const publicPath = String(attachment?.publicPath || '').trim();
  const relativePath = String(attachment?.relativePath || '').trim();
  const candidates = [];

  if (publicPath) {
    candidates.push(publicPath);
  }

  if (relativePath) {
    try {
      candidates.push(publicAssetPath(relativePath));
    } catch (_) {
      // Ignore malformed legacy paths; the caller will treat the local file as missing.
    }
  }

  for (const candidate of candidates) {
    const storagePath = resolveStorageRequestPath(candidate);
    if (storagePath) {
      return storagePath;
    }
  }

  return null;
}

function normalizeAttachmentBulkSelection(items = []) {
  const rawItems = Array.isArray(items) ? items : [];
  const seen = new Set();
  const normalized = [];

  for (const item of rawItems) {
    const messageId = String(item?.messageId || '').trim();
    const attachmentIndex = Number(item?.attachmentIndex);
    if (!messageId || !Number.isInteger(attachmentIndex) || attachmentIndex < 0) {
      continue;
    }

    const key = `${messageId}::${attachmentIndex}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({ messageId, attachmentIndex });
  }

  return normalized;
}

function resolveFolderResultCount(folderCounts = {}, folder = 'all') {
  if (folder === 'unread') {
    return Number(folderCounts.unreadCount || 0);
  }
  if (folder === 'read') {
    return Number(folderCounts.readCount || 0);
  }
  if (folder === 'starred') {
    return Number(folderCounts.starredCount || 0);
  }
  if (folder === 'trash') {
    return Number(folderCounts.trashCount || 0);
  }
  if (folder === 'junk') {
    return Number(folderCounts.junkCount || 0);
  }
  return Number(folderCounts.totalCount || 0);
}

function normalizeGoogleOauthState(value) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeMailboxAuthType(providerId, requestedAuthType, existingMailbox = null) {
  const normalizedProvider = String(providerId || '').trim().toLowerCase();
  const normalized = String(
    requestedAuthType ||
      existingMailbox?.authType ||
      (normalizedProvider === 'gmail'
        ? 'gmail_oauth'
        : normalizedProvider === 'outlook'
          ? 'microsoft_oauth'
          : 'password'),
  )
    .trim()
    .toLowerCase();

  if (normalizedProvider === 'gmail') {
    return normalized === 'password' ? 'password' : 'gmail_oauth';
  }

  if (normalizedProvider === 'outlook') {
    return normalized === 'password' ? 'password' : 'microsoft_oauth';
  }

  return 'password';
}

function resolveGoogleClientId(payload = {}, existingMailbox = null) {
  const systemSettings = getSystemSettings();
  return normalizeGoogleClientId(
    payload.googleClientId ||
      existingMailbox?.oauthClientId ||
      existingMailbox?.oauth?.clientId ||
      systemSettings?.googleClientId ||
      process.env.GOOGLE_CLIENT_ID,
  );
}

function resolveGoogleClientSecret(payload = {}, existingMailbox = null) {
  const fromPayload = trimString(payload.googleClientSecret);
  if (fromPayload) {
    return {
      plain: fromPayload,
      encrypted: encrypt(fromPayload),
    };
  }

  const encryptedExisting = trimString(existingMailbox?.oauth?.clientSecretEncrypted);
  if (encryptedExisting) {
    return {
      plain: decrypt(encryptedExisting),
      encrypted: encryptedExisting,
    };
  }

  const encryptedSystem = trimString(getSystemSettings()?.googleClientSecretEncrypted);
  if (encryptedSystem) {
    return {
      plain: decrypt(encryptedSystem),
      encrypted: encryptedSystem,
    };
  }

  const fromEnv = trimString(process.env.GOOGLE_CLIENT_SECRET);
  if (fromEnv) {
    return {
      plain: fromEnv,
      encrypted: encrypt(fromEnv),
    };
  }

  return {
    plain: '',
    encrypted: '',
  };
}

function resolveMicrosoftClientId(payload = {}, existingMailbox = null) {
  const systemSettings = getSystemSettings();
  return trimString(
    payload.microsoftClientId ||
      existingMailbox?.oauthClientId ||
      existingMailbox?.oauth?.clientId ||
      systemSettings?.microsoftClientId ||
      process.env.MICROSOFT_CLIENT_ID,
  );
}

function resolveMicrosoftClientSecret(payload = {}, existingMailbox = null) {
  const fromPayload = trimString(payload.microsoftClientSecret);
  if (fromPayload) {
    return {
      plain: fromPayload,
      encrypted: encrypt(fromPayload),
    };
  }

  const encryptedExisting = trimString(existingMailbox?.oauth?.clientSecretEncrypted);
  if (encryptedExisting) {
    return {
      plain: decrypt(encryptedExisting),
      encrypted: encryptedExisting,
    };
  }

  const encryptedSystem = trimString(getSystemSettings()?.microsoftClientSecretEncrypted);
  if (encryptedSystem) {
    return {
      plain: decrypt(encryptedSystem),
      encrypted: encryptedSystem,
    };
  }

  const fromEnv = trimString(process.env.MICROSOFT_CLIENT_SECRET);
  if (fromEnv) {
    return {
      plain: fromEnv,
      encrypted: encrypt(fromEnv),
    };
  }

  return {
    plain: '',
    encrypted: '',
  };
}

function resolveMicrosoftTenantId(payload = {}, existingMailbox = null) {
  const systemSettings = getSystemSettings();
  return normalizeMicrosoftTenantId(
    payload.microsoftTenantId ||
      existingMailbox?.oauthTenantId ||
      existingMailbox?.oauth?.tenantId ||
      systemSettings?.microsoftTenantId ||
      process.env.MICROSOFT_TENANT_ID,
  );
}

function normalizeMicrosoftProtocolMode(value, fallback = 'graph_imap_dual') {
  const normalized = String(value || fallback || 'graph_imap_dual').trim().toLowerCase();
  if (normalized === 'graph_only') {
    return 'graph_only';
  }
  if (normalized === 'imap_only') {
    return 'imap_only';
  }
  return 'graph_imap_dual';
}

function resolveMicrosoftProtocolMode(payload = {}, existingMailbox = null) {
  return normalizeMicrosoftProtocolMode(
    payload.microsoftProtocolMode ||
      existingMailbox?.oauthProtocolMode ||
      existingMailbox?.oauth?.protocolMode ||
      'graph_imap_dual',
  );
}

function requestBaseUrl(request, url) {
  const forwardedProto = trimString(String(request.headers['x-forwarded-proto'] || '').split(',')[0]);
  const forwardedHost = trimString(String(request.headers['x-forwarded-host'] || '').split(',')[0]);
  const protocol = forwardedProto || trimString(String(url.protocol || 'http:').replace(/:$/, '')) || 'http';
  const host = forwardedHost || trimString(String(request.headers.host || 'localhost'));

  return `${protocol}://${host}`;
}

function normalizePublicBaseUrlCandidate(value = '') {
  const trimmed = trimString(value);
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }

    return parsed.origin;
  } catch (_) {
    return '';
  }
}

function resolveOauthBaseUrl(request, url, preferredBaseUrl = '') {
  const explicitBaseUrl = normalizePublicBaseUrlCandidate(preferredBaseUrl);
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }

  const originHeader = normalizePublicBaseUrlCandidate(request.headers.origin);
  if (originHeader) {
    return originHeader;
  }

  const refererHeader = normalizePublicBaseUrlCandidate(request.headers.referer);
  if (refererHeader) {
    return refererHeader;
  }

  return requestBaseUrl(request, url);
}

function cleanupGoogleOAuthRequests() {
  const threshold = Date.now() - GOOGLE_OAUTH_REQUEST_TTL_MS;

  for (const [requestId, entry] of googleOAuthRequests.entries()) {
    if (Number(entry?.createdAt || 0) < threshold) {
      googleOAuthRequests.delete(requestId);
    }
  }
}

function getGoogleOAuthRequest(requestId) {
  cleanupGoogleOAuthRequests();
  return googleOAuthRequests.get(String(requestId || '').trim()) || null;
}

function getGoogleOAuthRequestByState(state) {
  cleanupGoogleOAuthRequests();
  const stateToken = trimString(state);

  for (const entry of googleOAuthRequests.values()) {
    if (entry.oauthState === stateToken) {
      return entry;
    }
  }

  return null;
}

function cleanupMicrosoftOAuthRequests() {
  const threshold = Date.now() - MICROSOFT_OAUTH_REQUEST_TTL_MS;

  for (const [requestId, entry] of microsoftOAuthRequests.entries()) {
    if (Number(entry?.createdAt || 0) < threshold) {
      microsoftOAuthRequests.delete(requestId);
    }
  }
}

function getMicrosoftOAuthRequest(requestId) {
  cleanupMicrosoftOAuthRequests();
  return microsoftOAuthRequests.get(String(requestId || '').trim()) || null;
}

function getMicrosoftOAuthRequestByState(state) {
  cleanupMicrosoftOAuthRequests();
  const stateToken = trimString(state);

  for (const entry of microsoftOAuthRequests.values()) {
    if (entry.oauthState === stateToken) {
      return entry;
    }
  }

  return null;
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(html);
}

function sendText(response, statusCode, text, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(String(text || ''));
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sanitizePreviewHtmlSource(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<frameset[\s\S]*?<\/frameset>/gi, '')
    .replace(/<frame[\s\S]*?>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/<applet[\s\S]*?<\/applet>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/\s+on[a-z-]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src|xlink:href|action|formaction)\s*=\s*(['"])\s*(javascript:|vbscript:|file:|data:text\/html)[\s\S]*?\2/gi, '');
}

function buildPreviewHtmlDocument(source = '') {
  const htmlSource = sanitizePreviewHtmlSource(source).trim();
  if (!htmlSource) {
    return '';
  }

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta name="referrer" content="no-referrer" />',
    '<style>',
    'html,body{margin:0;padding:0;background:#fff;width:100%;max-width:100%;}',
    'body{color:#0f172a;overflow-wrap:anywhere;word-break:break-word;-webkit-text-size-adjust:100%;}',
    'img,video,canvas,svg,table{max-width:100% !important;}',
    'img,video,canvas,svg{height:auto !important;}',
    'table{width:auto;max-width:100%;border-collapse:collapse;}',
    'blockquote{max-width:100%;margin-inline:0;}',
    'pre{white-space:pre-wrap;word-break:break-word;}',
    'a{overflow-wrap:anywhere;word-break:break-word;}',
    '@media (max-width:720px){body{min-width:0 !important;}table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;}td,th{word-break:break-word;}}',
    '</style>',
    '</head>',
    '<body>',
    htmlSource,
    '</body>',
    '</html>',
  ].join('');
}

function renderMessagePreviewPage(message, settings = {}) {
  const siteName = escapeHtml(String(settings?.siteName || 'Mail Union').trim() || 'Mail Union');
  const subject = escapeHtml(String(message?.subject || '无主题'));
  const fromText = escapeHtml(String(message?.fromName || message?.fromAddress || '未知发件人'));
  const mailboxText = escapeHtml(String(message?.mailboxEmail || message?.mailboxName || ''));
  const receivedAt = escapeHtml(String(message?.receivedAt || ''));
  const fallbackBody = escapeHtml(String(message?.textBody || message?.preview || '暂无可显示的邮件正文。'));
  const previewHtml = buildPreviewHtmlDocument(message?.htmlBody || '');
  const contentMarkup = previewHtml
    ? `
      <div class="preview-render-meta">
        <span class="tag">HTML 原始排版</span>
        <p>已尽量按原邮件样式展示；如果邮件依赖远程图片、特殊字体或客户端专属能力，视觉上可能会有少量差异。</p>
      </div>
      <div class="preview-frame-shell">
        <iframe
          class="preview-frame"
          title="原始邮件 HTML 正文"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerpolicy="no-referrer"
          srcdoc="${escapeHtml(previewHtml)}"
        ></iframe>
      </div>
    `
    : `
      <section class="translation-panel" id="translationPanel" hidden>
        <div class="translation-head">
          <div>
            <span class="tag tag-translate">译文预览</span>
            <h2 id="translationSubject">正在准备译文...</h2>
          </div>
          <p id="translationMeta">点击“一键翻译”后，会在原邮件基础上生成中文译文，原始正文会保留在下方。</p>
        </div>
        <div class="translation-body" id="translationBody"></div>
      </section>
      <pre class="preview-fallback">${fallbackBody}</pre>
    `;

  return `
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${subject} | ${siteName}</title>
        <style>
          :root {
            color-scheme: light;
            --bg: #eef6f7;
            --panel: rgba(255,255,255,0.92);
            --line: rgba(148,163,184,0.22);
            --text: #0f172a;
            --muted: #5b6b81;
            --accent: #14b8a6;
            --shadow: 0 24px 60px rgba(15,23,42,0.12);
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            color: var(--text);
            background:
              radial-gradient(circle at top left, rgba(20,184,166,0.12), transparent 32%),
              linear-gradient(180deg, #f4fbfb 0%, var(--bg) 100%);
            min-height: 100vh;
          }
          .shell {
            width: min(1180px, calc(100vw - 32px));
            margin: 24px auto;
            display: grid;
            gap: 18px;
          }
          .panel {
            border: 1px solid var(--line);
            border-radius: 24px;
            background: var(--panel);
            backdrop-filter: blur(14px);
            box-shadow: var(--shadow);
          }
          .hero {
            padding: 24px 26px;
            display: grid;
            gap: 14px;
          }
          .eyebrow {
            margin: 0;
            color: #567084;
            font-size: 12px;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            font-weight: 700;
          }
          h1 {
            margin: 0;
            font-size: clamp(28px, 4vw, 42px);
            line-height: 1.15;
          }
          .meta-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 12px;
          }
          .meta-card {
            padding: 14px 16px;
            border-radius: 18px;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.72);
          }
          .meta-card span {
            display: block;
            color: var(--muted);
            font-size: 12px;
            margin-bottom: 6px;
          }
          .meta-card strong {
            display: block;
            line-height: 1.6;
            word-break: break-word;
          }
          .content-panel {
            padding: 18px;
            display: grid;
            gap: 16px;
          }
          .preview-render-meta {
            display: grid;
            gap: 8px;
            padding: 16px 18px;
            border-radius: 18px;
            border: 1px solid var(--line);
            background: rgba(248,250,252,0.92);
          }
          .preview-render-meta p {
            margin: 0;
            color: var(--muted);
            line-height: 1.7;
          }
          .tag {
            display: inline-flex;
            width: fit-content;
            align-items: center;
            padding: 6px 10px;
            border-radius: 999px;
            background: rgba(20,184,166,0.1);
            color: #0f766e;
            font-size: 12px;
            font-weight: 700;
          }
          .preview-frame-shell {
            border-radius: 22px;
            overflow: hidden;
            border: 1px solid var(--line);
            background: #fff;
            min-height: 72vh;
          }
          .preview-frame {
            display: block;
            width: 100%;
            min-height: 72vh;
            border: 0;
            background: #fff;
          }
          .preview-fallback {
            margin: 0;
            padding: 20px 22px;
            border-radius: 18px;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.9);
            color: var(--text);
            line-height: 1.86;
            white-space: pre-wrap;
            word-break: break-word;
          }
          @media (max-width: 720px) {
            .shell { width: min(100vw - 18px, 1180px); margin: 12px auto; }
            .hero { padding: 18px; }
            .content-panel { padding: 12px; }
            .preview-frame-shell, .preview-frame { min-height: 78vh; }
          }
        </style>
      </head>
      <body>
        <main class="shell">
          <section class="panel hero">
            <p class="eyebrow">Mail Preview</p>
            <h1>${subject}</h1>
            <div class="meta-grid">
              <div class="meta-card"><span>发件人</span><strong>${fromText}</strong></div>
              <div class="meta-card"><span>邮箱</span><strong>${mailboxText || '未记录'}</strong></div>
              <div class="meta-card"><span>接收时间</span><strong>${receivedAt || '未记录'}</strong></div>
            </div>
          </section>
          <section class="panel content-panel">
            ${contentMarkup}
          </section>
        </main>
      </body>
    </html>
  `;
}

function buildMessageTranslationOptions(systemSettings = null) {
  const settings = systemSettings || getSystemSettings();
  return {
    translationProvider: settings?.translationProvider || process.env.TRANSLATION_PROVIDER || 'mymemory_free',
    translationTargetLanguage:
      settings?.translationTargetLanguage || process.env.TRANSLATION_TARGET_LANGUAGE || 'zh-CN',
    translationBaseUrl: settings?.translationBaseUrl || process.env.TRANSLATION_BASE_URL || '',
    translationRegion: settings?.translationRegion || process.env.TRANSLATION_REGION || '',
    translationModel: settings?.translationModel || process.env.TRANSLATION_MODEL || '',
    translationApiKey: resolveTranslationApiKey({}, settings).plain,
  };
}

async function translatePreviewTextNodes(texts = [], systemSettings = null) {
  const sourceTexts = Array.isArray(texts) ? texts : [];
  const normalized = sourceTexts.map((value) => String(value || ''));
  const uniqueOrder = [];
  const uniqueMap = new Map();

  normalized.forEach((value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    if (!uniqueMap.has(trimmed)) {
      uniqueMap.set(trimmed, '');
      uniqueOrder.push(trimmed);
    }
  });

  let translationMeta = null;
  const translationOptions = buildMessageTranslationOptions(systemSettings);
  for (const text of uniqueOrder) {
    const translation = await translateTextContent(text, translationOptions);
    uniqueMap.set(text, String(translation?.translatedText || '').trim() || text);
    if (!translationMeta) {
      translationMeta = translation;
    }
  }

  return {
    meta: translationMeta || {
      providerLabel: '',
      fallbackNotice: '',
      targetLanguage: translationOptions.translationTargetLanguage || 'zh-CN',
    },
    texts: normalized.map((value) => {
      const trimmed = value.trim();
      return trimmed ? (uniqueMap.get(trimmed) || value) : value;
    }),
  };
}

function resolvePreviewMessageAccess(token = '') {
  const tokenPayload = verifySignedToken(token);
  const expiresAt = Number(tokenPayload?.expiresAt || 0);
  const userId = String(tokenPayload?.userId || '').trim();
  const messageId = String(tokenPayload?.messageId || '').trim();
  const isValidToken =
    tokenPayload?.type === 'mail-preview'
    && userId
    && messageId
    && expiresAt
    && Date.now() <= expiresAt;

  if (!isValidToken) {
    return {
      ok: false,
      statusCode: 403,
      error: '当前预览链接无效，或已过期。',
    };
  }

  const previewUser = getUserById(userId);
  const message = previewUser ? getMessageById(messageId, previewUser) : null;
  if (!previewUser || !message) {
    return {
      ok: false,
      statusCode: 404,
      error: '对应邮件不存在，或者你已无权访问该邮件。',
    };
  }

  return {
    ok: true,
    tokenPayload,
    previewUser,
    message,
  };
}

function buildPreviewAccessPayloadFromEntryToken(token = '') {
  const tokenPayload = verifySignedToken(token);
  const messageId = String(tokenPayload?.m || '').trim();
  const userId = String(tokenPayload?.u || '').trim();
  const expiresAt = Number(tokenPayload?.e || 0);
  const channel = String(tokenPayload?.c || '').trim();

  if (!messageId || !userId || !expiresAt || Date.now() > expiresAt) {
    return null;
  }

  return {
    type: 'mail-preview',
    channel,
    messageId,
    userId,
    expiresAt,
  };
}

function renderMessagePreviewPageV2(message, settings = {}, previewToken = '') {
  const siteName = escapeHtml(String(settings?.siteName || 'Mail Union').trim() || 'Mail Union');
  const subject = escapeHtml(String(message?.subject || '无主题'));
  const fromText = escapeHtml(String(message?.fromName || message?.fromAddress || '未知发件人'));
  const mailboxText = escapeHtml(String(message?.mailboxEmail || message?.mailboxName || ''));
  const receivedAt = escapeHtml(String(message?.receivedAt || ''));
  const fallbackBody = escapeHtml(String(message?.textBody || message?.preview || '暂无可显示的邮件正文。'));
  const previewHtml = buildPreviewHtmlDocument(message?.htmlBody || '');
  const previewTokenLiteral = JSON.stringify(String(previewToken || ''));
  const contentMarkup = previewHtml
    ? `
      <section class="translation-panel" id="translationPanel" hidden>
        <div class="translation-head">
          <div>
            <span class="tag tag-translate">译文预览</span>
            <h2 id="translationSubject">正在准备译文...</h2>
          </div>
          <p id="translationMeta">点击“一键翻译”后，会在原邮件基础上生成中文译文，原始 HTML 排版保持不变。</p>
        </div>
        <div class="translation-body" id="translationBody"></div>
      </section>
      <div class="preview-frame-shell">
        <iframe
          class="preview-frame"
          id="previewFrame"
          title="原始邮件 HTML 正文"
          sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
          referrerpolicy="no-referrer"
          srcdoc="${escapeHtml(previewHtml)}"
        ></iframe>
      </div>
    `
    : `<pre class="preview-fallback">${fallbackBody}</pre>`;

  return `
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${subject} | ${siteName}</title>
        <style>
          :root {
            color-scheme: light;
            --bg: #eef6f7;
            --panel: rgba(255,255,255,0.92);
            --line: rgba(148,163,184,0.22);
            --text: #0f172a;
            --muted: #5b6b81;
            --shadow: 0 24px 60px rgba(15,23,42,0.12);
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            color: var(--text);
            background:
              radial-gradient(circle at top left, rgba(20,184,166,0.12), transparent 32%),
              linear-gradient(180deg, #f4fbfb 0%, var(--bg) 100%);
            min-height: 100vh;
          }
          .shell {
            width: min(1180px, calc(100vw - 28px));
            margin: 18px auto 24px;
            display: grid;
            gap: 16px;
          }
          .panel {
            border: 1px solid var(--line);
            border-radius: 22px;
            background: var(--panel);
            backdrop-filter: blur(14px);
            box-shadow: var(--shadow);
          }
          .hero {
            padding: 22px 24px;
            display: grid;
            gap: 14px;
          }
          .eyebrow {
            margin: 0;
            color: #567084;
            font-size: 12px;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            font-weight: 700;
          }
          h1 {
            margin: 0;
            font-size: clamp(28px, 4vw, 42px);
            line-height: 1.15;
          }
          .meta-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 12px;
          }
          .meta-card {
            padding: 14px 16px;
            border-radius: 18px;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.72);
          }
          .meta-card span {
            display: block;
            color: var(--muted);
            font-size: 12px;
            margin-bottom: 6px;
          }
          .meta-card strong {
            display: block;
            line-height: 1.6;
            word-break: break-word;
          }
          .content-panel {
            padding: 16px;
            display: grid;
            gap: 16px;
          }
          .toolbar {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 14px 16px;
            border-radius: 18px;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.82);
          }
          .toolbar-note {
            flex: 1 1 340px;
            min-width: 0;
            display: grid;
            gap: 4px;
          }
          .toolbar-note strong {
            color: var(--text);
            font-size: 15px;
            font-weight: 700;
            line-height: 1.5;
          }
          .toolbar-note span {
            color: var(--muted);
            font-size: 13px;
            line-height: 1.7;
          }
          .toolbar-actions {
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
            justify-content: flex-end;
            flex: 0 0 auto;
          }
          .translate-button {
            appearance: none;
            border: 0;
            border-radius: 999px;
            background: linear-gradient(135deg, #14b8a6 0%, #0f766e 100%);
            color: #fff;
            padding: 12px 18px;
            min-height: 44px;
            font-size: 14px;
            font-weight: 700;
            cursor: pointer;
            box-shadow: 0 14px 30px rgba(15, 118, 110, 0.18);
          }
          .translate-button[disabled] {
            opacity: 0.65;
            cursor: wait;
          }
          .translate-status {
            color: var(--muted);
            font-size: 13px;
            line-height: 1.6;
            flex: 1 1 220px;
            min-width: 0;
            text-align: right;
          }
          .tag {
            display: inline-flex;
            width: fit-content;
            align-items: center;
            padding: 6px 10px;
            border-radius: 999px;
            background: rgba(20,184,166,0.1);
            color: #0f766e;
            font-size: 12px;
            font-weight: 700;
          }
          .tag-translate {
            background: rgba(15,118,110,0.1);
          }
          .translation-panel {
            display: grid;
            gap: 16px;
            padding: 20px;
            border-radius: 20px;
            border: 1px solid rgba(20,184,166,0.22);
            background: linear-gradient(180deg, rgba(240,253,250,0.95) 0%, rgba(255,255,255,0.96) 100%);
          }
          .translation-head {
            display: grid;
            gap: 10px;
          }
          .translation-head h2 {
            margin: 10px 0 0;
            font-size: clamp(20px, 3vw, 28px);
            line-height: 1.35;
          }
          .translation-head p {
            margin: 0;
            color: var(--muted);
            line-height: 1.7;
          }
          .translation-body {
            padding: 18px 20px;
            border-radius: 18px;
            border: 1px solid rgba(148,163,184,0.22);
            background: rgba(255,255,255,0.9);
            color: var(--text);
            line-height: 1.9;
            white-space: pre-wrap;
            word-break: break-word;
          }
          .preview-frame-shell {
            border-radius: 20px;
            overflow: hidden;
            border: 1px solid var(--line);
            background: #fff;
            min-height: clamp(460px, 72vh, 960px);
          }
          .preview-frame {
            display: block;
            width: 100%;
            min-height: clamp(460px, 72vh, 960px);
            border: 0;
            background: #fff;
          }
          .preview-fallback {
            margin: 0;
            padding: 20px 22px;
            border-radius: 18px;
            border: 1px solid var(--line);
            background: rgba(255,255,255,0.9);
            color: var(--text);
            line-height: 1.86;
            white-space: pre-wrap;
            word-break: break-word;
          }
          @media (max-width: 900px) {
            .meta-grid {
              grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            }
          }
          @media (max-width: 720px) {
            .shell { width: min(100vw - 16px, 1180px); margin: 8px auto 16px; gap: 12px; }
            .panel { border-radius: 18px; }
            .hero { padding: 16px; gap: 12px; }
            h1 { font-size: clamp(24px, 7vw, 34px); }
            .meta-grid { grid-template-columns: 1fr; gap: 10px; }
            .meta-card { padding: 12px 14px; border-radius: 16px; }
            .content-panel { padding: 10px; gap: 12px; }
            .toolbar { padding: 12px; border-radius: 16px; }
            .toolbar-note { flex-basis: 100%; gap: 2px; }
            .toolbar-note strong { font-size: 14px; line-height: 1.5; }
            .toolbar-note span { font-size: 12px; line-height: 1.65; }
            .toolbar-actions { flex-direction: column; align-items: stretch; gap: 8px; }
            .translate-button { width: 100%; }
            .translate-status { flex: none; text-align: left; font-size: 12px; }
            .translation-panel { padding: 16px; border-radius: 18px; }
            .translation-body { padding: 16px; border-radius: 16px; }
            .preview-frame-shell, .preview-frame { min-height: clamp(420px, 68vh, 760px); border-radius: 18px; }
            .preview-fallback { padding: 16px; border-radius: 16px; }
          }
        </style>
      </head>
      <body>
        <main class="shell">
          <section class="panel hero">
            <p class="eyebrow">Mail Preview</p>
            <h1>${subject}</h1>
            <div class="meta-grid">
              <div class="meta-card"><span>发件人</span><strong>${fromText}</strong></div>
              <div class="meta-card"><span>邮箱</span><strong>${mailboxText || '未记录'}</strong></div>
              <div class="meta-card"><span>接收时间</span><strong>${receivedAt || '未记录'}</strong></div>
            </div>
          </section>
          <section class="panel content-panel">
            <div class="toolbar">
              <div class="toolbar-note">
                <strong>通知里只显示摘要，完整邮件在这里查看</strong>
                <span>这里会尽量按原邮件 HTML 一比一展示，点击右侧按钮可在不改变原排版的前提下生成译文。</span>
              </div>
              <div class="toolbar-actions">
                <span class="translate-status" id="translateStatus">尚未翻译</span>
                <button class="translate-button" id="translateButton" type="button">一键翻译</button>
              </div>
            </div>
            ${contentMarkup}
          </section>
        </main>
        <script>
          const previewToken = ${previewTokenLiteral};
          const translateButton = document.getElementById('translateButton');
          const translateStatus = document.getElementById('translateStatus');
          const translationPanel = document.getElementById('translationPanel');
          const translationSubject = document.getElementById('translationSubject');
          const translationMeta = document.getElementById('translationMeta');
          const translationBody = document.getElementById('translationBody');
          const previewFrame = document.getElementById('previewFrame');

          function syncPreviewFrameHeight() {
            if (!previewFrame) {
              return;
            }

            try {
              const frameDocument = previewFrame.contentDocument || previewFrame.contentWindow?.document;
              if (!frameDocument) {
                return;
              }

              const nextHeight = Math.max(
                frameDocument.documentElement?.scrollHeight || 0,
                frameDocument.body?.scrollHeight || 0,
                Math.round(window.innerHeight * (window.innerWidth <= 720 ? 0.62 : 0.72)),
              );
              if (nextHeight > 0) {
                previewFrame.style.height = nextHeight + 'px';
              }
            } catch (_) {
              // Ignore iframe resize errors and keep the minimum height.
            }
          }

          async function translatePreviewMessage() {
            if (!previewToken || !translateButton) {
              return;
            }

            translateButton.disabled = true;
            translateStatus.textContent = '正在翻译...';

            try {
              const response = await fetch('/preview/message/translate', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ token: previewToken }),
              });
              const payload = await response.json().catch(() => ({}));
              if (!response.ok) {
                throw new Error(payload.error || '翻译失败，请稍后重试。');
              }

              const translation = payload.translation || {};
              if (translationPanel) {
                translationPanel.hidden = false;
              }
              if (translationSubject) {
                translationSubject.textContent = translation.translatedSubject || '邮件译文';
              }
              if (translationBody) {
                translationBody.textContent = translation.translatedBody || '当前邮件没有可展示的译文内容。';
              }
              if (translationMeta) {
                const metaParts = [];
                if (translation.providerLabel) {
                  metaParts.push('翻译引擎：' + translation.providerLabel);
                }
                if (translation.targetLanguage) {
                  metaParts.push('目标语言：' + translation.targetLanguage);
                }
                if (translation.fallbackNotice) {
                  metaParts.push(translation.fallbackNotice);
                }
                translationMeta.textContent = metaParts.join(' · ') || '已根据原邮件正文生成译文，原始 HTML 排版保持不变。';
              }

              translateStatus.textContent = '翻译完成';
              translateButton.textContent = '重新翻译';
            } catch (error) {
              translateStatus.textContent = String(error && error.message ? error.message : error || '翻译失败');
            } finally {
              translateButton.disabled = false;
            }
          }

          if (translateButton) {
            translateButton.addEventListener('click', translatePreviewMessage);
          }

          if (previewFrame) {
            previewFrame.addEventListener('load', () => {
              syncPreviewFrameHeight();
              window.setTimeout(syncPreviewFrameHeight, 180);
              window.setTimeout(syncPreviewFrameHeight, 600);
              window.setTimeout(syncPreviewFrameHeight, 1500);
            });
            window.addEventListener('resize', syncPreviewFrameHeight);
            window.setTimeout(syncPreviewFrameHeight, 60);
          }
        </script>
      </body>
    </html>
  `;
}

function renderMessagePreviewPageV3(message, settings = {}, previewToken = '') {
  const previewTokenLiteral = JSON.stringify(String(previewToken || ''));
  const inlineScript = `
        <script>
          const previewToken = ${previewTokenLiteral};
          const translateButton = document.getElementById('translateButton');
          const translateStatus = document.getElementById('translateStatus');
          const translationPanel = document.getElementById('translationPanel');
          const previewFrame = document.getElementById('previewFrame');
          const pageSubject = document.querySelector('.hero h1');
          const fallbackBody = document.querySelector('.preview-fallback');
          const originalTitle = document.title;
          const titleSuffix = originalTitle.includes(' | ') ? originalTitle.split(' | ').slice(1).join(' | ') : '';
          const previewState = {
            translated: false,
            originalSubject: pageSubject ? pageSubject.textContent : '',
            originalTexts: [],
            nodes: [],
          };

          if (translationPanel) {
            translationPanel.remove();
          }

          function syncPreviewFrameHeight() {
            if (!previewFrame) {
              return;
            }

            try {
              const frameDocument = previewFrame.contentDocument || previewFrame.contentWindow?.document;
              if (!frameDocument) {
                return;
              }

              const nextHeight = Math.max(
                frameDocument.documentElement?.scrollHeight || 0,
                frameDocument.body?.scrollHeight || 0,
                Math.round(window.innerHeight * (window.innerWidth <= 720 ? 0.62 : 0.72)),
              );
              if (nextHeight > 0) {
                previewFrame.style.height = nextHeight + 'px';
              }
            } catch (_) {
              // Ignore iframe resize errors and keep the minimum height.
            }
          }

          function currentPreviewRoot() {
            if (previewFrame) {
              try {
                const frameDocument = previewFrame.contentDocument || previewFrame.contentWindow?.document;
                if (frameDocument && frameDocument.body) {
                  return frameDocument.body;
                }
              } catch (_) {
                return null;
              }
            }

            return fallbackBody || null;
          }

          function collectTranslatableNodes(root) {
            if (!root) {
              return [];
            }

            const blockedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'OPTION']);
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
              acceptNode(node) {
                const parentTag = node.parentElement ? node.parentElement.tagName : '';
                const text = String(node.nodeValue || '');
                if (blockedTags.has(parentTag)) {
                  return NodeFilter.FILTER_REJECT;
                }
                if (!text.trim()) {
                  return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
              },
            });

            const nodes = [];
            let currentNode = walker.nextNode();
            while (currentNode) {
              nodes.push(currentNode);
              currentNode = walker.nextNode();
            }
            return nodes;
          }

          function applyTextValues(values) {
            previewState.nodes.forEach((node, index) => {
              if (Object.prototype.hasOwnProperty.call(values, index)) {
                node.nodeValue = values[index];
              }
            });
          }

          function restoreOriginalPreview() {
            applyTextValues(previewState.originalTexts);
            if (pageSubject) {
              pageSubject.textContent = previewState.originalSubject;
            }
            document.title = originalTitle;
            previewState.translated = false;
            if (translateButton) {
              translateButton.textContent = '翻译为中文';
            }
            if (translateStatus) {
              translateStatus.textContent = '当前显示原文';
            }
            syncPreviewFrameHeight();
          }

          async function translatePreviewMessage() {
            if (!previewToken || !translateButton) {
              return;
            }

            if (previewState.translated) {
              restoreOriginalPreview();
              return;
            }

            const root = currentPreviewRoot();
            const nodes = collectTranslatableNodes(root);
            if (!nodes.length && !pageSubject) {
              if (translateStatus) {
                translateStatus.textContent = '当前页面没有可翻译的正文文本';
              }
              return;
            }

            previewState.nodes = nodes;
            previewState.originalTexts = nodes.map((node) => node.nodeValue);
            translateButton.disabled = true;
            translateStatus.textContent = '正在按原排版翻译...';

            try {
              const response = await fetch('/preview/message/translate', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  token: previewToken,
                  subject: pageSubject ? pageSubject.textContent : '',
                  texts: previewState.originalTexts,
                }),
              });
              const payload = await response.json().catch(() => ({}));
              if (!response.ok) {
                throw new Error(payload.error || '翻译失败，请稍后重试。');
              }
              if (!Array.isArray(payload.texts)) {
                throw new Error('翻译结果格式不正确，请稍后重试。');
              }

              applyTextValues(payload.texts);
              if (pageSubject && payload.subject) {
                pageSubject.textContent = payload.subject;
                document.title = titleSuffix ? payload.subject + ' | ' + titleSuffix : payload.subject;
              }

              previewState.translated = true;
              translateButton.textContent = '显示原文';
              if (translateStatus) {
                const meta = payload.translation || {};
                const parts = [];
                if (meta.providerLabel) {
                  parts.push('翻译引擎：' + meta.providerLabel);
                }
                if (meta.targetLanguage) {
                  parts.push('目标语言：' + meta.targetLanguage);
                }
                if (meta.fallbackNotice) {
                  parts.push(meta.fallbackNotice);
                }
                translateStatus.textContent = parts.join(' · ') || '当前显示译文';
              }
              syncPreviewFrameHeight();
            } catch (error) {
              translateStatus.textContent = String(error && error.message ? error.message : error || '翻译失败');
            } finally {
              translateButton.disabled = false;
            }
          }

          if (translateButton) {
            translateButton.textContent = '翻译为中文';
            translateButton.addEventListener('click', translatePreviewMessage);
          }
          if (translateStatus) {
            translateStatus.textContent = '当前显示原文';
          }

          if (previewFrame) {
            previewFrame.addEventListener('load', () => {
              syncPreviewFrameHeight();
              window.setTimeout(syncPreviewFrameHeight, 180);
              window.setTimeout(syncPreviewFrameHeight, 600);
              window.setTimeout(syncPreviewFrameHeight, 1500);
            });
            window.addEventListener('resize', syncPreviewFrameHeight);
            window.setTimeout(syncPreviewFrameHeight, 60);
          }
        </script>
  `;

  return renderMessagePreviewPageV2(message, settings, previewToken)
    .replace(/<section class="translation-panel"[\s\S]*?<\/section>/, '')
    .replace(/<script>[\s\S]*?<\/script>/, inlineScript);
}

function renderMessagePreviewErrorPage(message, settings = {}) {
  const siteName = escapeHtml(String(settings?.siteName || 'Mail Union').trim() || 'Mail Union');
  const detail = escapeHtml(String(message || '当前预览链接无效，或已过期。'));

  return `
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>邮件预览不可用 | ${siteName}</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: linear-gradient(180deg, #f7fbfb 0%, #edf4f5 100%);
            font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            color: #0f172a;
            padding: 20px;
          }
          .card {
            width: min(560px, 100%);
            padding: 28px;
            border-radius: 24px;
            border: 1px solid rgba(148,163,184,0.22);
            background: rgba(255,255,255,0.94);
            box-shadow: 0 24px 60px rgba(15,23,42,0.12);
            display: grid;
            gap: 12px;
          }
          .eyebrow {
            margin: 0;
            color: #567084;
            font-size: 12px;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            font-weight: 700;
          }
          h1 { margin: 0; font-size: 30px; }
          p { margin: 0; line-height: 1.8; color: #5b6b81; }
        </style>
      </head>
      <body>
        <section class="card">
          <p class="eyebrow">Mail Preview</p>
          <h1>邮件预览不可用</h1>
          <p>${detail}</p>
        </section>
      </body>
    </html>
  `;
}

function renderPublicLegalPage(type, settings = {}, baseUrl = '') {
  const siteName = trimString(settings?.siteName) || 'Mail Union';
  const safeSiteName = escapeHtml(siteName);
  const safeBaseUrl = escapeHtml(baseUrl);
  const homePath = '/';
  const privacyPath = '/legal/privacy';
  const termsPath = '/legal/terms';
  const safeHomeUrl = escapeHtml(homePath);
  const safePrivacyUrl = escapeHtml(privacyPath);
  const safeTermsUrl = escapeHtml(termsPath);
  const updatedAt = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
  const isPrivacy = type === 'privacy';
  const title = isPrivacy ? `${siteName} 隐私政策` : `${siteName} 服务条款`;
  const intro = isPrivacy
    ? `${siteName} 用于统一接收和管理用户已授权接入的邮箱信息。使用本系统即表示你已阅读并理解本隐私政策。`
    : `${siteName} 提供多邮箱统一收件、同步、通知和后台管理功能。使用本系统前，请先阅读以下服务条款。`;
  const sections = isPrivacy
    ? [
        {
          title: '1. 我们处理的信息',
          items: [
            '用户主动填写的账号资料，例如登录用户名、头像链接、邮箱接入配置、通知配置与系统设置。',
            '为实现统一收件功能而读取的邮件数据，包括发件人、主题、时间、正文摘要、附件信息以及同步状态。',
            '系统运行过程中产生的必要日志、同步错误信息、备份记录与安全审计信息。',
          ],
        },
        {
          title: '2. 信息使用目的',
          items: [
            '完成 Gmail、Outlook、QQ、163 等邮箱的授权接入、邮件拉取、分类展示和状态同步。',
            '按照用户设置发送 Telegram、企业微信、飞书等通知，或执行邮件翻译、备份、远程存储等功能。',
            '用于排查同步故障、提升系统稳定性与保障账号安全。',
          ],
        },
        {
          title: '3. 信息存储与保护',
          items: [
            '系统会将必要配置和同步数据保存在服务器本地数据库、附件目录或你启用的远程存储中。',
            '我们建议你仅在受控服务器环境部署本系统，并为管理员账号、数据库文件和备份文件设置访问控制。',
            '如你启用了代理、远程存储、第三方通知或翻译引擎，相关数据会按你的配置发送到对应服务商。',
          ],
        },
        {
          title: '4. 用户权利',
          items: [
            '你可以随时修改或删除已接入的邮箱、通知配置和账号信息。',
            '如不再使用本系统，可由管理员删除账号、清理邮件缓存、附件和备份文件。',
            '如果你对数据处理方式有疑问，请联系系统管理员。',
          ],
        },
      ]
    : [
        {
          title: '1. 服务说明',
          items: [
            `${siteName} 是一套用于统一接收和管理多邮箱邮件的后台系统，支持接入邮箱、同步收件箱、通知推送、翻译和备份等功能。`,
            '你应确保自己对接入的邮箱账号拥有合法使用权，并理解 OAuth2、IMAP、Graph API 等接入方式对应的权限范围。',
          ],
        },
        {
          title: '2. 用户义务',
          items: [
            '你应妥善保管管理员账号、密码、客户端密钥、刷新令牌等敏感信息，不得用于非法用途。',
            '不得利用本系统从事垃圾邮件、未授权抓取、违规监听、破坏第三方服务稳定性等行为。',
            '在为其他成员分配权限或导入邮箱前，你应确认其已获得相应授权。',
          ],
        },
        {
          title: '3. 第三方服务',
          items: [
            '本系统可接入 Google、Microsoft、Telegram、企业微信、飞书、翻译引擎和对象存储等第三方服务。',
            '第三方服务的可用性、配额限制、审核要求和合规义务由对应服务商决定，你需要自行遵守其最新规则。',
          ],
        },
        {
          title: '4. 免责声明',
          items: [
            '本系统按当前可用状态提供，部署者应自行负责服务器安全、数据备份、权限分配和合规配置。',
            '因第三方接口变更、网络波动、错误配置、账号封禁或用户误操作导致的同步失败或数据缺失，系统部署者需自行排查和承担相应影响。',
          ],
        },
      ];
  const sectionsHtml = sections
    .map(
      (section) => `
        <section class="legal-section">
          <h2>${escapeHtml(section.title)}</h2>
          <ul>
            ${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
          </ul>
        </section>
      `,
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #0f172a; color: #e2e8f0; }
      a { color: #67e8f9; }
      .shell { max-width: 920px; margin: 0 auto; padding: 48px 20px 72px; }
      .hero { padding: 28px; border-radius: 24px; background: linear-gradient(135deg, rgba(20, 184, 166, 0.18), rgba(37, 99, 235, 0.2)); border: 1px solid rgba(148, 163, 184, 0.2); box-shadow: 0 24px 60px rgba(15, 23, 42, 0.28); }
      .hero h1 { margin: 0 0 12px; font-size: 30px; }
      .hero p { margin: 0; color: #cbd5e1; line-height: 1.8; }
      .meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 18px; }
      .tag { display: inline-flex; align-items: center; min-height: 34px; padding: 0 14px; border-radius: 999px; background: rgba(15, 23, 42, 0.34); border: 1px solid rgba(148, 163, 184, 0.2); color: #e2e8f0; }
      .content { display: grid; gap: 16px; margin-top: 24px; }
      .legal-section { padding: 22px 24px; border-radius: 22px; background: rgba(15, 23, 42, 0.72); border: 1px solid rgba(148, 163, 184, 0.16); }
      .legal-section h2 { margin: 0 0 12px; font-size: 18px; }
      .legal-section ul { margin: 0; padding-left: 20px; color: #cbd5e1; line-height: 1.8; }
      .footer { margin-top: 20px; padding: 18px 20px; border-radius: 18px; background: rgba(15, 23, 42, 0.58); border: 1px solid rgba(148, 163, 184, 0.14); color: #94a3b8; line-height: 1.8; }
      .footer strong { color: #e2e8f0; }
      .origin-link-text { word-break: break-all; }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(intro)}</p>
        <div class="meta">
          <span class="tag">站点：${safeSiteName}</span>
          <span class="tag">更新：${escapeHtml(updatedAt)}</span>
          <span class="tag">主页：<a href="${safeHomeUrl}" data-origin-link="${safeHomeUrl}"><span class="origin-link-text">${safeBaseUrl || safeHomeUrl}</span></a></span>
        </div>
      </section>
      <section class="content">
        ${sectionsHtml}
      </section>
      <section class="footer">
        <strong>文档链接</strong><br />
        隐私政策：<a href="${safePrivacyUrl}" data-origin-link="${safePrivacyUrl}"><span class="origin-link-text">${safePrivacyUrl}</span></a><br />
        服务条款：<a href="${safeTermsUrl}" data-origin-link="${safeTermsUrl}"><span class="origin-link-text">${safeTermsUrl}</span></a><br />
        如果你要提交 Google OAuth 审核，建议把当前地址替换成正式部署后的公网 HTTPS 域名，并按你的实际业务补充联系信息。
      </section>
    </main>
    <script>
      (() => {
        const origin = window.location.origin || '';
        document.querySelectorAll('[data-origin-link]').forEach((link) => {
          const path = String(link.getAttribute('data-origin-link') || '').trim();
          if (!path) {
            return;
          }
          const absolute = path.startsWith('http://') || path.startsWith('https://')
            ? path
            : origin + path;
          link.href = absolute;
          const textNode = link.querySelector('.origin-link-text');
          if (textNode) {
            textNode.textContent = absolute;
          } else {
            link.textContent = absolute;
          }
        });
      })();
    </script>
  </body>
</html>`;
}

function renderGoogleOAuthResultPage(title, message, tone = 'success', options = {}) {
  const safeTitle = escapeHtml(title || 'Google OAuth2');
  const safeMessage = escapeHtml(message || '');
  const redirectUrl = trimString(options.redirectUrl || '');
  const safeRedirectUrl = escapeHtml(redirectUrl);
  const toneLabel = tone === 'error' ? '\u6388\u6743\u5931\u8d25' : '\u6388\u6743\u5b8c\u6210';

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #0f172a; color: #e2e8f0; }
      .shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .card { width: min(420px, 100%); padding: 24px; border-radius: 18px; background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(148, 163, 184, 0.22); box-shadow: 0 24px 60px rgba(15, 23, 42, 0.38); }
      h1 { margin: 0 0 10px; font-size: 22px; }
      p { margin: 0; line-height: 1.7; color: #cbd5e1; }
      .tag { display: inline-flex; align-items: center; min-height: 30px; padding: 0 12px; border-radius: 999px; margin-bottom: 14px; font-size: 13px; font-weight: 600; }
      .tag.success { background: rgba(16, 185, 129, 0.14); color: #34d399; }
      .tag.error { background: rgba(239, 68, 68, 0.14); color: #f87171; }
      .link { display: inline-flex; align-items: center; min-height: 42px; padding: 0 16px; border-radius: 12px; margin-top: 18px; color: #e2e8f0; text-decoration: none; background: rgba(37, 99, 235, 0.18); border: 1px solid rgba(96, 165, 250, 0.32); }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="card">
        <div class="tag ${tone === 'error' ? 'error' : 'success'}">${toneLabel}</div>
        <h1>${safeTitle}</h1>
        <p>${safeMessage}</p>
        ${
          safeRedirectUrl
            ? `<a class="link" href="${safeRedirectUrl}">\u8fd4\u56de\u7cfb\u7edf</a>`
            : ''
        }
      </div>
    </div>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage({ source: 'mail-union-google-oauth', tone: ${JSON.stringify(
            tone,
          )} }, window.location.origin);
          setTimeout(() => window.close(), 1200);
        } else if (${JSON.stringify(redirectUrl)}) {
          setTimeout(() => window.location.replace(${JSON.stringify(redirectUrl)}), 1200);
        }
      } catch (_) {}
    </script>
  </body>
</html>`;
}

function normalizePortalEntryPath(pathname, fallback = '/gm') {
  const normalized = trimString(pathname || '').replace(/\/+$/, '') || '/';
  if (normalized === '/gm') {
    return '/gm';
  }
  if (normalized === '/user') {
    return '/user';
  }

  return fallback === '/user' ? '/user' : '/gm';
}

function buildOAuthResultRedirectUrl(request, url, provider, tone, message = '', portalPath = '/gm', baseUrl = '') {
  const redirectUrl = new URL(`${resolveOauthBaseUrl(request, url, baseUrl)}${normalizePortalEntryPath(portalPath)}`);
  redirectUrl.hash = 'mailboxes';
  redirectUrl.searchParams.set('oauth_provider', String(provider || '').trim() || 'oauth');
  redirectUrl.searchParams.set('oauth_status', tone === 'error' ? 'error' : 'success');
  if (message) {
    redirectUrl.searchParams.set('oauth_message', String(message).trim().slice(0, 500));
  }

  return redirectUrl.toString();
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function sendFile(response, filePath, extraHeaders = {}) {
  if (!fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.zip': 'application/zip',
  };

  response.writeHead(200, {
    'Content-Type': contentTypes[extension] || 'application/octet-stream',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    ...extraHeaders,
  });
  fs.createReadStream(filePath).pipe(response);
}

function notFound(response) {
  sendJson(response, 404, { error: 'Resource not found.' });
}

function forbidden(response, message = 'You do not have permission to perform this action.') {
  sendJson(response, 403, { error: message });
}

function parseRequestPath(urlPathname) {
  const safePath = urlPathname === '/' ? '/index.html' : urlPathname;
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    return null;
  }

  return resolvedPath;
}

async function prepareSystemBrandAsset(input = {}, existingSettings = null) {
  const currentSettings = existingSettings || getSystemSettings();
  const siteName =
    trimString(input.siteName ?? currentSettings?.siteName) || 'Mail Union';
  const logoMode = normalizeSystemLogoMode(input.logoMode ?? currentSettings?.logoMode);
  const logoUrl = normalizeSystemLogoUrl(input.logoUrl ?? currentSettings?.logoUrl);
  const logoUploadDataUrl = trimString(input.logoUploadDataUrl);
  const logoUploadFilename = trimString(input.logoUploadFilename) || 'site-logo';

  if (logoMode === 'url' && logoUrl) {
    return downloadAssetFromUrl(logoUrl, {
      category: 'icons',
      filename: 'site-logo',
      prefix: 'site-logo',
    });
  }

  if (logoMode === 'upload') {
    if (logoUploadDataUrl) {
      return writeDataUrlAsset(logoUploadDataUrl, {
        category: 'icons',
        filename: logoUploadFilename,
        prefix: 'site-logo',
      });
    }

    if (String(currentSettings?.logoAssetPath || '').trim()) {
      return {
        relativePath: String(currentSettings.logoAssetPath).trim(),
      };
    }

    throw new Error('Please upload a logo image first.');
  }

  return saveGeneratedSiteIcon(siteName);
}

async function ensureSystemBrandAsset(settings = null) {
  const currentSettings = settings || getSystemSettings();
  if (String(currentSettings?.logoAssetPath || '').trim()) {
    return currentSettings;
  }

  try {
    const asset = await prepareSystemBrandAsset({}, currentSettings);
    return updateSystemSettings({
      logoAssetPath: asset.relativePath,
    });
  } catch (_) {
    return currentSettings;
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024 * 1024) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });

    request.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Request body is not valid JSON.'));
      }
    });

    request.on('error', reject);
  });
}

function readText(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
    });

    request.on('end', () => {
      resolve(body);
    });

    request.on('error', reject);
  });
}

function readRequestBodyToFile(request, filePath, options = {}) {
  return new Promise((resolve, reject) => {
    const maxBytes = Math.max(Number(options.maxBytes || BACKUP_RESTORE_UPLOAD_MAX_BYTES), 1);
    let totalBytes = 0;
    let settled = false;
    const output = fs.createWriteStream(filePath);

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      output.destroy();
      try {
        fs.rmSync(filePath, { force: true });
      } catch (_) {
        // Ignore cleanup failure for temporary upload files.
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    output.on('error', fail);
    request.on('aborted', () => fail(new Error('备份压缩包上传已中断，请重新上传。')));
    request.on('error', fail);
    request.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        request.destroy();
        fail(new Error('备份压缩包过大，请拆分后再试。'));
        return;
      }

      output.write(chunk);
    });

    request.on('end', () => {
      output.end(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          sizeBytes: totalBytes,
        });
      });
    });
  });
}

function parseXmlTagValue(xml, tagName) {
  const source = String(xml || '');
  const safeTagName = String(tagName || '').trim();
  if (!source || !safeTagName) {
    return '';
  }

  const cdataPattern = new RegExp(`<${safeTagName}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${safeTagName}>`, 'i');
  const cdataMatch = source.match(cdataPattern);
  if (cdataMatch?.[1]) {
    return cdataMatch[1];
  }

  const plainPattern = new RegExp(`<${safeTagName}>([\\s\\S]*?)<\\/${safeTagName}>`, 'i');
  const plainMatch = source.match(plainPattern);
  return plainMatch?.[1] ? plainMatch[1].trim() : '';
}

function buildWecomCallbackSignature(token, timestamp, nonce, encryptedText) {
  return createHash('sha1')
    .update(
      [String(token || ''), String(timestamp || ''), String(nonce || ''), String(encryptedText || '')]
        .sort()
        .join(''),
    )
    .digest('hex');
}

function decodeWecomEncodingAesKey(encodingAesKey = '') {
  const normalized = String(encodingAesKey || '').trim();
  const decoded = Buffer.from(`${normalized}=`, 'base64');
  if (decoded.length !== 32) {
    throw new Error('企业微信 EncodingAESKey 无效。');
  }
  return decoded;
}

function stripWecomPkcs7Padding(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('企业微信回调内容为空。');
  }

  const paddingLength = buffer[buffer.length - 1];
  if (paddingLength < 1 || paddingLength > 32) {
    throw new Error('企业微信回调填充内容无效。');
  }

  return buffer.subarray(0, buffer.length - paddingLength);
}

function decryptWecomCallbackPayload(encryptedText = '', encodingAesKey = '') {
  const aesKey = decodeWecomEncodingAesKey(encodingAesKey);
  const encryptedBuffer = Buffer.from(String(encryptedText || '').trim(), 'base64');
  const decipher = createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);

  const decryptedBuffer = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  const plainBuffer = stripWecomPkcs7Padding(decryptedBuffer);
  const messageLength = plainBuffer.readUInt32BE(16);
  const xmlStart = 20;
  const xmlEnd = xmlStart + messageLength;
  const xml = plainBuffer.subarray(xmlStart, xmlEnd).toString('utf8');
  const receiveId = plainBuffer.subarray(xmlEnd).toString('utf8');

  return {
    xml,
    receiveId,
  };
}

async function handleWecomCallbackPublicRoutes(request, response, url) {
  const callbackMatch = url.pathname.match(/^\/api\/notifications\/wecom\/callback\/([^/]+)$/);
  if (!callbackMatch) {
    return false;
  }

  const userId = decodeURIComponent(callbackMatch[1] || '');
  const callbackSetting = notificationService.getWecomCallbackSetting(userId);
  if (!callbackSetting.userId || callbackSetting.mode !== 'app') {
    sendText(response, 404, 'Not found');
    return true;
  }

  if (!callbackSetting.callbackToken || !callbackSetting.encodingAesKey || !callbackSetting.corpId) {
    sendText(response, 400, 'WeCom callback is not configured yet.');
    return true;
  }

  const timestamp = url.searchParams.get('timestamp') || '';
  const nonce = url.searchParams.get('nonce') || '';
  const signature = url.searchParams.get('msg_signature') || '';

  try {
    if (request.method === 'GET') {
      const echoStr = url.searchParams.get('echostr') || '';
      if (!echoStr) {
        throw new Error('缺少 echostr。');
      }

      const expectedSignature = buildWecomCallbackSignature(
        callbackSetting.callbackToken,
        timestamp,
        nonce,
        echoStr,
      );
      if (signature !== expectedSignature) {
        sendText(response, 403, 'Invalid signature');
        return true;
      }

      const decrypted = decryptWecomCallbackPayload(echoStr, callbackSetting.encodingAesKey);
      if (decrypted.receiveId && decrypted.receiveId !== callbackSetting.corpId) {
        throw new Error('企业微信回调 CorpID 校验失败。');
      }

      sendText(response, 200, decrypted.xml);
      return true;
    }

    if (request.method === 'POST') {
      const rawBody = await readText(request);
      const encryptedText = parseXmlTagValue(rawBody, 'Encrypt');
      if (!encryptedText) {
        throw new Error('企业微信回调缺少 Encrypt 节点。');
      }

      const expectedSignature = buildWecomCallbackSignature(
        callbackSetting.callbackToken,
        timestamp,
        nonce,
        encryptedText,
      );
      if (signature !== expectedSignature) {
        sendText(response, 403, 'Invalid signature');
        return true;
      }

      const decrypted = decryptWecomCallbackPayload(encryptedText, callbackSetting.encodingAesKey);
      if (decrypted.receiveId && decrypted.receiveId !== callbackSetting.corpId) {
        throw new Error('企业微信回调 CorpID 校验失败。');
      }

      sendText(response, 200, 'success');
      return true;
    }

    sendText(response, 405, 'Method not allowed', { Allow: 'GET, POST' });
    return true;
  } catch (error) {
    sendText(response, 400, String(error.message || error || 'WeCom callback error.'));
    return true;
  }
}

async function getAuthContext(request) {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return { user: null, token: null, clearCookie: false };
  }

  const session = getSessionUserByToken(token);
  if (!session) {
    return { user: null, token, clearCookie: true };
  }

  return {
    user: session.user,
    token,
    clearCookie: false,
  };
}

async function requireAuth(request, response) {
  const auth = await getAuthContext(request);
  if (!auth.user) {
    sendJson(
      response,
      401,
      { error: 'Please sign in first.' },
      auth.clearCookie ? { 'Set-Cookie': clearSessionCookie() } : {},
    );
    return null;
  }

  return auth;
}

function requireAdmin(auth, response) {
  if (auth.user.role !== 'admin') {
    forbidden(response, 'Administrator permission required.');
    return false;
  }

  return true;
}

function validateUsernameValue(username) {
  const value = normalizeUsername(username);
  if (!value) {
    throw new Error('Please provide a username.');
  }
  if (value.length < 2) {
    throw new Error('Username must be at least 2 characters.');
  }
  return value;
}

function localRuntimeAssetPath(relativePath = '') {
  const normalized = String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean);

  if (!normalized.length) {
    return '';
  }

  return path.join('runtime', 'files', ...normalized);
}

function normalizeAvatarUrl(value) {
  const url = String(value || '').trim();
  if (!url) {
    return '';
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Avatar URL must start with http or https.');
  }

  return url;
}

function normalizeSystemLogoMode(value) {
  const normalized = String(value || 'auto').trim().toLowerCase();
  return ['auto', 'url', 'upload'].includes(normalized) ? normalized : 'auto';
}

function normalizeSystemLogoUrl(value) {
  const url = String(value || '').trim();
  if (!url) {
    return '';
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Site logo URL must start with http or https.');
  }

  return url;
}

function normalizeTranslationProvider(value) {
  const normalized = String(value || 'google_free').trim().toLowerCase();
  return ['google_free', 'mymemory_free', 'libretranslate', 'azure_translator', 'openai_compatible'].includes(normalized)
    ? normalized
    : 'google_free';
}

function normalizeTranslationTargetLanguage(value) {
  const normalized = String(value || 'zh-CN').trim();
  return normalized ? normalized.slice(0, 40) : 'zh-CN';
}

function normalizeTranslationBaseUrl(value) {
  const url = String(value || '').trim();
  if (!url) {
    return '';
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Translation base URL must start with http or https.');
  }

  return url.replace(/\/+$/, '');
}

function normalizeTranslationRegion(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 80) : '';
}

function resolveTranslationApiKey(payload = {}, settings = null) {
  const fromPayload = trimString(payload.translationApiKey);
  if (fromPayload) {
    return {
      plain: fromPayload,
      encrypted: encrypt(fromPayload),
    };
  }

  const encryptedSetting = trimString((settings || getSystemSettings())?.translationApiKeyEncrypted);
  if (encryptedSetting) {
    return {
      plain: decrypt(encryptedSetting),
      encrypted: encryptedSetting,
    };
  }

  const fromEnv = trimString(process.env.TRANSLATION_API_KEY);
  if (fromEnv) {
    return {
      plain: fromEnv,
      encrypted: encrypt(fromEnv),
    };
  }

  return {
    plain: '',
    encrypted: '',
  };
}

function resolveSystemStorageSecret(field, settings = null) {
  const currentSettings = settings || getSystemSettings();

  if (field === 'storageS3Secret') {
    const fromPayload = trimString(currentSettings?.storageS3Secret);
    if (fromPayload) {
      return { plain: fromPayload };
    }
    return {
      plain: trimString(currentSettings?.storageS3SecretEncrypted)
        ? decrypt(String(currentSettings.storageS3SecretEncrypted))
        : '',
    };
  }

  if (field === 'storageWebdavPassword') {
    const fromPayload = trimString(currentSettings?.storageWebdavPassword);
    if (fromPayload) {
      return { plain: fromPayload };
    }
    return {
      plain: trimString(currentSettings?.storageWebdavPasswordEncrypted)
        ? decrypt(String(currentSettings.storageWebdavPasswordEncrypted))
        : '',
    };
  }

  if (field === 'storageFtpPassword') {
    const fromPayload = trimString(currentSettings?.storageFtpPassword);
    if (fromPayload) {
      return { plain: fromPayload };
    }
    return {
      plain: trimString(currentSettings?.storageFtpPasswordEncrypted)
        ? decrypt(String(currentSettings.storageFtpPasswordEncrypted))
        : '',
    };
  }

  return {
    plain: '',
  };
}

function sanitizeSystemSettings(settings, options = {}) {
  const includeAuthConfig = options.includeAuthConfig !== undefined ? Boolean(options.includeAuthConfig) : true;
  const includeSmtpConfig = Boolean(options.includeSmtpConfig);
  const includeGoogleClientId = Boolean(options.includeGoogleClientId);
  const includeMicrosoftClientId = Boolean(options.includeMicrosoftClientId);
  const includeTranslationConfig = Boolean(options.includeTranslationConfig);
  const includeStorageConfig = Boolean(options.includeStorageConfig);
  const includeBackupConfig = Boolean(options.includeBackupConfig);
  const includeProxyConfig = Boolean(options.includeProxyConfig);
  const resolvedGoogleClientId = String(
    settings?.googleClientId || process.env.GOOGLE_CLIENT_ID || '',
  ).trim();
  const googleClientSecretConfigured =
    Boolean(settings?.googleClientSecretConfigured) ||
    Boolean(String(process.env.GOOGLE_CLIENT_SECRET || '').trim());
  const resolvedMicrosoftClientId = String(
    settings?.microsoftClientId || process.env.MICROSOFT_CLIENT_ID || '',
  ).trim();
  const resolvedMicrosoftTenantId = normalizeMicrosoftTenantId(
    settings?.microsoftTenantId || process.env.MICROSOFT_TENANT_ID,
  );
  const microsoftClientSecretConfigured =
    Boolean(settings?.microsoftClientSecretConfigured) ||
    Boolean(String(process.env.MICROSOFT_CLIENT_SECRET || '').trim());
  const resolvedTranslationProvider = normalizeTranslationProvider(
    settings?.translationProvider || process.env.TRANSLATION_PROVIDER,
  );
  const resolvedTranslationTargetLanguage = normalizeTranslationTargetLanguage(
    settings?.translationTargetLanguage || process.env.TRANSLATION_TARGET_LANGUAGE,
  );
  const resolvedTranslationBaseUrl = normalizeTranslationBaseUrl(
    settings?.translationBaseUrl || process.env.TRANSLATION_BASE_URL,
  );
  const resolvedTranslationRegion = normalizeTranslationRegion(
    settings?.translationRegion || process.env.TRANSLATION_REGION,
  );
  const resolvedTranslationModel = trimString(
    settings?.translationModel || process.env.TRANSLATION_MODEL,
  );
  const translationApiKeyConfigured =
    Boolean(settings?.translationApiKeyConfigured) ||
    Boolean(String(process.env.TRANSLATION_API_KEY || '').trim());
  const resolvedStorageProvider = normalizeStorageProvider(settings?.storageProvider || 'local');
  const resolvedOutboundProxyMode = normalizeOutboundProxyMode(
    settings?.outboundProxyMode || process.env.MAIL_UNION_OUTBOUND_PROXY_MODE,
    'system',
  );
  const resolvedOutboundProxyUrl = normalizeProxyUrl(
    settings?.outboundProxyUrl || process.env.MAIL_UNION_OUTBOUND_PROXY_URL,
  );
  const resolvedOutboundProxyBypass = normalizeOutboundProxyBypass(
    settings?.outboundProxyBypass || process.env.MAIL_UNION_OUTBOUND_PROXY_BYPASS,
  );
  const registrationSettings = readRegistrationSettings(settings);

  return {
    siteName: String(settings?.siteName || 'Mail Union').trim() || 'Mail Union',
    logoMode: normalizeSystemLogoMode(settings?.logoMode),
    logoUrl: String(settings?.logoUrl || '').trim(),
    logoAssetUrl: publicAssetPath(String(settings?.logoAssetPath || '').trim()),
    logoAssetLocalPath: localRuntimeAssetPath(String(settings?.logoAssetPath || '').trim()),
    googleClientId: includeGoogleClientId ? resolvedGoogleClientId : '',
    googleClientSecretConfigured,
    googleAppConfigured: Boolean(resolvedGoogleClientId && googleClientSecretConfigured),
    microsoftClientId: includeMicrosoftClientId ? resolvedMicrosoftClientId : '',
    microsoftClientSecretConfigured,
    microsoftTenantId: resolvedMicrosoftTenantId,
    microsoftAppConfigured: Boolean(resolvedMicrosoftClientId),
    registrationEnabled: includeAuthConfig ? registrationSettings.registrationEnabled : true,
    registrationEmailVerificationRequired: includeAuthConfig
      ? registrationSettings.registrationEmailVerificationRequired
      : false,
    registrationEmailDomainWhitelist: includeAuthConfig
      ? registrationSettings.registrationEmailDomainWhitelist
      : [],
    passwordResetEnabled: includeAuthConfig ? registrationSettings.passwordResetEnabled : false,
    sessionTimeoutValue: includeAuthConfig ? Math.max(Number(settings?.sessionTimeoutValue || 7) || 7, 1) : 7,
    sessionTimeoutUnit: includeAuthConfig
      ? ['minute', 'hour', 'day', 'month', 'year'].includes(String(settings?.sessionTimeoutUnit || '').trim())
        ? String(settings?.sessionTimeoutUnit || '').trim()
        : 'day'
      : 'day',
    smtpHost: includeSmtpConfig ? String(settings?.smtpHost || '').trim() : '',
    smtpPort: includeSmtpConfig ? Number(settings?.smtpPort || 587) : 587,
    smtpSecure: includeSmtpConfig ? Boolean(settings?.smtpSecure) : false,
    smtpUsername: includeSmtpConfig ? String(settings?.smtpUsername || '').trim() : '',
    smtpPasswordConfigured: includeSmtpConfig ? Boolean(settings?.smtpPasswordConfigured) : false,
    smtpFromName: includeSmtpConfig ? String(settings?.smtpFromName || 'Mail Union').trim() || 'Mail Union' : '',
    smtpFromEmail: includeSmtpConfig ? String(settings?.smtpFromEmail || '').trim() : '',
    translationProvider: includeTranslationConfig ? resolvedTranslationProvider : 'mymemory_free',
    translationTargetLanguage: includeTranslationConfig ? resolvedTranslationTargetLanguage : 'zh-CN',
    translationBaseUrl: includeTranslationConfig ? resolvedTranslationBaseUrl : '',
    translationRegion: includeTranslationConfig ? resolvedTranslationRegion : '',
    translationModel: includeTranslationConfig ? resolvedTranslationModel : '',
    translationApiKeyConfigured: includeTranslationConfig ? translationApiKeyConfigured : false,
    storageProvider: includeStorageConfig ? resolvedStorageProvider : 'local',
    storageSyncPolicy: includeStorageConfig
      ? normalizeStorageSyncPolicy(settings?.storageSyncPolicy, 'all_local')
      : 'all_local',
    storageRemotePathPrefix: includeStorageConfig
      ? String(settings?.storageRemotePathPrefix || 'mail-union').trim() || 'mail-union'
      : 'mail-union',
    storageS3Bucket: includeStorageConfig ? String(settings?.storageS3Bucket || '').trim() : '',
    storageS3Region: includeStorageConfig ? String(settings?.storageS3Region || '').trim() : '',
    storageS3Endpoint: includeStorageConfig ? String(settings?.storageS3Endpoint || '').trim() : '',
    storageS3AccessKey: includeStorageConfig ? String(settings?.storageS3AccessKey || '').trim() : '',
    storageS3SecretConfigured: includeStorageConfig
      ? Boolean(settings?.storageS3SecretConfigured)
      : false,
    storageS3ForcePathStyle: includeStorageConfig
      ? Boolean(settings?.storageS3ForcePathStyle)
      : false,
    storageWebdavUrl: includeStorageConfig ? String(settings?.storageWebdavUrl || '').trim() : '',
    storageWebdavUsername: includeStorageConfig
      ? String(settings?.storageWebdavUsername || '').trim()
      : '',
    storageWebdavPasswordConfigured: includeStorageConfig
      ? Boolean(settings?.storageWebdavPasswordConfigured)
      : false,
    storageFtpHost: includeStorageConfig ? String(settings?.storageFtpHost || '').trim() : '',
    storageFtpPort: includeStorageConfig ? Number(settings?.storageFtpPort || 21) : 21,
    storageFtpSecure: includeStorageConfig ? Boolean(settings?.storageFtpSecure) : false,
    storageFtpUsername: includeStorageConfig ? String(settings?.storageFtpUsername || '').trim() : '',
    storageFtpPasswordConfigured: includeStorageConfig
      ? Boolean(settings?.storageFtpPasswordConfigured)
      : false,
    backupEnabled: includeBackupConfig ? Boolean(settings?.backupEnabled) : false,
    backupIntervalHours: includeBackupConfig ? Number(settings?.backupIntervalHours || 24) : 24,
    backupTarget: includeBackupConfig
      ? String(settings?.backupTarget || 'local').trim() || 'local'
      : 'local',
    backupRetentionCount: includeBackupConfig ? Number(settings?.backupRetentionCount || 10) : 10,
    backupContentMode: includeBackupConfig
      ? String(settings?.backupContentMode || 'database_and_site').trim() || 'database_and_site'
      : 'database_and_site',
    backupIncludeRuntimeFiles: includeBackupConfig
      ? Boolean(settings?.backupIncludeRuntimeFiles)
      : true,
    outboundProxyMode: includeProxyConfig ? resolvedOutboundProxyMode : 'system',
    outboundProxyUrl: includeProxyConfig ? resolvedOutboundProxyUrl : '',
    outboundProxyBypass: includeProxyConfig ? resolvedOutboundProxyBypass : '',
    themePresetId: String(settings?.themePresetId || 'ocean-mist').trim() || 'ocean-mist',
    createdAt: settings?.createdAt || null,
    updatedAt: settings?.updatedAt || null,
  };
}

function sanitizeBackupRecord(record) {
  if (!record) {
    return null;
  }

  const localReady = Boolean(record.localPath && fs.existsSync(record.localPath));

  return {
    id: record.id,
    filename: String(record.filename || '').trim(),
    status: String(record.status || 'pending').trim() || 'pending',
    triggerSource: String(record.triggerSource || 'manual').trim() || 'manual',
    destination: String(record.destination || 'local').trim() || 'local',
    localReady,
    remoteReady: Boolean(String(record.remotePath || '').trim()),
    remotePath: String(record.remotePath || '').trim(),
    sizeBytes: Number(record.sizeBytes || 0),
    sha256: String(record.sha256 || '').trim(),
    error: String(record.error || '').trim(),
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    downloadUrl: localReady ? `/api/backups/${encodeURIComponent(record.id)}/download` : '',
  };
}

function isGeneratedUserEmail(email) {
  return /@users\\.mail-union\\.local$/i.test(String(email || '').trim());
}

function buildUserEmail(preferredEmail, username, existingUserId = null) {
  const normalizedPreferred = normalizeEmail(preferredEmail);
  if (normalizedPreferred) {
    const conflict = getUserByEmail(normalizedPreferred);
    if (!conflict || conflict.id === existingUserId) {
      return normalizedPreferred;
    }
    throw new Error('This contact email is already in use.');
  }

  const base = `${normalizeUsername(username) || 'user'}@users.mail-union.local`;
  let candidate = base;
  let suffix = 2;
  while (true) {
    const conflict = getUserByEmail(candidate);
    if (!conflict || conflict.id === existingUserId) {
      return candidate;
    }
    candidate = `${normalizeUsername(username) || 'user'}-${suffix}@users.mail-union.local`;
    suffix += 1;
  }
}

function readRegistrationSettings(settings = getSystemSettings()) {
  return {
    registrationEnabled: Boolean(settings?.registrationEnabled ?? true),
    registrationEmailVerificationRequired: Boolean(settings?.registrationEmailVerificationRequired),
    registrationEmailDomainWhitelist: Array.isArray(settings?.registrationEmailDomainWhitelist)
      ? settings.registrationEmailDomainWhitelist
      : [],
    passwordResetEnabled: Boolean(settings?.passwordResetEnabled),
  };
}

function hashEmailAuthCode(code) {
  return createHash('sha256').update(String(code || '').trim()).digest('hex');
}

function createEmailAuthCodeValue() {
  return String(randomInt(100000, 1000000));
}

function maskEmailAddress(email) {
  const normalized = normalizeEmail(email);
  const [localPart, domainPart] = normalized.split('@');
  if (!localPart || !domainPart) {
    return normalized;
  }
  const visibleLocal = localPart.length <= 2 ? localPart.slice(0, 1) : localPart.slice(0, 2);
  return `${visibleLocal}***@${domainPart}`;
}

function normalizeRegistrationWhitelist(settings = getSystemSettings()) {
  return Array.isArray(settings?.registrationEmailDomainWhitelist)
    ? settings.registrationEmailDomainWhitelist
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
    : [];
}

function isRegistrationEmailAllowed(email, settings = getSystemSettings()) {
  const whitelist = normalizeRegistrationWhitelist(settings);
  if (!whitelist.length) {
    return true;
  }

  const normalizedEmail = normalizeEmail(email);
  return whitelist.some((domain) => normalizedEmail.endsWith(domain));
}

function assertRegistrationEmailAllowed(email, settings = getSystemSettings()) {
  if (!isRegistrationEmailAllowed(email, settings)) {
    throw new Error('当前注册仅允许指定邮箱域名，请更换符合白名单的邮箱。');
  }
}

function ensureAuthMailReady(settings = getSystemSettings(), purpose = 'register') {
  if (!isAuthMailConfigured(settings)) {
    throw new Error(
      purpose === 'reset'
        ? '管理员还没有配置 SMTP 发信功能，暂时无法通过邮箱重置密码。'
        : '管理员还没有配置 SMTP 发信功能，暂时无法发送注册验证码。',
    );
  }
}

async function issueEmailAuthCode({ email, purpose, userId = null, settings = getSystemSettings() }) {
  deleteExpiredEmailAuthCodes();
  const latest = getLatestEmailAuthCode(email, purpose);
  if (latest?.created_at) {
    const latestCreatedAt = new Date(latest.created_at).getTime();
    if (Number.isFinite(latestCreatedAt) && Date.now() - latestCreatedAt < 60 * 1000) {
      throw new Error('验证码发送过于频繁，请等待 60 秒后再试。');
    }
  }

  const code = createEmailAuthCodeValue();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  createEmailAuthCode({
    email,
    purpose,
    userId,
    codeHash: hashEmailAuthCode(code),
    expiresAt,
  });
  await sendAuthCodeMail(
    {
      to: email,
      purpose,
      code,
    },
    settings,
  );

  return {
    email: normalizeEmail(email),
    maskedEmail: maskEmailAddress(email),
    expiresAt,
  };
}

function verifyEmailAuthCodeOrThrow({ email, purpose, code, userId = null }) {
  const verified = consumeEmailAuthCode({
    email,
    purpose,
    userId,
    codeHash: hashEmailAuthCode(code),
  });
  if (!verified) {
    throw new Error('验证码无效或已过期，请重新获取。');
  }
  return verified;
}

function assertRegistrationEmailAllowed(email, settings = getSystemSettings()) {
  if (!isRegistrationEmailAllowed(email, settings)) {
    throw new Error('当前注册只允许指定邮箱域名，请更换为白名单中的邮箱。');
  }
}

function ensureAuthMailReady(settings = getSystemSettings(), purpose = 'register') {
  if (!isAuthMailConfigured(settings)) {
    throw new Error(
      purpose === 'reset'
        ? '管理员还没有配置 SMTP 发信功能，暂时无法通过邮箱重置密码。'
        : '管理员还没有配置 SMTP 发信功能，暂时无法发送注册验证码。',
    );
  }
}

async function issueEmailAuthCode({ email, purpose, userId = null, settings = getSystemSettings() }) {
  deleteExpiredEmailAuthCodes();
  const latest = getLatestEmailAuthCode(email, purpose);
  if (latest?.created_at) {
    const latestCreatedAt = new Date(latest.created_at).getTime();
    if (Number.isFinite(latestCreatedAt) && Date.now() - latestCreatedAt < 60 * 1000) {
      throw new Error('验证码发送过于频繁，请等待 60 秒后再试。');
    }
  }

  const code = createEmailAuthCodeValue();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  createEmailAuthCode({
    email,
    purpose,
    userId,
    codeHash: hashEmailAuthCode(code),
    expiresAt,
  });
  await sendAuthCodeMail(
    {
      to: email,
      purpose,
      code,
    },
    settings,
  );

  return {
    email: normalizeEmail(email),
    maskedEmail: maskEmailAddress(email),
    expiresAt,
  };
}

function verifyEmailAuthCodeOrThrow({ email, purpose, code, userId = null }) {
  const verified = consumeEmailAuthCode({
    email,
    purpose,
    userId,
    codeHash: hashEmailAuthCode(code),
  });
  if (!verified) {
    throw new Error('验证码无效或已过期，请重新获取。');
  }
  return verified;
}

function resolvePortalPathForUser(user, preferredPortalPath = '') {
  if (user?.role === 'admin') {
    return '/gm';
  }

  if (normalizePortalEntryPath(preferredPortalPath, '/user') === '/user') {
    return '/user';
  }

  return '/user';
}

function resolveUserForPasswordReset(payload = {}) {
  const login = trimString(payload.login || payload.username || payload.account);
  const directEmail = normalizeEmail(payload.email);
  const candidateByLogin =
    (login && (getUserAuthByUsername(normalizeUsername(login)) || getUserAuthByEmail(normalizeEmail(login)))) ||
    null;
  const candidateByEmail = directEmail ? getUserAuthByEmail(directEmail) : null;
  const user = candidateByLogin || candidateByEmail;

  if (!user) {
    throw new Error('没有找到可重置密码的账号，请检查登录用户名或联系邮箱。');
  }

  if (directEmail && normalizeEmail(user.email) !== directEmail) {
    throw new Error('填写的联系邮箱与当前账号不匹配。');
  }

  const normalizedUserEmail = normalizeEmail(user.email);
  if (!normalizedUserEmail || isGeneratedUserEmail(normalizedUserEmail)) {
    throw new Error('当前账号没有可用的联系邮箱，暂时无法通过邮箱找回密码。');
  }

  return user;
}

function buildDraftSmtpSettings(existingSettings = {}, payload = {}) {
  const clearSmtpPassword = normalizeBooleanFlag(payload.clearSmtpPassword, false);
  const nextPassword = Object.prototype.hasOwnProperty.call(payload, 'smtpPassword')
    ? trimString(payload.smtpPassword)
    : '';
  const encryptedPassword = nextPassword
    ? encrypt(nextPassword)
    : clearSmtpPassword
      ? ''
      : String(existingSettings.smtpPasswordEncrypted || '').trim();

  return {
    ...existingSettings,
    smtpHost: Object.prototype.hasOwnProperty.call(payload, 'smtpHost')
      ? trimString(payload.smtpHost)
      : String(existingSettings.smtpHost || '').trim(),
    smtpPort: Object.prototype.hasOwnProperty.call(payload, 'smtpPort')
      ? Number(payload.smtpPort || 587)
      : Number(existingSettings.smtpPort || 587),
    smtpSecure: Object.prototype.hasOwnProperty.call(payload, 'smtpSecure')
      ? normalizeBooleanFlag(payload.smtpSecure, false)
      : Boolean(existingSettings.smtpSecure),
    smtpUsername: Object.prototype.hasOwnProperty.call(payload, 'smtpUsername')
      ? trimString(payload.smtpUsername)
      : String(existingSettings.smtpUsername || '').trim(),
    smtpPasswordEncrypted: encryptedPassword,
    smtpPasswordConfigured: Boolean(encryptedPassword),
    smtpFromName: Object.prototype.hasOwnProperty.call(payload, 'smtpFromName')
      ? trimString(payload.smtpFromName) || 'Mail Union'
      : String(existingSettings.smtpFromName || 'Mail Union').trim() || 'Mail Union',
    smtpFromEmail: Object.prototype.hasOwnProperty.call(payload, 'smtpFromEmail')
      ? normalizeEmail(payload.smtpFromEmail)
      : normalizeEmail(existingSettings.smtpFromEmail),
  };
}

function buildMailboxUpsertPayload(payload, currentUser, existingMailbox = null) {
  const providerId = String(payload.provider || existingMailbox?.provider || 'generic');
  const preset = PROVIDER_PRESET_MAP[providerId] || PROVIDER_PRESET_MAP.generic;
  const authType = normalizeMailboxAuthType(providerId, payload.authType, existingMailbox);
  const password = trimString(payload.password);
  const ownerUserId =
    currentUser.role === 'admin'
      ? String(payload.ownerUserId || existingMailbox?.ownerUserId || currentUser.id)
      : currentUser.id;
  const imapHost = trimString(payload.imapHost || existingMailbox?.imap_host || preset.imapHost || '');
  const imapPort = Number(payload.imapPort || existingMailbox?.imap_port || preset.imapPort || 993);
  const secure =
    payload.secure === false || payload.secure === 'false'
      ? false
      : Boolean(payload.secure ?? existingMailbox?.secure ?? preset.secure);
  const syncIntervalSeconds = clampSyncIntervalSeconds(
    payload.syncIntervalSeconds,
    Number(existingMailbox?.syncIntervalSeconds) || MIN_SYNC_INTERVAL_SECONDS,
  );
  const syncAttachments = normalizeBooleanFlag(
    payload.syncAttachments,
    existingMailbox?.syncAttachments ?? true,
  );
  const sortOrder = normalizeMailboxSortOrder(payload.sortOrder, existingMailbox?.sortOrder ?? 100);
  const isPinned = normalizeBooleanFlag(payload.isPinned, existingMailbox?.isPinned ?? false);
  const existingOauth = normalizeGoogleOauthState(existingMailbox?.oauth);
  const baseEmail =
    normalizeEmail(payload.email || existingMailbox?.email || '') ||
    normalizeEmail(payload.oauthEmail || existingOauth.email || existingMailbox?.oauthEmail || '');
  const username = trimString(payload.username || existingMailbox?.username || baseEmail);
  const name = trimString(payload.name || existingMailbox?.name || baseEmail);

  if (!imapHost) {
    throw new Error('Please provide the IMAP host.');
  }
  if (!imapPort) {
    throw new Error('Please provide the IMAP port.');
  }

  if (authType === 'gmail_oauth' || authType === 'microsoft_oauth') {
    const isGoogleOauth = authType === 'gmail_oauth';
    const clientId = isGoogleOauth
      ? resolveGoogleClientId(payload, existingMailbox)
      : resolveMicrosoftClientId(payload, existingMailbox);
    const clientSecret = isGoogleOauth
      ? resolveGoogleClientSecret(payload, existingMailbox)
      : resolveMicrosoftClientSecret(payload, existingMailbox);
    const microsoftProtocolMode = isGoogleOauth
      ? 'graph_imap_dual'
      : resolveMicrosoftProtocolMode(payload, existingMailbox);
    const sharedMicrosoftRefreshToken = isGoogleOauth ? '' : trimString(payload.microsoftRefreshToken);
    const graphMicrosoftRefreshToken = isGoogleOauth
      ? ''
      : trimString(payload.microsoftGraphRefreshToken || sharedMicrosoftRefreshToken);
    const imapMicrosoftRefreshToken = isGoogleOauth
      ? ''
      : trimString(payload.microsoftImapRefreshToken || sharedMicrosoftRefreshToken);
    const sharedMicrosoftRefreshTokenEncrypted = sharedMicrosoftRefreshToken
      ? encrypt(sharedMicrosoftRefreshToken)
      : trimString(existingOauth.sharedRefreshTokenEncrypted || existingOauth.refreshTokenEncrypted);
    const graphMicrosoftRefreshTokenEncrypted = graphMicrosoftRefreshToken
      ? encrypt(graphMicrosoftRefreshToken)
      : trimString(existingOauth.graphRefreshTokenEncrypted || sharedMicrosoftRefreshTokenEncrypted);
    const imapMicrosoftRefreshTokenEncrypted = imapMicrosoftRefreshToken
      ? encrypt(imapMicrosoftRefreshToken)
      : trimString(
          existingOauth.imapRefreshTokenEncrypted ||
            existingOauth.refreshTokenEncrypted ||
            sharedMicrosoftRefreshTokenEncrypted,
        );
    const oauth = {
      ...existingOauth,
      clientId,
      clientSecretEncrypted: clientSecret.encrypted || existingOauth.clientSecretEncrypted || '',
      email: baseEmail || trimString(existingOauth.email),
      ...(isGoogleOauth
        ? {}
        : {
            tenantId: resolveMicrosoftTenantId(payload, existingMailbox),
            protocolMode: microsoftProtocolMode,
            source: trimString(payload.microsoftRefreshToken || payload.microsoftGraphRefreshToken || payload.microsoftImapRefreshToken)
              ? 'manual'
              : trimString(existingOauth.source || 'oauth'),
            sharedRefreshTokenEncrypted: sharedMicrosoftRefreshTokenEncrypted,
            graphRefreshTokenEncrypted: graphMicrosoftRefreshTokenEncrypted,
            imapRefreshTokenEncrypted: imapMicrosoftRefreshTokenEncrypted,
            refreshTokenEncrypted: imapMicrosoftRefreshTokenEncrypted || sharedMicrosoftRefreshTokenEncrypted,
          }),
    };
    const hasOauthRefreshToken = isGoogleOauth
      ? Boolean(oauth.refreshTokenEncrypted)
      : Boolean(
          oauth.sharedRefreshTokenEncrypted ||
            oauth.graphRefreshTokenEncrypted ||
            oauth.imapRefreshTokenEncrypted ||
            oauth.refreshTokenEncrypted ||
            oauth.accessTokenEncrypted ||
            oauth.graphAccessTokenEncrypted,
        );

    if (!baseEmail && !oauth.email) {
      throw new Error(
        isGoogleOauth
          ? 'Please provide the Gmail address, or complete Google OAuth first.'
          : 'Please provide the Outlook email address, or complete Microsoft OAuth first.',
      );
    }
    if (!clientId) {
      throw new Error(
        isGoogleOauth
          ? 'Please provide Google Client ID or set GOOGLE_CLIENT_ID.'
          : 'Please configure the Microsoft app in System Settings first, or provide a mailbox-specific Microsoft Client ID.',
      );
    }
    if (isGoogleOauth && !oauth.clientSecretEncrypted) {
      throw new Error(
        isGoogleOauth
          ? 'Please provide Google Client Secret or set GOOGLE_CLIENT_SECRET.'
          : 'Please provide Microsoft Client Secret or set MICROSOFT_CLIENT_SECRET.',
      );
    }
    if (!hasOauthRefreshToken) {
      throw new Error(
        isGoogleOauth
          ? 'Please complete Google OAuth2 authorization first.'
          : 'Please enter a Microsoft refresh token or complete Microsoft OAuth2 first.',
      );
    }

    return {
      ownerUserId,
      name: name || baseEmail || oauth.email,
      provider: providerId,
      email: baseEmail || normalizeEmail(oauth.email),
      username: username || baseEmail || oauth.email,
      passwordEncrypted: password ? encrypt(password) : existingMailbox?.password_encrypted || encrypt(''),
      authType,
      oauth,
      imapHost,
      imapPort,
      secure,
      syncAttachments,
      syncIntervalSeconds,
      sortOrder,
      isPinned,
    };
  }

  if (!baseEmail) {
    throw new Error('Please provide an email address.');
  }
  if (!password && !existingMailbox?.password_encrypted) {
    throw new Error('Please provide the IMAP password or app password.');
  }

  return {
    ownerUserId,
    name: name || baseEmail,
    provider: providerId,
    email: baseEmail,
    username: username || baseEmail,
    passwordEncrypted: password ? encrypt(password) : existingMailbox.password_encrypted,
    authType: 'password',
    oauth: {},
    imapHost,
    imapPort,
    secure,
    syncAttachments,
    syncIntervalSeconds,
    sortOrder,
    isPinned,
  };
}

function normalizeMailboxPayload(payload, currentUser) {
  return buildMailboxUpsertPayload(payload, currentUser, null);
}

function normalizeMailboxPayloadForUpdate(payload, currentUser, existingMailbox) {
  return buildMailboxUpsertPayload(payload, currentUser, existingMailbox);
}

function buildGoogleOauthMailboxInput(requestEntry, granted = {}, existingMailbox = null) {
  const email = normalizeEmail(requestEntry.email || granted.email || existingMailbox?.email || '');
  const username = trimString(requestEntry.username || existingMailbox?.username || email);
  const name = trimString(requestEntry.name || existingMailbox?.name || email);
  const existingOauth = normalizeGoogleOauthState(existingMailbox?.oauth);
  const clientSecret = resolveGoogleClientSecret(
    {
      googleClientSecret: requestEntry.clientSecret,
    },
    existingMailbox,
  );
  const refreshTokenPlain =
    trimString(granted.refreshToken) ||
    (existingOauth.refreshTokenEncrypted ? decrypt(existingOauth.refreshTokenEncrypted) : '');

  if (!email) {
    throw new Error('Google 授权成功了，但没有获取到 Gmail 邮箱地址。');
  }
  if (!refreshTokenPlain) {
    throw new Error('Google 授权成功，但没有拿到 refresh_token，请重新授权并确认允许离线访问。');
  }

  const accessToken = trimString(granted.accessToken);
  const expiresAt = new Date(
    Date.now() + Math.max(Number(granted.expiresIn) || 3600, 60) * 1000,
  ).toISOString();

  return {
    ownerUserId: requestEntry.ownerUserId,
    name: name || email,
    provider: 'gmail',
    email,
    username: username || email,
    passwordEncrypted: existingMailbox?.password_encrypted || encrypt(''),
    authType: 'gmail_oauth',
    oauth: {
      ...existingOauth,
      clientId: requestEntry.clientId,
      clientSecretEncrypted: clientSecret.encrypted || existingOauth.clientSecretEncrypted || '',
      refreshTokenEncrypted: encrypt(refreshTokenPlain),
      accessTokenEncrypted: accessToken ? encrypt(accessToken) : existingOauth.accessTokenEncrypted || '',
      expiresAt,
      email,
      scope: trimString(granted.scope || existingOauth.scope),
      tokenType: trimString(granted.tokenType || existingOauth.tokenType || 'Bearer'),
    },
    imapHost: trimString(requestEntry.imapHost || 'imap.gmail.com') || 'imap.gmail.com',
    imapPort: Number(requestEntry.imapPort || 993) || 993,
    secure: requestEntry.secure === false ? false : Boolean(requestEntry.secure ?? true),
    syncIntervalSeconds: clampSyncIntervalSeconds(requestEntry.syncIntervalSeconds, 5),
    sortOrder: normalizeMailboxSortOrder(requestEntry.sortOrder, existingMailbox?.sortOrder ?? 100),
    isPinned: normalizeBooleanFlag(requestEntry.isPinned, existingMailbox?.isPinned ?? false),
  };
}

function buildMicrosoftOauthMailboxInput(requestEntry, granted = {}, existingMailbox = null) {
  const identityEmail = normalizeEmail(
    requestEntry.email ||
      granted.email ||
      granted.preferredUsername ||
      existingMailbox?.email ||
      '',
  );
  const username = trimString(requestEntry.username || existingMailbox?.username || identityEmail);
  const name = trimString(requestEntry.name || existingMailbox?.name || identityEmail);
  const existingOauth = normalizeGoogleOauthState(existingMailbox?.oauth);
  const clientSecret = resolveMicrosoftClientSecret(requestEntry, existingMailbox);
  const refreshTokenPlain =
    trimString(granted.refreshToken) ||
    (existingOauth.refreshTokenEncrypted ? decrypt(existingOauth.refreshTokenEncrypted) : '');

  if (!identityEmail) {
    throw new Error('Microsoft 授权成功了，但没有获取到 Outlook 邮箱地址。');
  }
  if (!refreshTokenPlain) {
    throw new Error('Microsoft 授权成功，但没有拿到 refresh_token，请重新授权并确认允许离线访问。');
  }

  if (!identityEmail) {
    throw new Error('Microsoft 授权成功了，但没有获取到 Outlook 邮箱地址。');
  }
  if (!refreshTokenPlain) {
    throw new Error('Microsoft 授权成功，但没有拿到 refresh_token，请重新授权并确认允许离线访问。');
  }

  if (!identityEmail) {
    throw new Error('Microsoft 授权成功了，但没有获取到 Outlook 邮箱地址。');
  }
  if (!refreshTokenPlain) {
    throw new Error('Microsoft 授权成功，但没有拿到 refresh_token，请重新授权并允许离线访问。');
  }

  const accessToken = trimString(granted.accessToken);
  const expiresAt = new Date(
    Date.now() + Math.max(Number(granted.expiresIn) || 3600, 60) * 1000,
  ).toISOString();

  return {
    ownerUserId: requestEntry.ownerUserId,
    name: name || identityEmail,
    provider: 'outlook',
    email: identityEmail,
    username: username || identityEmail,
    passwordEncrypted:
      trimString(requestEntry.password)
        ? encrypt(trimString(requestEntry.password))
        : existingMailbox?.password_encrypted || encrypt(''),
    authType: 'microsoft_oauth',
    oauth: {
      ...existingOauth,
      protocolMode: resolveMicrosoftProtocolMode(requestEntry, existingMailbox),
      tenantId: resolveMicrosoftTenantId(requestEntry, existingMailbox),
      clientId: requestEntry.clientId,
      clientSecretEncrypted: clientSecret.encrypted || existingOauth.clientSecretEncrypted || '',
      sharedRefreshTokenEncrypted: encrypt(refreshTokenPlain),
      refreshTokenEncrypted: encrypt(refreshTokenPlain),
      imapRefreshTokenEncrypted: encrypt(refreshTokenPlain),
      accessTokenEncrypted: accessToken ? encrypt(accessToken) : existingOauth.accessTokenEncrypted || '',
      imapAccessTokenEncrypted: accessToken ? encrypt(accessToken) : existingOauth.imapAccessTokenEncrypted || '',
      expiresAt,
      imapExpiresAt: expiresAt,
      email: identityEmail,
      scope: trimString(granted.scope || existingOauth.scope),
      imapScope: trimString(granted.scope || existingOauth.imapScope || existingOauth.scope),
      tokenType: trimString(granted.tokenType || existingOauth.tokenType || 'Bearer'),
      imapTokenType: trimString(
        granted.tokenType || existingOauth.imapTokenType || existingOauth.tokenType || 'Bearer',
      ),
      source: 'oauth',
    },
    imapHost: trimString(requestEntry.imapHost || 'outlook.office365.com') || 'outlook.office365.com',
    imapPort: Number(requestEntry.imapPort || 993) || 993,
    secure: requestEntry.secure === false ? false : Boolean(requestEntry.secure ?? true),
    syncIntervalSeconds: clampSyncIntervalSeconds(requestEntry.syncIntervalSeconds, 5),
    sortOrder: normalizeMailboxSortOrder(requestEntry.sortOrder, existingMailbox?.sortOrder ?? 100),
    isPinned: normalizeBooleanFlag(requestEntry.isPinned, existingMailbox?.isPinned ?? false),
  };
}

function pushMailboxErrorDetail(target, value, options = {}) {
  const text = trimString(value);
  if (!text) {
    return;
  }

  if (options.skipGeneric && text === 'Command failed') {
    return;
  }

  if (!target.includes(text)) {
    target.push(text);
  }
}

function collectMailboxErrorDetails(error, target = []) {
  if (!error) {
    return target;
  }

  if (typeof error === 'string') {
    pushMailboxErrorDetail(target, error, { skipGeneric: true });
    return target;
  }

  pushMailboxErrorDetail(target, error.message, { skipGeneric: true });
  pushMailboxErrorDetail(target, error.responseText);
  pushMailboxErrorDetail(target, error.serverResponseCode);
  pushMailboxErrorDetail(target, error.graphMessage, { skipGeneric: true });
  pushMailboxErrorDetail(target, error.imapMessage, { skipGeneric: true });

  if (error.graphError && error.graphError !== error) {
    collectMailboxErrorDetails(error.graphError, target);
  }
  if (error.imapError && error.imapError !== error) {
    collectMailboxErrorDetails(error.imapError, target);
  }

  return target;
}

function isMicrosoftConsumerIdentity(mailboxLike = {}) {
  return [mailboxLike?.email, mailboxLike?.username, mailboxLike?.oauthEmail]
    .map((value) => trimString(value).toLowerCase())
    .some((value) => {
      const parts = value.split('@');
      const domain = parts.length > 1 ? parts[parts.length - 1] : '';
      return MICROSOFT_PERSONAL_DOMAINS.has(domain);
    });
}

function isGuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    trimString(value),
  );
}

function describeMailboxConnectionError(error, mailboxLike = {}) {
  const detailParts = collectMailboxErrorDetails(error);
  const message =
    detailParts.join(' / ') || trimString(error?.message || error || '') || 'Unknown mailbox error.';
  const provider = String(mailboxLike?.provider || '').trim().toLowerCase();
  const authType = String(mailboxLike?.authType || 'password').trim().toLowerCase();
  const normalizedMessage = message.toLowerCase();
  const shortMessage = detailParts.slice(0, 2).join('；') || message;

  if (provider === 'outlook' && authType !== 'password') {
    if (
      isMicrosoftConsumerIdentity(mailboxLike) &&
      isGuidLike(mailboxLike.oauthTenantId || mailboxLike?.oauth?.tenantId)
    ) {
      return `${shortMessage} 当前绑定的是个人 Microsoft 邮箱，但系统里配置的 Tenant ID 看起来是企业目录 ID。要接入 @outlook.com / @hotmail.com / @live.com / @msn.com，Azure 应用通常需要把 Supported account types 改成“任何组织目录中的帐户和个人 Microsoft 帐户”，并重新完成 Microsoft OAuth2 授权。`;
    }
    if (normalizedMessage.includes('aadsts700016')) {
      return `${shortMessage} 当前 Microsoft 应用不支持这个租户或账号类型。请检查 Azure 应用的 Supported account types，若需要接入个人 Outlook 邮箱，请启用个人 Microsoft 帐户支持后重新授权。`;
    }
    if (normalizedMessage.includes('aadsts65001') || normalizedMessage.includes('consent_required')) {
      return `${shortMessage} 当前 Microsoft 应用还没有为这个账号完成邮件权限授权。请在 Azure 门户里确认 IMAP.AccessAsUser.All 与 Mail.ReadWrite 已授予并完成 consent，然后重新点击“连接 Microsoft”。`;
    }
    if (normalizedMessage.includes('mail.read') || normalizedMessage.includes('mail.readwrite')) {
      return `${shortMessage} 当前 Microsoft Graph 令牌缺少读取邮件权限。请在 Azure 应用里补齐 Mail.Read 或 Mail.ReadWrite，并重新完成 OAuth2 授权。`;
    }
    if (
      normalizedMessage.includes('authenticate failed') ||
      normalizedMessage.includes('authfailed') ||
      normalizedMessage.includes('logondenied')
    ) {
      return `${shortMessage} Outlook IMAP OAuth2 登录被微软拒绝了。请确认应用已经为该账号授予 IMAP.AccessAsUser.All，并重新完成 Microsoft OAuth2 授权。`;
    }
  }

  if (provider === 'outlook') {
    if (authType === 'password') {
      return `${message} 当前 Outlook / Microsoft 365 更常见的接入方式是 OAuth2 / Modern Auth；另外 Outlook.com 的 IMAP 访问也需要先在网页版设置里开启。`;
    }

    return `${message} 请确认微软应用注册已启用 IMAP OAuth2 权限，并且回调地址、Client ID、Client Secret、Tenant 设置正确。`;
  }

  return message;
}

function isMailboxConnectionChanged(previousMailbox, nextMailbox) {
  const previousProtocolMode = normalizeMicrosoftProtocolMode(previousMailbox?.oauthProtocolMode || previousMailbox?.oauth?.protocolMode);
  const nextProtocolMode = normalizeMicrosoftProtocolMode(nextMailbox?.oauth?.protocolMode);

  return (
    previousMailbox.provider !== nextMailbox.provider ||
    previousMailbox.email !== nextMailbox.email ||
    previousMailbox.username !== nextMailbox.username ||
    String(previousMailbox.authType || 'password') !== String(nextMailbox.authType || 'password') ||
    previousMailbox.imap_host !== nextMailbox.imapHost ||
    Number(previousMailbox.imap_port) !== Number(nextMailbox.imapPort) ||
    Boolean(previousMailbox.secure) !== Boolean(nextMailbox.secure) ||
    String(previousMailbox.oauthClientId || previousMailbox?.oauth?.clientId || '') !==
      String(nextMailbox?.oauth?.clientId || '') ||
    String(previousMailbox.oauthTenantId || previousMailbox?.oauth?.tenantId || '').trim().toLowerCase() !==
      String(nextMailbox?.oauth?.tenantId || '').trim().toLowerCase() ||
    previousProtocolMode !== nextProtocolMode
  );
}

function getVisibleUsersForMailboxForm(currentUser) {
  return currentUser.role === 'admin'
    ? listUsers().filter((user) => user.status === 'active').map(sanitizeUser)
    : [sanitizeUser(currentUser)];
}

async function syncVisibleMailboxes(user) {
  const mailboxes = listMailboxes({ viewer: user });
  const results = [];

  for (const mailbox of mailboxes) {
    try {
      const result = await syncService.syncMailbox(mailbox.id, 'manual-visible');
      results.push({ mailboxId: mailbox.id, ok: true, ...result });
    } catch (error) {
      results.push({
        mailboxId: mailbox.id,
        ok: false,
        error: String(error.message || error),
      });
    }
  }

  return {
    mailboxCount: mailboxes.length,
    results,
  };
}

async function resyncMailboxes(mailboxIds) {
  const normalizedIds = Array.from(
    new Set((mailboxIds || []).map((mailboxId) => String(mailboxId || '').trim()).filter(Boolean)),
  );

  const results = [];
  for (const mailboxId of normalizedIds) {
    try {
      let result = await syncService.syncMailbox(mailboxId, 'remote-change');
      if (result?.skipped && result.reason === 'already-running') {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        result = await syncService.syncMailbox(mailboxId, 'remote-change-retry');
      }
      results.push({ mailboxId, ok: true, ...result });
    } catch (error) {
      results.push({
        mailboxId,
        ok: false,
        error: String(error.message || error),
      });
    }
  }

  return results;
}

function triggerMailboxSyncInBackground(mailboxId, source = 'background-save') {
  const normalizedMailboxId = String(mailboxId || '').trim();
  if (!normalizedMailboxId) {
    return;
  }

  setTimeout(() => {
    syncService.syncMailbox(normalizedMailboxId, source).catch((error) => {
      console.error('[mailbox-background-sync]', {
        mailboxId: normalizedMailboxId,
        source,
        error: error?.stack || error?.message || String(error),
      });
    });
  }, 0);
}

function findVisibleMailboxByEmail(viewer, email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return null;
  }

  return listMailboxes({ viewer, limit: 1000 }).find((mailbox) => mailbox.email === normalizedEmail) || null;
}

const MICROSOFT_IMPORT_SEPARATOR_CANDIDATES = ['----', '\t', '|', ','];

function cleanMicrosoftImportValue(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\u2060]/g, '')
    .trim();
}

function splitMicrosoftImportLine(line) {
  const normalizedLine = cleanMicrosoftImportValue(line);
  const separator =
    MICROSOFT_IMPORT_SEPARATOR_CANDIDATES.find((candidate) => normalizedLine.includes(candidate)) || '----';

  return normalizedLine.split(separator).map((part) => cleanMicrosoftImportValue(part));
}

function looksLikeMicrosoftGuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanMicrosoftImportValue(value));
}

function looksLikeMicrosoftTenantId(value) {
  const normalized = cleanMicrosoftImportValue(value).toLowerCase();
  return normalized === 'common' || normalized === 'consumers' || normalized === 'organizations' || looksLikeMicrosoftGuid(normalized);
}

function parseMicrosoftImportProtocolMode(value) {
  const normalized = cleanMicrosoftImportValue(value).toLowerCase();
  if (!normalized) {
    return '';
  }
  if (['graph_only', 'graph-only', 'graph'].includes(normalized)) {
    return 'graph_only';
  }
  if (['imap_only', 'imap-only', 'imap'].includes(normalized)) {
    return 'imap_only';
  }
  if (['graph_imap_dual', 'graph-imap-dual', 'graph+imap', 'graph_imap', 'dual'].includes(normalized)) {
    return 'graph_imap_dual';
  }
  return '';
}

function looksLikeRefreshToken(value) {
  const normalized = cleanMicrosoftImportValue(value);
  return normalized.length >= 24 && !/\s/.test(normalized) && !normalized.includes('@');
}

function isMicrosoftImportHeader(parts = []) {
  const normalized = parts.map((part) => cleanMicrosoftImportValue(part).toLowerCase());
  return (
    normalized.includes('email') &&
    (normalized.includes('clientid') || normalized.includes('client_id')) &&
    (normalized.includes('refreshtoken') || normalized.includes('refresh_token'))
  );
}

function parseMicrosoftImportFields(parts, index) {
  if (parts.length < 3) {
    throw new Error(
      `第 ${index + 1} 行格式不正确，支持：邮箱----ClientId----RefreshToken 或 邮箱----密码----ClientId----RefreshToken。`,
    );
  }

  let password = '';
  let clientId = '';
  let refreshToken = '';
  let nextIndex = 1;

  if (looksLikeMicrosoftGuid(parts[1]) && looksLikeRefreshToken(parts[2])) {
    clientId = cleanMicrosoftImportValue(parts[1]);
    refreshToken = cleanMicrosoftImportValue(parts[2]);
    nextIndex = 3;
  } else {
    if (parts.length < 4) {
      throw new Error(
        `第 ${index + 1} 行格式不正确，支持：邮箱----ClientId----RefreshToken 或 邮箱----密码----ClientId----RefreshToken。`,
      );
    }

    password = cleanMicrosoftImportValue(parts[1]);
    clientId = cleanMicrosoftImportValue(parts[2]);
    refreshToken = cleanMicrosoftImportValue(parts[3]);
    nextIndex = 4;
  }

  let tenantId = '';
  let protocolMode = '';
  let clientSecret = '';

  for (const part of parts.slice(nextIndex)) {
    const value = cleanMicrosoftImportValue(part);
    if (!value) {
      continue;
    }

    const parsedProtocolMode = parseMicrosoftImportProtocolMode(value);
    if (!tenantId && looksLikeMicrosoftTenantId(value)) {
      tenantId = value;
      continue;
    }
    if (!protocolMode && parsedProtocolMode) {
      protocolMode = parsedProtocolMode;
      continue;
    }
    if (!clientSecret) {
      clientSecret = value;
    }
  }

  return {
    password,
    clientId,
    refreshToken,
    tenantId,
    protocolMode,
    clientSecret,
  };
}

function parseMicrosoftOauthImportText(text, defaults = {}) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => cleanMicrosoftImportValue(line))
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'));

  if (!lines.length) {
    throw new Error('请先选择导入文件，或粘贴至少一行 Outlook OAuth2 配置。');
  }

  return lines.reduce((entries, line, index) => {
    const parts = splitMicrosoftImportLine(line);
    if (isMicrosoftImportHeader(parts)) {
      return entries;
    }

    const normalizedEmail = normalizeEmail(parts[0]);
    if (!normalizedEmail) {
      throw new Error(`第 ${index + 1} 行没有有效的邮箱地址。`);
    }

    const { password, clientId, refreshToken, tenantId, protocolMode, clientSecret } =
      parseMicrosoftImportFields(parts, index);

    if (!clientId) {
      throw new Error(`第 ${index + 1} 行缺少 Microsoft Client ID。`);
    }
    if (!refreshToken) {
      throw new Error(`第 ${index + 1} 行缺少 Microsoft refresh token。`);
    }

    entries.push({
      ownerUserId: defaults.ownerUserId,
      provider: 'outlook',
      authType: 'microsoft_oauth',
      name: normalizedEmail,
      email: normalizedEmail,
      username: normalizedEmail,
      password,
      microsoftClientId: clientId,
      microsoftClientSecret: clientSecret || defaults.microsoftClientSecret || '',
      microsoftTenantId: tenantId || defaults.microsoftTenantId || 'common',
      microsoftProtocolMode: normalizeMicrosoftProtocolMode(
        protocolMode || defaults.microsoftProtocolMode || 'graph_imap_dual',
      ),
      microsoftRefreshToken: refreshToken,
      imapHost: trimString(defaults.imapHost || 'outlook.office365.com') || 'outlook.office365.com',
      imapPort: Number(defaults.imapPort || 993) || 993,
      secure: defaults.secure === false ? false : true,
      syncIntervalSeconds: clampSyncIntervalSeconds(defaults.syncIntervalSeconds, 5),
      sortOrder: normalizeMailboxSortOrder(defaults.sortOrder, 100),
      isPinned: normalizeBooleanFlag(defaults.isPinned, false),
    });

    return entries;
  }, []);
}

async function handleGoogleOAuthPublicRoutes(request, response, url) {
  if (request.method !== 'GET' || url.pathname !== '/api/oauth/google/callback') {
    return false;
  }

  const oauthRequest = getGoogleOAuthRequestByState(url.searchParams.get('state'));
  const successRedirectUrl = buildOAuthResultRedirectUrl(
    request,
    url,
    'google',
    'success',
    'Gmail 授权完成，系统已自动同步最新配置。',
    oauthRequest?.portalPath,
    oauthRequest?.baseUrl,
  );
  if (!oauthRequest) {
    sendHtml(
      response,
      400,
      renderGoogleOAuthResultPage(
        '授权已失效',
        '这次 Google 授权请求已经失效，请回到系统里重新发起。',
        'error',
        {
          redirectUrl: buildOAuthResultRedirectUrl(
            request,
            url,
            'google',
            'error',
            'Google 授权请求已失效，请重新发起。',
          ),
        },
      ),
    );
    return true;
  }

  const oauthError = trimString(url.searchParams.get('error'));
  const oauthErrorDescription = trimString(url.searchParams.get('error_description'));
  if (oauthError) {
    oauthRequest.status = 'error';
    oauthRequest.error = oauthErrorDescription || oauthError;
    oauthRequest.updatedAt = Date.now();
    sendHtml(
      response,
      400,
      renderGoogleOAuthResultPage('Google 授权失败', oauthRequest.error, 'error', {
        redirectUrl: buildOAuthResultRedirectUrl(
          request,
          url,
          'google',
          'error',
          oauthRequest.error,
          oauthRequest?.portalPath,
          oauthRequest?.baseUrl,
        ),
      }),
    );
    return true;
  }

  const code = trimString(url.searchParams.get('code'));
  if (!code) {
    oauthRequest.status = 'error';
    oauthRequest.error = 'Google 没有返回授权码。';
    oauthRequest.updatedAt = Date.now();
    sendHtml(
      response,
      400,
      renderGoogleOAuthResultPage('Google 授权失败', oauthRequest.error, 'error', {
        redirectUrl: buildOAuthResultRedirectUrl(
          request,
          url,
          'google',
          'error',
          oauthRequest.error,
          oauthRequest?.portalPath,
          oauthRequest?.baseUrl,
        ),
      }),
    );
    return true;
  }

  try {
    const tokenResult = await exchangeGoogleCode({
      code,
      clientId: oauthRequest.clientId,
      clientSecret: oauthRequest.clientSecret,
      redirectUri: `${resolveOauthBaseUrl(request, url, oauthRequest?.baseUrl)}/api/oauth/google/callback`,
    });
    const idTokenPayload = decodeGoogleIdToken(tokenResult.id_token);
    const existingMailbox = oauthRequest.mailboxId ? getMailboxById(oauthRequest.mailboxId) : null;
    const nextPayload = buildGoogleOauthMailboxInput(
      oauthRequest,
      {
        email: normalizeEmail(idTokenPayload.email || oauthRequest.email || existingMailbox?.email || ''),
        refreshToken: tokenResult.refresh_token,
        accessToken: tokenResult.access_token,
        expiresIn: tokenResult.expires_in,
        scope: tokenResult.scope,
        tokenType: tokenResult.token_type,
      },
      existingMailbox,
    );

    if (!getUserById(nextPayload.ownerUserId)) {
      throw new Error('The selected owner user does not exist.');
    }

    let mailbox = null;
    let syncResult = null;

    if (existingMailbox) {
      const connectionChanged = isMailboxConnectionChanged(existingMailbox, nextPayload);
      mailbox = updateMailbox(existingMailbox.id, nextPayload);
      if (connectionChanged) {
        clearMailboxMessages(mailbox.id);
      }
      syncResult = await syncService.syncMailbox(mailbox.id, 'google-oauth-update');
    } else {
      mailbox = createMailbox(nextPayload);
      syncResult = await syncService.syncMailbox(mailbox.id, 'google-oauth-create');
    }

    oauthRequest.status = 'completed';
    oauthRequest.updatedAt = Date.now();
    oauthRequest.error = '';
    oauthRequest.mailbox = sanitizeMailbox(getMailboxById(mailbox.id));
    oauthRequest.syncResult = syncResult;
    oauthRequest.grantedEmail = nextPayload.email;
    const redirectUrl = successRedirectUrl;

    sendHtml(
      response,
      200,
      renderGoogleOAuthResultPage(
        'Google 授权成功',
        'Gmail 已经完成授权并同步到系统，现在可以回到主界面继续测试了。',
        'success',
        { redirectUrl },
      ),
    );
  } catch (error) {
    oauthRequest.status = 'error';
    oauthRequest.updatedAt = Date.now();
    oauthRequest.error = String(error.message || error);
    console.error('[google-oauth-callback]', error?.stack || error?.message || String(error));

    sendHtml(
      response,
      400,
      renderGoogleOAuthResultPage('Google 授权失败', oauthRequest.error, 'error', {
        redirectUrl: buildOAuthResultRedirectUrl(
          request,
          url,
          'google',
          'error',
          oauthRequest.error,
          oauthRequest?.portalPath,
          oauthRequest?.baseUrl,
        ),
      }),
    );
  }

  return true;
}

async function handleGoogleOAuthPrivateRoutes(request, response, url, auth) {
  if (request.method === 'POST' && url.pathname === '/api/oauth/google/start') {
    try {
      const payload = await readJson(request);
      const mailboxId = trimString(payload.mailboxId);
      const existingMailbox = mailboxId ? getMailboxById(mailboxId, auth.user) : null;

      if (mailboxId && !existingMailbox) {
        notFound(response);
        return true;
      }

      const providerId = String(payload.provider || existingMailbox?.provider || 'gmail');
      const authType = normalizeMailboxAuthType(providerId, payload.authType, existingMailbox);
      if (providerId !== 'gmail' || authType !== 'gmail_oauth') {
        throw new Error('This endpoint is only for Gmail OAuth2 authorization.');
      }

      const ownerUserId =
        auth.user.role === 'admin'
          ? String(payload.ownerUserId || existingMailbox?.ownerUserId || auth.user.id)
          : auth.user.id;
      if (!getUserById(ownerUserId)) {
        throw new Error('The selected owner user does not exist.');
      }

      const clientId = resolveGoogleClientId(payload, existingMailbox);
      const clientSecret = resolveGoogleClientSecret(payload, existingMailbox);
      if (!clientId) {
        throw new Error(
          auth.user.role === 'admin'
            ? '请先到系统设置完成 Google 应用配置，再回来连接 Gmail。'
            : '当前系统尚未配置 Google 应用，请联系管理员处理。',
        );
      }
      if (!clientSecret.plain) {
        throw new Error(
          auth.user.role === 'admin'
            ? '请先到系统设置保存 Google 客户端密钥（Client Secret），再回来连接 Gmail。'
            : '当前系统尚未配置 Google 客户端密钥（Client Secret），请联系管理员处理。',
        );
      }

      const requestId = randomUUID();
      const oauthState = randomUUID();
      const email = normalizeEmail(payload.email || existingMailbox?.email || '');
      const oauthBaseUrl = resolveOauthBaseUrl(request, url, payload.publicBaseUrl);

      googleOAuthRequests.set(requestId, {
        requestId,
        oauthState,
        baseUrl: oauthBaseUrl,
        userId: auth.user.id,
        portalPath: normalizePortalEntryPath(
          payload.portalPath,
          resolvePortalPathForUser(auth.user),
        ),
        mailboxId: mailboxId || '',
        ownerUserId,
        name: trimString(payload.name || existingMailbox?.name || ''),
        email,
        username: trimString(payload.username || existingMailbox?.username || email),
        imapHost: trimString(payload.imapHost || existingMailbox?.imap_host || 'imap.gmail.com') || 'imap.gmail.com',
        imapPort: Number(payload.imapPort || existingMailbox?.imap_port || 993) || 993,
        secure:
          payload.secure === false || payload.secure === 'false'
            ? false
            : Boolean(payload.secure ?? existingMailbox?.secure ?? true),
        syncIntervalSeconds: clampSyncIntervalSeconds(
          payload.syncIntervalSeconds,
          Number(existingMailbox?.syncIntervalSeconds) || 5,
        ),
        sortOrder: normalizeMailboxSortOrder(payload.sortOrder, existingMailbox?.sortOrder ?? 100),
        isPinned: normalizeBooleanFlag(payload.isPinned, existingMailbox?.isPinned ?? false),
        clientId,
        clientSecret: clientSecret.plain,
        status: 'pending',
        error: '',
        mailbox: null,
        syncResult: null,
        grantedEmail: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      sendJson(response, 200, {
        ok: true,
        requestId,
        authorizeUrl: buildGoogleAuthorizeUrl({
          clientId,
          redirectUri: `${oauthBaseUrl}/api/oauth/google/callback`,
          state: oauthState,
          loginHint: email,
        }),
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/oauth/google/status') {
    const oauthRequest = getGoogleOAuthRequest(url.searchParams.get('requestId'));
    if (!oauthRequest || oauthRequest.userId !== auth.user.id) {
      notFound(response);
      return true;
    }

    sendJson(response, 200, {
      ok: true,
      status: oauthRequest.status,
      error: oauthRequest.error || '',
      mailbox: oauthRequest.mailbox || null,
      syncResult: oauthRequest.syncResult || null,
      email: oauthRequest.grantedEmail || oauthRequest.email || '',
    });
    return true;
  }

  return false;
}

async function handleMicrosoftOAuthPublicRoutes(request, response, url) {
  if (request.method !== 'GET' || url.pathname !== '/api/oauth/microsoft/callback') {
    return false;
  }

  const oauthRequest = getMicrosoftOAuthRequestByState(url.searchParams.get('state'));
  const successRedirectUrl = buildOAuthResultRedirectUrl(
    request,
    url,
    'microsoft',
    'success',
    'Microsoft 授权完成，Outlook 邮箱已同步回系统。',
    oauthRequest?.portalPath,
    oauthRequest?.baseUrl,
  );
  if (!oauthRequest) {
    sendHtml(
      response,
      400,
      renderGoogleOAuthResultPage(
        '授权已失效',
        '这次 Microsoft 授权请求已经失效，请回到系统里重新发起。',
        'error',
        {
          redirectUrl: buildOAuthResultRedirectUrl(
            request,
            url,
            'microsoft',
            'error',
            'Microsoft 授权请求已失效，请重新发起。',
          ),
        },
      ),
    );
    return true;
  }

  const oauthError = trimString(url.searchParams.get('error'));
  const oauthErrorDescription = trimString(url.searchParams.get('error_description'));
  if (oauthError) {
    oauthRequest.status = 'error';
    oauthRequest.error = oauthErrorDescription || oauthError;
    oauthRequest.updatedAt = Date.now();
    sendHtml(
      response,
      400,
      renderGoogleOAuthResultPage('Microsoft 授权失败', oauthRequest.error, 'error', {
        redirectUrl: buildOAuthResultRedirectUrl(
          request,
          url,
          'microsoft',
          'error',
          oauthRequest.error,
          oauthRequest?.portalPath,
          oauthRequest?.baseUrl,
        ),
      }),
    );
    return true;
  }

  const code = trimString(url.searchParams.get('code'));
  if (!code) {
    oauthRequest.status = 'error';
    oauthRequest.error = 'Microsoft 没有返回授权码。';
    oauthRequest.updatedAt = Date.now();
    sendHtml(
      response,
      400,
      renderGoogleOAuthResultPage('Microsoft 授权失败', oauthRequest.error, 'error', {
        redirectUrl: buildOAuthResultRedirectUrl(
          request,
          url,
          'microsoft',
          'error',
          oauthRequest.error,
          oauthRequest?.portalPath,
          oauthRequest?.baseUrl,
        ),
      }),
    );
    return true;
  }

  try {
    const tokenResult = await exchangeMicrosoftCode({
      code,
      tenantId: oauthRequest.tenantId,
      clientId: oauthRequest.clientId,
      clientSecret: oauthRequest.clientSecret,
      redirectUri: `${resolveOauthBaseUrl(request, url, oauthRequest?.baseUrl)}/api/oauth/microsoft/callback`,
    });
    const idTokenPayload = decodeMicrosoftIdToken(tokenResult.id_token);
    const existingMailbox = oauthRequest.mailboxId ? getMailboxById(oauthRequest.mailboxId) : null;
    const nextPayload = buildMicrosoftOauthMailboxInput(
      oauthRequest,
      {
        email: normalizeEmail(
          idTokenPayload.email ||
            idTokenPayload.preferred_username ||
            oauthRequest.email ||
            existingMailbox?.email ||
            '',
        ),
        preferredUsername: trimString(idTokenPayload.preferred_username),
        refreshToken: tokenResult.refresh_token,
        accessToken: tokenResult.access_token,
        expiresIn: tokenResult.expires_in,
        scope: tokenResult.scope,
        tokenType: tokenResult.token_type,
      },
      existingMailbox,
    );

    if (!getUserById(nextPayload.ownerUserId)) {
      throw new Error('The selected owner user does not exist.');
    }

    let mailbox = null;
    let syncResult = null;
    let syncWarning = '';

    if (existingMailbox) {
      const connectionChanged = isMailboxConnectionChanged(existingMailbox, nextPayload);
      mailbox = updateMailbox(existingMailbox.id, nextPayload);
      if (connectionChanged) {
        clearMailboxMessages(mailbox.id);
      }
      try {
        syncResult = await syncService.syncMailbox(mailbox.id, 'microsoft-oauth-update');
      } catch (syncError) {
        syncWarning = describeMailboxConnectionError(syncError, nextPayload);
        console.error('[microsoft-oauth-sync]', {
          mailboxId: mailbox.id,
          email: nextPayload.email,
          warning: syncWarning,
          error: syncError?.stack || syncError?.message || String(syncError),
        });
      }
    } else {
      mailbox = createMailbox(nextPayload);
      try {
        syncResult = await syncService.syncMailbox(mailbox.id, 'microsoft-oauth-create');
      } catch (syncError) {
        syncWarning = describeMailboxConnectionError(syncError, nextPayload);
        console.error('[microsoft-oauth-sync]', {
          mailboxId: mailbox.id,
          email: nextPayload.email,
          warning: syncWarning,
          error: syncError?.stack || syncError?.message || String(syncError),
        });
      }
    }

    oauthRequest.status = 'completed';
    oauthRequest.updatedAt = Date.now();
    oauthRequest.error = '';
    oauthRequest.warning = syncWarning;
    oauthRequest.mailbox = sanitizeMailbox(getMailboxById(mailbox.id));
    oauthRequest.syncResult = syncResult;
    oauthRequest.grantedEmail = nextPayload.email;
    const successMessage = syncWarning
      ? `Microsoft 授权已经完成，但首次同步没有成功。${syncWarning} 你可以先返回系统，修正权限或应用配置后再点击“立即同步”。`
      : 'Outlook 閭宸茬粡瀹屾垚鎺堟潈骞跺悓姝ュ埌绯荤粺锛岀幇鍦ㄥ彲浠ュ洖鍒颁富鐣岄潰缁х画娴嬭瘯浜嗐€?';
    const redirectUrl = syncWarning
      ? buildOAuthResultRedirectUrl(
          request,
          url,
          'microsoft',
          'success',
          syncWarning,
          oauthRequest?.portalPath,
          oauthRequest?.baseUrl,
        )
      : successRedirectUrl;

    sendHtml(
      response,
      200,
      renderGoogleOAuthResultPage(
        'Microsoft 授权成功',
        'Outlook 邮箱已经完成授权并同步到系统，现在可以回到主界面继续测试了。',
        'success',
        { redirectUrl },
      ),
    );
  } catch (error) {
    oauthRequest.status = 'error';
    oauthRequest.updatedAt = Date.now();
    oauthRequest.error = String(error.message || error);

    sendHtml(
      response,
      400,
      renderGoogleOAuthResultPage('Microsoft 授权失败', oauthRequest.error, 'error', {
        redirectUrl: buildOAuthResultRedirectUrl(
          request,
          url,
          'microsoft',
          'error',
          oauthRequest.error,
          oauthRequest?.portalPath,
          oauthRequest?.baseUrl,
        ),
      }),
    );
  }

  return true;
}

async function handleMicrosoftOAuthPrivateRoutes(request, response, url, auth) {
  if (request.method === 'POST' && url.pathname === '/api/oauth/microsoft/start') {
    try {
      const payload = await readJson(request);
      const mailboxId = trimString(payload.mailboxId);
      const existingMailbox = mailboxId ? getMailboxById(mailboxId, auth.user) : null;

      if (mailboxId && !existingMailbox) {
        notFound(response);
        return true;
      }

      const providerId = String(payload.provider || existingMailbox?.provider || 'outlook');
      const authType = normalizeMailboxAuthType(providerId, payload.authType, existingMailbox);
      if (providerId !== 'outlook' || authType !== 'microsoft_oauth') {
        throw new Error('This endpoint is only for Microsoft Outlook OAuth2 authorization.');
      }

      const ownerUserId =
        auth.user.role === 'admin'
          ? String(payload.ownerUserId || existingMailbox?.ownerUserId || auth.user.id)
          : auth.user.id;
      if (!getUserById(ownerUserId)) {
        throw new Error('The selected owner user does not exist.');
      }

      const clientId = resolveMicrosoftClientId(payload, existingMailbox);
      const clientSecret = resolveMicrosoftClientSecret(payload, existingMailbox);
      const tenantId = resolveMicrosoftTenantId(payload, existingMailbox);
      if (!clientId) {
        throw new Error('Please configure the Microsoft app in System Settings first, then retry Microsoft OAuth2 authorization.');
      }

      const requestId = randomUUID();
      const oauthState = randomUUID();
      const email = normalizeEmail(payload.email || existingMailbox?.email || '');
      const oauthBaseUrl = resolveOauthBaseUrl(request, url, payload.publicBaseUrl);

      microsoftOAuthRequests.set(requestId, {
        requestId,
        oauthState,
        baseUrl: oauthBaseUrl,
        userId: auth.user.id,
        portalPath: normalizePortalEntryPath(
          payload.portalPath,
          resolvePortalPathForUser(auth.user),
        ),
        mailboxId: mailboxId || '',
        ownerUserId,
        name: trimString(payload.name || existingMailbox?.name || ''),
        email,
        username: trimString(payload.username || existingMailbox?.username || email),
        imapHost:
          trimString(payload.imapHost || existingMailbox?.imap_host || 'outlook.office365.com') ||
          'outlook.office365.com',
        imapPort: Number(payload.imapPort || existingMailbox?.imap_port || 993) || 993,
        secure:
          payload.secure === false || payload.secure === 'false'
            ? false
            : Boolean(payload.secure ?? existingMailbox?.secure ?? true),
        syncIntervalSeconds: clampSyncIntervalSeconds(
          payload.syncIntervalSeconds,
          Number(existingMailbox?.syncIntervalSeconds) || 5,
        ),
        sortOrder: normalizeMailboxSortOrder(payload.sortOrder, existingMailbox?.sortOrder ?? 100),
        isPinned: normalizeBooleanFlag(payload.isPinned, existingMailbox?.isPinned ?? false),
        password: trimString(payload.password),
        microsoftProtocolMode: resolveMicrosoftProtocolMode(payload, existingMailbox),
        clientId,
        clientSecret: clientSecret.plain,
        tenantId,
        status: 'pending',
        error: '',
        mailbox: null,
        syncResult: null,
        grantedEmail: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      sendJson(response, 200, {
        ok: true,
        requestId,
        authorizeUrl: buildMicrosoftAuthorizeUrl({
          tenantId,
          clientId,
          redirectUri: `${oauthBaseUrl}/api/oauth/microsoft/callback`,
          state: oauthState,
          loginHint: email,
          prompt: 'consent',
        }),
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/oauth/microsoft/status') {
    const oauthRequest = getMicrosoftOAuthRequest(url.searchParams.get('requestId'));
    if (!oauthRequest || oauthRequest.userId !== auth.user.id) {
      notFound(response);
      return true;
    }

    sendJson(response, 200, {
      ok: true,
      status: oauthRequest.status,
      error: oauthRequest.error || '',
      warning: oauthRequest.warning || '',
      mailbox: oauthRequest.mailbox || null,
      syncResult: oauthRequest.syncResult || null,
      email: oauthRequest.grantedEmail || oauthRequest.email || '',
    });
    return true;
  }

  return false;
}

async function handleAuthRoutes(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/auth/me') {
    const auth = await getAuthContext(request);
    if (!auth.user) {
      sendJson(
        response,
        401,
        { error: 'You are not signed in.' },
        auth.clearCookie ? { 'Set-Cookie': clearSessionCookie() } : {},
      );
      return true;
    }

    sendJson(response, 200, {
      user: sanitizeUser(auth.user),
      usersForAssignment: getVisibleUsersForMailboxForm(auth.user),
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    try {
      const payload = await readJson(request);
      const login = String(payload.username || payload.login || '').trim();
      const password = String(payload.password || '');
      const username = normalizeUsername(login);

      const authUser = getUserAuthByUsername(username) || getUserAuthByEmail(normalizeEmail(login));
      if (!authUser || authUser.status !== 'active' || !verifyPassword(password, authUser.password_hash)) {
        sendJson(response, 401, { error: 'Username or password is incorrect.' });
        return true;
      }

      const token = createSessionToken();
      const systemSettings = getSystemSettings();
      const expiresAt = createSessionExpiry({
        value: systemSettings?.sessionTimeoutValue,
        unit: systemSettings?.sessionTimeoutUnit,
      });
      createSession({
        userId: authUser.id,
        token,
        expiresAt,
        userAgent: request.headers['user-agent'] || '',
      });
      markUserLoggedIn(authUser.id);

      sendJson(
        response,
        200,
        {
          ok: true,
          user: sanitizeUser(getUserById(authUser.id)),
          usersForAssignment: getVisibleUsersForMailboxForm(getUserById(authUser.id)),
        },
        { 'Set-Cookie': createSessionCookie(token, expiresAt) },
      );
      return true;
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
      return true;
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/email-code') {
    try {
      const payload = await readJson(request);
      const settings = getSystemSettings();
      const purpose = trimString(payload.purpose || 'register') === 'reset' ? 'reset' : 'register';

      if (purpose === 'register') {
        const registrationSettings = readRegistrationSettings(settings);
        if (!registrationSettings.registrationEnabled) {
          throw new Error('当前系统暂未开放用户注册。');
        }

        if (!registrationSettings.registrationEmailVerificationRequired) {
          throw new Error('当前系统未开启注册邮箱验证码。');
        }

        const email = normalizeEmail(payload.email);
        if (!email) {
          throw new Error('请先填写联系邮箱。');
        }

        assertRegistrationEmailAllowed(email, settings);
        ensureAuthMailReady(settings, 'register');

        const result = await issueEmailAuthCode({
          email,
          purpose: 'register',
          settings,
        });
        sendJson(response, 200, {
          ok: true,
          purpose,
          maskedEmail: result.maskedEmail,
          expiresAt: result.expiresAt,
          message: `验证码已发送到 ${result.maskedEmail}。`,
        });
        return true;
      }

      const registrationSettings = readRegistrationSettings(settings);
      if (!registrationSettings.passwordResetEnabled) {
        throw new Error('当前系统未开启邮箱找回密码。');
      }

      ensureAuthMailReady(settings, 'reset');
      const user = resolveUserForPasswordReset(payload);
      const result = await issueEmailAuthCode({
        email: user.email,
        purpose: 'reset',
        userId: user.id,
        settings,
      });

      sendJson(response, 200, {
        ok: true,
        purpose,
        maskedEmail: result.maskedEmail,
        expiresAt: result.expiresAt,
        message: `重置验证码已发送到 ${result.maskedEmail}。`,
      });
      return true;
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
      return true;
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/password-reset') {
    try {
      const payload = await readJson(request);
      const settings = getSystemSettings();
      const registrationSettings = readRegistrationSettings(settings);
      if (!registrationSettings.passwordResetEnabled) {
        throw new Error('当前系统未开启邮箱找回密码。');
      }

      const user = resolveUserForPasswordReset(payload);
      verifyEmailAuthCodeOrThrow({
        email: user.email,
        purpose: 'reset',
        code: payload.emailCode || payload.code,
        userId: user.id,
      });

      updateUser(user.id, {
        passwordHash: hashPassword(payload.password),
      });

      sendJson(response, 200, {
        ok: true,
        message: '密码已重置，请使用新密码登录。',
      });
      return true;
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
      return true;
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/register') {
    try {
      const payload = await readJson(request);
      const settings = getSystemSettings();
      const registrationSettings = readRegistrationSettings(settings);
      if (!registrationSettings.registrationEnabled) {
        throw new Error('当前系统暂未开放用户注册。');
      }

      const username = validateUsernameValue(payload.username);
      const name = String(payload.name || username).trim() || username;
      const avatarUrl = normalizeAvatarUrl(payload.avatarUrl);
      const passwordHash = hashPassword(payload.password);
      const preferredEmail = normalizeEmail(payload.email);
      const whitelist = normalizeRegistrationWhitelist(settings);

      if (
        registrationSettings.registrationEmailVerificationRequired
        || whitelist.length
      ) {
        if (!preferredEmail) {
          throw new Error('当前注册需要填写联系邮箱。');
        }
        assertRegistrationEmailAllowed(preferredEmail, settings);
      }

      if (getUserByUsername(username)) {
        throw new Error('当前登录用户名已被占用。');
      }

      if (preferredEmail && registrationSettings.registrationEmailVerificationRequired) {
        verifyEmailAuthCodeOrThrow({
          email: preferredEmail,
          purpose: 'register',
          code: payload.emailCode,
        });
      }

      const user = createUser({
        name,
        username,
        email: buildUserEmail(preferredEmail, username),
        avatarUrl,
        passwordHash,
        role: 'user',
        status: 'inactive',
      });

      sendJson(response, 201, {
        ok: true,
        user: sanitizeUser(user),
        message: '注册成功，请等待管理员启用账号。',
      });
      return true;
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
      return true;
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/register') {
    try {
      const payload = await readJson(request);
      const username = validateUsernameValue(payload.username);
      const name = String(payload.name || username).trim() || username;
      const avatarUrl = normalizeAvatarUrl(payload.avatarUrl);
      const passwordHash = hashPassword(payload.password);

      if (getUserByUsername(username)) {
        throw new Error('This username is already in use.');
      }

      const user = createUser({
        name,
        username,
        email: buildUserEmail(payload.email, username),
        avatarUrl,
        passwordHash,
        role: 'user',
        status: 'inactive',
      });

      sendJson(response, 201, {
        ok: true,
        user: sanitizeUser(user),
        message: '濞夈劌鍞介幋鎰閿涘矁顕粵澶婄窡缁狅紕鎮婇崨妯烘儙閻劏澶勯幋鏋偓?',
      });
      return true;
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
      return true;
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    const auth = await getAuthContext(request);
    if (auth.token) {
      deleteSessionByToken(auth.token);
    }

    sendJson(response, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    return true;
  }

  return false;
}

async function handleUserRoutes(request, response, url, auth) {
  if (request.method === 'GET' && url.pathname === '/api/users') {
    if (!requireAdmin(auth, response)) {
      return true;
    }

    sendJson(response, 200, { users: listUsers().map(sanitizeUser) });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/users') {
    if (!requireAdmin(auth, response)) {
      return true;
    }

    try {
      const payload = await readJson(request);
      const username = validateUsernameValue(payload.username);
      const email = buildUserEmail(payload.email, username);
      const name = String(payload.name || '').trim() || username;
      const avatarUrl = normalizeAvatarUrl(payload.avatarUrl);
      const role = payload.role === 'admin' ? 'admin' : 'user';
      const status = payload.status === 'inactive' ? 'inactive' : 'active';
      const passwordHash = hashPassword(payload.password);

      if (!name) {
        throw new Error('Please provide a name.');
      }
      if (!email) {
        throw new Error('Please provide an email address.');
      }
      if (getUserAuthByEmail(email)) {
        throw new Error('This email is already in use.');
      }

      if (getUserByUsername(username)) {
        throw new Error('This username is already in use.');
      }

      const user = createUser({ name, username, email, avatarUrl, passwordHash, role, status });
      sendJson(response, 201, { ok: true, user: sanitizeUser(user) });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return true;
  }

  const updateMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (request.method === 'PATCH' && updateMatch) {
    if (!requireAdmin(auth, response)) {
      return true;
    }

    try {
      const userId = updateMatch[1];
      const existing = getUserById(userId);
      if (!existing) {
        notFound(response);
        return true;
      }

      const payload = await readJson(request);
      const nextRole = payload.role === 'admin' ? 'admin' : payload.role === 'user' ? 'user' : existing.role;
      const nextStatus =
        payload.status === 'inactive' ? 'inactive' : payload.status === 'active' ? 'active' : existing.status;

      const activeAdmins = listUsers().filter((user) => user.role === 'admin' && user.status === 'active');
      const removesLastAdmin =
        existing.role === 'admin' &&
        existing.status === 'active' &&
        activeAdmins.length === 1 &&
        (nextRole !== 'admin' || nextStatus !== 'active');

      if (removesLastAdmin) {
        throw new Error('At least one active administrator must remain.');
      }

      const updateInput = {};
      const nextUsername =
        payload.username !== undefined ? validateUsernameValue(payload.username) : existing.username;
      if (payload.name !== undefined) {
        updateInput.name = String(payload.name || '').trim() || existing.name;
      }
      if (payload.username !== undefined) {
        const conflict = getUserByUsername(nextUsername);
        if (conflict && conflict.id !== userId) {
          throw new Error('This username is already in use.');
        }
        updateInput.username = nextUsername;
      }
      if (payload.email !== undefined) {
        updateInput.email = buildUserEmail(payload.email, nextUsername, userId);
      } else if (payload.username !== undefined && isGeneratedUserEmail(existing.email)) {
        updateInput.email = buildUserEmail('', nextUsername, userId);
      }
      if (payload.avatarUrl !== undefined) {
        updateInput.avatarUrl = normalizeAvatarUrl(payload.avatarUrl);
      }
      if (payload.password) {
        updateInput.passwordHash = hashPassword(payload.password);
      }
      updateInput.role = nextRole;
      updateInput.status = nextStatus;

      const updated = updateUser(userId, updateInput);
      sendJson(response, 200, { ok: true, user: sanitizeUser(updated) });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return true;
  }

  return false;
}

async function handleProfileRoutes(request, response, auth) {
  if (request.method === 'PATCH') {
    try {
      const payload = await readJson(request);
      const currentUser = getUserById(auth.user.id) || auth.user;
      const updates = {};
      if (payload.name !== undefined) {
        const name = String(payload.name || '').trim();
        if (!name) {
          throw new Error('Name cannot be empty.');
        }
        updates.name = name;
      }

      if (payload.username !== undefined) {
        const username = validateUsernameValue(payload.username);
        const conflict = getUserByUsername(username);
        if (conflict && conflict.id !== auth.user.id) {
          throw new Error('This username is already in use.');
        }
        updates.username = username;
        if (isGeneratedUserEmail(currentUser.email)) {
          updates.email = buildUserEmail('', username, auth.user.id);
        }
      }
      if (payload.avatarUrl !== undefined) {
        updates.avatarUrl = normalizeAvatarUrl(payload.avatarUrl);
      }

      if (payload.newPassword) {
        validatePassword(payload.newPassword);
        const authUser =
          getUserAuthByUsername(currentUser.username || auth.user.username) ||
          getUserAuthByEmail(currentUser.email || auth.user.email);
        if (!verifyPassword(payload.currentPassword, authUser.password_hash)) {
          throw new Error('Current password is incorrect.');
        }
        updates.passwordHash = hashPassword(payload.newPassword);
      }

      const updated = updateUser(auth.user.id, updates);
      sendJson(response, 200, { ok: true, user: sanitizeUser(updated) });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return true;
  }

  return false;
}

async function handleNotificationRoutes(request, response, url, auth) {
  if (request.method === 'GET' && url.pathname === '/api/notifications') {
    const notifications = notificationService.listSettingsForUser(auth.user.id);
    const wecomDiscovery = await notificationService.getWecomDiscovery(auth.user.id);
    sendJson(response, 200, {
      notifications,
      wecomDiscovery,
    });
    return true;
  }

  const revealMatch = url.pathname.match(/^\/api\/notifications\/(telegram|wecom|feishu)\/reveal$/);
  if (request.method === 'GET' && revealMatch) {
    try {
      const setting = notificationService.getEditableSetting(auth.user.id, revealMatch[1]);
      sendJson(response, 200, { ok: true, setting });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return true;
  }

  const settingMatch = url.pathname.match(/^\/api\/notifications\/(telegram|wecom|feishu|template)$/);
  if (request.method === 'PUT' && settingMatch) {
    try {
      const payload = await readJson(request);
      const setting = await notificationService.saveSetting(auth.user.id, settingMatch[1], payload);
      sendJson(response, 200, { ok: true, setting });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return true;
  }

  const testMatch = url.pathname.match(/^\/api\/notifications\/(telegram|wecom|feishu)\/test$/);
  if (request.method === 'POST' && testMatch) {
    try {
      const result = await notificationService.sendTest(auth.user.id, testMatch[1]);
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return true;
  }

  return false;
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      port: PORT,
      databaseFile,
      adminEmail: DEFAULT_ADMIN_EMAIL,
      appSecretConfigured:
        Boolean(process.env.APP_SECRET) && process.env.APP_SECRET !== DEFAULT_SECRET,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/system-settings') {
    const auth = await getAuthContext(request);
    const systemSettings = await ensureSystemBrandAsset(getSystemSettings());
    sendJson(response, 200, {
      settings: sanitizeSystemSettings(systemSettings, {
        includeAuthConfig: true,
        includeSmtpConfig: auth.user?.role === 'admin',
        includeGoogleClientId: auth.user?.role === 'admin',
        includeMicrosoftClientId: auth.user?.role === 'admin',
        includeTranslationConfig: auth.user?.role === 'admin',
        includeStorageConfig: auth.user?.role === 'admin',
        includeBackupConfig: auth.user?.role === 'admin',
        includeProxyConfig: auth.user?.role === 'admin',
      }),
    }, auth.clearCookie ? { 'Set-Cookie': clearSessionCookie() } : {});
    return;
  }

  if (await handleWecomCallbackPublicRoutes(request, response, url)) {
    return;
  }

  if (await handleGoogleOAuthPublicRoutes(request, response, url)) {
    return;
  }

  if (await handleMicrosoftOAuthPublicRoutes(request, response, url)) {
    return;
  }

  if (await handleAuthRoutes(request, response, url)) {
    return;
  }

  const auth = await requireAuth(request, response);
  if (!auth) {
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    sendJson(response, 200, sanitizeDashboard(getDashboardSummary(auth.user)));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/providers') {
    sendJson(response, 200, {
      providers: PROVIDER_PRESETS,
      usersForAssignment: getVisibleUsersForMailboxForm(auth.user),
    });
    return;
  }

  if (request.method === 'PUT' && url.pathname === '/api/system-settings') {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const payload = await readJson(request);
      const existingSettings = getSystemSettings();
      const hasBrandPayload =
        Object.prototype.hasOwnProperty.call(payload, 'siteName') ||
        Object.prototype.hasOwnProperty.call(payload, 'logoMode') ||
        Object.prototype.hasOwnProperty.call(payload, 'logoUrl') ||
        Object.prototype.hasOwnProperty.call(payload, 'logoUploadDataUrl');
      const brandAsset = hasBrandPayload
        ? await prepareSystemBrandAsset(payload, existingSettings)
        : null;
      const settings = updateSystemSettings({
        ...(Object.prototype.hasOwnProperty.call(payload, 'siteName')
          ? { siteName: trimString(payload.siteName) || 'Mail Union' }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'logoMode')
          ? { logoMode: normalizeSystemLogoMode(payload.logoMode) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'logoUrl')
          ? { logoUrl: normalizeSystemLogoUrl(payload.logoUrl) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'logoUploadDataUrl')
          ? { logoUploadDataUrl: payload.logoUploadDataUrl }
          : {}),
        ...(brandAsset ? { logoAssetPath: brandAsset.relativePath } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'googleClientId')
          ? { googleClientId: trimString(payload.googleClientId) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'googleClientSecret')
          ? { googleClientSecret: payload.googleClientSecret }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'microsoftClientId')
          ? { microsoftClientId: trimString(payload.microsoftClientId) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'microsoftClientSecret')
          ? { microsoftClientSecret: payload.microsoftClientSecret }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'clearMicrosoftClientSecret')
          ? {
              clearMicrosoftClientSecret: normalizeBooleanFlag(
                payload.clearMicrosoftClientSecret,
                false,
              ),
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'microsoftTenantId')
          ? { microsoftTenantId: normalizeMicrosoftTenantId(payload.microsoftTenantId) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'registrationEnabled')
          ? { registrationEnabled: normalizeBooleanFlag(payload.registrationEnabled, true) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'registrationEmailVerificationRequired')
          ? {
              registrationEmailVerificationRequired: normalizeBooleanFlag(
                payload.registrationEmailVerificationRequired,
                false,
              ),
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'registrationEmailDomainWhitelist')
          ? {
              registrationEmailDomainWhitelist: Array.isArray(payload.registrationEmailDomainWhitelist)
                ? payload.registrationEmailDomainWhitelist
                : String(payload.registrationEmailDomainWhitelist || '')
                    .split(/[\s,;|]+/g)
                    .filter(Boolean),
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'passwordResetEnabled')
          ? { passwordResetEnabled: normalizeBooleanFlag(payload.passwordResetEnabled, false) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'sessionTimeoutValue')
          ? { sessionTimeoutValue: Number(payload.sessionTimeoutValue || 0) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'sessionTimeoutUnit')
          ? { sessionTimeoutUnit: trimString(payload.sessionTimeoutUnit || 'day') }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpHost')
          ? { smtpHost: trimString(payload.smtpHost) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpPort')
          ? { smtpPort: Number(payload.smtpPort || 587) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpSecure')
          ? { smtpSecure: normalizeBooleanFlag(payload.smtpSecure, false) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpUsername')
          ? { smtpUsername: trimString(payload.smtpUsername) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpPassword')
          ? { smtpPassword: payload.smtpPassword }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'clearSmtpPassword')
          ? { clearSmtpPassword: normalizeBooleanFlag(payload.clearSmtpPassword, false) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpFromName')
          ? { smtpFromName: trimString(payload.smtpFromName) || 'Mail Union' }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpFromEmail')
          ? { smtpFromEmail: normalizeEmail(payload.smtpFromEmail) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'translationProvider')
          ? { translationProvider: normalizeTranslationProvider(payload.translationProvider) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'translationTargetLanguage')
          ? {
              translationTargetLanguage: normalizeTranslationTargetLanguage(
                payload.translationTargetLanguage,
              ),
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'translationBaseUrl')
          ? { translationBaseUrl: normalizeTranslationBaseUrl(payload.translationBaseUrl) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'translationRegion')
          ? { translationRegion: normalizeTranslationRegion(payload.translationRegion) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'translationModel')
          ? { translationModel: trimString(payload.translationModel) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'translationApiKey')
          ? { translationApiKey: payload.translationApiKey }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'clearTranslationApiKey')
          ? {
              clearTranslationApiKey: normalizeBooleanFlag(payload.clearTranslationApiKey, false),
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageProvider')
          ? { storageProvider: normalizeStorageProvider(payload.storageProvider) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageSyncPolicy')
          ? { storageSyncPolicy: normalizeStorageSyncPolicy(payload.storageSyncPolicy, 'all_local') }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageRemotePathPrefix')
          ? { storageRemotePathPrefix: trimString(payload.storageRemotePathPrefix) || 'mail-union' }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageS3Bucket')
          ? { storageS3Bucket: trimString(payload.storageS3Bucket) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageS3Region')
          ? { storageS3Region: trimString(payload.storageS3Region) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageS3Endpoint')
          ? { storageS3Endpoint: trimString(payload.storageS3Endpoint) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageS3AccessKey')
          ? { storageS3AccessKey: trimString(payload.storageS3AccessKey) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageS3Secret')
          ? { storageS3Secret: payload.storageS3Secret }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'clearStorageS3Secret')
          ? { clearStorageS3Secret: normalizeBooleanFlag(payload.clearStorageS3Secret, false) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageS3ForcePathStyle')
          ? {
              storageS3ForcePathStyle: normalizeBooleanFlag(
                payload.storageS3ForcePathStyle,
                false,
              ),
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageWebdavUrl')
          ? { storageWebdavUrl: trimString(payload.storageWebdavUrl) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageWebdavUsername')
          ? { storageWebdavUsername: trimString(payload.storageWebdavUsername) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageWebdavPassword')
          ? { storageWebdavPassword: payload.storageWebdavPassword }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'clearStorageWebdavPassword')
          ? {
              clearStorageWebdavPassword: normalizeBooleanFlag(
                payload.clearStorageWebdavPassword,
                false,
              ),
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageFtpHost')
          ? { storageFtpHost: trimString(payload.storageFtpHost) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageFtpPort')
          ? { storageFtpPort: Number(payload.storageFtpPort || 21) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageFtpSecure')
          ? { storageFtpSecure: normalizeBooleanFlag(payload.storageFtpSecure, false) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageFtpUsername')
          ? { storageFtpUsername: trimString(payload.storageFtpUsername) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageFtpPassword')
          ? { storageFtpPassword: payload.storageFtpPassword }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'clearStorageFtpPassword')
          ? {
              clearStorageFtpPassword: normalizeBooleanFlag(
                payload.clearStorageFtpPassword,
                false,
              ),
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'backupEnabled')
          ? { backupEnabled: normalizeBooleanFlag(payload.backupEnabled, false) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'backupIntervalHours')
          ? { backupIntervalHours: Number(payload.backupIntervalHours || 24) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'backupTarget')
          ? { backupTarget: trimString(payload.backupTarget) || 'local' }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'backupRetentionCount')
          ? { backupRetentionCount: Number(payload.backupRetentionCount || 10) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'backupContentMode')
          ? { backupContentMode: trimString(payload.backupContentMode) || 'database_and_site' }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'backupIncludeRuntimeFiles')
          ? {
              backupIncludeRuntimeFiles: normalizeBooleanFlag(
                payload.backupIncludeRuntimeFiles,
                true,
              ),
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'outboundProxyMode')
          ? { outboundProxyMode: normalizeOutboundProxyMode(payload.outboundProxyMode, 'system') }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'outboundProxyUrl')
          ? { outboundProxyUrl: normalizeProxyUrl(payload.outboundProxyUrl) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'outboundProxyBypass')
          ? { outboundProxyBypass: normalizeOutboundProxyBypass(payload.outboundProxyBypass) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'themePresetId')
          ? { themePresetId: trimString(payload.themePresetId) || 'ocean-mist' }
          : {}),
      });

      applyRuntimeProxyEnvironment(settings);
      backupService.refreshSchedule();

      sendJson(response, 200, {
        ok: true,
        settings: sanitizeSystemSettings(settings, {
          includeAuthConfig: true,
          includeSmtpConfig: true,
          includeGoogleClientId: true,
          includeMicrosoftClientId: true,
          includeTranslationConfig: true,
          includeStorageConfig: true,
          includeBackupConfig: true,
          includeProxyConfig: true,
        }),
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/system-settings/test-translation') {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const payload = await readJson(request);
      const existingSettings = getSystemSettings();
      const requestedTranslationProvider = Object.prototype.hasOwnProperty.call(payload, 'translationProvider')
        ? normalizeTranslationProvider(payload.translationProvider)
        : normalizeTranslationProvider(existingSettings?.translationProvider);
      const requestedTranslationApiKey = trimString(payload.translationApiKey);
      const translationProviderChanged =
        requestedTranslationProvider !== normalizeTranslationProvider(existingSettings?.translationProvider);
      const useClearedTranslationApiKey =
        normalizeBooleanFlag(payload.clearTranslationApiKey, false)
        && !requestedTranslationApiKey;
      const resolvedTranslationApiKey = useClearedTranslationApiKey
        ? ''
        : requestedTranslationApiKey
          ? requestedTranslationApiKey
          : translationProviderChanged
            ? ''
            : resolveTranslationApiKey(payload, existingSettings).plain;
      const test = await testTranslationConfig({
        translationProvider: requestedTranslationProvider,
        translationTargetLanguage: Object.prototype.hasOwnProperty.call(payload, 'translationTargetLanguage')
          ? normalizeTranslationTargetLanguage(payload.translationTargetLanguage)
          : normalizeTranslationTargetLanguage(existingSettings?.translationTargetLanguage),
        translationBaseUrl: Object.prototype.hasOwnProperty.call(payload, 'translationBaseUrl')
          ? normalizeTranslationBaseUrl(payload.translationBaseUrl)
          : normalizeTranslationBaseUrl(existingSettings?.translationBaseUrl),
        translationRegion: Object.prototype.hasOwnProperty.call(payload, 'translationRegion')
          ? normalizeTranslationRegion(payload.translationRegion)
          : normalizeTranslationRegion(existingSettings?.translationRegion),
        translationModel: Object.prototype.hasOwnProperty.call(payload, 'translationModel')
          ? trimString(payload.translationModel)
          : trimString(existingSettings?.translationModel),
        translationApiKey: resolvedTranslationApiKey,
      });

      sendJson(response, 200, {
        ok: true,
        message: '翻译配置测试通过。',
        test,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (
    request.method === 'POST'
    && url.pathname === '/api/system-settings/test-smtp'
    && trimString(url.searchParams.get('mode') || '') === 'verify'
  ) {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const payload = await readJson(request);
      const existingSettings = getSystemSettings();
      const smtpSettings = buildDraftSmtpSettings(existingSettings, payload);

      await verifyAuthMailConnection(smtpSettings);
      sendJson(response, 200, {
        ok: true,
        message: 'SMTP 连接测试成功。',
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (
    request.method === 'POST'
    && url.pathname === '/api/system-settings/test-smtp'
    && trimString(url.searchParams.get('mode') || 'draft') === 'draft'
  ) {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const payload = await readJson(request);
      const existingSettings = getSystemSettings();
      const smtpSettings = buildDraftSmtpSettings(existingSettings, payload);
      const testEmail = normalizeEmail(payload.testEmail || auth.user.email || DEFAULT_ADMIN_EMAIL);
      if (!testEmail) {
        throw new Error('请先填写一个可接收测试邮件的邮箱地址。');
      }

      await sendAuthMailTest({ to: testEmail }, smtpSettings);
      sendJson(response, 200, {
        ok: true,
        message: `测试邮件已发送到 ${testEmail}。`,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/system-settings/test-smtp') {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const payload = await readJson(request);
      const existingSettings = getSystemSettings();
      const smtpSettings = updateSystemSettings({
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpHost')
          ? { smtpHost: trimString(payload.smtpHost) }
          : { smtpHost: existingSettings.smtpHost }),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpPort')
          ? { smtpPort: Number(payload.smtpPort || 587) }
          : { smtpPort: existingSettings.smtpPort }),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpSecure')
          ? { smtpSecure: normalizeBooleanFlag(payload.smtpSecure, false) }
          : { smtpSecure: existingSettings.smtpSecure }),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpUsername')
          ? { smtpUsername: trimString(payload.smtpUsername) }
          : { smtpUsername: existingSettings.smtpUsername }),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpPassword')
          ? { smtpPassword: payload.smtpPassword }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'clearSmtpPassword')
          ? { clearSmtpPassword: normalizeBooleanFlag(payload.clearSmtpPassword, false) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpFromName')
          ? { smtpFromName: trimString(payload.smtpFromName) || 'Mail Union' }
          : { smtpFromName: existingSettings.smtpFromName }),
        ...(Object.prototype.hasOwnProperty.call(payload, 'smtpFromEmail')
          ? { smtpFromEmail: normalizeEmail(payload.smtpFromEmail) }
          : { smtpFromEmail: existingSettings.smtpFromEmail }),
      });
      const testEmail = normalizeEmail(payload.testEmail || auth.user.email || DEFAULT_ADMIN_EMAIL);
      if (!testEmail) {
        throw new Error('请先填写一个可接收测试邮件的邮箱地址。');
      }
      await sendAuthMailTest({ to: testEmail }, smtpSettings);
      sendJson(response, 200, {
        ok: true,
        message: `测试邮件已发送到 ${testEmail}。`,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/system-settings/test-proxy') {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const payload = await readJson(request);
      const existingSettings = getSystemSettings();
      const proxySettings = {
        ...existingSettings,
        ...(Object.prototype.hasOwnProperty.call(payload, 'outboundProxyMode')
          ? { outboundProxyMode: normalizeOutboundProxyMode(payload.outboundProxyMode, 'system') }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'outboundProxyUrl')
          ? { outboundProxyUrl: normalizeProxyUrl(payload.outboundProxyUrl) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'outboundProxyBypass')
          ? { outboundProxyBypass: normalizeOutboundProxyBypass(payload.outboundProxyBypass) }
          : {}),
      };

      if (proxySettings.outboundProxyMode === 'custom' && !proxySettings.outboundProxyUrl) {
        throw new Error('自定义代理模式下必须填写代理地址（Proxy URL）。');
      }

      const proxyTest = await testOutboundConnectivity(proxySettings);
      sendJson(response, 200, {
        ok: true,
        message:
          proxyTest.successCount === proxyTest.totalCount
            ? '外网代理连通测试通过。'
            : `外网代理测试完成，${proxyTest.successCount}/${proxyTest.totalCount} 个目标可达。`,
        proxyTest,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/system-settings/test-storage') {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const payload = await readJson(request);
      const existingSettings = getSystemSettings();
      const storageSettings = {
        ...existingSettings,
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageProvider')
          ? { storageProvider: normalizeStorageProvider(payload.storageProvider) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageSyncPolicy')
          ? { storageSyncPolicy: normalizeStorageSyncPolicy(payload.storageSyncPolicy, 'all_local') }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageRemotePathPrefix')
          ? { storageRemotePathPrefix: trimString(payload.storageRemotePathPrefix) || 'mail-union' }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageS3Bucket')
          ? { storageS3Bucket: trimString(payload.storageS3Bucket) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageS3Region')
          ? { storageS3Region: trimString(payload.storageS3Region) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageS3Endpoint')
          ? { storageS3Endpoint: trimString(payload.storageS3Endpoint) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageS3AccessKey')
          ? { storageS3AccessKey: trimString(payload.storageS3AccessKey) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageS3Secret')
          ? { storageS3Secret: payload.storageS3Secret }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageS3ForcePathStyle')
          ? {
              storageS3ForcePathStyle: normalizeBooleanFlag(
                payload.storageS3ForcePathStyle,
                false,
              ),
            }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageWebdavUrl')
          ? { storageWebdavUrl: trimString(payload.storageWebdavUrl) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageWebdavUsername')
          ? { storageWebdavUsername: trimString(payload.storageWebdavUsername) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageWebdavPassword')
          ? { storageWebdavPassword: payload.storageWebdavPassword }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageFtpHost')
          ? { storageFtpHost: trimString(payload.storageFtpHost) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageFtpPort')
          ? { storageFtpPort: Number(payload.storageFtpPort || 21) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageFtpSecure')
          ? { storageFtpSecure: normalizeBooleanFlag(payload.storageFtpSecure, false) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageFtpUsername')
          ? { storageFtpUsername: trimString(payload.storageFtpUsername) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'storageFtpPassword')
          ? { storageFtpPassword: payload.storageFtpPassword }
          : {}),
      };

      const test = await testRemoteStorageConnection(storageSettings);
      sendJson(response, 200, {
        ok: true,
        message: String(test.message || '远程存储测试通过。').trim() || '远程存储测试通过。',
        test,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (
    request.method === 'GET'
    && url.pathname === '/api/system-settings/reveal'
    && trimString(url.searchParams.get('field') || '') === 'smtpPassword'
  ) {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const secret = trimString(getSystemSettings()?.smtpPasswordEncrypted);
      sendJson(response, 200, {
        ok: true,
        setting: {
          smtpPassword: secret ? decrypt(secret) : '',
        },
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/system-settings/reveal') {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const field = trimString(url.searchParams.get('field') || 'microsoftClientSecret');
      if (field === 'translationApiKey') {
        const secret = resolveTranslationApiKey({}, null);
        sendJson(response, 200, {
          ok: true,
          setting: {
            translationApiKey: secret.plain || '',
          },
        });
        return;
      }

      if (
        ['storageS3Secret', 'storageWebdavPassword', 'storageFtpPassword'].includes(field)
      ) {
        const secret = resolveSystemStorageSecret(field);
        sendJson(response, 200, {
          ok: true,
          setting: {
            [field]: secret.plain || '',
          },
        });
        return;
      }

      if (field === 'googleClientSecret') {
        const secret = resolveGoogleClientSecret({}, null);
        sendJson(response, 200, {
          ok: true,
          setting: {
            googleClientSecret: secret.plain || '',
          },
        });
        return;
      }

      if (field !== 'microsoftClientSecret') {
        sendJson(response, 400, { error: 'Unsupported reveal field.' });
        return;
      }

      const secret = resolveMicrosoftClientSecret({}, null);
      sendJson(response, 200, {
        ok: true,
        setting: {
          microsoftClientSecret: secret.plain || '',
        },
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/backups') {
    if (!requireAdmin(auth, response)) {
      return;
    }

    sendJson(response, 200, {
      backups: listBackupRecords(80).map(sanitizeBackupRecord),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/backups/run') {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const payload = await readJson(request);
      const backup = await backupService.runBackup({
        destination: trimString(payload.destination) || undefined,
        backupContentMode: trimString(payload.backupContentMode) || undefined,
        triggerSource: 'manual',
      });
      sendJson(response, 200, {
        ok: true,
        backup: sanitizeBackupRecord(backup),
        backups: listBackupRecords(80).map(sanitizeBackupRecord),
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/backups/restore') {
    if (!requireAdmin(auth, response)) {
      return;
    }

    const restoreMode = trimString(url.searchParams.get('mode') || 'full_site_data');
    const uploadRoot = path.join(process.cwd(), 'runtime', 'uploads');
    const uploadPath = path.join(uploadRoot, `backup-restore-${Date.now()}-${randomUUID()}.zip`);
    fs.mkdirSync(uploadRoot, { recursive: true });
    backupService.stop();
    syncService.pause();

    try {
      await syncService.waitForIdle(30_000);
      await readRequestBodyToFile(request, uploadPath, {
        maxBytes: BACKUP_RESTORE_UPLOAD_MAX_BYTES,
      });

      const restoreResult = await backupService.restoreBackupArchive(uploadPath, {
        restoreMode,
      });
      const restoredSettings = getSystemSettings();
      const warnings = [];
      try {
        applyRuntimeProxyEnvironment(restoredSettings);
      } catch (runtimeError) {
        const warning = `系统还原已完成，但恢复后的代理配置未能立即生效：${String(runtimeError.message || runtimeError)}`;
        warnings.push(warning);
        console.warn('[restore] runtime proxy refresh warning:', warning);
      }

      const responseHeaders = restoreResult.requiresReauth
        ? { 'Set-Cookie': clearSessionCookie() }
        : {};

      sendJson(response, 200, {
        ok: true,
        restoreMode: restoreResult.restoreMode || restoreMode,
        contentMode: restoreResult.contentMode,
        restoredComponents: restoreResult.restoredComponents || [],
        clearedComponents: restoreResult.clearedComponents || [],
        restartRecommended: Boolean(restoreResult.restartRecommended),
        requiresReauth: Boolean(restoreResult.requiresReauth),
        warnings,
        safetyBackup: restoreResult.safetyBackup
          ? {
              filename: String(restoreResult.safetyBackup.filename || '').trim(),
              localPath: String(restoreResult.safetyBackup.localPath || '').trim(),
              createdAt: restoreResult.safetyBackup.createdAt || null,
            }
          : null,
        backups: restoreResult.requiresReauth
          ? []
          : listBackupRecords(80).map(sanitizeBackupRecord),
      }, responseHeaders);
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    } finally {
      try {
        fs.rmSync(uploadPath, { force: true });
      } catch (_) {
        // Ignore cleanup failure for temporary upload files.
      }

      syncService.resume();
      backupService.refreshSchedule();
    }
    return;
  }

  const backupRecordMatch = url.pathname.match(/^\/api\/backups\/([^/]+)$/);
  if (request.method === 'DELETE' && backupRecordMatch) {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const deleted = await backupService.deleteBackup(backupRecordMatch[1]);
      if (!deleted) {
        notFound(response);
        return;
      }

      const warnings = Array.isArray(deleted.warnings) ? deleted.warnings.filter(Boolean) : [];
      sendJson(response, 200, {
        ok: true,
        deletedId: deleted.record?.id || '',
        warnings,
        backups: listBackupRecords(80).map(sanitizeBackupRecord),
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  const backupDownloadMatch = url.pathname.match(/^\/api\/backups\/([^/]+)\/download$/);
  if (request.method === 'GET' && backupDownloadMatch) {
    if (!requireAdmin(auth, response)) {
      return;
    }

    const backup = backupService.getBackupRecord(backupDownloadMatch[1]);
    if (!backup || !backup.localPath || !fs.existsSync(backup.localPath)) {
      notFound(response);
      return;
    }

    sendFile(response, backup.localPath, {
      'Content-Disposition': `attachment; filename="${encodeURIComponent(
        backup.filename || path.basename(backup.localPath),
      )}"`,
    });
    return;
  }

  if (url.pathname === '/api/profile') {
    if (await handleProfileRoutes(request, response, auth)) {
      return;
    }
  }

  if (await handleGoogleOAuthPrivateRoutes(request, response, url, auth)) {
    return;
  }

  if (await handleMicrosoftOAuthPrivateRoutes(request, response, url, auth)) {
    return;
  }

  if (await handleNotificationRoutes(request, response, url, auth)) {
    return;
  }

  if (await handleUserRoutes(request, response, url, auth)) {
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/mailboxes') {
    const ownerUserId =
      auth.user.role === 'admin' ? url.searchParams.get('ownerUserId') || null : null;
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 1000), 1), 5000);
    sendJson(response, 200, {
      mailboxes: listMailboxes({ viewer: auth.user, ownerUserId, limit }).map(sanitizeMailbox),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/mailboxes/bulk-delete') {
    try {
      const payload = await readJson(request);
      const mailboxIds = Array.from(
        new Set((payload.mailboxIds || []).map((mailboxId) => String(mailboxId || '').trim()).filter(Boolean)),
      );

      const visibleMailboxes = mailboxIds
        .map((mailboxId) => getMailboxById(mailboxId, auth.user))
        .filter(Boolean);

      for (const mailbox of visibleMailboxes) {
        deleteMailbox(mailbox.id);
      }

      sendJson(response, 200, {
        ok: true,
        deletedCount: visibleMailboxes.length,
        deletedMailboxIds: visibleMailboxes.map((mailbox) => mailbox.id),
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/mailboxes/import/microsoft') {
    try {
      const requestBody = await readJson(request);
      const systemSettings = getSystemSettings();
      const ownerUserId =
        auth.user.role === 'admin'
          ? String(requestBody.ownerUserId || auth.user.id)
          : auth.user.id;

      if (!getUserById(ownerUserId)) {
        throw new Error('The selected owner user does not exist.');
      }

      const entries = parseMicrosoftOauthImportText(
        requestBody.importText || requestBody.content || requestBody.text || '',
        {
          ownerUserId,
          microsoftClientSecret: requestBody.microsoftClientSecret,
          microsoftTenantId: requestBody.microsoftTenantId || systemSettings.microsoftTenantId || 'common',
          microsoftProtocolMode: requestBody.microsoftProtocolMode,
          imapHost: requestBody.imapHost,
          imapPort: requestBody.imapPort,
          secure: requestBody.secure,
          syncIntervalSeconds: requestBody.syncIntervalSeconds,
          sortOrder: requestBody.sortOrder,
          isPinned: requestBody.isPinned,
        },
      );

      const results = [];
      for (const entry of entries) {
        try {
          const existingMailbox = findVisibleMailboxByEmail(auth.user, entry.email);
          const normalizedPayload = existingMailbox
            ? normalizeMailboxPayloadForUpdate(entry, auth.user, existingMailbox)
            : normalizeMailboxPayload(entry, auth.user);

          const connectionChanged = existingMailbox
            ? isMailboxConnectionChanged(existingMailbox, normalizedPayload)
            : false;
          const mailbox = existingMailbox
            ? updateMailbox(existingMailbox.id, normalizedPayload)
            : createMailbox(normalizedPayload);

          if (connectionChanged) {
            clearMailboxMessages(mailbox.id);
          }

          let syncResult = null;
          let warning = '';
          try {
            syncResult = await syncService.syncMailbox(
              mailbox.id,
              existingMailbox ? 'microsoft-import-update' : 'microsoft-import-create',
            );
          } catch (syncError) {
            warning = describeMailboxConnectionError(syncError, normalizedPayload);
          }

          results.push({
            email: entry.email,
            ok: true,
            action: existingMailbox ? 'updated' : 'created',
            mailbox: sanitizeMailbox(getMailboxById(mailbox.id, auth.user)),
            syncResult,
            verified: !warning,
            warning,
          });
        } catch (error) {
          results.push({
            email: entry.email,
            ok: false,
            error: String(error.message || error),
          });
        }
      }

      sendJson(response, 200, {
        ok: true,
        total: results.length,
        createdCount: results.filter((item) => item.ok && item.action === 'created').length,
        updatedCount: results.filter((item) => item.ok && item.action === 'updated').length,
        failedCount: results.filter((item) => !item.ok).length,
        warningCount: results.filter((item) => item.ok && item.warning).length,
        results,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/mailboxes/test') {
    let requestBody = null;
    let requestContext = null;
    try {
      requestBody = await readJson(request);
      const existingMailbox = requestBody.mailboxId
        ? getMailboxById(String(requestBody.mailboxId), auth.user)
        : null;

      if (requestBody.mailboxId && !existingMailbox) {
        notFound(response);
        return;
      }

      const payload = existingMailbox
        ? normalizeMailboxPayloadForUpdate(requestBody, auth.user, existingMailbox)
        : normalizeMailboxPayload(requestBody, auth.user);
      requestContext = payload;
      const probe = await syncService.testConnection({
        id: 'probe',
        provider: payload.provider,
        email: payload.email,
        username: payload.username,
        password_encrypted: payload.passwordEncrypted,
        authType: payload.authType,
        oauth: payload.oauth,
        imap_host: payload.imapHost,
        imap_port: payload.imapPort,
        secure: payload.secure,
      });
      sendJson(response, 200, { ok: true, probe });
    } catch (error) {
      sendJson(response, 400, { error: describeMailboxConnectionError(error, requestContext || requestBody || {}) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/mailboxes') {
    let payload = null;
    try {
      payload = normalizeMailboxPayload(await readJson(request), auth.user);
      if (payload.ownerUserId !== auth.user.id && auth.user.role !== 'admin') {
        forbidden(response);
        return;
      }
      if (!getUserById(payload.ownerUserId)) {
        throw new Error('The selected owner user does not exist.');
      }

      await syncService.testConnection({
        id: 'probe',
        provider: payload.provider,
        email: payload.email,
        username: payload.username,
        password_encrypted: payload.passwordEncrypted,
        authType: payload.authType,
        oauth: payload.oauth,
        imap_host: payload.imapHost,
        imap_port: payload.imapPort,
        secure: payload.secure,
      });

      const mailbox = createMailbox(payload);
      sendJson(response, 201, {
        ok: true,
        mailbox: sanitizeMailbox(getMailboxById(mailbox.id, auth.user)),
        syncStarted: true,
      });
      triggerMailboxSyncInBackground(mailbox.id, 'initial-save');
    } catch (error) {
      sendJson(response, 400, { error: describeMailboxConnectionError(error, payload || {}) });
    }
    return;
  }

  const revealMailboxPasswordMatch = url.pathname.match(/^\/api\/mailboxes\/([^/]+)\/password$/);
  if (request.method === 'POST' && revealMailboxPasswordMatch) {
    const mailbox = getMailboxById(revealMailboxPasswordMatch[1], auth.user);
    if (!mailbox) {
      notFound(response);
      return;
    }

    if (String(mailbox.authType || 'password').trim() !== 'password') {
      sendJson(response, 400, { error: '当前邮箱使用的是 OAuth2 登录方式，没有可显示的 IMAP 密码。' });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      password: mailbox.password_encrypted ? decrypt(mailbox.password_encrypted) : '',
    });
    return;
  }

  const updateMailboxDisplayMatch = url.pathname.match(/^\/api\/mailboxes\/([^/]+)\/display$/);
  if (request.method === 'PATCH' && updateMailboxDisplayMatch) {
    const existingMailbox = getMailboxById(updateMailboxDisplayMatch[1], auth.user);
    if (!existingMailbox) {
      notFound(response);
      return;
    }

    try {
      const payload = await readJson(request);
      const mailbox = updateMailboxDisplay(existingMailbox.id, {
        sortOrder: normalizeMailboxSortOrder(payload.sortOrder, existingMailbox.sortOrder ?? 100),
        isPinned: normalizeBooleanFlag(payload.isPinned, existingMailbox.isPinned ?? false),
      });
      sendJson(response, 200, {
        ok: true,
        mailbox: sanitizeMailbox(getMailboxById(mailbox.id, auth.user)),
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/mailboxes/reorder') {
    try {
      const payload = await readJson(request);
      const visibleMailboxes = listMailboxes({ viewer: auth.user, limit: 5000 });
      const visibleMailboxMap = new Map(visibleMailboxes.map((mailbox) => [mailbox.id, mailbox]));
      const requestedIds = Array.from(
        new Set((payload.orderedMailboxIds || []).map((mailboxId) => String(mailboxId || '').trim()).filter(Boolean)),
      ).filter((mailboxId) => visibleMailboxMap.has(mailboxId));

      if (!requestedIds.length) {
        throw new Error('请至少提供一个可见邮箱进行排序。');
      }

      const orderedMailboxIds = [
        ...requestedIds,
        ...visibleMailboxes
          .map((mailbox) => mailbox.id)
          .filter((mailboxId) => !requestedIds.includes(mailboxId)),
      ];
      const entries = orderedMailboxIds.map((mailboxId, index) => ({
        id: mailboxId,
        sortOrder: (index + 1) * 10,
      }));

      const mailboxes = updateMailboxSortOrders(entries)
        .filter(Boolean)
        .map((mailbox) => sanitizeMailbox(getMailboxById(mailbox.id, auth.user)));

      sendJson(response, 200, {
        ok: true,
        mailboxes,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  const updateMailboxMatch = url.pathname.match(/^\/api\/mailboxes\/([^/]+)$/);
  if (request.method === 'PATCH' && updateMailboxMatch) {
    const existingMailbox = getMailboxById(updateMailboxMatch[1], auth.user);
    if (!existingMailbox) {
      notFound(response);
      return;
    }

    let payload = null;
    try {
      payload = normalizeMailboxPayloadForUpdate(
        await readJson(request),
        auth.user,
        existingMailbox,
      );
      if (payload.ownerUserId !== auth.user.id && auth.user.role !== 'admin') {
        forbidden(response);
        return;
      }
      if (!getUserById(payload.ownerUserId)) {
        throw new Error('The selected owner user does not exist.');
      }

      await syncService.testConnection({
        id: existingMailbox.id,
        provider: payload.provider,
        email: payload.email,
        username: payload.username,
        password_encrypted: payload.passwordEncrypted,
        authType: payload.authType,
        oauth: payload.oauth,
        imap_host: payload.imapHost,
        imap_port: payload.imapPort,
        secure: payload.secure,
      });

      const connectionChanged = isMailboxConnectionChanged(existingMailbox, payload);
      const mailbox = updateMailbox(existingMailbox.id, payload);
      if (connectionChanged) {
        clearMailboxMessages(mailbox.id);
      }
      sendJson(response, 200, {
        ok: true,
        mailbox: sanitizeMailbox(getMailboxById(mailbox.id, auth.user)),
        syncStarted: true,
        resetMessages: connectionChanged,
      });
      triggerMailboxSyncInBackground(mailbox.id, 'update-save');
    } catch (error) {
      sendJson(response, 400, { error: describeMailboxConnectionError(error, payload || existingMailbox || {}) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/sync-all') {
    try {
      const result = await syncVisibleMailboxes(auth.user);
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(response, 500, { error: String(error.message || error) });
    }
    return;
  }

  const syncMailboxMatch = url.pathname.match(/^\/api\/mailboxes\/([^/]+)\/sync$/);
  if (request.method === 'POST' && syncMailboxMatch) {
    const mailbox = getMailboxById(syncMailboxMatch[1], auth.user);
    if (!mailbox) {
      notFound(response);
      return;
    }

    try {
      const result = await syncService.syncMailbox(mailbox.id, 'manual-single');
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(response, 400, { error: describeMailboxConnectionError(error, mailbox) });
    }
    return;
  }

  const updateMailboxIntervalMatch = url.pathname.match(/^\/api\/mailboxes\/([^/]+)\/interval$/);
  if (request.method === 'PATCH' && updateMailboxIntervalMatch) {
    const mailbox = getMailboxById(updateMailboxIntervalMatch[1], auth.user);
    if (!mailbox) {
      notFound(response);
      return;
    }

    try {
      const payload = await readJson(request);
      const syncIntervalSeconds = Math.min(
        Math.max(Number(payload.syncIntervalSeconds) || MIN_SYNC_INTERVAL_SECONDS, MIN_SYNC_INTERVAL_SECONDS),
        MAX_SYNC_INTERVAL_SECONDS,
      );
      const updated = updateMailboxSyncInterval(mailbox.id, syncIntervalSeconds);
      sendJson(response, 200, { ok: true, mailbox: sanitizeMailbox(updated) });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  const deleteMailboxMatch = url.pathname.match(/^\/api\/mailboxes\/([^/]+)$/);
  if (request.method === 'DELETE' && deleteMailboxMatch) {
    const mailbox = getMailboxById(deleteMailboxMatch[1], auth.user);
    if (!mailbox) {
      notFound(response);
      return;
    }

    deleteMailbox(mailbox.id);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/messages') {
    const mailboxId = url.searchParams.get('mailboxId') || null;
    const query = url.searchParams.get('q') || '';
    const folder = url.searchParams.get('folder') || 'all';
    const pageSize = normalizePaginationPageSize(
      url.searchParams.get('pageSize') || url.searchParams.get('limit') || 10,
      10,
    );
    const requestedPage = normalizePaginationPage(url.searchParams.get('page') || 1, 1);
    const ownerUserId =
      auth.user.role === 'admin' ? url.searchParams.get('ownerUserId') || null : null;
    const baseOptions = {
      viewer: auth.user,
      mailboxId,
      ownerUserId,
      query,
    };
    const folderCounts = getMessageFolderStats(baseOptions);
    const totalItems = resolveFolderResultCount(folderCounts, folder);
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const page = Math.min(requestedPage, totalPages);
    sendJson(response, 200, {
      messages: listMessages({
        ...baseOptions,
        folder,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }).map(sanitizeMessageListItem),
      folder,
      folderCounts,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages,
      },
    });
    return;
  }

  if (request.method === 'PATCH' && url.pathname === '/api/messages/bulk') {
    try {
      const payload = await readJson(request);
      const sourceMessages = getMessagesByIds(payload.messageIds, auth.user);
      await syncService.applyRemoteMessageStates(sourceMessages, {
        isRead: payload.isRead,
        isStarred: payload.isStarred,
      });
      const messages = updateMessagesState(payload.messageIds, auth.user, {
        isRead: payload.isRead,
        isStarred: payload.isStarred,
      });

      sendJson(response, 200, {
        ok: true,
        updatedCount: messages.length,
        messages: messages.map(sanitizeMessageListItem),
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/messages/bulk-delete') {
    try {
      const payload = await readJson(request);
      const sourceMessages = getMessagesByIds(payload.messageIds, auth.user);
      if (!sourceMessages.length) {
        sendJson(response, 200, { ok: true, deletedCount: 0, mailboxResults: [] });
        return;
      }

      await syncService.deleteRemoteMessages(sourceMessages, {
        permanent: Boolean(payload.permanent),
      });
      const mailboxResults = await resyncMailboxes(sourceMessages.map((message) => message.mailboxId));

      sendJson(response, 200, {
        ok: true,
        deletedCount: sourceMessages.length,
        mailboxResults,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/attachment-metadata') {
    const attachmentPage = buildAttachmentMetadataPage(auth.user, {
      ownerUserId: url.searchParams.get('ownerUserId') || null,
      mailboxId: url.searchParams.get('mailboxId') || null,
      page: url.searchParams.get('page') || 1,
      pageSize: url.searchParams.get('pageSize') || url.searchParams.get('limit') || 10,
    });

    sendJson(response, 200, {
      attachments: attachmentPage.attachments,
      pagination: attachmentPage.pagination,
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/attachment-metadata/sync-selected') {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const result = await syncService.syncEligibleMailboxAttachments({
        limit: Number(url.searchParams.get('limit') || 2000),
      });
      const attachmentPage = buildAttachmentMetadataPage(auth.user, {
        page: url.searchParams.get('page') || 1,
        pageSize: url.searchParams.get('pageSize') || url.searchParams.get('refreshLimit') || 10,
      });

      sendJson(response, 200, {
        ok: true,
        result,
        attachments: attachmentPage.attachments,
        pagination: attachmentPage.pagination,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/attachment-metadata/bulk-delete') {
    if (!requireAdmin(auth, response)) {
      return;
    }

    try {
      const payload = await readJson(request);
      const selections = normalizeAttachmentBulkSelection(payload.attachments);
      const result = {
        requestedCount: selections.length,
        deletedCount: 0,
        updatedCount: 0,
        missingFileCount: 0,
        skippedCount: 0,
        errorCount: 0,
        errors: [],
      };

      for (const selection of selections) {
        try {
          const message = getMessageById(selection.messageId, auth.user);
          const attachments = Array.isArray(message?.attachments) ? message.attachments.slice() : [];
          const attachment = attachments[selection.attachmentIndex] || null;

          if (!message || !attachment || !attachment.stored) {
            result.skippedCount += 1;
            continue;
          }

          const storagePath = resolveAttachmentLocalStoragePath(attachment);
          if (storagePath && fs.existsSync(storagePath)) {
            await fs.promises.unlink(storagePath);
            result.deletedCount += 1;
          } else {
            result.missingFileCount += 1;
          }

          attachments[selection.attachmentIndex] = {
            ...attachment,
            stored: false,
            relativePath: '',
            publicPath: '',
            note: '本地附件已手动删除，需要时可重新同步。',
            error: '',
          };
          updateMessageAttachments(message.id, auth.user, attachments);
          result.updatedCount += 1;
        } catch (error) {
          result.errorCount += 1;
          result.errors.push({
            messageId: selection.messageId,
            attachmentIndex: selection.attachmentIndex,
            error: String(error.message || error),
          });
        }
      }

      const attachmentPage = buildAttachmentMetadataPage(auth.user, {
        page: url.searchParams.get('page') || 1,
        pageSize: url.searchParams.get('pageSize') || 10,
      });

      sendJson(response, 200, {
        ok: true,
        result,
        attachments: attachmentPage.attachments,
        pagination: attachmentPage.pagination,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  const messageTranslateMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/translate$/);
  if (request.method === 'POST' && messageTranslateMatch) {
    try {
      const sourceMessage = getMessageById(messageTranslateMatch[1], auth.user);
      if (!sourceMessage) {
        notFound(response);
        return;
      }

      const translation = await translateMessage(sourceMessage, buildMessageTranslationOptions(getSystemSettings()));

      sendJson(response, 200, {
        ok: true,
        translation,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  const messageAttachmentMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/attachments\/(\d+)\/(open|download)$/);
  if (request.method === 'GET' && messageAttachmentMatch) {
    try {
      const messageId = messageAttachmentMatch[1];
      const attachmentIndex = Number(messageAttachmentMatch[2]);
      const action = String(messageAttachmentMatch[3] || 'open').trim().toLowerCase();
      let message = getMessageById(messageId, auth.user);

      if (!message) {
        notFound(response);
        return;
      }

      let attachment = Array.isArray(message.attachments) ? message.attachments[attachmentIndex] || null : null;
      let storagePath =
        attachment?.publicPath && attachment?.stored
          ? resolveStorageRequestPath(String(attachment.publicPath || '').trim())
          : null;

      if (!attachment) {
        notFound(response);
        return;
      }

      if (!storagePath || !fs.existsSync(storagePath)) {
        sendJson(response, 404, {
          error: '当前附件尚未同步到本地，请先在系统设置中执行“同步已勾选邮箱附件”。',
        });
        return;
      }

      const attachmentFilename = String(attachment.filename || `attachment-${attachmentIndex + 1}`).trim() || `attachment-${attachmentIndex + 1}`;
      sendFile(response, storagePath, {
        'Content-Disposition': `${action === 'download' ? 'attachment' : 'inline'}; filename="${encodeURIComponent(attachmentFilename)}"`,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  const messageMatch = url.pathname.match(/^\/api\/messages\/([^/]+)$/);
  if (request.method === 'PATCH' && messageMatch) {
    try {
      const payload = await readJson(request);
      const sourceMessage = getMessageById(messageMatch[1], auth.user);
      if (!sourceMessage) {
        notFound(response);
        return;
      }
      await syncService.applyRemoteMessageState(sourceMessage, {
        isRead: payload.isRead,
        isStarred: payload.isStarred,
      });
      const updated = updateMessageState(messageMatch[1], auth.user, {
        isRead: payload.isRead,
        isStarred: payload.isStarred,
      });

      if (!updated) {
        notFound(response);
        return;
      }

      sendJson(response, 200, { ok: true, message: sanitizeMessageListItem(updated) });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'DELETE' && messageMatch) {
    try {
      const sourceMessage = getMessageById(messageMatch[1], auth.user);
      if (!sourceMessage) {
        notFound(response);
        return;
      }

      await syncService.deleteRemoteMessages([sourceMessage], {
        permanent: url.searchParams.get('permanent') === '1',
      });
      const mailboxResults = await resyncMailboxes([sourceMessage.mailboxId]);

      sendJson(response, 200, {
        ok: true,
        deletedCount: 1,
        mailboxResults,
      });
    } catch (error) {
      sendJson(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === 'GET' && messageMatch) {
    const message = getMessageById(messageMatch[1], auth.user);
    if (!message) {
      notFound(response);
      return;
    }

    sendJson(response, 200, { message });
    return;
  }

  notFound(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }

    if (url.pathname.startsWith('/files/')) {
      const storagePath = resolveStorageRequestPath(url.pathname);
      if (!storagePath || !fs.existsSync(storagePath)) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }

      sendFile(response, storagePath);
      return;
    }

    if (
      request.method === 'GET'
      && ['/legal/privacy', '/legal/privacy.html', '/legal/terms', '/legal/terms.html'].includes(url.pathname)
    ) {
      const currentSettings = sanitizeSystemSettings(getSystemSettings());
      const documentType = url.pathname.includes('privacy') ? 'privacy' : 'terms';
      sendHtml(response, 200, renderPublicLegalPage(documentType, currentSettings, requestBaseUrl(request, url)));
      return;
    }

    const previewEntryMatch = url.pathname.match(/^\/m\/([^/]+)$/);
    if (request.method === 'GET' && previewEntryMatch) {
      const currentSettings = sanitizeSystemSettings(getSystemSettings());
      const accessPayload = buildPreviewAccessPayloadFromEntryToken(previewEntryMatch[1] || '');
      if (!accessPayload) {
        sendHtml(response, 403, renderMessagePreviewErrorPage('当前预览链接无效，或已过期。', currentSettings));
        return;
      }

      const fullPreviewToken = createSignedToken(accessPayload);
      response.writeHead(302, {
        Location: `/preview/message?token=${encodeURIComponent(fullPreviewToken)}`,
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/preview/message') {
      const currentSettings = sanitizeSystemSettings(getSystemSettings());
      const token = url.searchParams.get('token') || '';
      const previewResult = resolvePreviewMessageAccess(token);
      if (!previewResult.ok) {
        sendHtml(response, previewResult.statusCode, renderMessagePreviewErrorPage(previewResult.error, currentSettings));
        return;
      }

      sendHtml(response, 200, renderMessagePreviewPageV3(previewResult.message, currentSettings, token));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/preview/message/translate') {
      try {
        const payload = await readJson(request);
        const token = trimString(payload?.token || url.searchParams.get('token') || '');
        const previewResult = resolvePreviewMessageAccess(token);
        if (!previewResult.ok) {
          sendJson(response, previewResult.statusCode, { error: previewResult.error });
          return;
        }

        const systemSettings = getSystemSettings();
        const inlineTexts = Array.isArray(payload?.texts) ? payload.texts.slice(0, 600) : null;
        const inlineSubject = trimString(payload?.subject || '');

        if (inlineTexts) {
          const totalLength = inlineTexts.reduce((sum, item) => sum + String(item || '').length, 0);
          if (totalLength > 120000) {
            throw new Error('翻译内容过长，请缩小范围后重试。');
          }

          const translatedSubject = inlineSubject
            ? await translateTextContent(inlineSubject, buildMessageTranslationOptions(systemSettings))
            : null;
          const translatedTexts = await translatePreviewTextNodes(inlineTexts, systemSettings);
          sendJson(response, 200, {
            ok: true,
            inline: true,
            subject: translatedSubject?.translatedText || '',
            texts: translatedTexts.texts,
            translation: {
              provider: translatedSubject?.provider || translatedTexts.meta?.provider || '',
              requestedProvider:
                translatedSubject?.requestedProvider || translatedTexts.meta?.requestedProvider || '',
              providerLabel: translatedSubject?.providerLabel || translatedTexts.meta?.providerLabel || '',
              fallbackNotice:
                translatedSubject?.fallbackNotice || translatedTexts.meta?.fallbackNotice || '',
              targetLanguage:
                translatedSubject?.targetLanguage || translatedTexts.meta?.targetLanguage || 'zh-CN',
              generatedAt: new Date().toISOString(),
            },
          });
          return;
        }

        const translation = await translateMessage(
          previewResult.message,
          buildMessageTranslationOptions(systemSettings),
        );
        sendJson(response, 200, {
          ok: true,
          translation,
        });
      } catch (error) {
        sendJson(response, 400, { error: String(error.message || error) });
      }
      return;
    }

    const staticPath = parseRequestPath(url.pathname);
    if (!staticPath || !fs.existsSync(staticPath)) {
      const isStaticAssetRequest =
        url.pathname.startsWith('/assets/') ||
        url.pathname.includes('.');
      if (isStaticAssetRequest) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }

      sendFile(response, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }

    sendFile(response, staticPath);
  } catch (error) {
    console.error('[server]', error);
    sendJson(response, 500, { error: String(error.message || error) });
  }
});

applyRuntimeProxyEnvironment(getSystemSettings());

server.listen(PORT, () => {
  if (!process.env.APP_SECRET || process.env.APP_SECRET === DEFAULT_SECRET) {
    console.warn('[config] APP_SECRET is not set; using the development default secret.');
  }

  if (bootstrapResult.created) {
    console.log(
      `[bootstrap] 已创建管理员账号 ${DEFAULT_ADMIN_EMAIL}，初始密码为 ${DEFAULT_ADMIN_PASSWORD}`,
    );
  }

  console.log(`[mail-union] running at http://localhost:${PORT}`);
});

syncService.start();
backupService.start();
