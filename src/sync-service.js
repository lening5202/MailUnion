const fs = require('node:fs');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { decrypt, encrypt } = require('./crypto');
const { fetchWithOutboundProxy } = require('./outbound-network');
const {
  clearMailboxFolderMessages,
  getMailboxById,
  getSystemSettings,
  getMailboxSyncState,
  listMailboxesForSync,
  listMessagesWithAttachments,
  markMailboxSyncError,
  markMailboxSyncStart,
  markMailboxSyncSuccess,
  pruneFolderMessages,
  saveMessage,
  updateMessageAttachments,
  updateMailboxOAuthState,
  upsertMailboxSyncState,
} = require('./db');
const {
  isGoogleOAuthMailbox,
  refreshGoogleAccessToken,
} = require('./google-oauth');
const {
  buildMicrosoftScopes,
  isMicrosoftOAuthMailbox,
  normalizeMicrosoftTenantId,
  refreshMicrosoftAccessToken,
} = require('./microsoft-oauth');
const { inferStorageCategory, resolveStorageRequestPath, writeBufferAsset } = require('./storage');

const INITIAL_SYNC_LIMIT = Math.min(Math.max(Number(process.env.INITIAL_SYNC_LIMIT) || 30, 1), 200);
const DEFAULT_SYNC_INTERVAL = Math.max(Number(process.env.SYNC_INTERVAL_MS) || 1000, 1000);
const TEXT_BODY_LIMIT = 120000;
const HTML_BODY_LIMIT = 250000;
const SYNC_FOLDER_KINDS = ['inbox', 'trash', 'junk'];
const MICROSOFT_GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const GRAPH_SYNC_OVERLAP_MS = 5 * 60 * 1000;
const MICROSOFT_GRAPH_DEFAULT_SCOPES = ['https://graph.microsoft.com/.default', 'offline_access'];
const MICROSOFT_PERSONAL_DOMAINS = new Set(['outlook.com', 'hotmail.com', 'live.com', 'msn.com']);

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fallbackTextFromHtml(html) {
  return cleanText(
    String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' '),
  );
}

function createPreview(text) {
  return cleanText(text).slice(0, 180);
}

function mapAddresses(addressObject) {
  const value = addressObject?.value || [];
  return value.map((entry) => ({
    name: entry.name || '',
    address: entry.address || '',
  }));
}

function isSeen(flags) {
  if (!flags) {
    return false;
  }

  if (Array.isArray(flags)) {
    return flags.includes('\\Seen');
  }

  if (typeof flags.has === 'function') {
    return flags.has('\\Seen');
  }

  return false;
}

function isFlagged(flags) {
  if (!flags) {
    return false;
  }

  if (Array.isArray(flags)) {
    return flags.includes('\\Flagged');
  }

  if (typeof flags.has === 'function') {
    return flags.has('\\Flagged');
  }

  return false;
}

function normalizeFolderPath(path) {
  return String(path || 'INBOX').trim() || 'INBOX';
}

function normalizeFolderKind(value) {
  const folderKind = String(value || 'inbox').trim().toLowerCase();
  return SYNC_FOLDER_KINDS.includes(folderKind) ? folderKind : 'inbox';
}

function folderKindFromSpecialUse(specialUse, path, name) {
  const normalizedPath = normalizeFolderPath(path);
  const normalizedName = `${normalizedPath} ${String(name || '')}`.toLowerCase();

  if (String(specialUse || '').trim() === '\\Inbox' || normalizedPath.toUpperCase() === 'INBOX') {
    return 'inbox';
  }

  if (String(specialUse || '').trim() === '\\Trash') {
    return 'trash';
  }

  if (String(specialUse || '').trim() === '\\Junk') {
    return 'junk';
  }

  if (/(^|[\s/._-])(trash|deleted|bin)([\s/._-]|$)|垃圾箱|回收站|已删除/i.test(normalizedName)) {
    return 'trash';
  }

  if (/(^|[\s/._-])(junk|spam|bulk)([\s/._-]|$)|垃圾邮件/i.test(normalizedName)) {
    return 'junk';
  }

  return null;
}

function folderCandidateScore(entry, kind) {
  const normalizedPath = normalizeFolderPath(entry?.path);
  let score = 0;

  if (entry?.specialUse) {
    score += 20;
  }

  if (kind === 'inbox' && normalizedPath.toUpperCase() === 'INBOX') {
    score += 50;
  }

  if (kind === 'trash' && /(trash|deleted)/i.test(normalizedPath)) {
    score += 10;
  }

  if (kind === 'junk' && /(junk|spam)/i.test(normalizedPath)) {
    score += 10;
  }

  return score;
}

function discoverFolderTargets(listResponse = []) {
  const selectedByKind = new Map();

  for (const entry of listResponse) {
    const isDisabled =
      Boolean(entry?.disabled) ||
      entry?.flags?.has?.('\\Noselect') ||
      (Array.isArray(entry?.flags) && entry.flags.includes('\\Noselect'));
    if (isDisabled) {
      continue;
    }

    const folderKind = folderKindFromSpecialUse(entry?.specialUse, entry?.path, entry?.name);
    if (!folderKind) {
      continue;
    }

    const candidate = {
      kind: folderKind,
      path: normalizeFolderPath(entry?.path),
      specialUse: String(entry?.specialUse || '').trim(),
    };
    const current = selectedByKind.get(folderKind);
    if (!current || folderCandidateScore(candidate, folderKind) > folderCandidateScore(current, folderKind)) {
      selectedByKind.set(folderKind, candidate);
    }
  }

  if (!selectedByKind.has('inbox')) {
    selectedByKind.set('inbox', {
      kind: 'inbox',
      path: 'INBOX',
      specialUse: '\\Inbox',
    });
  }

  return SYNC_FOLDER_KINDS.map((kind) => selectedByKind.get(kind)).filter(Boolean);
}

function folderStateSeed(mailbox, folder) {
  const folderKind = normalizeFolderKind(folder?.kind);

  return {
    mailboxId: mailbox.id,
    folderPath: normalizeFolderPath(folder?.path),
    folderKind,
    lastUid: folderKind === 'inbox' ? Number(mailbox.lastUid || 0) : 0,
    uidValidity: folderKind === 'inbox' ? mailbox.uidValidity ?? null : null,
    lastExists: 0,
    lastSyncedAt: folderKind === 'inbox' ? mailbox.lastSyncedAt ?? null : null,
  };
}

function mailboxFolderMap(folderTargets = []) {
  return Object.fromEntries(folderTargets.map((folder) => [normalizeFolderKind(folder.kind), folder]));
}

function sanitizeStoragePrefix(value, fallback = 'mail') {
  return (
    String(value || '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 48) || fallback
  );
}

function normalizeStoredAttachmentRecord(mailbox, remoteMessageKey, attachment = {}) {
  const filename = String(attachment?.filename || '(attachment)').trim() || '(attachment)';
  const contentType = String(attachment?.contentType || '').trim();
  const contentBuffer = Buffer.isBuffer(attachment?.content)
    ? attachment.content
    : Buffer.from(attachment?.content || '');
  const size = Number(attachment?.size || contentBuffer.length || 0);
  const category = inferStorageCategory(contentType, filename);

  try {
    const savedAsset =
      contentBuffer.length > 0
        ? writeBufferAsset(contentBuffer, {
            category,
            filename,
            contentType,
            prefix: sanitizeStoragePrefix(`${mailbox.provider}-${mailbox.email}`),
            key: `${remoteMessageKey}:${filename}:${size}`,
          })
        : null;

    return {
      filename,
      contentType,
      size,
      category,
      stored: Boolean(savedAsset),
      relativePath: savedAsset?.relativePath || '',
      publicPath: savedAsset?.publicPath || '',
    };
  } catch (error) {
    return {
      filename,
      contentType,
      size,
      category,
      stored: false,
      relativePath: '',
      publicPath: '',
      error: String(error.message || error),
    };
  }
}

function normalizeAttachmentRecord(mailbox, imapMessage, attachment) {
  return normalizeStoredAttachmentRecord(mailbox, `${mailbox.id}:imap:${imapMessage.uid || 0}`, attachment);
}

function decodeGraphAttachmentContent(contentBytes = '') {
  const normalized = String(contentBytes || '').trim();
  if (!normalized) {
    return Buffer.alloc(0);
  }

  try {
    return Buffer.from(normalized, 'base64');
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function normalizeGraphAttachmentRecord(mailbox, graphMessage, attachment = {}) {
  const attachmentType = String(attachment?.['@odata.type'] || '').trim().toLowerCase();
  const filename = String(attachment?.name || '(attachment)').trim() || '(attachment)';
  const contentType = String(attachment?.contentType || '').trim();
  const size = Number(attachment?.size || 0);
  const isInline = Boolean(attachment?.isInline);

  if (!attachmentType.endsWith('fileattachment')) {
    return {
      filename,
      contentType,
      size,
      category: inferStorageCategory(contentType, filename),
      stored: false,
      relativePath: '',
      publicPath: '',
      inline: isInline,
      note: 'Graph 非文件附件，当前仅展示元数据。',
    };
  }

  return {
    ...normalizeStoredAttachmentRecord(mailbox, `${mailbox.id}:graph:${graphMessage?.id || 'message'}`, {
      filename,
      contentType,
      size,
      content: decodeGraphAttachmentContent(attachment?.contentBytes),
    }),
    inline: isInline,
  };
}

function normalizeMessage(mailbox, folder, imapMessage, parsedMessage) {
  const from = mapAddresses(parsedMessage.from)[0] || { name: '', address: '' };
  const textBody = cleanText(parsedMessage.text) || fallbackTextFromHtml(parsedMessage.html);
  const htmlBody =
    typeof parsedMessage.html === 'string' ? parsedMessage.html.slice(0, HTML_BODY_LIMIT) : '';

  return {
    mailboxId: mailbox.id,
    folderPath: normalizeFolderPath(folder?.path),
    folderKind: normalizeFolderKind(folder?.kind),
    remoteUid: Number(imapMessage.uid),
    remoteId: String(imapMessage.uid || '').trim(),
    remoteSource: 'imap',
    messageId: parsedMessage.messageId || '',
    subject: parsedMessage.subject || '(无主题)',
    fromName: from.name,
    fromAddress: from.address,
    to: mapAddresses(parsedMessage.to),
    receivedAt: (
      parsedMessage.date ||
      imapMessage.internalDate ||
      new Date()
    ).toISOString(),
    preview: createPreview(textBody || parsedMessage.subject || ''),
    textBody: textBody.slice(0, TEXT_BODY_LIMIT),
    htmlBody,
    attachments: (parsedMessage.attachments || []).map((attachment) => ({
      filename: attachment.filename || '(未命名附件)',
      contentType: attachment.contentType || '',
      size: attachment.size || 0,
    })),
    isRead: isSeen(imapMessage.flags),
    isStarred: isFlagged(imapMessage.flags),
    flags: Array.from(imapMessage.flags || []),
  };
}

function createDetachedAttachmentMetadataRecord(attachment = {}, options = {}) {
  const filename = String(attachment?.filename || attachment?.name || '(未命名附件)').trim() || '(未命名附件)';
  const contentType = String(attachment?.contentType || '').trim();

  return {
    filename,
    contentType,
    size: Number(attachment?.size || 0),
    category: inferStorageCategory(contentType, filename),
    stored: false,
    relativePath: '',
    publicPath: '',
    inline: Boolean(options.inline ?? attachment?.inline ?? attachment?.isInline),
    note:
      String(options.note || '').trim()
      || '附件尚未同步到本地，请在系统设置中手动执行同步。',
  };
}

function attachmentHasLocalFile(attachment = {}) {
  if (!attachment?.stored) {
    return false;
  }

  const publicPath = String(attachment?.publicPath || '').trim();
  if (!publicPath) {
    return false;
  }

  const storagePath = resolveStorageRequestPath(publicPath);
  return Boolean(storagePath && fs.existsSync(storagePath));
}

function countMissingLocalAttachments(attachments = []) {
  return (attachments || []).reduce((count, attachment) => {
    const note = String(attachment?.note || attachment?.error || '').trim();
    if (note.includes('非文件附件')) {
      return count;
    }

    const hasPath = Boolean(
      String(attachment?.relativePath || '').trim()
      || String(attachment?.publicPath || '').trim(),
    );
    return count + (!attachmentHasLocalFile(attachment) || !hasPath ? 1 : 0);
  }, 0);
}

function countLocalAttachments(attachments = []) {
  return (attachments || []).reduce(
    (count, attachment) => count + (attachmentHasLocalFile(attachment) ? 1 : 0),
    0,
  );
}

function normalizeMessageWithStoredAttachments(mailbox, folder, imapMessage, parsedMessage) {
  const normalized = normalizeMessage(mailbox, folder, imapMessage, parsedMessage);
  normalized.attachments = (parsedMessage.attachments || []).map((attachment) =>
    createDetachedAttachmentMetadataRecord(attachment),
  );
  return normalized;
}

function normalizeOauthState(mailbox) {
  return mailbox?.oauth && typeof mailbox.oauth === 'object' ? mailbox.oauth : {};
}

function normalizeMicrosoftProtocolMode(value) {
  const normalized = String(value || 'graph_imap_dual').trim().toLowerCase();
  if (normalized === 'graph_only') {
    return 'graph_only';
  }
  if (normalized === 'imap_only') {
    return 'imap_only';
  }
  return 'graph_imap_dual';
}

function getMicrosoftProtocolMode(mailbox) {
  return normalizeMicrosoftProtocolMode(normalizeOauthState(mailbox).protocolMode);
}

function decryptMaybe(value) {
  return String(value || '').trim() ? decrypt(value) : '';
}

function getSystemMicrosoftOauthConfig() {
  const settings = getSystemSettings();
  return {
    clientId: String(settings?.microsoftClientId || process.env.MICROSOFT_CLIENT_ID || '').trim(),
    clientSecret:
      decryptMaybe(settings?.microsoftClientSecretEncrypted) ||
      String(process.env.MICROSOFT_CLIENT_SECRET || '').trim(),
    tenantId: normalizeMicrosoftTenantId(
      settings?.microsoftTenantId || process.env.MICROSOFT_TENANT_ID,
    ),
  };
}

function getMicrosoftMailboxAppConfig(mailbox) {
  const oauth = normalizeOauthState(mailbox);
  const systemConfig = getSystemMicrosoftOauthConfig();
  const mailboxClientId = String(oauth.clientId || '').trim();
  const systemClientId = String(systemConfig.clientId || '').trim();
  const mailboxClientSecret = decryptMaybe(oauth.clientSecretEncrypted);
  const usesSystemClient =
    !mailboxClientId || (systemClientId && mailboxClientId.toLowerCase() === systemClientId.toLowerCase());

  return {
    oauth,
    systemConfig,
    clientId: mailboxClientId || systemClientId,
    clientSecret: mailboxClientSecret || (usesSystemClient ? systemConfig.clientSecret : ''),
    tenantId: normalizeMicrosoftTenantId(oauth.tenantId || systemConfig.tenantId),
    usesSystemClient,
  };
}

function hasStoredMailboxPassword(mailbox) {
  return Boolean(decryptMaybe(mailbox?.password_encrypted));
}

function getMicrosoftRefreshToken(oauth, scopeSet = 'imap') {
  if (String(scopeSet).trim().toLowerCase() === 'graph') {
    return decryptMaybe(
      oauth.graphRefreshTokenEncrypted || oauth.sharedRefreshTokenEncrypted || oauth.refreshTokenEncrypted,
    );
  }

  return decryptMaybe(
    oauth.imapRefreshTokenEncrypted || oauth.refreshTokenEncrypted || oauth.sharedRefreshTokenEncrypted,
  );
}

function getMicrosoftAccessToken(oauth, scopeSet = 'imap') {
  if (String(scopeSet).trim().toLowerCase() === 'graph') {
    return decryptMaybe(oauth.graphAccessTokenEncrypted);
  }

  return decryptMaybe(oauth.imapAccessTokenEncrypted || oauth.accessTokenEncrypted);
}

function getMicrosoftTokenExpiry(oauth, scopeSet = 'imap') {
  if (String(scopeSet).trim().toLowerCase() === 'graph') {
    return String(oauth.graphExpiresAt || '').trim();
  }

  return String(oauth.imapExpiresAt || oauth.expiresAt || '').trim();
}

function splitMicrosoftScopes(scopeValue = '') {
  return String(scopeValue || '')
    .trim()
    .split(/\s+/)
    .map((scope) => scope.trim().toLowerCase())
    .filter(Boolean);
}

function hasMicrosoftGraphReadScope(scopeValue = '') {
  return splitMicrosoftScopes(scopeValue).some(
    (scope) =>
      scope === 'mail.read' ||
      scope === 'mail.readwrite' ||
      scope.endsWith('/mail.read') ||
      scope.endsWith('/mail.readwrite'),
  );
}

function getMicrosoftIdentityCandidates(mailbox, oauth = normalizeOauthState(mailbox)) {
  return [mailbox?.email, mailbox?.username, oauth?.email]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
}

function isMicrosoftConsumerMailbox(mailbox, oauth = normalizeOauthState(mailbox)) {
  return getMicrosoftIdentityCandidates(mailbox, oauth).some((value) => {
    const parts = value.split('@');
    const domain = parts.length > 1 ? parts[parts.length - 1] : '';
    return MICROSOFT_PERSONAL_DOMAINS.has(domain);
  });
}

function buildMicrosoftTenantCandidates(mailbox, tenantId) {
  const normalizedTenantId = normalizeMicrosoftTenantId(tenantId);
  const candidates = [normalizedTenantId];

  if (normalizedTenantId === 'common' && isMicrosoftConsumerMailbox(mailbox)) {
    candidates.push('consumers');
  }

  return Array.from(new Set(candidates));
}

function trimErrorDetail(value) {
  return String(value || '').trim();
}

function pushErrorDetail(target, value, options = {}) {
  const detail = trimErrorDetail(value);
  if (!detail) {
    return;
  }

  if (options.skipGeneric && detail === 'Command failed') {
    return;
  }

  if (!target.includes(detail)) {
    target.push(detail);
  }
}

function describeMicrosoftProtocolError(protocolLabel, error) {
  const details = [];

  pushErrorDetail(details, error?.message, { skipGeneric: true });
  pushErrorDetail(details, error?.responseText);
  pushErrorDetail(details, error?.serverResponseCode);
  pushErrorDetail(details, error?.responseStatus);
  pushErrorDetail(details, error?.code);

  if (!details.length && trimErrorDetail(error?.message)) {
    details.push(trimErrorDetail(error.message));
  }

  return `${protocolLabel}：${details.join(' / ') || '未知错误'}`;
}

function buildMicrosoftDualProtocolError(mailbox, graphError, imapError) {
  const graphMessage = graphError ? describeMicrosoftProtocolError('Graph', graphError) : '';
  const imapMessage = imapError ? describeMicrosoftProtocolError('IMAP', imapError) : '';
  const details = [graphMessage, imapMessage].filter(Boolean);
  const combined = new Error(`Microsoft Graph 与 IMAP 都没有连接成功。${details.join('；')}`);

  combined.graphError = graphError || null;
  combined.imapError = imapError || null;
  combined.graphMessage = graphMessage;
  combined.imapMessage = imapMessage;
  combined.mailboxId = mailbox?.id || '';
  combined.mailboxEmail = mailbox?.email || mailbox?.username || '';
  combined.responseText = trimErrorDetail(imapError?.responseText || graphError?.responseText);
  combined.responseStatus = trimErrorDetail(imapError?.responseStatus || graphError?.responseStatus);
  combined.serverResponseCode = trimErrorDetail(
    imapError?.serverResponseCode || graphError?.serverResponseCode,
  );
  combined.authenticationFailed = Boolean(imapError?.authenticationFailed);
  combined.code = trimErrorDetail(imapError?.code || graphError?.code);

  return combined;
}

async function refreshMicrosoftAccessTokenCompat(options = {}) {
  const tenantCandidates = buildMicrosoftTenantCandidates(options.mailbox, options.tenantId);
  const attempts = [];

  for (const tenantId of tenantCandidates) {
    attempts.push({
      tenantId,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      refreshToken: options.refreshToken,
      scopeSet: options.scopeSet,
      compatibilityMode: 'standard',
    });

    if (String(options.scopeSet || '').trim().toLowerCase() === 'graph') {
      attempts.push({
        tenantId,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        refreshToken: options.refreshToken,
        scopes: MICROSOFT_GRAPH_DEFAULT_SCOPES,
        compatibilityMode: 'graph_default',
      });
    }
  }

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const refreshed = await refreshMicrosoftAccessToken(attempt);
      return {
        ...refreshed,
        compatibilityMode: attempt.compatibilityMode,
        tenantIdUsed: attempt.tenantId,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Microsoft OAuth2 刷新失败。');
}

function microsoftFolderDescriptor(kind = 'inbox') {
  const normalizedKind = normalizeFolderKind(kind);
  if (normalizedKind === 'trash') {
    return {
      kind: 'trash',
      path: 'Deleted Items',
      graphId: 'deleteditems',
    };
  }
  if (normalizedKind === 'junk') {
    return {
      kind: 'junk',
      path: 'Junk Email',
      graphId: 'junkemail',
    };
  }
  return {
    kind: 'inbox',
    path: 'INBOX',
    graphId: 'inbox',
  };
}

function mapGraphAddresses(entries = []) {
  return (entries || []).map((entry) => ({
    name: String(entry?.emailAddress?.name || '').trim(),
    address: String(entry?.emailAddress?.address || '').trim(),
  }));
}

function normalizeGraphMessage(mailbox, folder, graphMessage, attachments = []) {
  const from = mapGraphAddresses(graphMessage?.from ? [graphMessage.from] : [])[0] || {
    name: '',
    address: '',
  };
  const bodyContent = String(graphMessage?.body?.content || '');
  const bodyType = String(graphMessage?.body?.contentType || '').trim().toLowerCase();
  const htmlBody = bodyType === 'html' ? bodyContent.slice(0, HTML_BODY_LIMIT) : '';
  const textBody = bodyType === 'html'
    ? fallbackTextFromHtml(bodyContent).slice(0, TEXT_BODY_LIMIT)
    : cleanText(bodyContent).slice(0, TEXT_BODY_LIMIT);

  return {
    mailboxId: mailbox.id,
    folderPath: normalizeFolderPath(folder.path),
    folderKind: normalizeFolderKind(folder.kind),
    remoteUid: 0,
    remoteId: String(graphMessage?.id || '').trim(),
    remoteSource: 'graph',
    messageId: String(graphMessage?.internetMessageId || graphMessage?.id || '').trim(),
    subject: String(graphMessage?.subject || '').trim() || '(无主题)',
    fromName: from.name,
    fromAddress: from.address,
    to: mapGraphAddresses(graphMessage?.toRecipients || []),
    receivedAt: (
      graphMessage?.receivedDateTime ? new Date(graphMessage.receivedDateTime) : new Date()
    ).toISOString(),
    preview: createPreview(String(graphMessage?.bodyPreview || textBody || graphMessage?.subject || '')),
    textBody,
    htmlBody,
    attachments,
    isRead: Boolean(graphMessage?.isRead),
    isStarred: String(graphMessage?.flag?.flagStatus || '').trim().toLowerCase() === 'flagged',
    flags: [
      Boolean(graphMessage?.isRead) ? '\\Seen' : '',
      String(graphMessage?.flag?.flagStatus || '').trim().toLowerCase() === 'flagged' ? '\\Flagged' : '',
      'graph',
    ].filter(Boolean),
  };
}

async function buildGoogleOAuthClientConfig(mailbox) {
  const oauth = normalizeOauthState(mailbox);
  const clientId = String(oauth.clientId || process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = oauth.clientSecretEncrypted
    ? decrypt(oauth.clientSecretEncrypted)
    : String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const refreshToken = oauth.refreshTokenEncrypted ? decrypt(oauth.refreshTokenEncrypted) : '';

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google OAuth2 配置不完整，请重新为这个 Gmail 邮箱授权。');
  }

  let accessToken = oauth.accessTokenEncrypted ? decrypt(oauth.accessTokenEncrypted) : '';
  let expiresAt = String(oauth.expiresAt || '').trim();
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : 0;

  if (!accessToken || !expiresAtMs || expiresAtMs - Date.now() < 60_000) {
    const refreshed = await refreshGoogleAccessToken({
      clientId,
      clientSecret,
      refreshToken,
    });

    accessToken = String(refreshed.access_token || '').trim();
    expiresAt = new Date(Date.now() + Math.max(Number(refreshed.expires_in) || 3600, 60) * 1000).toISOString();

    if (!accessToken) {
      throw new Error('Google OAuth2 刷新成功，但没有拿到可用的访问令牌。');
    }

    const nextOauth = {
      ...oauth,
      clientId,
      clientSecretEncrypted: oauth.clientSecretEncrypted || encrypt(clientSecret),
      refreshTokenEncrypted: oauth.refreshTokenEncrypted || encrypt(refreshToken),
      accessTokenEncrypted: encrypt(accessToken),
      expiresAt,
      scope: String(refreshed.scope || oauth.scope || '').trim(),
      tokenType: String(refreshed.token_type || oauth.tokenType || 'Bearer').trim(),
    };

    if (mailbox.id) {
      updateMailboxOAuthState(mailbox.id, nextOauth);
    }
    mailbox.oauth = nextOauth;
    mailbox.oauthEmail = String(nextOauth.email || mailbox.oauthEmail || '').trim();
  }

  return {
    host: mailbox.imap_host,
    port: Number(mailbox.imap_port),
    secure: Boolean(mailbox.secure),
    auth: {
      user: mailbox.username || oauth.email || mailbox.email,
      accessToken,
    },
    logger: false,
    disableAutoIdle: true,
  };
}

async function buildMicrosoftOAuthClientConfig(mailbox) {
  const { oauth, clientId, clientSecret, tenantId } = getMicrosoftMailboxAppConfig(mailbox);
  const refreshToken = getMicrosoftRefreshToken(oauth, 'imap');
  const storedPassword = decryptMaybe(mailbox.password_encrypted);

  if (!refreshToken) {
    if (storedPassword) {
      return {
        host: mailbox.imap_host,
        port: Number(mailbox.imap_port),
        secure: Boolean(mailbox.secure),
        auth: {
          user: mailbox.username || oauth.email || mailbox.email,
          pass: storedPassword,
        },
        logger: false,
        disableAutoIdle: true,
      };
    }

    throw new Error('Microsoft OAuth2 的 IMAP 令牌缺失，请补充 refresh token，或改用 Graph-only 模式。');
  }

  if (!clientId) {
    throw new Error('Microsoft OAuth2 缺少 Client ID。');
  }

  let accessToken = getMicrosoftAccessToken(oauth, 'imap');
  let expiresAt = getMicrosoftTokenExpiry(oauth, 'imap');
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : 0;
  let effectiveTenantId = tenantId;

  if (!accessToken || !expiresAtMs || expiresAtMs - Date.now() < 60_000) {
    try {
    const refreshed = await refreshMicrosoftAccessTokenCompat({
      mailbox,
      tenantId,
      clientId,
      clientSecret,
      refreshToken,
      scopeSet: 'imap',
    });

    accessToken = String(refreshed.access_token || '').trim();
    expiresAt = new Date(Date.now() + Math.max(Number(refreshed.expires_in) || 3600, 60) * 1000).toISOString();
    effectiveTenantId = normalizeMicrosoftTenantId(refreshed.tenantIdUsed || tenantId);

    if (!accessToken) {
      throw new Error('Microsoft OAuth2 刷新成功，但没有拿到可用的访问令牌。');
    }

    const nextOauth = {
      ...oauth,
      tenantId: effectiveTenantId,
      clientId,
      clientSecretEncrypted: oauth.clientSecretEncrypted || (clientSecret ? encrypt(clientSecret) : ''),
      sharedRefreshTokenEncrypted:
        oauth.sharedRefreshTokenEncrypted || oauth.refreshTokenEncrypted || encrypt(refreshToken),
      refreshTokenEncrypted: oauth.refreshTokenEncrypted || oauth.imapRefreshTokenEncrypted || encrypt(refreshToken),
      imapRefreshTokenEncrypted: oauth.imapRefreshTokenEncrypted || encrypt(refreshToken),
      accessTokenEncrypted: encrypt(accessToken),
      imapAccessTokenEncrypted: encrypt(accessToken),
      expiresAt,
      imapExpiresAt: expiresAt,
      scope: String(refreshed.scope || oauth.scope || '').trim(),
      imapScope: String(refreshed.scope || oauth.imapScope || oauth.scope || '').trim(),
      tokenType: String(refreshed.token_type || oauth.tokenType || 'Bearer').trim(),
      imapTokenType: String(refreshed.token_type || oauth.imapTokenType || oauth.tokenType || 'Bearer').trim(),
    };

    if (mailbox.id) {
      updateMailboxOAuthState(mailbox.id, nextOauth, 'microsoft_oauth');
    }
    mailbox.oauth = nextOauth;
    mailbox.oauthEmail = String(nextOauth.email || mailbox.oauthEmail || '').trim();
    } catch (refreshError) {
      if (storedPassword) {
        return {
          host: mailbox.imap_host,
          port: Number(mailbox.imap_port),
          secure: Boolean(mailbox.secure),
          auth: {
            user: mailbox.username || oauth.email || mailbox.email,
            pass: storedPassword,
          },
          logger: false,
          disableAutoIdle: true,
        };
      }

      throw refreshError;
    }
  }

  return {
    host: mailbox.imap_host,
    port: Number(mailbox.imap_port),
    secure: Boolean(mailbox.secure),
    auth: {
      user: mailbox.username || oauth.email || mailbox.email,
      accessToken,
    },
    logger: false,
    disableAutoIdle: true,
  };
}

async function buildMicrosoftGraphContext(mailbox) {
  const { oauth, clientId, clientSecret, tenantId } = getMicrosoftMailboxAppConfig(mailbox);
  const refreshToken = getMicrosoftRefreshToken(oauth, 'graph');

  if (!clientId) {
    throw new Error('Microsoft Graph 缺少 Client ID。');
  }
  if (!refreshToken) {
    throw new Error('Microsoft Graph 缺少 refresh token，请在 Outlook OAuth2 配置中补充。');
  }

  let accessToken = getMicrosoftAccessToken(oauth, 'graph');
  let expiresAt = getMicrosoftTokenExpiry(oauth, 'graph');
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : 0;
  let effectiveTenantId = tenantId;
  let grantedGraphScope = String(oauth.graphScope || oauth.scope || '').trim();

  if (!accessToken || !expiresAtMs || expiresAtMs - Date.now() < 60_000) {
    const refreshed = await refreshMicrosoftAccessTokenCompat({
      mailbox,
      tenantId,
      clientId,
      clientSecret,
      refreshToken,
      scopeSet: 'graph',
    });

    accessToken = String(refreshed.access_token || '').trim();
    expiresAt = new Date(Date.now() + Math.max(Number(refreshed.expires_in) || 3600, 60) * 1000).toISOString();
    effectiveTenantId = normalizeMicrosoftTenantId(refreshed.tenantIdUsed || tenantId);
    grantedGraphScope = String(refreshed.scope || oauth.graphScope || oauth.scope || '').trim();

    if (!accessToken) {
      throw new Error('Microsoft Graph 刷新成功，但没有拿到可用的访问令牌。');
    }

    const nextOauth = {
      ...oauth,
      tenantId: effectiveTenantId,
      clientId,
      clientSecretEncrypted: oauth.clientSecretEncrypted || (clientSecret ? encrypt(clientSecret) : ''),
      sharedRefreshTokenEncrypted:
        oauth.sharedRefreshTokenEncrypted || oauth.refreshTokenEncrypted || encrypt(refreshToken),
      graphRefreshTokenEncrypted:
        oauth.graphRefreshTokenEncrypted || oauth.sharedRefreshTokenEncrypted || oauth.refreshTokenEncrypted || encrypt(refreshToken),
      graphAccessTokenEncrypted: encrypt(accessToken),
      graphExpiresAt: expiresAt,
      graphScope: String(refreshed.scope || oauth.graphScope || '').trim(),
      graphTokenType: String(refreshed.token_type || oauth.graphTokenType || 'Bearer').trim(),
    };

    if (mailbox.id) {
      updateMailboxOAuthState(mailbox.id, nextOauth, 'microsoft_oauth');
    }
    mailbox.oauth = nextOauth;
    mailbox.oauthEmail = String(nextOauth.email || mailbox.oauthEmail || '').trim();
  }

  if (grantedGraphScope && !hasMicrosoftGraphReadScope(grantedGraphScope)) {
    throw new Error('Microsoft Graph 当前令牌不包含 Mail.Read 或 Mail.ReadWrite 权限。');
  }

  return {
    accessToken,
    tenantId: effectiveTenantId,
  };
}

async function graphRequest(accessToken, path, options = {}) {
  const requestUrl = path.startsWith('http') ? path : `${MICROSOFT_GRAPH_BASE_URL}${path}`;
  let response = null;
  try {
    response = await fetchWithOutboundProxy(
      requestUrl,
      {
        method: options.method || 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      },
      {
        timeoutMs: 20000,
      },
    );
  } catch (error) {
    throw new Error(
      `Microsoft Graph 网络请求失败，请检查系统设置 -> 外网代理。${String(error?.cause?.message || error?.message || error || '').trim()}`,
    );
  }

  if (response.status === 204) {
    return null;
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    const detail =
      payload?.error?.message ||
      payload?.error_description ||
      response.statusText ||
      'Unknown Microsoft Graph error';
    throw new Error(`Microsoft Graph 请求失败：${response.status} ${detail}`);
  }

  return payload;
}

async function testMicrosoftGraphConnection(mailbox) {
  const graphContext = await buildMicrosoftGraphContext(mailbox);
  const inbox = await graphRequest(
    graphContext.accessToken,
    '/me/mailFolders/inbox?$select=displayName,totalItemCount,unreadItemCount',
  );

  return {
    protocol: 'graph',
    exists: Number(inbox?.totalItemCount || 0),
    unreadCount: Number(inbox?.unreadItemCount || 0),
    uidNext: 0,
    uidValidity: 0,
  };
}

async function listGraphMessages(accessToken, folder, lastSyncedAt = '') {
  const params = new URLSearchParams({
    $select: [
      'id',
      'internetMessageId',
      'subject',
      'from',
      'toRecipients',
      'receivedDateTime',
      'bodyPreview',
      'body',
      'hasAttachments',
      'isRead',
      'flag',
    ].join(','),
    $top: String(lastSyncedAt ? Math.max(INITIAL_SYNC_LIMIT, 80) : INITIAL_SYNC_LIMIT),
    $orderby: lastSyncedAt ? 'receivedDateTime asc' : 'receivedDateTime desc',
  });

  if (lastSyncedAt) {
    params.set('$filter', `receivedDateTime ge ${lastSyncedAt}`);
  }

  const payload = await graphRequest(
    accessToken,
    `/me/mailFolders/${encodeURIComponent(folder.graphId)}/messages?${params.toString()}`,
  );

  return Array.isArray(payload?.value) ? payload.value : [];
}

async function listGraphAttachments(accessToken, messageId = '', options = {}) {
  const normalizedMessageId = String(messageId || '').trim();
  if (!normalizedMessageId) {
    return [];
  }

  const attachments = [];
  const includeContentBytes = options.includeContentBytes !== false;
  const selectedFields = ['id', 'name', 'contentType', 'size', 'isInline'];
  if (includeContentBytes) {
    selectedFields.push('contentBytes');
  }
  let nextPath = `/me/messages/${encodeURIComponent(normalizedMessageId)}/attachments?$select=${selectedFields.join(',')}`;

  while (nextPath) {
    const payload = await graphRequest(accessToken, nextPath);
    if (Array.isArray(payload?.value)) {
      attachments.push(...payload.value);
    }

    const nextLink = String(payload?.['@odata.nextLink'] || '').trim();
    nextPath = nextLink || '';
  }

  return attachments;
}

async function buildClientConfig(mailbox) {
  if (isGoogleOAuthMailbox(mailbox)) {
    return buildGoogleOAuthClientConfig(mailbox);
  }

  if (isMicrosoftOAuthMailbox(mailbox)) {
    return buildMicrosoftOAuthClientConfig(mailbox);
  }

  return {
    host: mailbox.imap_host,
    port: Number(mailbox.imap_port),
    secure: Boolean(mailbox.secure),
    auth: {
      user: mailbox.username,
      pass: decrypt(mailbox.password_encrypted),
    },
    logger: false,
    disableAutoIdle: true,
  };
}

function describeClientTarget(mailbox = {}) {
  return [
    mailbox.name,
    mailbox.email,
    mailbox.username,
    mailbox.id,
    mailbox.imap_host,
    mailbox.host,
  ]
    .map((value) => String(value || '').trim())
    .find(Boolean) || 'unknown-mailbox';
}

async function createClient(mailbox, context = 'sync') {
  const client = new ImapFlow(await buildClientConfig(mailbox));
  const target = describeClientTarget(mailbox);

  client.on('error', (error) => {
    const details = error?.stack || error?.message || String(error);
    console.error(`[imap:${context}] ${target}`, details);
  });

  return client;
}

async function closeClient(client) {
  try {
    if (client.usable) {
      await client.logout();
    }
  } catch (_) {
    try {
      client.close();
    } catch (__unused) {
      return;
    }
  }
}

class MailSyncService {
  constructor(options = {}) {
    this.runningMailboxes = new Set();
    this.intervalHandle = null;
    this.startupTimeoutHandle = null;
    this.onNewMessages = options.onNewMessages || null;
    this.paused = false;
  }

  start() {
    if (this.intervalHandle) {
      return;
    }

    this.intervalHandle = setInterval(() => {
      this.syncAll('scheduled').catch((error) => {
        console.error('[sync-all]', error);
      });
    }, DEFAULT_SYNC_INTERVAL);

    this.startupTimeoutHandle = setTimeout(() => {
      this.startupTimeoutHandle = null;
      this.syncAll('startup').catch((error) => {
        console.error('[sync-startup]', error);
      });
    }, 2000);
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    if (this.startupTimeoutHandle) {
      clearTimeout(this.startupTimeoutHandle);
      this.startupTimeoutHandle = null;
    }
  }

  pause() {
    this.paused = true;
    this.stop();
  }

  resume() {
    this.paused = false;
    this.start();
  }

  async waitForIdle(timeoutMs = 30_000) {
    const startedAt = Date.now();

    while (this.runningMailboxes.size > 0) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error('当前仍有邮箱同步任务在执行，请稍后再试系统还原。');
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
  }

  async testConnection(config) {
    let graphError = null;

    if (isMicrosoftOAuthMailbox(config) && getMicrosoftProtocolMode(config) !== 'imap_only') {
      try {
        return await testMicrosoftGraphConnection(config);
      } catch (error) {
        graphError = error;
        if (getMicrosoftProtocolMode(config) === 'graph_only') {
          throw error;
        }
      }
    }

    let client = null;
    try {
      client = await createClient(config, 'test-connection');
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        return {
          protocol: 'imap',
          exists: Number(client.mailbox.exists || 0),
          uidNext: Number(client.mailbox.uidNext || 0),
          uidValidity: Number(client.mailbox.uidValidity || 0),
        };
      } finally {
        lock.release();
      }
    } catch (imapError) {
      if (isMicrosoftOAuthMailbox(config) && graphError) {
        throw buildMicrosoftDualProtocolError(config, graphError, imapError);
      }

      throw imapError;
    } finally {
      if (client) {
        await closeClient(client);
      }
    }
  }

  async syncAll(reason = 'manual') {
    if (this.paused) {
      return {
        reason,
        paused: true,
        mailboxCount: 0,
        results: [],
      };
    }

    const mailboxes = listMailboxesForSync();
    const results = [];

    for (const mailbox of mailboxes) {
      try {
        const result = await this.syncMailbox(mailbox.id, reason);
        results.push({ mailboxId: mailbox.id, ok: true, ...result });
      } catch (error) {
        results.push({ mailboxId: mailbox.id, ok: false, error: String(error.message || error) });
      }
    }

    return {
      reason,
      mailboxCount: mailboxes.length,
      results,
    };
  }

  async syncMailbox(mailboxId, reason = 'manual') {
    if (this.paused) {
      throw new Error('系统正在执行数据恢复，暂时无法同步邮箱。');
    }

    if (this.runningMailboxes.has(mailboxId)) {
      return { skipped: true, reason: 'already-running' };
    }

    const mailbox = getMailboxById(mailboxId);
    if (!mailbox) {
      throw new Error('邮箱账户不存在。');
    }

    const lastSyncedAt = mailbox.lastSyncedAt ? new Date(mailbox.lastSyncedAt).getTime() : 0;
    const intervalMs = Number(mailbox.syncIntervalSeconds || 5) * 1000;
    if (
      reason === 'scheduled' &&
      lastSyncedAt > 0 &&
      Date.now() - lastSyncedAt < intervalMs
    ) {
      return { skipped: true, reason: 'interval-not-reached' };
    }

    this.runningMailboxes.add(mailboxId);
    markMailboxSyncStart(mailboxId);

    try {
      const result = await this.performSync(mailbox);
      markMailboxSyncSuccess(mailboxId, {
        lastUid: result.lastUid,
        uidValidity: result.uidValidity,
        syncedAt: new Date().toISOString(),
      });

      if (this.onNewMessages && result.newMessages.length) {
        try {
          await this.onNewMessages(mailbox, result.newMessages);
        } catch (notifyError) {
          console.error('[notify]', notifyError);
        }
      }

      return {
        synced: result.synced,
        lastUid: result.lastUid,
        uidValidity: result.uidValidity,
        newestReceivedAt: result.newestReceivedAt,
        newCount: result.newMessages.length,
        folders: result.folders,
      };
    } catch (error) {
      markMailboxSyncError(mailboxId, error);
      throw error;
    } finally {
      this.runningMailboxes.delete(mailboxId);
    }
  }

  async syncFolder(client, mailbox, folder) {
    const folderPath = normalizeFolderPath(folder?.path);
    const folderKind = normalizeFolderKind(folder?.kind);
    let folderState =
      getMailboxSyncState(mailbox.id, folderPath) || folderStateSeed(mailbox, { path: folderPath, kind: folderKind });
    let lastSeenUid = Number(folderState.lastUid || 0);
    let previousExists = Number(folderState.lastExists || 0);
    let newestReceivedAt = null;
    const newMessages = [];
    let synced = 0;

    const lock = await client.getMailboxLock(folderPath);

    try {
      const currentUidValidity = Number(client.mailbox.uidValidity || 0);
      if (
        folderState.uidValidity &&
        currentUidValidity &&
        Number(folderState.uidValidity) !== currentUidValidity
      ) {
        clearMailboxFolderMessages(mailbox.id, folderPath);
        folderState = folderStateSeed(mailbox, { path: folderPath, kind: folderKind });
        lastSeenUid = 0;
        previousExists = 0;
      }

      const exists = Number(client.mailbox.exists || 0);
      const uidNext = Number(client.mailbox.uidNext || 1);
      const startUid = lastSeenUid > 0 ? lastSeenUid + 1 : Math.max(1, uidNext - INITIAL_SYNC_LIMIT);

      if (exists > 0) {
        for await (const message of client.fetch(
          `${startUid}:*`,
          {
            uid: true,
            flags: true,
            internalDate: true,
            source: true,
          },
          {
            uid: true,
          },
        )) {
          const parsedMessage = await simpleParser(message.source);
          const normalized = normalizeMessageWithStoredAttachments(
            mailbox,
            { path: folderPath, kind: folderKind },
            message,
            parsedMessage,
          );
          const savedMessage = saveMessage(normalized);
          if (savedMessage) {
            newMessages.push(savedMessage);
          }
          synced += 1;
          lastSeenUid = Math.max(lastSeenUid, Number(message.uid || 0));
          if (!newestReceivedAt || new Date(normalized.receivedAt) > new Date(newestReceivedAt)) {
            newestReceivedAt = normalized.receivedAt;
          }
        }
      }

      if (!folderState.lastSyncedAt || previousExists > exists) {
        const remoteUids = exists > 0 ? (await client.search({ all: true }, { uid: true })) || [] : [];
        pruneFolderMessages(mailbox.id, folderPath, remoteUids);
      }

      lastSeenUid = Math.max(lastSeenUid, Math.max(0, uidNext - 1));

      upsertMailboxSyncState({
        mailboxId: mailbox.id,
        folderPath,
        folderKind,
        lastUid: lastSeenUid,
        uidValidity: currentUidValidity,
        lastExists: exists,
        lastSyncedAt: new Date().toISOString(),
      });

      return {
        synced,
        folderPath,
        folderKind,
        lastUid: lastSeenUid,
        uidValidity: currentUidValidity,
        newestReceivedAt,
        newMessages,
      };
    } finally {
      lock.release();
    }
  }

  async performImapSync(mailbox) {
    const client = await createClient(mailbox, 'perform-sync');
    let synced = 0;
    let newestReceivedAt = null;
    const newMessages = [];
    let inboxLastUid = Number(mailbox.lastUid || 0);
    let inboxUidValidity = mailbox.uidValidity ?? null;
    const folders = [];

    try {
      await client.connect();

      const folderTargets = discoverFolderTargets(await client.list());

      for (const folder of folderTargets) {
        const result = await this.syncFolder(client, mailbox, folder);
        folders.push({
          path: result.folderPath,
          kind: result.folderKind,
          synced: result.synced,
          newCount: result.newMessages.length,
        });
        synced += result.synced;
        if (result.newestReceivedAt && (!newestReceivedAt || new Date(result.newestReceivedAt) > new Date(newestReceivedAt))) {
          newestReceivedAt = result.newestReceivedAt;
        }
        newMessages.push(...result.newMessages);

        if (result.folderKind === 'inbox') {
          inboxLastUid = result.lastUid;
          inboxUidValidity = result.uidValidity;
        }
      }

      return {
        synced,
        lastUid: inboxLastUid,
        uidValidity: inboxUidValidity,
        newestReceivedAt,
        newMessages,
        folders,
      };
    } finally {
      await closeClient(client);
    }
  }

  async syncMicrosoftGraphFolder(mailbox, folder) {
    const graphContext = await buildMicrosoftGraphContext(mailbox);
    const folderPath = normalizeFolderPath(folder.path);
    const folderKind = normalizeFolderKind(folder.kind);
    const folderState =
      getMailboxSyncState(mailbox.id, folderPath) || folderStateSeed(mailbox, { path: folderPath, kind: folderKind });
    const lastSyncedAtMs = folderState?.lastSyncedAt ? Date.parse(folderState.lastSyncedAt) : 0;
    const nextSyncFloor = lastSyncedAtMs
      ? new Date(Math.max(lastSyncedAtMs - GRAPH_SYNC_OVERLAP_MS, 0)).toISOString()
      : '';
    const remoteMessages = await listGraphMessages(graphContext.accessToken, folder, nextSyncFloor);
    const newMessages = [];
    let newestReceivedAt = null;

    for (const remoteMessage of remoteMessages) {
      const attachments = remoteMessage?.hasAttachments
        ? (await listGraphAttachments(graphContext.accessToken, remoteMessage.id, {
            includeContentBytes: false,
          })).map((attachment) =>
            createDetachedAttachmentMetadataRecord(attachment, {
              inline: Boolean(attachment?.isInline),
            }),
          )
        : [];
      const normalized = normalizeGraphMessage(mailbox, folder, remoteMessage, attachments);
      if (!normalized.remoteId) {
        continue;
      }

      const savedMessage = saveMessage(normalized);
      if (savedMessage) {
        newMessages.push(savedMessage);
      }
      if (!newestReceivedAt || new Date(normalized.receivedAt) > new Date(newestReceivedAt)) {
        newestReceivedAt = normalized.receivedAt;
      }
    }

    upsertMailboxSyncState({
      mailboxId: mailbox.id,
      folderPath,
      folderKind,
      lastUid: 0,
      uidValidity: 0,
      lastExists: remoteMessages.length,
      lastSyncedAt: new Date().toISOString(),
    });

    return {
      synced: remoteMessages.length,
      folderPath,
      folderKind,
      lastUid: 0,
      uidValidity: 0,
      newestReceivedAt,
      newMessages,
    };
  }

  async performMicrosoftGraphSync(mailbox) {
    let synced = 0;
    let newestReceivedAt = null;
    const newMessages = [];
    const folders = [];

    for (const folder of SYNC_FOLDER_KINDS.map((kind) => microsoftFolderDescriptor(kind))) {
      const result = await this.syncMicrosoftGraphFolder(mailbox, folder);
      folders.push({
        path: result.folderPath,
        kind: result.folderKind,
        synced: result.synced,
        newCount: result.newMessages.length,
      });
      synced += result.synced;
      if (result.newestReceivedAt && (!newestReceivedAt || new Date(result.newestReceivedAt) > new Date(newestReceivedAt))) {
        newestReceivedAt = result.newestReceivedAt;
      }
      newMessages.push(...result.newMessages);
    }

    return {
      synced,
      lastUid: 0,
      uidValidity: 0,
      newestReceivedAt,
      newMessages,
      folders,
    };
  }

  async performSync(mailbox) {
    let graphError = null;

    if (isMicrosoftOAuthMailbox(mailbox) && getMicrosoftProtocolMode(mailbox) !== 'imap_only') {
      try {
        return await this.performMicrosoftGraphSync(mailbox);
      } catch (error) {
        graphError = error;
        if (getMicrosoftProtocolMode(mailbox) === 'graph_only') {
          throw error;
        }
      }
    }

    try {
      return await this.performImapSync(mailbox);
    } catch (imapError) {
      if (isMicrosoftOAuthMailbox(mailbox) && graphError) {
        throw buildMicrosoftDualProtocolError(mailbox, graphError, imapError);
      }

      throw imapError;
    }
  }

  async materializeMessageAttachments(message) {
    if (!message?.id || !message?.mailboxId) {
      throw new Error('Message not found.');
    }

    const mailbox = getMailboxById(message.mailboxId);
    if (!mailbox) {
      throw new Error('Mailbox account not found.');
    }

    let attachments = [];
    const remoteSource = String(message.remoteSource || 'imap').trim().toLowerCase() || 'imap';

    if (remoteSource === 'graph') {
      const remoteId = String(message.remoteId || '').trim();
      if (!remoteId) {
        throw new Error('Microsoft Graph attachment id is missing.');
      }

      const graphContext = await buildMicrosoftGraphContext(mailbox);
      attachments = (await listGraphAttachments(graphContext.accessToken, remoteId)).map((attachment) =>
        normalizeGraphAttachmentRecord(mailbox, { id: remoteId }, attachment),
      );
    } else {
      const remoteUid = Number(message.remoteUid || 0);
      if (!(remoteUid > 0)) {
        throw new Error('IMAP attachment uid is missing.');
      }

      const folderPath = normalizeFolderPath(message.folderPath || 'INBOX');
      const client = await createClient(mailbox, 'materialize-attachments');

      try {
        await client.connect();
        const lock = await client.getMailboxLock(folderPath);

        try {
          const fetched = await client.fetchOne(
            remoteUid,
            {
              uid: true,
              flags: true,
              internalDate: true,
              source: true,
            },
            {
              uid: true,
            },
          );

          if (!fetched?.source) {
            throw new Error('Unable to fetch the original message source.');
          }

          const parsedMessage = await simpleParser(fetched.source);
          attachments = (parsedMessage.attachments || []).map((attachment) =>
            normalizeAttachmentRecord(mailbox, fetched, attachment),
          );
        } finally {
          lock.release();
        }
      } finally {
        await closeClient(client);
      }
    }

    return updateMessageAttachments(message.id, null, attachments);
  }

  async syncEligibleMailboxAttachments(options = {}) {
    const eligibleMailboxes = listMailboxesForSync().filter((mailbox) => mailbox?.syncAttachments !== false);
    if (!eligibleMailboxes.length) {
      return {
        eligibleMailboxCount: 0,
        scannedMessageCount: 0,
        syncedMessageCount: 0,
        skippedMessageCount: 0,
        storedAttachmentCount: 0,
        errorCount: 0,
        errors: [],
      };
    }

    const candidateMessages = listMessagesWithAttachments(
      eligibleMailboxes.map((mailbox) => mailbox.id),
      {
        limit: Math.min(Math.max(Number(options.limit) || 2000, 1), 10000),
      },
    );

    let scannedMessageCount = 0;
    let syncedMessageCount = 0;
    let skippedMessageCount = 0;
    let storedAttachmentCount = 0;
    const errors = [];

    for (const message of candidateMessages) {
      scannedMessageCount += 1;
      const missingAttachmentCount = countMissingLocalAttachments(message.attachments);
      if (!(missingAttachmentCount > 0)) {
        skippedMessageCount += 1;
        continue;
      }

      try {
        const previousLocalCount = countLocalAttachments(message.attachments);
        const updatedMessage = await this.materializeMessageAttachments(message);
        const nextLocalCount = countLocalAttachments(updatedMessage?.attachments);
        const syncedAttachmentCount = Math.max(nextLocalCount - previousLocalCount, 0);

        if (syncedAttachmentCount > 0) {
          syncedMessageCount += 1;
          storedAttachmentCount += syncedAttachmentCount;
        } else {
          skippedMessageCount += 1;
        }
      } catch (error) {
        errors.push({
          messageId: message.id,
          subject: String(message.subject || '').trim(),
          error: String(error.message || error),
        });
      }
    }

    return {
      eligibleMailboxCount: eligibleMailboxes.length,
      scannedMessageCount,
      syncedMessageCount,
      skippedMessageCount,
      storedAttachmentCount,
      errorCount: errors.length,
      errors,
    };
  }

  async applyRemoteMessageState(message, nextFields = {}) {
    return this.applyRemoteMessageStates([message], nextFields);
  }

  async applyRemoteMessageStates(messages, nextFields = {}) {
    const visibleMessages = (messages || []).filter(
      (message) =>
        message?.mailboxId &&
        (String(message?.remoteId || '').trim() || Number(message?.remoteUid || 0) > 0),
    );
    if (!visibleMessages.length) {
      return;
    }

    const groups = new Map();
    for (const message of visibleMessages) {
      const folderPath = normalizeFolderPath(message.folderPath);
      const remoteSource = String(message.remoteSource || 'imap').trim().toLowerCase() || 'imap';
      const key = `${message.mailboxId}::${remoteSource}::${folderPath}`;
      if (!groups.has(key)) {
        groups.set(key, {
          mailboxId: message.mailboxId,
          remoteSource,
          folderPath,
          messages: [],
        });
      }
      groups.get(key).messages.push(message);
    }

    for (const group of groups.values()) {
      const mailbox = getMailboxById(group.mailboxId);
      if (!mailbox) {
        throw new Error('Mailbox account not found.');
      }

      if (group.remoteSource === 'graph') {
        const graphContext = await buildMicrosoftGraphContext(mailbox);
        const remoteIds = Array.from(
          new Set(group.messages.map((message) => String(message.remoteId || '').trim()).filter(Boolean)),
        );

        for (const remoteId of remoteIds) {
          const patchBody = {};
          if (typeof nextFields.isRead === 'boolean') {
            patchBody.isRead = nextFields.isRead;
          }
          if (typeof nextFields.isStarred === 'boolean') {
            patchBody.flag = { flagStatus: nextFields.isStarred ? 'flagged' : 'notFlagged' };
          }
          if (Object.keys(patchBody).length) {
            await graphRequest(graphContext.accessToken, `/me/messages/${encodeURIComponent(remoteId)}`, {
              method: 'PATCH',
              body: patchBody,
            });
          }
        }
        continue;
      }

      const client = await createClient(mailbox, 'apply-remote-state');
      try {
        await client.connect();
        const lock = await client.getMailboxLock(group.folderPath);

        try {
          const remoteUids = Array.from(
            new Set(group.messages.map((message) => Number(message.remoteUid)).filter((value) => value > 0)),
          );
          const storeOptions = { uid: true, silent: true };

          if (typeof nextFields.isRead === 'boolean' && remoteUids.length) {
            if (nextFields.isRead) {
              await client.messageFlagsAdd(remoteUids, ['\\Seen'], storeOptions);
            } else {
              await client.messageFlagsRemove(remoteUids, ['\\Seen'], storeOptions);
            }
          }

          if (typeof nextFields.isStarred === 'boolean' && remoteUids.length) {
            if (nextFields.isStarred) {
              await client.messageFlagsAdd(remoteUids, ['\\Flagged'], storeOptions);
            } else {
              await client.messageFlagsRemove(remoteUids, ['\\Flagged'], storeOptions);
            }
          }
        } finally {
          lock.release();
        }
      } finally {
        await closeClient(client);
      }
    }
  }

  async deleteRemoteMessages(messages, options = {}) {
    const visibleMessages = (messages || []).filter(
      (message) =>
        message?.mailboxId &&
        (String(message?.remoteId || '').trim() || Number(message?.remoteUid || 0) > 0),
    );
    if (!visibleMessages.length) {
      return;
    }

    const byMailboxAndSource = new Map();
    for (const message of visibleMessages) {
      const mailboxKey = `${message.mailboxId}::${String(message.remoteSource || 'imap').trim().toLowerCase() || 'imap'}`;
      if (!byMailboxAndSource.has(mailboxKey)) {
        byMailboxAndSource.set(mailboxKey, []);
      }
      byMailboxAndSource.get(mailboxKey).push(message);
    }

    for (const [mailboxKey, mailboxMessages] of byMailboxAndSource.entries()) {
      const [mailboxId, remoteSource = 'imap'] = String(mailboxKey).split('::');
      const mailbox = getMailboxById(mailboxId);
      if (!mailbox) {
        throw new Error('Mailbox account not found.');
      }

      if (remoteSource === 'graph') {
        const graphContext = await buildMicrosoftGraphContext(mailbox);

        for (const message of mailboxMessages) {
          const remoteId = String(message.remoteId || '').trim();
          if (!remoteId) {
            continue;
          }

          const permanentDelete =
            Boolean(options.permanent) || normalizeFolderKind(message.folderKind) === 'trash';

          if (!permanentDelete) {
            await graphRequest(graphContext.accessToken, `/me/messages/${encodeURIComponent(remoteId)}/move`, {
              method: 'POST',
              body: { destinationId: 'deleteditems' },
            });
          } else {
            await graphRequest(graphContext.accessToken, `/me/messages/${encodeURIComponent(remoteId)}`, {
              method: 'DELETE',
            });
          }
        }
        continue;
      }

      const client = await createClient(mailbox, 'delete-remote-messages');
      try {
        await client.connect();
        const folderTargets = mailboxFolderMap(discoverFolderTargets(await client.list()));
        const trashFolder = folderTargets.trash || null;
        const groups = new Map();

        for (const message of mailboxMessages) {
          const folderPath = normalizeFolderPath(message.folderPath);
          if (!groups.has(folderPath)) {
            groups.set(folderPath, []);
          }
          groups.get(folderPath).push(message);
        }

        for (const [folderPath, folderMessages] of groups.entries()) {
          const lock = await client.getMailboxLock(folderPath);

          try {
            const remoteUids = Array.from(
              new Set(folderMessages.map((message) => Number(message.remoteUid)).filter((value) => value > 0)),
            );
            if (!remoteUids.length) {
              continue;
            }

            const allAlreadyInTrash = folderMessages.every(
              (message) => normalizeFolderKind(message.folderKind) === 'trash',
            );
            const permanentDelete = Boolean(options.permanent) || allAlreadyInTrash;

            if (!permanentDelete && trashFolder && normalizeFolderPath(trashFolder.path) !== folderPath) {
              await client.messageMove(remoteUids, trashFolder.path, { uid: true });
            } else {
              await client.messageDelete(remoteUids, { uid: true });
            }
          } finally {
            lock.release();
          }
        }
      } finally {
        await closeClient(client);
      }
    }
  }
}

module.exports = {
  MailSyncService,
};
