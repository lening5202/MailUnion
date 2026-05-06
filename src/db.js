const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, normalizeEmail, normalizeUsername } = require('./auth');
const { encrypt } = require('./crypto');
const {
  normalizeOutboundProxyBypass,
  normalizeOutboundProxyMode,
  normalizeProxyUrl,
} = require('./outbound-network');

const databaseFile = path.join(process.cwd(), 'data', 'mail-union.sqlite');
const databaseWalFile = `${databaseFile}-wal`;
const databaseShmFile = `${databaseFile}-shm`;
fs.mkdirSync(path.dirname(databaseFile), { recursive: true });

let db = null;

const SPECIAL_MESSAGE_FOLDER_KINDS = ['trash', 'junk'];
const DEFAULT_SESSION_TIMEOUT_VALUE = Math.max(Number(process.env.SESSION_TTL_DAYS) || 7, 1);
const DEFAULT_SESSION_TIMEOUT_UNIT = 'day';

function trimString(value) {
  return String(value || '').trim();
}

function normalizeGoogleClientId(value) {
  const normalized = trimString(value).replace(/["'`“”‘’]/g, '');
  if (!normalized) {
    return '';
  }

  const matchedClientId = normalized.match(/[a-z0-9][a-z0-9-]*\.apps\.googleusercontent\.com/i);
  if (matchedClientId?.[0]) {
    return matchedClientId[0];
  }

  return normalized
    .replace(/^client\s*id\s*[:：]?\s*/i, '')
    .replace(/^客户端\s*id\s*[:：]?\s*/i, '')
    .trim();
}

function applyDatabaseSchema() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      avatar_url TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      user_agent TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mailboxes (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      password_encrypted TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'password',
      oauth_json TEXT NOT NULL DEFAULT '{}',
      imap_host TEXT NOT NULL,
      imap_port INTEGER NOT NULL,
      secure INTEGER NOT NULL DEFAULT 1,
      sync_attachments INTEGER NOT NULL DEFAULT 1,
      sync_interval_seconds INTEGER NOT NULL DEFAULT 5,
      sort_order INTEGER NOT NULL DEFAULT 100,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      last_uid INTEGER NOT NULL DEFAULT 0,
      uid_validity INTEGER,
      last_synced_at TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      mailbox_id TEXT NOT NULL,
      folder_path TEXT NOT NULL DEFAULT 'INBOX',
      folder_kind TEXT NOT NULL DEFAULT 'inbox',
      remote_uid INTEGER NOT NULL,
      remote_id TEXT NOT NULL DEFAULT '',
      remote_source TEXT NOT NULL DEFAULT 'imap',
      message_id TEXT,
      subject TEXT NOT NULL,
      from_name TEXT,
      from_address TEXT,
      to_json TEXT NOT NULL DEFAULT '[]',
      received_at TEXT NOT NULL,
      preview TEXT,
      text_body TEXT,
      html_body TEXT,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      is_read INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      raw_flags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
      UNIQUE (mailbox_id, folder_path, remote_source, remote_id)
    );

    CREATE TABLE IF NOT EXISTS mailbox_sync_state (
      mailbox_id TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      folder_kind TEXT NOT NULL DEFAULT 'inbox',
      last_uid INTEGER NOT NULL DEFAULT 0,
      uid_validity INTEGER,
      last_exists INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (mailbox_id, folder_path),
      FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notification_targets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      secret_encrypted TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (user_id, channel)
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      site_name TEXT NOT NULL DEFAULT 'Mail Union',
      logo_mode TEXT NOT NULL DEFAULT 'auto',
      logo_url TEXT,
      logo_svg TEXT,
      logo_asset_path TEXT,
      google_client_id TEXT,
      google_client_secret_encrypted TEXT,
      microsoft_client_id TEXT,
      microsoft_client_secret_encrypted TEXT,
      microsoft_tenant_id TEXT NOT NULL DEFAULT 'common',
      auth_config_json TEXT NOT NULL DEFAULT '{}',
      smtp_config_json TEXT NOT NULL DEFAULT '{}',
      translation_provider TEXT NOT NULL DEFAULT 'google_free',
      translation_target_language TEXT NOT NULL DEFAULT 'zh-CN',
      translation_base_url TEXT,
      translation_region TEXT,
      translation_model TEXT,
      translation_api_key_encrypted TEXT,
      storage_provider TEXT NOT NULL DEFAULT 'local',
      storage_config_json TEXT NOT NULL DEFAULT '{}',
      backup_config_json TEXT NOT NULL DEFAULT '{}',
      proxy_config_json TEXT NOT NULL DEFAULT '{}',
      theme_preset_id TEXT NOT NULL DEFAULT 'ocean-mist',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_auth_codes (
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      email TEXT NOT NULL,
      user_id TEXT,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      trigger_source TEXT NOT NULL DEFAULT 'manual',
      destination TEXT NOT NULL DEFAULT 'local',
      local_path TEXT,
      remote_path TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_messages_mailbox_received_at ON messages(mailbox_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mailbox_sync_state_kind ON mailbox_sync_state(mailbox_id, folder_kind);
    CREATE INDEX IF NOT EXISTS idx_backups_created_at ON backups(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_auth_codes_lookup ON email_auth_codes(email, purpose, created_at DESC);
  `);
}

function checkpointDatabase(mode = 'TRUNCATE') {
  if (!db) {
    return;
  }

  const normalizedMode = String(mode || 'TRUNCATE').trim().toUpperCase();
  const checkpointMode = ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(normalizedMode)
    ? normalizedMode
    : 'TRUNCATE';
  db.exec(`PRAGMA wal_checkpoint(${checkpointMode});`);
}

function initializeDatabaseConnection() {
  if (db) {
    return db;
  }

  db = new DatabaseSync(databaseFile);
  applyDatabaseSchema();
  ensureLegacyMigrations();
  ensureSystemSettingsRow();
  cleanupExpiredSessions();
  deleteExpiredEmailAuthCodes();
  return db;
}

function closeDatabaseConnection(options = {}) {
  if (!db) {
    return;
  }

  const shouldCheckpoint = options.checkpoint !== false;
  if (shouldCheckpoint) {
    checkpointDatabase(options.checkpointMode || 'TRUNCATE');
  }

  db.close();
  db = null;
}

function reopenDatabaseConnection() {
  closeDatabaseConnection();
  return initializeDatabaseConnection();
}

initializeDatabaseConnection();

function now() {
  return new Date().toISOString();
}

function safeParseJson(value, fallback = {}) {
  try {
    return JSON.parse(String(value || ''));
  } catch (_) {
    return fallback;
  }
}

function messageFolderKindSql(alias = 'msg') {
  return `COALESCE(${alias}.folder_kind, 'inbox')`;
}

function normalMessageFolderSql(alias = 'msg') {
  return `${messageFolderKindSql(alias)} NOT IN (${SPECIAL_MESSAGE_FOLDER_KINDS.map((kind) => `'${kind}'`).join(', ')})`;
}

function mailboxDisplayOrderSql(alias = 'm') {
  return `COALESCE(${alias}.is_pinned, 0) DESC, COALESCE(${alias}.sort_order, 100) ASC, ${alias}.created_at ASC, ${alias}.id ASC`;
}

function mailboxRecentOrderSql(alias = 'm') {
  return `COALESCE(${alias}.last_synced_at, ${alias}.created_at) DESC, ${alias}.created_at DESC`;
}

function normalizeMailboxSortOrder(value, fallback = 100) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.max(Math.round(numeric), 0);
  }

  const normalizedFallback = Number(fallback);
  if (Number.isFinite(normalizedFallback)) {
    return Math.max(Math.round(normalizedFallback), 0);
  }

  return 100;
}

function ensureLegacyMigrations() {
  const userColumns = getTableColumns('users');
  const addedUsernameColumn = !userColumns.includes('username');
  if (addedUsernameColumn) {
    db.exec('ALTER TABLE users ADD COLUMN username TEXT');
  }
  if (!userColumns.includes('avatar_url')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
  }

  backfillUserIdentityColumns({ resetDefaultAdminPassword: addedUsernameColumn });
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');

  const mailboxColumns = getTableColumns('mailboxes');
  if (!mailboxColumns.includes('owner_user_id')) {
    db.exec('ALTER TABLE mailboxes ADD COLUMN owner_user_id TEXT');
  }
  if (!mailboxColumns.includes('auth_type')) {
    db.exec("ALTER TABLE mailboxes ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'password'");
  }
  if (!mailboxColumns.includes('oauth_json')) {
    db.exec("ALTER TABLE mailboxes ADD COLUMN oauth_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!mailboxColumns.includes('sort_order')) {
    db.exec('ALTER TABLE mailboxes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 100');
  }
  if (!mailboxColumns.includes('is_pinned')) {
    db.exec('ALTER TABLE mailboxes ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0');
  }
  if (!mailboxColumns.includes('sync_attachments')) {
    db.exec('ALTER TABLE mailboxes ADD COLUMN sync_attachments INTEGER NOT NULL DEFAULT 1');
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_mailboxes_owner_user_id ON mailboxes(owner_user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mailboxes_display_order ON mailboxes(is_pinned, sort_order, created_at)');
  db.exec("UPDATE mailboxes SET auth_type = 'password' WHERE auth_type IS NULL OR TRIM(auth_type) = ''");
  db.exec("UPDATE mailboxes SET oauth_json = '{}' WHERE oauth_json IS NULL OR TRIM(oauth_json) = ''");
  db.exec('UPDATE mailboxes SET sort_order = 100 WHERE sort_order IS NULL OR sort_order < 0');
  db.exec('UPDATE mailboxes SET is_pinned = 0 WHERE is_pinned IS NULL');
  db.exec('UPDATE mailboxes SET sync_attachments = 1 WHERE sync_attachments IS NULL');
  db.exec('UPDATE mailboxes SET sync_interval_seconds = 5 WHERE sync_interval_seconds IS NULL OR sync_interval_seconds = 120 OR sync_interval_seconds < 1');

  const systemSettingColumns = getTableColumns('system_settings');
  if (!systemSettingColumns.includes('google_client_id')) {
    db.exec('ALTER TABLE system_settings ADD COLUMN google_client_id TEXT');
  }
  if (!systemSettingColumns.includes('google_client_secret_encrypted')) {
    db.exec('ALTER TABLE system_settings ADD COLUMN google_client_secret_encrypted TEXT');
  }
  if (!systemSettingColumns.includes('microsoft_client_id')) {
    db.exec('ALTER TABLE system_settings ADD COLUMN microsoft_client_id TEXT');
  }
  if (!systemSettingColumns.includes('microsoft_client_secret_encrypted')) {
    db.exec('ALTER TABLE system_settings ADD COLUMN microsoft_client_secret_encrypted TEXT');
  }
  if (!systemSettingColumns.includes('microsoft_tenant_id')) {
    db.exec("ALTER TABLE system_settings ADD COLUMN microsoft_tenant_id TEXT NOT NULL DEFAULT 'common'");
  }
  if (!systemSettingColumns.includes('auth_config_json')) {
    db.exec("ALTER TABLE system_settings ADD COLUMN auth_config_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!systemSettingColumns.includes('smtp_config_json')) {
    db.exec("ALTER TABLE system_settings ADD COLUMN smtp_config_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!systemSettingColumns.includes('logo_asset_path')) {
    db.exec('ALTER TABLE system_settings ADD COLUMN logo_asset_path TEXT');
  }
  if (!systemSettingColumns.includes('translation_provider')) {
    db.exec("ALTER TABLE system_settings ADD COLUMN translation_provider TEXT NOT NULL DEFAULT 'google_free'");
  }
  if (!systemSettingColumns.includes('translation_target_language')) {
    db.exec("ALTER TABLE system_settings ADD COLUMN translation_target_language TEXT NOT NULL DEFAULT 'zh-CN'");
  }
  if (!systemSettingColumns.includes('translation_base_url')) {
    db.exec('ALTER TABLE system_settings ADD COLUMN translation_base_url TEXT');
  }
  if (!systemSettingColumns.includes('translation_region')) {
    db.exec('ALTER TABLE system_settings ADD COLUMN translation_region TEXT');
  }
  if (!systemSettingColumns.includes('translation_model')) {
    db.exec('ALTER TABLE system_settings ADD COLUMN translation_model TEXT');
  }
  if (!systemSettingColumns.includes('translation_api_key_encrypted')) {
    db.exec('ALTER TABLE system_settings ADD COLUMN translation_api_key_encrypted TEXT');
  }
  if (!systemSettingColumns.includes('storage_provider')) {
    db.exec("ALTER TABLE system_settings ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'local'");
  }
  if (!systemSettingColumns.includes('storage_config_json')) {
    db.exec("ALTER TABLE system_settings ADD COLUMN storage_config_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!systemSettingColumns.includes('backup_config_json')) {
    db.exec("ALTER TABLE system_settings ADD COLUMN backup_config_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!systemSettingColumns.includes('proxy_config_json')) {
    db.exec("ALTER TABLE system_settings ADD COLUMN proxy_config_json TEXT NOT NULL DEFAULT '{}'");
  }
  db.exec("UPDATE system_settings SET microsoft_tenant_id = 'common' WHERE microsoft_tenant_id IS NULL OR TRIM(microsoft_tenant_id) = ''");
  db.exec("UPDATE system_settings SET translation_provider = 'google_free' WHERE translation_provider IS NULL OR TRIM(translation_provider) = ''");
  db.exec("UPDATE system_settings SET translation_target_language = 'zh-CN' WHERE translation_target_language IS NULL OR TRIM(translation_target_language) = ''");
  db.exec("UPDATE system_settings SET storage_provider = 'local' WHERE storage_provider IS NULL OR TRIM(storage_provider) = ''");
  db.exec("UPDATE system_settings SET storage_config_json = '{}' WHERE storage_config_json IS NULL OR TRIM(storage_config_json) = ''");
  db.exec("UPDATE system_settings SET backup_config_json = '{}' WHERE backup_config_json IS NULL OR TRIM(backup_config_json) = ''");
  db.exec("UPDATE system_settings SET proxy_config_json = '{}' WHERE proxy_config_json IS NULL OR TRIM(proxy_config_json) = ''");
  db.exec("UPDATE system_settings SET auth_config_json = '{}' WHERE auth_config_json IS NULL OR TRIM(auth_config_json) = ''");
  db.exec("UPDATE system_settings SET smtp_config_json = '{}' WHERE smtp_config_json IS NULL OR TRIM(smtp_config_json) = ''");

  const messageColumns = getTableColumns('messages');
  if (!messageColumns.includes('is_starred')) {
    db.exec('ALTER TABLE messages ADD COLUMN is_starred INTEGER NOT NULL DEFAULT 0');
  }
  const migratedMessageColumns = getTableColumns('messages');
  if (
    !migratedMessageColumns.includes('folder_path') ||
    !migratedMessageColumns.includes('folder_kind') ||
    !migratedMessageColumns.includes('remote_id') ||
    !migratedMessageColumns.includes('remote_source')
  ) {
    migrateMessagesTable();
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_mailbox_is_read ON messages(mailbox_id, is_read)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_mailbox_is_starred ON messages(mailbox_id, is_starred)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_mailbox_folder_received_at ON messages(mailbox_id, folder_kind, received_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_mailbox_folder_path_uid ON messages(mailbox_id, folder_path, remote_uid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_mailbox_folder_remote ON messages(mailbox_id, folder_path, remote_source, remote_id)');
  db.exec('CREATE TABLE IF NOT EXISTS mailbox_sync_state (mailbox_id TEXT NOT NULL, folder_path TEXT NOT NULL, folder_kind TEXT NOT NULL DEFAULT \'inbox\', last_uid INTEGER NOT NULL DEFAULT 0, uid_validity INTEGER, last_exists INTEGER NOT NULL DEFAULT 0, last_synced_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (mailbox_id, folder_path), FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mailbox_sync_state_kind ON mailbox_sync_state(mailbox_id, folder_kind)');
  db.exec('CREATE TABLE IF NOT EXISTS email_auth_codes (id TEXT PRIMARY KEY, purpose TEXT NOT NULL, email TEXT NOT NULL, user_id TEXT, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_email_auth_codes_lookup ON email_auth_codes(email, purpose, created_at DESC)');
  backfillMailboxSyncState();
}

function migrateMessagesTable() {
  const legacyTableName = '__messages_legacy_migration__';
  const legacyColumns = getTableColumns('messages');
  const hasFolderPath = legacyColumns.includes('folder_path');
  const hasFolderKind = legacyColumns.includes('folder_kind');
  const hasIsStarred = legacyColumns.includes('is_starred');
  const hasRawFlags = legacyColumns.includes('raw_flags');
  const hasRemoteId = legacyColumns.includes('remote_id');
  const hasRemoteSource = legacyColumns.includes('remote_source');

  try {
    db.exec('BEGIN');
    db.exec(`DROP TABLE IF EXISTS ${legacyTableName}`);
    db.exec(`ALTER TABLE messages RENAME TO ${legacyTableName}`);
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        mailbox_id TEXT NOT NULL,
        folder_path TEXT NOT NULL DEFAULT 'INBOX',
        folder_kind TEXT NOT NULL DEFAULT 'inbox',
        remote_uid INTEGER NOT NULL,
        remote_id TEXT NOT NULL DEFAULT '',
        remote_source TEXT NOT NULL DEFAULT 'imap',
        message_id TEXT,
        subject TEXT NOT NULL,
        from_name TEXT,
        from_address TEXT,
        to_json TEXT NOT NULL DEFAULT '[]',
        received_at TEXT NOT NULL,
        preview TEXT,
        text_body TEXT,
        html_body TEXT,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        is_read INTEGER NOT NULL DEFAULT 0,
        is_starred INTEGER NOT NULL DEFAULT 0,
        raw_flags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
        UNIQUE (mailbox_id, folder_path, remote_source, remote_id)
      )
    `);
    db.exec(`
      INSERT INTO messages (
        id, mailbox_id, folder_path, folder_kind, remote_uid, remote_id, remote_source, message_id, subject, from_name,
        from_address, to_json, received_at, preview, text_body, html_body, attachments_json,
        is_read, is_starred, raw_flags, created_at, updated_at
      )
      SELECT
        id,
        mailbox_id,
        ${hasFolderPath ? 'folder_path' : "'INBOX'"},
        ${hasFolderKind ? 'folder_kind' : "'inbox'"},
        remote_uid,
        ${hasRemoteId ? "COALESCE(NULLIF(remote_id, ''), CAST(remote_uid AS TEXT), id)" : "COALESCE(CAST(remote_uid AS TEXT), id)"},
        ${hasRemoteSource ? "COALESCE(NULLIF(remote_source, ''), 'imap')" : "'imap'"},
        message_id,
        subject,
        from_name,
        from_address,
        to_json,
        received_at,
        preview,
        text_body,
        html_body,
        attachments_json,
        is_read,
        ${hasIsStarred ? 'is_starred' : '0'},
        ${hasRawFlags ? 'raw_flags' : "'[]'"},
        created_at,
        updated_at
      FROM ${legacyTableName}
    `);
    db.exec(`DROP TABLE ${legacyTableName}`);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // Ignore rollback failures when the transaction did not start cleanly.
    }
    throw error;
  }
}

function backfillMailboxSyncState() {
  const timestamp = now();
  db.prepare(`
    INSERT INTO mailbox_sync_state (
      mailbox_id, folder_path, folder_kind, last_uid, uid_validity, last_exists, last_synced_at, created_at, updated_at
    )
    SELECT
      m.id,
      'INBOX',
      'inbox',
      COALESCE(m.last_uid, 0),
      m.uid_validity,
      0,
      m.last_synced_at,
      ?,
      ?
    FROM mailboxes m
    WHERE NOT EXISTS (
      SELECT 1
      FROM mailbox_sync_state state
      WHERE state.mailbox_id = m.id AND state.folder_path = 'INBOX'
    )
  `).run(timestamp, timestamp);
}

function backfillUserIdentityColumns(options = {}) {
  const rows = db.prepare(`
    SELECT id, name, email, username, role
    FROM users
    ORDER BY created_at ASC, id ASC
  `).all();
  const used = new Set();

  for (const row of rows) {
    let candidate = normalizeUsername(row.username);
    if (!candidate) {
      candidate = baseUsernameFromRow(row);
    }

    let nextUsername = candidate || `user-${String(row.id || '').slice(0, 8)}`;
    let suffix = 2;
    while (used.has(nextUsername)) {
      nextUsername = `${candidate || 'user'}-${suffix}`;
      suffix += 1;
    }

    used.add(nextUsername);
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(nextUsername, row.id);
  }

  if (options.resetDefaultAdminPassword) {
    const existingAdmin = db
      .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, id ASC LIMIT 1")
      .get();

    if (existingAdmin) {
      db.prepare('UPDATE users SET username = ?, password_hash = ?, updated_at = ? WHERE id = ?').run(
        'admin',
        hashPassword('admin'),
        now(),
        existingAdmin.id,
      );
    }
  }
}

function baseUsernameFromRow(row) {
  const emailLocal = String(row.email || '').split('@')[0];
  const normalizedEmailLocal = normalizeUsername(emailLocal);
  if (normalizedEmailLocal) {
    return normalizedEmailLocal;
  }

  const normalizedName = normalizeUsername(String(row.name || '').replace(/\s+/g, '-'));
  if (normalizedName) {
    return normalizedName;
  }

  return '';
}

function getTableColumns(tableName) {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((column) => column.name);
}

function cleanupExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}

function hashToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function parseUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    username: row.username,
    email: row.email,
    avatarUrl: row.avatar_url || '',
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mailboxCount: row.mailbox_count ?? 0,
  };
}

function parseMailbox(row) {
  if (!row) {
    return null;
  }

  const oauth = safeParseJson(row.oauth_json, {});
  const oauthProtocolMode = String(oauth.protocolMode || 'graph_imap_dual').trim().toLowerCase() || 'graph_imap_dual';
  const oauthSharedRefreshTokenEncrypted = String(
    oauth.sharedRefreshTokenEncrypted || oauth.refreshTokenEncrypted || '',
  ).trim();
  const oauthImapRefreshTokenEncrypted = String(
    oauth.imapRefreshTokenEncrypted || oauth.refreshTokenEncrypted || '',
  ).trim();
  const oauthGraphRefreshTokenEncrypted = String(
    oauth.graphRefreshTokenEncrypted || oauth.sharedRefreshTokenEncrypted || oauth.refreshTokenEncrypted || '',
  ).trim();
  const oauthImapAccessTokenEncrypted = String(
    oauth.imapAccessTokenEncrypted || oauth.accessTokenEncrypted || '',
  ).trim();
  const oauthGraphAccessTokenEncrypted = String(oauth.graphAccessTokenEncrypted || '').trim();

  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name ?? '',
    ownerEmail: row.owner_email ?? '',
    name: row.name,
    provider: row.provider,
    email: row.email,
    username: row.username,
    password_encrypted: row.password_encrypted,
    authType: row.auth_type || 'password',
    oauth,
    oauthEmail: String(oauth.email || '').trim(),
    oauthConfigured: Boolean(
      oauthSharedRefreshTokenEncrypted ||
        oauthImapRefreshTokenEncrypted ||
        oauthGraphRefreshTokenEncrypted ||
        oauthImapAccessTokenEncrypted ||
        oauthGraphAccessTokenEncrypted,
    ),
    oauthClientId: String(oauth.clientId || '').trim(),
    oauthProtocolMode,
    oauthImapReady: Boolean(oauthImapRefreshTokenEncrypted || oauthImapAccessTokenEncrypted),
    oauthGraphReady: Boolean(oauthGraphRefreshTokenEncrypted || oauthGraphAccessTokenEncrypted),
    oauthSource: String(oauth.source || '').trim(),
    imap_host: row.imap_host,
    imap_port: row.imap_port,
    secure: Boolean(row.secure),
    syncAttachments: row.sync_attachments === undefined ? true : Boolean(row.sync_attachments),
    syncIntervalSeconds: row.sync_interval_seconds,
    sortOrder: normalizeMailboxSortOrder(row.sort_order, 100),
    isPinned: Boolean(row.is_pinned),
    lastUid: row.last_uid,
    uidValidity: row.uid_validity,
    lastSyncedAt: row.last_synced_at,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count ?? 0,
    unreadCount: row.unread_count ?? 0,
    trashCount: row.trash_count ?? 0,
    junkCount: row.junk_count ?? 0,
    latestMessageAt: row.latest_message_at ?? null,
  };
}

function parseMailboxSyncState(row) {
  if (!row) {
    return null;
  }

  return {
    mailboxId: row.mailbox_id,
    folderPath: row.folder_path,
    folderKind: row.folder_kind,
    lastUid: row.last_uid,
    uidValidity: row.uid_validity,
    lastExists: row.last_exists,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseNotificationTarget(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    enabled: Boolean(row.enabled),
    secretEncrypted: row.secret_encrypted || '',
    config: safeParseJson(row.config_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSystemLogoMode(value, fallback = 'auto') {
  const normalized = String(value || fallback || 'auto').trim().toLowerCase();
  return ['auto', 'url', 'upload'].includes(normalized) ? normalized : 'auto';
}

function normalizeStorageProvider(value, fallback = 'local') {
  const normalized = String(value || fallback || 'local').trim().toLowerCase();
  return ['local', 's3', 'webdav', 'ftp'].includes(normalized) ? normalized : 'local';
}

function normalizeStorageRemotePathPrefix(value, fallback = 'mail-union') {
  const normalized = String(value ?? fallback ?? 'mail-union')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]+/g, '-'))
    .filter(Boolean)
    .join('/');
  return normalized || 'mail-union';
}

function normalizeStorageSyncPolicy(value, fallback = 'all_local') {
  const normalized = String(value || fallback || 'all_local').trim().toLowerCase();
  return ['all_local', 'all_remote', 'attachments_remote_only'].includes(normalized)
    ? normalized
    : 'all_local';
}

function normalizeOptionalHttpUrl(value, fallback = '') {
  const url = String(value ?? fallback ?? '').trim();
  if (!url) {
    return '';
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Storage URL must start with http or https.');
  }
  return url.replace(/\/+$/g, '');
}

function normalizeOptionalHostname(value, fallback = '') {
  return String(value ?? fallback ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '')
    .slice(0, 255);
}

function normalizeEmailDomainWhitelist(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,;|]+/g)
      : Array.isArray(fallback)
        ? fallback
        : [];

  return Array.from(
    new Set(
      source
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
        .map((item) => {
          const normalized = item.startsWith('@') ? item : `@${item.replace(/^@+/g, '')}`;
          return normalized === '@' ? '' : normalized;
        })
        .filter(Boolean),
    ),
  );
}

function normalizeOptionalEmail(value, fallback = '') {
  return normalizeEmail(String(value ?? fallback ?? '').trim());
}

function normalizePort(value, fallback = 21) {
  const port = Number(value || fallback || 21);
  if (!Number.isFinite(port)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(port), 1), 65535);
}

function normalizeBooleanValue(value, fallback = false) {
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

function normalizeSessionTimeoutUnit(value, fallback = DEFAULT_SESSION_TIMEOUT_UNIT) {
  const fallbackUnit = String(fallback || DEFAULT_SESSION_TIMEOUT_UNIT).trim().toLowerCase();
  const normalized = String(value || fallbackUnit || DEFAULT_SESSION_TIMEOUT_UNIT).trim().toLowerCase();
  return ['minute', 'hour', 'day', 'month', 'year'].includes(normalized)
    ? normalized
    : ['minute', 'hour', 'day', 'month', 'year'].includes(fallbackUnit)
      ? fallbackUnit
      : DEFAULT_SESSION_TIMEOUT_UNIT;
}

function normalizeSessionTimeoutValue(value, fallback = DEFAULT_SESSION_TIMEOUT_VALUE) {
  const fallbackNumber = Number.isFinite(Number(fallback))
    ? Number(fallback)
    : DEFAULT_SESSION_TIMEOUT_VALUE;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return Math.max(Math.round(fallbackNumber), 1);
  }

  return Math.min(Math.max(Math.round(numeric), 1), 1000);
}

function normalizeBackupTarget(value, fallback = 'local') {
  const normalized = String(value || fallback || 'local').trim().toLowerCase();
  return ['local', 'remote', 'both'].includes(normalized) ? normalized : 'local';
}

function normalizeBackupContentMode(value, fallback = 'database_and_site') {
  const normalized = String(value || fallback || 'database_and_site').trim().toLowerCase();
  return ['database_only', 'site_only', 'database_and_site'].includes(normalized)
    ? normalized
    : 'database_and_site';
}

function normalizeBackupIntervalHours(value, fallback = 24) {
  const hours = Number(value || fallback || 24);
  if (!Number.isFinite(hours)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(hours), 1), 24 * 30);
}

function normalizeBackupRetentionCount(value, fallback = 10) {
  const count = Number(value || fallback || 10);
  if (!Number.isFinite(count)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(count), 1), 200);
}

function normalizeTranslationProvider(value, fallback = 'google_free') {
  const normalized = String(value || fallback || 'google_free').trim().toLowerCase();
  return ['google_free', 'mymemory_free', 'libretranslate', 'azure_translator', 'openai_compatible'].includes(normalized)
    ? normalized
    : 'google_free';
}

function normalizeTranslationTargetLanguage(value, fallback = 'zh-CN') {
  const normalized = String(value || fallback || 'zh-CN').trim();
  return normalized ? normalized.slice(0, 40) : 'zh-CN';
}

function normalizeTranslationBaseUrl(value, fallback = '') {
  const url = String(value ?? fallback ?? '').trim();
  if (!url) {
    return '';
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Translation base URL must start with http or https.');
  }

  return url.replace(/\/+$/, '');
}

function normalizeTranslationRegion(value, fallback = '') {
  const normalized = String(value ?? fallback ?? '').trim();
  return normalized ? normalized.slice(0, 80) : '';
}

function parseSystemSettings(row) {
  if (!row) {
    return {
      siteName: 'Mail Union',
      logoMode: 'auto',
      logoUrl: '',
      logoAssetPath: '',
      googleClientId: '',
      googleClientSecretEncrypted: '',
      googleClientSecretConfigured: false,
      googleAppConfigured: false,
      microsoftClientId: '',
      microsoftClientSecretEncrypted: '',
      microsoftClientSecretConfigured: false,
      microsoftTenantId: 'common',
      microsoftAppConfigured: false,
      registrationEnabled: true,
      registrationEmailVerificationRequired: false,
      registrationEmailDomainWhitelist: [],
      passwordResetEnabled: false,
      sessionTimeoutValue: DEFAULT_SESSION_TIMEOUT_VALUE,
      sessionTimeoutUnit: DEFAULT_SESSION_TIMEOUT_UNIT,
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUsername: '',
      smtpPasswordEncrypted: '',
      smtpPasswordConfigured: false,
      smtpFromName: 'Mail Union',
      smtpFromEmail: '',
      translationProvider: 'google_free',
      translationTargetLanguage: 'zh-CN',
      translationBaseUrl: '',
      translationRegion: '',
      translationModel: '',
      translationApiKeyEncrypted: '',
      translationApiKeyConfigured: false,
      storageProvider: 'local',
      storageSyncPolicy: 'all_local',
      storageRemotePathPrefix: 'mail-union',
      storageS3Bucket: '',
      storageS3Region: '',
      storageS3Endpoint: '',
      storageS3AccessKey: '',
      storageS3SecretEncrypted: '',
      storageS3SecretConfigured: false,
      storageS3ForcePathStyle: false,
      storageWebdavUrl: '',
      storageWebdavUsername: '',
      storageWebdavPasswordEncrypted: '',
      storageWebdavPasswordConfigured: false,
      storageFtpHost: '',
      storageFtpPort: 21,
      storageFtpSecure: false,
      storageFtpUsername: '',
      storageFtpPasswordEncrypted: '',
      storageFtpPasswordConfigured: false,
      backupEnabled: false,
      backupIntervalHours: 24,
      backupTarget: 'local',
      backupRetentionCount: 10,
      backupContentMode: 'database_and_site',
      backupIncludeRuntimeFiles: true,
      themePresetId: 'ocean-mist',
      createdAt: null,
      updatedAt: null,
    };
  }

  const googleClientId = normalizeGoogleClientId(row.google_client_id || '');
  const googleClientSecretEncrypted = row.google_client_secret_encrypted || '';
  const microsoftClientId = row.microsoft_client_id || '';
  const microsoftClientSecretEncrypted = row.microsoft_client_secret_encrypted || '';
  const microsoftTenantId = row.microsoft_tenant_id || 'common';
  const translationApiKeyEncrypted = row.translation_api_key_encrypted || '';
  const authConfig = safeParseJson(row.auth_config_json, {});
  const smtpConfig = safeParseJson(row.smtp_config_json, {});
  const storageConfig = safeParseJson(row.storage_config_json, {});
  const backupConfig = safeParseJson(row.backup_config_json, {});
  const proxyConfig = safeParseJson(row.proxy_config_json, {});
  const backupContentMode = Object.prototype.hasOwnProperty.call(backupConfig, 'contentMode')
    ? normalizeBackupContentMode(backupConfig.contentMode, 'database_and_site')
    : normalizeBackupContentMode(
        normalizeBooleanValue(backupConfig.includeRuntimeFiles, true) ? 'database_and_site' : 'database_only',
        'database_and_site',
      );
  const smtpPasswordEncrypted = String(smtpConfig.passwordEncrypted || '').trim();
  const storageS3SecretEncrypted = String(storageConfig.s3SecretEncrypted || '').trim();
  const storageWebdavPasswordEncrypted = String(storageConfig.webdavPasswordEncrypted || '').trim();
  const storageFtpPasswordEncrypted = String(storageConfig.ftpPasswordEncrypted || '').trim();

  return {
    siteName: row.site_name || 'Mail Union',
    logoMode: normalizeSystemLogoMode(row.logo_mode, 'auto'),
    logoUrl: row.logo_url || '',
    logoAssetPath: row.logo_asset_path || '',
    googleClientId,
    googleClientSecretEncrypted,
    googleClientSecretConfigured: Boolean(googleClientSecretEncrypted),
    googleAppConfigured: Boolean(googleClientId && googleClientSecretEncrypted),
    microsoftClientId,
    microsoftClientSecretEncrypted,
    microsoftClientSecretConfigured: Boolean(microsoftClientSecretEncrypted),
    microsoftTenantId,
    microsoftAppConfigured: Boolean(microsoftClientId),
    registrationEnabled: normalizeBooleanValue(authConfig.registrationEnabled, true),
    registrationEmailVerificationRequired: normalizeBooleanValue(
      authConfig.registrationEmailVerificationRequired,
      false,
    ),
    registrationEmailDomainWhitelist: normalizeEmailDomainWhitelist(
      authConfig.registrationEmailDomainWhitelist,
      [],
    ),
    passwordResetEnabled: normalizeBooleanValue(authConfig.passwordResetEnabled, false),
    sessionTimeoutValue: normalizeSessionTimeoutValue(
      authConfig.sessionTimeoutValue,
      DEFAULT_SESSION_TIMEOUT_VALUE,
    ),
    sessionTimeoutUnit: normalizeSessionTimeoutUnit(
      authConfig.sessionTimeoutUnit,
      DEFAULT_SESSION_TIMEOUT_UNIT,
    ),
    smtpHost: normalizeOptionalHostname(smtpConfig.host, ''),
    smtpPort: normalizePort(smtpConfig.port, 587),
    smtpSecure: normalizeBooleanValue(smtpConfig.secure, false),
    smtpUsername: String(smtpConfig.username || '').trim(),
    smtpPasswordEncrypted,
    smtpPasswordConfigured: Boolean(smtpPasswordEncrypted),
    smtpFromName: String(smtpConfig.fromName || 'Mail Union').trim() || 'Mail Union',
    smtpFromEmail: normalizeOptionalEmail(smtpConfig.fromEmail, ''),
    translationProvider: normalizeTranslationProvider(row.translation_provider, 'google_free'),
    translationTargetLanguage: normalizeTranslationTargetLanguage(
      row.translation_target_language,
      'zh-CN',
    ),
    translationBaseUrl: normalizeTranslationBaseUrl(row.translation_base_url, ''),
    translationRegion: normalizeTranslationRegion(row.translation_region, ''),
    translationModel: String(row.translation_model || '').trim(),
    translationApiKeyEncrypted,
    translationApiKeyConfigured: Boolean(translationApiKeyEncrypted),
    storageProvider: normalizeStorageProvider(row.storage_provider, 'local'),
    storageSyncPolicy: normalizeStorageSyncPolicy(storageConfig.syncPolicy, 'all_local'),
    storageRemotePathPrefix: normalizeStorageRemotePathPrefix(
      storageConfig.remotePathPrefix,
      'mail-union',
    ),
    storageS3Bucket: String(storageConfig.s3Bucket || '').trim(),
    storageS3Region: String(storageConfig.s3Region || '').trim(),
    storageS3Endpoint: normalizeOptionalHttpUrl(storageConfig.s3Endpoint, ''),
    storageS3AccessKey: String(storageConfig.s3AccessKey || '').trim(),
    storageS3SecretEncrypted,
    storageS3SecretConfigured: Boolean(storageS3SecretEncrypted),
    storageS3ForcePathStyle: normalizeBooleanValue(storageConfig.s3ForcePathStyle, false),
    storageWebdavUrl: normalizeOptionalHttpUrl(storageConfig.webdavUrl, ''),
    storageWebdavUsername: String(storageConfig.webdavUsername || '').trim(),
    storageWebdavPasswordEncrypted,
    storageWebdavPasswordConfigured: Boolean(storageWebdavPasswordEncrypted),
    storageFtpHost: normalizeOptionalHostname(storageConfig.ftpHost, ''),
    storageFtpPort: normalizePort(storageConfig.ftpPort, 21),
    storageFtpSecure: normalizeBooleanValue(storageConfig.ftpSecure, false),
    storageFtpUsername: String(storageConfig.ftpUsername || '').trim(),
    storageFtpPasswordEncrypted,
    storageFtpPasswordConfigured: Boolean(storageFtpPasswordEncrypted),
    backupEnabled: normalizeBooleanValue(backupConfig.enabled, false),
    backupIntervalHours: normalizeBackupIntervalHours(backupConfig.intervalHours, 24),
    backupTarget: normalizeBackupTarget(backupConfig.target, 'local'),
    backupRetentionCount: normalizeBackupRetentionCount(backupConfig.retentionCount, 10),
    backupContentMode,
    backupIncludeRuntimeFiles: normalizeBooleanValue(backupConfig.includeRuntimeFiles, true),
    outboundProxyMode: normalizeOutboundProxyMode(proxyConfig.mode, 'system'),
    outboundProxyUrl: normalizeProxyUrl(proxyConfig.url),
    outboundProxyBypass: normalizeOutboundProxyBypass(proxyConfig.bypass),
    themePresetId: row.theme_preset_id || 'ocean-mist',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function parseMessage(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    mailboxName: row.mailbox_name,
    mailboxEmail: row.mailbox_email,
    provider: row.provider,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name ?? '',
    ownerEmail: row.owner_email ?? '',
    folderPath: row.folder_path || 'INBOX',
    folderKind: row.folder_kind || 'inbox',
    remoteUid: row.remote_uid,
    remoteId: row.remote_id || String(row.remote_uid || ''),
    remoteSource: row.remote_source || 'imap',
    messageId: row.message_id,
    subject: row.subject,
    fromName: row.from_name,
    fromAddress: row.from_address,
    to: safeParseJson(row.to_json, []),
    receivedAt: row.received_at,
    preview: row.preview || '',
    textBody: row.text_body || '',
    htmlBody: row.html_body || '',
    attachments: safeParseJson(row.attachments_json, []),
    isRead: Boolean(row.is_read),
    isStarred: Boolean(row.is_starred),
    flags: safeParseJson(row.raw_flags, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildMailboxScope(viewer, mailboxAlias = 'm') {
  const conditions = [];
  const params = [];

  if (viewer && viewer.role !== 'admin') {
    conditions.push(`${mailboxAlias}.owner_user_id = ?`);
    params.push(viewer.id);
  }

  return { conditions, params };
}

function buildMessageScope(viewer, mailboxAlias = 'mailbox') {
  const conditions = [];
  const params = [];

  if (viewer && viewer.role !== 'admin') {
    conditions.push(`${mailboxAlias}.owner_user_id = ?`);
    params.push(viewer.id);
  }

  return { conditions, params };
}

function buildMessageFilters(options = {}) {
  const {
    viewer = null,
    mailboxId = null,
    ownerUserId = null,
    query = '',
    folder = 'all',
    includeAllFolders = false,
  } = options;
  const { conditions, params } = buildMessageScope(viewer);

  if (mailboxId) {
    conditions.push('mailbox.id = ?');
    params.push(mailboxId);
  }

  if (ownerUserId) {
    conditions.push('mailbox.owner_user_id = ?');
    params.push(ownerUserId);
  }

  if (query) {
    conditions.push('(msg.subject LIKE ? OR msg.from_address LIKE ? OR msg.preview LIKE ?)');
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }

  if (folder === 'trash') {
    conditions.push(`${messageFolderKindSql()} = 'trash'`);
  } else if (folder === 'junk') {
    conditions.push(`${messageFolderKindSql()} = 'junk'`);
  } else if (!includeAllFolders) {
    conditions.push(normalMessageFolderSql());

    if (folder === 'unread') {
      conditions.push('msg.is_read = 0');
    } else if (folder === 'read') {
      conditions.push('msg.is_read = 1');
    } else if (folder === 'starred') {
      conditions.push('msg.is_starred = 1');
    }
  }

  return { conditions, params };
}

function getUserById(id) {
  return parseUser(
    db.prepare(`
      SELECT
        u.*,
        (SELECT COUNT(*) FROM mailboxes m WHERE m.owner_user_id = u.id) AS mailbox_count
      FROM users u
      WHERE u.id = ?
    `).get(id),
  );
}

function getUserByEmail(email) {
  return parseUser(
    db.prepare(`
      SELECT
        u.*,
        (SELECT COUNT(*) FROM mailboxes m WHERE m.owner_user_id = u.id) AS mailbox_count
      FROM users u
      WHERE u.email = ?
    `).get(email),
  );
}

function getUserByUsername(username) {
  return parseUser(
    db.prepare(`
      SELECT
        u.*,
        (SELECT COUNT(*) FROM mailboxes m WHERE m.owner_user_id = u.id) AS mailbox_count
      FROM users u
      WHERE u.username = ?
    `).get(username),
  );
}

function getUserAuthByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function getUserAuthByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function listUsers() {
  const rows = db.prepare(`
    SELECT
      u.*,
      (SELECT COUNT(*) FROM mailboxes m WHERE m.owner_user_id = u.id) AS mailbox_count
    FROM users u
    ORDER BY
      CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END ASC,
      u.created_at ASC
  `).all();

  return rows.map(parseUser);
}

function listNotificationTargets(userId) {
  const rows = db.prepare(`
    SELECT *
    FROM notification_targets
    WHERE user_id = ?
    ORDER BY channel ASC
  `).all(userId);

  return rows.map(parseNotificationTarget);
}

function getNotificationTarget(userId, channel) {
  return parseNotificationTarget(
    db.prepare(`
      SELECT *
      FROM notification_targets
      WHERE user_id = ? AND channel = ?
      LIMIT 1
    `).get(userId, channel),
  );
}

function upsertNotificationTarget(input) {
  const timestamp = now();
  const existing = db.prepare(`
    SELECT id, secret_encrypted
    FROM notification_targets
    WHERE user_id = ? AND channel = ?
    LIMIT 1
  `).get(input.userId, input.channel);

  const id = existing ? existing.id : randomUUID();
  const secretEncrypted =
    input.secretEncrypted !== undefined
      ? input.secretEncrypted
      : existing?.secret_encrypted || '';

  if (existing) {
    db.prepare(`
      UPDATE notification_targets
      SET
        enabled = ?,
        secret_encrypted = ?,
        config_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      input.enabled ? 1 : 0,
      secretEncrypted || null,
      JSON.stringify(input.config || {}),
      timestamp,
      id,
    );
  } else {
    db.prepare(`
      INSERT INTO notification_targets (
        id, user_id, channel, enabled, secret_encrypted, config_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.userId,
      input.channel,
      input.enabled ? 1 : 0,
      secretEncrypted || null,
      JSON.stringify(input.config || {}),
      timestamp,
      timestamp,
    );
  }

  return getNotificationTarget(input.userId, input.channel);
}

function ensureSystemSettingsRow() {
  const existing = db.prepare('SELECT id FROM system_settings WHERE id = 1').get();
  if (existing) {
    return;
  }

  const timestamp = now();
  db.prepare(`
    INSERT INTO system_settings (
      id, site_name, logo_mode, logo_url, logo_svg, logo_asset_path, microsoft_client_id, microsoft_client_secret_encrypted, microsoft_tenant_id,
      auth_config_json, smtp_config_json,
      translation_provider, translation_target_language, translation_base_url, translation_region, translation_model, translation_api_key_encrypted,
      storage_provider, storage_config_json, backup_config_json, proxy_config_json,
      theme_preset_id, created_at, updated_at
    )
    VALUES (1, 'Mail Union', 'auto', NULL, NULL, NULL, NULL, NULL, 'common', '{}', '{}', 'google_free', 'zh-CN', NULL, NULL, NULL, NULL, 'local', '{}', '{}', '{}', 'ocean-mist', ?, ?)
  `).run(timestamp, timestamp);
}

function getSystemSettings() {
  ensureSystemSettingsRow();
  return parseSystemSettings(db.prepare('SELECT * FROM system_settings WHERE id = 1').get());
}

function deleteExpiredEmailAuthCodes() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);

  db.prepare(`
    DELETE FROM email_auth_codes
    WHERE expires_at <= ? OR (consumed_at IS NOT NULL AND created_at <= ?)
  `).run(now(), cutoff.toISOString());
}

function createEmailAuthCode(input = {}) {
  deleteExpiredEmailAuthCodes();
  const id = randomUUID();
  const createdAt = now();
  db.prepare(`
    INSERT INTO email_auth_codes (
      id, purpose, email, user_id, code_hash, expires_at, consumed_at, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    id,
    String(input.purpose || '').trim(),
    normalizeEmail(input.email),
    input.userId || null,
    String(input.codeHash || '').trim(),
    String(input.expiresAt || '').trim(),
    createdAt,
  );

  return {
    id,
    purpose: String(input.purpose || '').trim(),
    email: normalizeEmail(input.email),
    userId: input.userId || null,
    codeHash: String(input.codeHash || '').trim(),
    expiresAt: String(input.expiresAt || '').trim(),
    consumedAt: null,
    createdAt,
  };
}

function getLatestEmailAuthCode(email, purpose) {
  deleteExpiredEmailAuthCodes();
  return db.prepare(`
    SELECT *
    FROM email_auth_codes
    WHERE email = ? AND purpose = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(normalizeEmail(email), String(purpose || '').trim());
}

function consumeEmailAuthCode(input = {}) {
  deleteExpiredEmailAuthCodes();
  const email = normalizeEmail(input.email);
  const purpose = String(input.purpose || '').trim();
  const userId = String(input.userId || '').trim();
  const codeHash = String(input.codeHash || '').trim();
  const currentTime = now();
  const statement = userId
    ? db.prepare(`
        SELECT *
        FROM email_auth_codes
        WHERE email = ? AND purpose = ? AND user_id = ? AND code_hash = ? AND consumed_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 1
      `)
    : db.prepare(`
        SELECT *
        FROM email_auth_codes
        WHERE email = ? AND purpose = ? AND code_hash = ? AND consumed_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 1
      `);
  const row = userId
    ? statement.get(email, purpose, userId, codeHash, currentTime)
    : statement.get(email, purpose, codeHash, currentTime);

  if (!row) {
    return null;
  }

  db.prepare('UPDATE email_auth_codes SET consumed_at = ? WHERE id = ?').run(currentTime, row.id);
  return {
    ...row,
    consumed_at: currentTime,
  };
}

function updateSystemSettings(input = {}) {
  ensureSystemSettingsRow();
  const existing = getSystemSettings();
  const siteName = String(input.siteName ?? existing.siteName ?? 'Mail Union').trim() || 'Mail Union';
  const logoMode = normalizeSystemLogoMode(input.logoMode, existing.logoMode);
  const logoUrl =
    input.logoUrl !== undefined ? String(input.logoUrl || '').trim() : String(existing.logoUrl || '');
  const logoAssetPath =
    input.logoAssetPath !== undefined
      ? String(input.logoAssetPath || '').trim()
      : String(existing.logoAssetPath || '').trim();
  const googleClientId =
    input.googleClientId !== undefined
      ? normalizeGoogleClientId(input.googleClientId)
      : normalizeGoogleClientId(existing.googleClientId || '');
  const clearGoogleClientSecret = Boolean(input.clearGoogleClientSecret);
  const googleClientSecretEncrypted =
    input.googleClientSecret !== undefined
      ? String(input.googleClientSecret || '').trim()
        ? encrypt(String(input.googleClientSecret || '').trim())
        : clearGoogleClientSecret
          ? ''
          : String(existing.googleClientSecretEncrypted || '').trim()
      : clearGoogleClientSecret
        ? ''
        : String(existing.googleClientSecretEncrypted || '').trim();
  const microsoftClientId =
    input.microsoftClientId !== undefined
      ? String(input.microsoftClientId || '').trim()
      : String(existing.microsoftClientId || '').trim();
  const clearMicrosoftClientSecret = Boolean(input.clearMicrosoftClientSecret);
  const microsoftClientSecretEncrypted =
    input.microsoftClientSecret !== undefined
      ? String(input.microsoftClientSecret || '').trim()
        ? encrypt(String(input.microsoftClientSecret || '').trim())
        : clearMicrosoftClientSecret
          ? ''
          : String(existing.microsoftClientSecretEncrypted || '').trim()
      : clearMicrosoftClientSecret
        ? ''
        : String(existing.microsoftClientSecretEncrypted || '').trim();
  const microsoftTenantId =
    String(input.microsoftTenantId ?? existing.microsoftTenantId ?? 'common').trim() || 'common';
  const registrationEnabled =
    input.registrationEnabled !== undefined
      ? normalizeBooleanValue(input.registrationEnabled, true)
      : normalizeBooleanValue(existing.registrationEnabled, true);
  const registrationEmailVerificationRequired =
    input.registrationEmailVerificationRequired !== undefined
      ? normalizeBooleanValue(input.registrationEmailVerificationRequired, false)
      : normalizeBooleanValue(existing.registrationEmailVerificationRequired, false);
  const registrationEmailDomainWhitelist =
    input.registrationEmailDomainWhitelist !== undefined
      ? normalizeEmailDomainWhitelist(input.registrationEmailDomainWhitelist, [])
      : normalizeEmailDomainWhitelist(existing.registrationEmailDomainWhitelist, []);
  const passwordResetEnabled =
    input.passwordResetEnabled !== undefined
      ? normalizeBooleanValue(input.passwordResetEnabled, false)
      : normalizeBooleanValue(existing.passwordResetEnabled, false);
  const sessionTimeoutValue =
    input.sessionTimeoutValue !== undefined
      ? normalizeSessionTimeoutValue(input.sessionTimeoutValue, existing.sessionTimeoutValue)
      : normalizeSessionTimeoutValue(existing.sessionTimeoutValue, DEFAULT_SESSION_TIMEOUT_VALUE);
  const sessionTimeoutUnit =
    input.sessionTimeoutUnit !== undefined
      ? normalizeSessionTimeoutUnit(input.sessionTimeoutUnit, existing.sessionTimeoutUnit)
      : normalizeSessionTimeoutUnit(existing.sessionTimeoutUnit, DEFAULT_SESSION_TIMEOUT_UNIT);
  const authConfigJson = JSON.stringify({
    registrationEnabled,
    registrationEmailVerificationRequired,
    registrationEmailDomainWhitelist,
    passwordResetEnabled,
    sessionTimeoutValue,
    sessionTimeoutUnit,
  });
  const smtpHost =
    input.smtpHost !== undefined
      ? normalizeOptionalHostname(input.smtpHost)
      : normalizeOptionalHostname(existing.smtpHost);
  const smtpPort =
    input.smtpPort !== undefined
      ? normalizePort(input.smtpPort, 587)
      : normalizePort(existing.smtpPort, 587);
  const smtpSecure =
    input.smtpSecure !== undefined
      ? normalizeBooleanValue(input.smtpSecure, false)
      : normalizeBooleanValue(existing.smtpSecure, false);
  const smtpUsername =
    input.smtpUsername !== undefined
      ? String(input.smtpUsername || '').trim()
      : String(existing.smtpUsername || '').trim();
  const clearSmtpPassword = normalizeBooleanValue(input.clearSmtpPassword, false);
  const smtpPasswordEncrypted =
    input.smtpPassword !== undefined
      ? String(input.smtpPassword || '').trim()
        ? encrypt(String(input.smtpPassword || '').trim())
        : clearSmtpPassword
          ? ''
          : String(existing.smtpPasswordEncrypted || '').trim()
      : clearSmtpPassword
        ? ''
        : String(existing.smtpPasswordEncrypted || '').trim();
  const smtpFromName =
    input.smtpFromName !== undefined
      ? String(input.smtpFromName || '').trim() || 'Mail Union'
      : String(existing.smtpFromName || 'Mail Union').trim() || 'Mail Union';
  const smtpFromEmail =
    input.smtpFromEmail !== undefined
      ? normalizeOptionalEmail(input.smtpFromEmail)
      : normalizeOptionalEmail(existing.smtpFromEmail);
  const smtpConfigJson = JSON.stringify({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    username: smtpUsername,
    passwordEncrypted: smtpPasswordEncrypted,
    fromName: smtpFromName,
    fromEmail: smtpFromEmail,
  });
  const translationProvider = normalizeTranslationProvider(
    input.translationProvider,
    existing.translationProvider,
  );
  const translationTargetLanguage = normalizeTranslationTargetLanguage(
    input.translationTargetLanguage,
    existing.translationTargetLanguage,
  );
  const translationBaseUrl =
    input.translationBaseUrl !== undefined
      ? normalizeTranslationBaseUrl(input.translationBaseUrl)
      : normalizeTranslationBaseUrl(existing.translationBaseUrl);
  const translationRegion =
    input.translationRegion !== undefined
      ? normalizeTranslationRegion(input.translationRegion)
      : normalizeTranslationRegion(existing.translationRegion);
  const translationModel =
    input.translationModel !== undefined
      ? String(input.translationModel || '').trim()
      : String(existing.translationModel || '').trim();
  const clearTranslationApiKey = Boolean(input.clearTranslationApiKey);
  const translationProviderChanged =
    translationProvider !== normalizeTranslationProvider(existing.translationProvider, 'google_free');
  const translationApiKeyEncrypted =
    input.translationApiKey !== undefined
      ? String(input.translationApiKey || '').trim()
        ? encrypt(String(input.translationApiKey || '').trim())
        : clearTranslationApiKey || translationProviderChanged
          ? ''
          : String(existing.translationApiKeyEncrypted || '').trim()
      : clearTranslationApiKey || translationProviderChanged
        ? ''
        : String(existing.translationApiKeyEncrypted || '').trim();
  const storageProvider = normalizeStorageProvider(input.storageProvider, existing.storageProvider);
  const storageSyncPolicy = normalizeStorageSyncPolicy(
    input.storageSyncPolicy,
    existing.storageSyncPolicy,
  );
  const storageRemotePathPrefix =
    input.storageRemotePathPrefix !== undefined
      ? normalizeStorageRemotePathPrefix(input.storageRemotePathPrefix, 'mail-union')
      : normalizeStorageRemotePathPrefix(existing.storageRemotePathPrefix, 'mail-union');
  const storageS3Bucket =
    input.storageS3Bucket !== undefined
      ? String(input.storageS3Bucket || '').trim()
      : String(existing.storageS3Bucket || '').trim();
  const storageS3Region =
    input.storageS3Region !== undefined
      ? String(input.storageS3Region || '').trim()
      : String(existing.storageS3Region || '').trim();
  const storageS3Endpoint =
    input.storageS3Endpoint !== undefined
      ? normalizeOptionalHttpUrl(input.storageS3Endpoint)
      : normalizeOptionalHttpUrl(existing.storageS3Endpoint);
  const storageS3AccessKey =
    input.storageS3AccessKey !== undefined
      ? String(input.storageS3AccessKey || '').trim()
      : String(existing.storageS3AccessKey || '').trim();
  const clearStorageS3Secret = normalizeBooleanValue(input.clearStorageS3Secret, false);
  const storageS3SecretEncrypted =
    input.storageS3Secret !== undefined
      ? String(input.storageS3Secret || '').trim()
        ? encrypt(String(input.storageS3Secret || '').trim())
        : clearStorageS3Secret
          ? ''
          : String(existing.storageS3SecretEncrypted || '').trim()
      : clearStorageS3Secret
        ? ''
        : String(existing.storageS3SecretEncrypted || '').trim();
  const storageS3ForcePathStyle =
    input.storageS3ForcePathStyle !== undefined
      ? normalizeBooleanValue(input.storageS3ForcePathStyle, false)
      : normalizeBooleanValue(existing.storageS3ForcePathStyle, false);
  const storageWebdavUrl =
    input.storageWebdavUrl !== undefined
      ? normalizeOptionalHttpUrl(input.storageWebdavUrl)
      : normalizeOptionalHttpUrl(existing.storageWebdavUrl);
  const storageWebdavUsername =
    input.storageWebdavUsername !== undefined
      ? String(input.storageWebdavUsername || '').trim()
      : String(existing.storageWebdavUsername || '').trim();
  const clearStorageWebdavPassword = normalizeBooleanValue(input.clearStorageWebdavPassword, false);
  const storageWebdavPasswordEncrypted =
    input.storageWebdavPassword !== undefined
      ? String(input.storageWebdavPassword || '').trim()
        ? encrypt(String(input.storageWebdavPassword || '').trim())
        : clearStorageWebdavPassword
          ? ''
          : String(existing.storageWebdavPasswordEncrypted || '').trim()
      : clearStorageWebdavPassword
        ? ''
        : String(existing.storageWebdavPasswordEncrypted || '').trim();
  const storageFtpHost =
    input.storageFtpHost !== undefined
      ? normalizeOptionalHostname(input.storageFtpHost)
      : normalizeOptionalHostname(existing.storageFtpHost);
  const storageFtpPort =
    input.storageFtpPort !== undefined
      ? normalizePort(input.storageFtpPort, 21)
      : normalizePort(existing.storageFtpPort, 21);
  const storageFtpSecure =
    input.storageFtpSecure !== undefined
      ? normalizeBooleanValue(input.storageFtpSecure, false)
      : normalizeBooleanValue(existing.storageFtpSecure, false);
  const storageFtpUsername =
    input.storageFtpUsername !== undefined
      ? String(input.storageFtpUsername || '').trim()
      : String(existing.storageFtpUsername || '').trim();
  const clearStorageFtpPassword = normalizeBooleanValue(input.clearStorageFtpPassword, false);
  const storageFtpPasswordEncrypted =
    input.storageFtpPassword !== undefined
      ? String(input.storageFtpPassword || '').trim()
        ? encrypt(String(input.storageFtpPassword || '').trim())
        : clearStorageFtpPassword
          ? ''
          : String(existing.storageFtpPasswordEncrypted || '').trim()
      : clearStorageFtpPassword
        ? ''
        : String(existing.storageFtpPasswordEncrypted || '').trim();
  const storageConfigJson = JSON.stringify({
    syncPolicy: storageSyncPolicy,
    remotePathPrefix: storageRemotePathPrefix,
    s3Bucket: storageS3Bucket,
    s3Region: storageS3Region,
    s3Endpoint: storageS3Endpoint,
    s3AccessKey: storageS3AccessKey,
    s3SecretEncrypted: storageS3SecretEncrypted,
    s3ForcePathStyle: storageS3ForcePathStyle,
    webdavUrl: storageWebdavUrl,
    webdavUsername: storageWebdavUsername,
    webdavPasswordEncrypted: storageWebdavPasswordEncrypted,
    ftpHost: storageFtpHost,
    ftpPort: storageFtpPort,
    ftpSecure: storageFtpSecure,
    ftpUsername: storageFtpUsername,
    ftpPasswordEncrypted: storageFtpPasswordEncrypted,
  });
  const backupEnabled =
    input.backupEnabled !== undefined
      ? normalizeBooleanValue(input.backupEnabled, false)
      : normalizeBooleanValue(existing.backupEnabled, false);
  const backupIntervalHours =
    input.backupIntervalHours !== undefined
      ? normalizeBackupIntervalHours(input.backupIntervalHours, 24)
      : normalizeBackupIntervalHours(existing.backupIntervalHours, 24);
  const backupTarget =
    input.backupTarget !== undefined
      ? normalizeBackupTarget(input.backupTarget, existing.backupTarget)
      : normalizeBackupTarget(existing.backupTarget, 'local');
  const backupRetentionCount =
    input.backupRetentionCount !== undefined
      ? normalizeBackupRetentionCount(input.backupRetentionCount, 10)
      : normalizeBackupRetentionCount(existing.backupRetentionCount, 10);
  const backupContentMode =
    input.backupContentMode !== undefined
      ? normalizeBackupContentMode(input.backupContentMode, existing.backupContentMode || 'database_and_site')
      : normalizeBackupContentMode(existing.backupContentMode, 'database_and_site');
  const backupIncludeRuntimeFiles =
    input.backupIncludeRuntimeFiles !== undefined
      ? normalizeBooleanValue(input.backupIncludeRuntimeFiles, true)
      : backupContentMode !== 'database_only';
  const backupConfigJson = JSON.stringify({
    enabled: backupEnabled,
    intervalHours: backupIntervalHours,
    target: backupTarget,
    retentionCount: backupRetentionCount,
    contentMode: backupContentMode,
    includeRuntimeFiles: backupIncludeRuntimeFiles,
  });
  const outboundProxyMode =
    input.outboundProxyMode !== undefined
      ? normalizeOutboundProxyMode(input.outboundProxyMode, 'system')
      : normalizeOutboundProxyMode(existing.outboundProxyMode, 'system');
  const outboundProxyUrl =
    input.outboundProxyUrl !== undefined
      ? normalizeProxyUrl(input.outboundProxyUrl)
      : normalizeProxyUrl(existing.outboundProxyUrl);
  const outboundProxyBypass =
    input.outboundProxyBypass !== undefined
      ? normalizeOutboundProxyBypass(input.outboundProxyBypass)
      : normalizeOutboundProxyBypass(existing.outboundProxyBypass);
  if (outboundProxyMode === 'custom' && !outboundProxyUrl) {
    throw new Error('自定义代理模式下必须填写代理地址（Proxy URL）。');
  }
  const proxyConfigJson = JSON.stringify({
    mode: outboundProxyMode,
    url: outboundProxyUrl,
    bypass: outboundProxyBypass,
  });
  const themePresetId =
    String(input.themePresetId ?? existing.themePresetId ?? 'ocean-mist').trim() || 'ocean-mist';

  db.prepare(`
    UPDATE system_settings
    SET
      site_name = ?,
      logo_mode = ?,
      logo_url = ?,
      logo_asset_path = ?,
      google_client_id = ?,
      google_client_secret_encrypted = ?,
      microsoft_client_id = ?,
      microsoft_client_secret_encrypted = ?,
      microsoft_tenant_id = ?,
      auth_config_json = ?,
      smtp_config_json = ?,
      translation_provider = ?,
      translation_target_language = ?,
      translation_base_url = ?,
      translation_region = ?,
      translation_model = ?,
      translation_api_key_encrypted = ?,
      storage_provider = ?,
      storage_config_json = ?,
      backup_config_json = ?,
      proxy_config_json = ?,
      theme_preset_id = ?,
      updated_at = ?
    WHERE id = 1
  `).run(
    siteName,
    logoMode,
    logoUrl || null,
    logoAssetPath || null,
    googleClientId || null,
    googleClientSecretEncrypted || null,
    microsoftClientId || null,
    microsoftClientSecretEncrypted || null,
    microsoftTenantId,
    authConfigJson,
    smtpConfigJson,
    translationProvider,
    translationTargetLanguage,
    translationBaseUrl || null,
    translationRegion || null,
    translationModel || null,
    translationApiKeyEncrypted || null,
    storageProvider,
    storageConfigJson,
    backupConfigJson,
    proxyConfigJson,
    themePresetId,
    now(),
  );

  return getSystemSettings();
}

function parseBackupRecord(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    filename: row.filename || '',
    status: row.status || 'pending',
    triggerSource: row.trigger_source || 'manual',
    destination: row.destination || 'local',
    localPath: row.local_path || '',
    remotePath: row.remote_path || '',
    sizeBytes: Number(row.size_bytes || 0),
    sha256: row.sha256 || '',
    error: row.error || '',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function createBackupRecord(input = {}) {
  const timestamp = now();
  const id = String(input.id || randomUUID()).trim() || randomUUID();
  db.prepare(`
    INSERT INTO backups (
      id, filename, status, trigger_source, destination, local_path, remote_path, size_bytes, sha256, error, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    String(input.filename || 'backup.zip').trim() || 'backup.zip',
    String(input.status || 'pending').trim() || 'pending',
    String(input.triggerSource || 'manual').trim() || 'manual',
    normalizeBackupTarget(input.destination, 'local'),
    String(input.localPath || '').trim() || null,
    String(input.remotePath || '').trim() || null,
    Number(input.sizeBytes || 0),
    String(input.sha256 || '').trim() || null,
    String(input.error || '').trim() || null,
    timestamp,
    timestamp,
  );

  return getBackupRecordById(id);
}

function getBackupRecordById(id) {
  return parseBackupRecord(db.prepare('SELECT * FROM backups WHERE id = ? LIMIT 1').get(id));
}

function listBackupRecords(limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return db
    .prepare(`
      SELECT *
      FROM backups
      ORDER BY datetime(created_at) DESC, rowid DESC
      LIMIT ?
    `)
    .all(safeLimit)
    .map(parseBackupRecord);
}

function updateBackupRecord(id, input = {}) {
  const existing = getBackupRecordById(id);
  if (!existing) {
    return null;
  }

  const updated = {
    filename:
      input.filename !== undefined
        ? String(input.filename || '').trim() || existing.filename
        : existing.filename,
    status:
      input.status !== undefined ? String(input.status || '').trim() || existing.status : existing.status,
    triggerSource:
      input.triggerSource !== undefined
        ? String(input.triggerSource || '').trim() || existing.triggerSource
        : existing.triggerSource,
    destination:
      input.destination !== undefined
        ? normalizeBackupTarget(input.destination, existing.destination)
        : existing.destination,
    localPath:
      input.localPath !== undefined ? String(input.localPath || '').trim() : existing.localPath,
    remotePath:
      input.remotePath !== undefined ? String(input.remotePath || '').trim() : existing.remotePath,
    sizeBytes:
      input.sizeBytes !== undefined ? Number(input.sizeBytes || 0) : Number(existing.sizeBytes || 0),
    sha256: input.sha256 !== undefined ? String(input.sha256 || '').trim() : existing.sha256,
    error: input.error !== undefined ? String(input.error || '').trim() : existing.error,
  };

  db.prepare(`
    UPDATE backups
    SET
      filename = ?,
      status = ?,
      trigger_source = ?,
      destination = ?,
      local_path = ?,
      remote_path = ?,
      size_bytes = ?,
      sha256 = ?,
      error = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    updated.filename,
    updated.status,
    updated.triggerSource,
    updated.destination,
    updated.localPath || null,
    updated.remotePath || null,
    updated.sizeBytes,
    updated.sha256 || null,
    updated.error || null,
    now(),
    id,
  );

  return getBackupRecordById(id);
}

function deleteBackupRecord(id) {
  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
}

function createUser(input) {
  const timestamp = now();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO users (
      id, name, username, email, avatar_url, password_hash, role, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.username,
    input.email,
    input.avatarUrl || null,
    input.passwordHash,
    input.role || 'user',
    input.status || 'active',
    timestamp,
    timestamp,
  );

  return getUserById(id);
}

function updateUser(userId, input) {
  const fields = [];
  const params = [];

  if (input.name !== undefined) {
    fields.push('name = ?');
    params.push(input.name);
  }
  if (input.username !== undefined) {
    fields.push('username = ?');
    params.push(input.username);
  }
  if (input.email !== undefined) {
    fields.push('email = ?');
    params.push(input.email);
  }
  if (input.avatarUrl !== undefined) {
    fields.push('avatar_url = ?');
    params.push(input.avatarUrl || null);
  }
  if (input.passwordHash !== undefined) {
    fields.push('password_hash = ?');
    params.push(input.passwordHash);
  }
  if (input.role !== undefined) {
    fields.push('role = ?');
    params.push(input.role);
  }
  if (input.status !== undefined) {
    fields.push('status = ?');
    params.push(input.status);
  }

  if (!fields.length) {
    return getUserById(userId);
  }

  fields.push('updated_at = ?');
  params.push(now(), userId);

  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getUserById(userId);
}

function markUserLoggedIn(userId) {
  db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(
    now(),
    now(),
    userId,
  );
}

function bootstrapAdmin(input) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (count > 0) {
    const existingAdmin =
      db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").get() ||
      db.prepare('SELECT * FROM users WHERE email = ? LIMIT 1').get(input.email);

    if (existingAdmin) {
      const adminUpdates = {};
      if (!existingAdmin.name) {
        adminUpdates.name = input.name;
      }
      if (!existingAdmin.username || existingAdmin.username !== input.username) {
        adminUpdates.username = input.username;
      }
      if (!existingAdmin.email) {
        adminUpdates.email = input.email;
      }
      if (input.avatarUrl && existingAdmin.avatar_url !== input.avatarUrl) {
        adminUpdates.avatarUrl = input.avatarUrl;
      }
      if (existingAdmin.status !== 'active') {
        adminUpdates.status = 'active';
      }
      if (existingAdmin.role !== 'admin') {
        adminUpdates.role = 'admin';
      }
      if (input.resetPassword) {
        adminUpdates.passwordHash = input.passwordHash;
      }
      if (Object.keys(adminUpdates).length) {
        updateUser(existingAdmin.id, adminUpdates);
      }
      assignMailboxOwnership(existingAdmin.id);
      return { created: false, user: getUserById(existingAdmin.id) };
    }
  }

  const created = createUser({
    name: input.name,
    username: input.username,
    email: input.email,
    avatarUrl: input.avatarUrl || '',
    passwordHash: input.passwordHash,
    role: 'admin',
    status: 'active',
  });
  assignMailboxOwnership(created.id);
  return { created: true, user: created };
}

function assignMailboxOwnership(userId) {
  db.prepare('UPDATE mailboxes SET owner_user_id = ? WHERE owner_user_id IS NULL').run(userId);
}

function createSession(input) {
  cleanupExpiredSessions();
  const timestamp = now();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO sessions (
      id, user_id, token_hash, user_agent, expires_at, created_at, last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.userId,
    hashToken(input.token),
    input.userAgent || '',
    input.expiresAt,
    timestamp,
    timestamp,
  );
}

function getSessionUserByToken(token) {
  cleanupExpiredSessions();
  const row = db.prepare(`
    SELECT
      sessions.id AS session_id,
      sessions.user_id AS session_user_id,
      sessions.expires_at AS session_expires_at,
      users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.status = 'active'
  `).get(hashToken(token), now());

  if (!row) {
    return null;
  }

  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now(), row.session_id);
  return {
    sessionId: row.session_id,
    user: parseUser(row),
  };
}

function deleteSessionByToken(token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

function listMailboxes(options = {}) {
  const { viewer = null, ownerUserId = null, limit = 200, order = 'display' } = options;
  const { conditions, params } = buildMailboxScope(viewer);

  if (ownerUserId) {
    conditions.push('m.owner_user_id = ?');
    params.push(ownerUserId);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      m.*,
      owner.name AS owner_name,
      owner.email AS owner_email,
      (SELECT COUNT(*) FROM messages msg WHERE msg.mailbox_id = m.id AND ${normalMessageFolderSql()}) AS message_count,
      (SELECT COUNT(*) FROM messages msg WHERE msg.mailbox_id = m.id AND ${normalMessageFolderSql()} AND msg.is_read = 0) AS unread_count,
      (SELECT COUNT(*) FROM messages msg WHERE msg.mailbox_id = m.id AND ${messageFolderKindSql()} = 'trash') AS trash_count,
      (SELECT COUNT(*) FROM messages msg WHERE msg.mailbox_id = m.id AND ${messageFolderKindSql()} = 'junk') AS junk_count,
      (SELECT MAX(received_at) FROM messages msg WHERE msg.mailbox_id = m.id) AS latest_message_at
    FROM mailboxes m
    LEFT JOIN users owner ON owner.id = m.owner_user_id
    ${whereClause}
    ORDER BY ${order === 'recent' ? mailboxRecentOrderSql('m') : mailboxDisplayOrderSql('m')}
    LIMIT ?
  `).all(...params, Math.min(Math.max(Number(limit) || 200, 1), 5000));

  return rows.map(parseMailbox);
}

function listMailboxesForSync() {
  const rows = db.prepare(`
    SELECT m.*
    FROM mailboxes m
    LEFT JOIN users owner ON owner.id = m.owner_user_id
    WHERE owner.status IS NULL OR owner.status = 'active'
    ORDER BY ${mailboxDisplayOrderSql('m')}
  `).all();

  return rows.map(parseMailbox);
}

function getMailboxById(id, viewer = null) {
  const { conditions, params } = buildMailboxScope(viewer);
  conditions.unshift('m.id = ?');
  params.unshift(id);
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const row = db.prepare(`
    SELECT
      m.*,
      owner.name AS owner_name,
      owner.email AS owner_email,
      (SELECT COUNT(*) FROM messages msg WHERE msg.mailbox_id = m.id AND ${normalMessageFolderSql()}) AS message_count,
      (SELECT COUNT(*) FROM messages msg WHERE msg.mailbox_id = m.id AND ${normalMessageFolderSql()} AND msg.is_read = 0) AS unread_count,
      (SELECT COUNT(*) FROM messages msg WHERE msg.mailbox_id = m.id AND ${messageFolderKindSql()} = 'trash') AS trash_count,
      (SELECT COUNT(*) FROM messages msg WHERE msg.mailbox_id = m.id AND ${messageFolderKindSql()} = 'junk') AS junk_count,
      (SELECT MAX(received_at) FROM messages msg WHERE msg.mailbox_id = m.id) AS latest_message_at
    FROM mailboxes m
    LEFT JOIN users owner ON owner.id = m.owner_user_id
    ${whereClause}
    LIMIT 1
  `).get(...params);

  return parseMailbox(row);
}

function upsertMailbox(input) {
  const timestamp = now();
  const existing = db.prepare('SELECT * FROM mailboxes WHERE email = ?').get(input.email);
  const authType = String(input.authType || 'password').trim() || 'password';
  const oauthJson = JSON.stringify(input.oauth || {});
  const sortOrder = normalizeMailboxSortOrder(input.sortOrder, existing?.sort_order ?? 100);
  const isPinned = input.isPinned === undefined ? Boolean(existing?.is_pinned) : Boolean(input.isPinned);
  const syncAttachments =
    input.syncAttachments === undefined
      ? existing?.sync_attachments === undefined
        ? true
        : Boolean(existing?.sync_attachments)
      : Boolean(input.syncAttachments);

  if (existing && existing.owner_user_id && existing.owner_user_id !== input.ownerUserId) {
    throw new Error('这个邮箱已经被其他账户接入了。');
  }

  const id = existing ? existing.id : randomUUID();
  if (existing) {
    db.prepare(`
      UPDATE mailboxes
      SET
        owner_user_id = ?,
        name = ?,
        provider = ?,
        username = ?,
        password_encrypted = ?,
        auth_type = ?,
        oauth_json = ?,
        imap_host = ?,
        imap_port = ?,
        secure = ?,
        sync_attachments = ?,
        sync_interval_seconds = ?,
        sort_order = ?,
        is_pinned = ?,
        last_error = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(
      input.ownerUserId,
      input.name,
      input.provider,
      input.username,
      input.passwordEncrypted,
      authType,
      oauthJson,
      input.imapHost,
      input.imapPort,
      input.secure ? 1 : 0,
      syncAttachments ? 1 : 0,
      input.syncIntervalSeconds,
      sortOrder,
      isPinned ? 1 : 0,
      timestamp,
      id,
    );
  } else {
    db.prepare(`
      INSERT INTO mailboxes (
        id, owner_user_id, name, provider, email, username, password_encrypted, auth_type, oauth_json,
        imap_host, imap_port, secure, sync_attachments, sync_interval_seconds, sort_order, is_pinned, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.ownerUserId,
      input.name,
      input.provider,
      input.email,
      input.username,
      input.passwordEncrypted,
      authType,
      oauthJson,
      input.imapHost,
      input.imapPort,
      input.secure ? 1 : 0,
      syncAttachments ? 1 : 0,
      input.syncIntervalSeconds,
      sortOrder,
      isPinned ? 1 : 0,
      timestamp,
      timestamp,
    );
  }

  return getMailboxById(id);
}

function createMailbox(input) {
  const existing = db.prepare('SELECT * FROM mailboxes WHERE email = ?').get(input.email);

  if (existing) {
    if (existing.owner_user_id && existing.owner_user_id !== input.ownerUserId) {
      throw new Error('这个邮箱已经被其他账户接入了。');
    }

    throw new Error('这个邮箱已经存在，请直接编辑已有配置。');
  }

  return upsertMailbox(input);
}

function updateMailbox(mailboxId, input) {
  const existing = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailboxId);
  if (!existing) {
    throw new Error('邮箱账户不存在。');
  }
  const authType = String(input.authType || 'password').trim() || 'password';
  const oauthJson = JSON.stringify(input.oauth || {});

  const emailConflict = db
    .prepare('SELECT id, owner_user_id FROM mailboxes WHERE email = ? AND id != ?')
    .get(input.email, mailboxId);

  if (emailConflict) {
    if (emailConflict.owner_user_id && emailConflict.owner_user_id !== input.ownerUserId) {
      throw new Error('这个邮箱已经被其他账户接入了。');
    }

    throw new Error('这个邮箱地址已被其他配置使用。');
  }

  const sortOrder = normalizeMailboxSortOrder(input.sortOrder, existing.sort_order ?? 100);
  const isPinned = input.isPinned === undefined ? Boolean(existing.is_pinned) : Boolean(input.isPinned);
  const syncAttachments =
    input.syncAttachments === undefined ? Boolean(existing.sync_attachments) : Boolean(input.syncAttachments);

  db.prepare(`
    UPDATE mailboxes
    SET
      owner_user_id = ?,
      name = ?,
      provider = ?,
      email = ?,
      username = ?,
      password_encrypted = ?,
      auth_type = ?,
      oauth_json = ?,
      imap_host = ?,
      imap_port = ?,
      secure = ?,
      sync_attachments = ?,
      sync_interval_seconds = ?,
      sort_order = ?,
      is_pinned = ?,
      last_error = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(
    input.ownerUserId,
    input.name,
    input.provider,
    input.email,
    input.username,
    input.passwordEncrypted,
    authType,
    oauthJson,
    input.imapHost,
    input.imapPort,
    input.secure ? 1 : 0,
    syncAttachments ? 1 : 0,
    input.syncIntervalSeconds,
    sortOrder,
    isPinned ? 1 : 0,
    now(),
    mailboxId,
  );

  return getMailboxById(mailboxId);
}

function updateMailboxOAuthState(mailboxId, oauth, authType = 'gmail_oauth') {
  db.prepare(`
    UPDATE mailboxes
    SET auth_type = ?, oauth_json = ?, updated_at = ?
    WHERE id = ?
  `).run(authType, JSON.stringify(oauth || {}), now(), mailboxId);

  return getMailboxById(mailboxId);
}

function updateMailboxSyncInterval(mailboxId, syncIntervalSeconds) {
  db.prepare(`
    UPDATE mailboxes
    SET sync_interval_seconds = ?, updated_at = ?
    WHERE id = ?
  `).run(syncIntervalSeconds, now(), mailboxId);

  return getMailboxById(mailboxId);
}

function updateMailboxDisplay(mailboxId, input = {}) {
  const existing = db.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailboxId);
  if (!existing) {
    throw new Error('邮箱账户不存在。');
  }

  const sortOrder = normalizeMailboxSortOrder(input.sortOrder, existing.sort_order ?? 100);
  const isPinned = input.isPinned === undefined ? Boolean(existing.is_pinned) : Boolean(input.isPinned);

  db.prepare(`
    UPDATE mailboxes
    SET sort_order = ?, is_pinned = ?, updated_at = ?
    WHERE id = ?
  `).run(sortOrder, isPinned ? 1 : 0, now(), mailboxId);

  return getMailboxById(mailboxId);
}

function updateMailboxSortOrders(entries = []) {
  const normalizedEntries = (entries || [])
    .map((entry) => ({
      id: String(entry?.id || '').trim(),
      sortOrder: normalizeMailboxSortOrder(entry?.sortOrder, 100),
    }))
    .filter((entry) => entry.id);

  if (!normalizedEntries.length) {
    return [];
  }

  const timestamp = now();
  const statement = db.prepare(`
    UPDATE mailboxes
    SET sort_order = ?, updated_at = ?
    WHERE id = ?
  `);

  for (const item of normalizedEntries) {
    statement.run(item.sortOrder, timestamp, item.id);
  }
  return normalizedEntries.map((entry) => getMailboxById(entry.id)).filter(Boolean);
}

function markMailboxSyncStart(mailboxId) {
  db.prepare(`
    UPDATE mailboxes
    SET status = 'syncing', last_error = NULL, updated_at = ?
    WHERE id = ?
  `).run(now(), mailboxId);
}

function markMailboxSyncSuccess(mailboxId, result) {
  db.prepare(`
    UPDATE mailboxes
    SET
      status = 'idle',
      last_uid = ?,
      uid_validity = ?,
      last_synced_at = ?,
      last_error = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(
    result.lastUid ?? 0,
    result.uidValidity ?? null,
    result.syncedAt ?? now(),
    now(),
    mailboxId,
  );
}

function markMailboxSyncError(mailboxId, error) {
  db.prepare(`
    UPDATE mailboxes
    SET status = 'error', last_error = ?, updated_at = ?
    WHERE id = ?
  `).run(String(error.message || error), now(), mailboxId);
}

function clearMailboxMessages(mailboxId) {
  db.prepare('DELETE FROM messages WHERE mailbox_id = ?').run(mailboxId);
  db.prepare('DELETE FROM mailbox_sync_state WHERE mailbox_id = ?').run(mailboxId);
  db.prepare(`
    UPDATE mailboxes
    SET last_uid = 0, uid_validity = NULL, last_synced_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(now(), mailboxId);
}

function clearMailboxFolderMessages(mailboxId, folderPath) {
  db.prepare('DELETE FROM messages WHERE mailbox_id = ? AND folder_path = ?').run(mailboxId, folderPath);
  db.prepare('DELETE FROM mailbox_sync_state WHERE mailbox_id = ? AND folder_path = ?').run(mailboxId, folderPath);
}

function getMailboxSyncState(mailboxId, folderPath) {
  return parseMailboxSyncState(
    db.prepare(`
      SELECT *
      FROM mailbox_sync_state
      WHERE mailbox_id = ? AND folder_path = ?
      LIMIT 1
    `).get(mailboxId, folderPath),
  );
}

function upsertMailboxSyncState(input) {
  const timestamp = now();
  db.prepare(`
    INSERT INTO mailbox_sync_state (
      mailbox_id, folder_path, folder_kind, last_uid, uid_validity, last_exists, last_synced_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mailbox_id, folder_path)
    DO UPDATE SET
      folder_kind = excluded.folder_kind,
      last_uid = excluded.last_uid,
      uid_validity = excluded.uid_validity,
      last_exists = excluded.last_exists,
      last_synced_at = excluded.last_synced_at,
      updated_at = excluded.updated_at
  `).run(
    input.mailboxId,
    input.folderPath,
    input.folderKind || 'inbox',
    Number(input.lastUid || 0),
    input.uidValidity ?? null,
    Math.max(Number(input.lastExists || 0), 0),
    input.lastSyncedAt || timestamp,
    timestamp,
    timestamp,
  );

  return getMailboxSyncState(input.mailboxId, input.folderPath);
}

function pruneFolderMessages(mailboxId, folderPath, remoteUids = []) {
  const keepSet = new Set(
    (remoteUids || [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0),
  );
  const localRows = db.prepare(`
    SELECT id, remote_uid
    FROM messages
    WHERE mailbox_id = ? AND folder_path = ?
  `).all(mailboxId, folderPath);
  const staleIds = localRows
    .filter((row) => !keepSet.has(Number(row.remote_uid || 0)))
    .map((row) => row.id);

  if (!staleIds.length) {
    return 0;
  }

  for (let index = 0; index < staleIds.length; index += 200) {
    const chunk = staleIds.slice(index, index + 200);
    db.prepare(`
      DELETE FROM messages
      WHERE id IN (${chunk.map(() => '?').join(', ')})
    `).run(...chunk);
  }

  return staleIds.length;
}

function deleteMailbox(mailboxId) {
  db.prepare('DELETE FROM mailboxes WHERE id = ?').run(mailboxId);
}

function normalizeMessageRemoteIdentity(message = {}) {
  const remoteSource = String(message.remoteSource || 'imap').trim().toLowerCase() || 'imap';
  const remoteId =
    String(
      message.remoteId ||
        (message.remoteUid !== undefined && message.remoteUid !== null ? String(message.remoteUid) : ''),
    ).trim() || String(message.id || '').trim();

  return {
    remoteSource,
    remoteId,
  };
}

function saveMessage(message) {
  const identity = normalizeMessageRemoteIdentity(message);
  const existing = db.prepare(`
    SELECT id
    FROM messages
    WHERE mailbox_id = ? AND folder_path = ? AND remote_source = ? AND remote_id = ?
    LIMIT 1
  `).get(message.mailboxId, message.folderPath || 'INBOX', identity.remoteSource, identity.remoteId);
  const timestamp = now();
  const insertedId = existing?.id || randomUUID();
  db.prepare(`
    INSERT INTO messages (
      id, mailbox_id, folder_path, folder_kind, remote_uid, remote_id, remote_source, message_id, subject, from_name, from_address,
      to_json, received_at, preview, text_body, html_body, attachments_json,
      is_read, is_starred, raw_flags, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mailbox_id, folder_path, remote_source, remote_id)
    DO UPDATE SET
      folder_kind = excluded.folder_kind,
      remote_uid = excluded.remote_uid,
      message_id = excluded.message_id,
      subject = excluded.subject,
      from_name = excluded.from_name,
      from_address = excluded.from_address,
      to_json = excluded.to_json,
      received_at = excluded.received_at,
      preview = excluded.preview,
      text_body = excluded.text_body,
      html_body = excluded.html_body,
      attachments_json = excluded.attachments_json,
      is_read = excluded.is_read,
      is_starred = excluded.is_starred,
      raw_flags = excluded.raw_flags,
      updated_at = excluded.updated_at
  `).run(
    insertedId,
    message.mailboxId,
    message.folderPath || 'INBOX',
    message.folderKind || 'inbox',
    Number(message.remoteUid) || 0,
    identity.remoteId,
    identity.remoteSource,
    message.messageId,
    message.subject,
    message.fromName,
    message.fromAddress,
    JSON.stringify(message.to || []),
    message.receivedAt,
    message.preview,
    message.textBody,
    message.htmlBody,
    JSON.stringify(message.attachments || []),
    message.isRead ? 1 : 0,
    message.isStarred ? 1 : 0,
    JSON.stringify(message.flags || []),
    timestamp,
    timestamp,
  );

  return existing ? null : getMessageById(insertedId, null);
}

function listMessages(options = {}) {
  const { limit = 100, offset = 0 } = options;
  const { conditions, params } = buildMessageFilters(options);
  const resolvedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const resolvedOffset = Math.max(Number(offset) || 0, 0);

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      msg.*,
      mailbox.name AS mailbox_name,
      mailbox.email AS mailbox_email,
      mailbox.provider AS provider,
      mailbox.owner_user_id AS owner_user_id,
      owner.name AS owner_name,
      owner.email AS owner_email
    FROM messages msg
    JOIN mailboxes mailbox ON mailbox.id = msg.mailbox_id
    LEFT JOIN users owner ON owner.id = mailbox.owner_user_id
    ${whereClause}
    ORDER BY msg.received_at DESC, msg.updated_at DESC
    LIMIT ?
    OFFSET ?
  `).all(...params, resolvedLimit, resolvedOffset);

  return rows.map(parseMessage);
}

function getMessageFolderStats(options = {}) {
  const { conditions, params } = buildMessageFilters({
    ...options,
    folder: 'all',
    includeAllFolders: true,
  });
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN ${normalMessageFolderSql()} THEN 1 ELSE 0 END) AS total_count,
      SUM(CASE WHEN ${normalMessageFolderSql()} AND msg.is_read = 0 THEN 1 ELSE 0 END) AS unread_count,
      SUM(CASE WHEN ${normalMessageFolderSql()} AND msg.is_read = 1 THEN 1 ELSE 0 END) AS read_count,
      SUM(CASE WHEN ${normalMessageFolderSql()} AND msg.is_starred = 1 THEN 1 ELSE 0 END) AS starred_count,
      SUM(CASE WHEN ${messageFolderKindSql()} = 'trash' THEN 1 ELSE 0 END) AS trash_count,
      SUM(CASE WHEN ${messageFolderKindSql()} = 'junk' THEN 1 ELSE 0 END) AS junk_count
    FROM messages msg
    JOIN mailboxes mailbox ON mailbox.id = msg.mailbox_id
    ${whereClause}
  `).get(...params);

  return {
    totalCount: row?.total_count ?? 0,
    unreadCount: row?.unread_count ?? 0,
    readCount: row?.read_count ?? 0,
    starredCount: row?.starred_count ?? 0,
    trashCount: row?.trash_count ?? 0,
    junkCount: row?.junk_count ?? 0,
  };
}

function getMessageById(messageId, viewer = null) {
  const { conditions, params } = buildMessageScope(viewer);
  conditions.unshift('msg.id = ?');
  params.unshift(messageId);
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const row = db.prepare(`
    SELECT
      msg.*,
      mailbox.name AS mailbox_name,
      mailbox.email AS mailbox_email,
      mailbox.provider AS provider,
      mailbox.owner_user_id AS owner_user_id,
      owner.name AS owner_name,
      owner.email AS owner_email
    FROM messages msg
    JOIN mailboxes mailbox ON mailbox.id = msg.mailbox_id
    LEFT JOIN users owner ON owner.id = mailbox.owner_user_id
    ${whereClause}
    LIMIT 1
  `).get(...params);

  return parseMessage(row);
}

function hasLocalAttachmentRecord(attachment = {}) {
  return Boolean(
    attachment?.stored
    && (
      String(attachment?.relativePath || '').trim()
      || String(attachment?.publicPath || '').trim()
    ),
  );
}

function listAttachmentMetadata(options = {}) {
  const {
    viewer = null,
    ownerUserId = null,
    mailboxId = null,
    offset = 0,
    limit = 120,
  } = options;
  const { conditions, params } = buildMessageScope(viewer);

  if (ownerUserId) {
    conditions.push('mailbox.owner_user_id = ?');
    params.push(ownerUserId);
  }

  if (mailboxId) {
    conditions.push('mailbox.id = ?');
    params.push(mailboxId);
  }

  conditions.push("msg.attachments_json IS NOT NULL");
  conditions.push("TRIM(msg.attachments_json) <> '[]'");
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT
      msg.*,
      mailbox.name AS mailbox_name,
      mailbox.email AS mailbox_email,
      mailbox.provider AS provider,
      mailbox.owner_user_id AS owner_user_id,
      owner.name AS owner_name,
      owner.email AS owner_email
    FROM messages msg
    JOIN mailboxes mailbox ON mailbox.id = msg.mailbox_id
    LEFT JOIN users owner ON owner.id = mailbox.owner_user_id
    ${whereClause}
    ORDER BY datetime(msg.received_at) DESC, msg.rowid DESC
  `).all(...params);

  const items = [];
  for (const row of rows) {
    const message = parseMessage(row);
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    attachments.forEach((attachment, index) => {
      if (!hasLocalAttachmentRecord(attachment)) {
        return;
      }

      items.push({
        messageId: message.id,
        attachmentIndex: index,
        subject: message.subject || '',
        mailboxId: message.mailboxId,
        mailboxName: message.mailboxName || '',
        mailboxEmail: message.mailboxEmail || '',
        provider: message.provider || '',
        ownerUserId: message.ownerUserId || '',
        ownerName: message.ownerName || '',
        ownerEmail: message.ownerEmail || '',
        receivedAt: message.receivedAt || null,
        remoteSource: message.remoteSource || 'imap',
        filename: String(attachment?.filename || `附件 ${index + 1}`).trim() || `附件 ${index + 1}`,
        contentType: String(attachment?.contentType || '').trim(),
        size: Number(attachment?.size || 0),
        stored: Boolean(attachment?.stored),
        publicPath: String(attachment?.publicPath || '').trim(),
        relativePath: String(attachment?.relativePath || '').trim(),
        category: String(attachment?.category || '').trim(),
        note: String(attachment?.note || attachment?.error || '').trim(),
      });
    });
  }

  const resolvedOffset = Math.max(Number(offset) || 0, 0);
  const resolvedLimit = Math.max(Number(limit) || 120, 1);

  return {
    items: items.slice(resolvedOffset, resolvedOffset + resolvedLimit),
    totalItems: items.length,
  };
}

function listMessagesWithAttachments(mailboxIds = [], options = {}) {
  const normalizedMailboxIds = Array.from(
    new Set((mailboxIds || []).map((mailboxId) => String(mailboxId || '').trim()).filter(Boolean)),
  );
  const limit = Math.min(Math.max(Number(options.limit) || 2000, 1), 10000);
  const conditions = [
    'msg.attachments_json IS NOT NULL',
    "TRIM(msg.attachments_json) <> '[]'",
  ];
  const params = [];

  if (normalizedMailboxIds.length) {
    conditions.push(`mailbox.id IN (${normalizedMailboxIds.map(() => '?').join(', ')})`);
    params.push(...normalizedMailboxIds);
  }

  const rows = db.prepare(`
    SELECT
      msg.*,
      mailbox.name AS mailbox_name,
      mailbox.email AS mailbox_email,
      mailbox.provider AS provider,
      mailbox.owner_user_id AS owner_user_id,
      owner.name AS owner_name,
      owner.email AS owner_email
    FROM messages msg
    JOIN mailboxes mailbox ON mailbox.id = msg.mailbox_id
    LEFT JOIN users owner ON owner.id = mailbox.owner_user_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY datetime(msg.received_at) DESC, msg.rowid DESC
    LIMIT ?
  `).all(...params, limit);

  return rows.map(parseMessage);
}

function getMessagesByIds(messageIds, viewer = null) {
  const normalizedIds = Array.from(
    new Set((messageIds || []).map((messageId) => String(messageId || '').trim()).filter(Boolean)),
  );

  if (!normalizedIds.length) {
    return [];
  }

  const { conditions, params } = buildMessageScope(viewer);
  conditions.unshift(`msg.id IN (${normalizedIds.map(() => '?').join(', ')})`);
  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT
      msg.*,
      mailbox.name AS mailbox_name,
      mailbox.email AS mailbox_email,
      mailbox.provider AS provider,
      mailbox.owner_user_id AS owner_user_id,
      owner.name AS owner_name,
      owner.email AS owner_email
    FROM messages msg
    JOIN mailboxes mailbox ON mailbox.id = msg.mailbox_id
    LEFT JOIN users owner ON owner.id = mailbox.owner_user_id
    ${whereClause}
    ORDER BY msg.received_at DESC, msg.updated_at DESC
  `).all(...normalizedIds, ...params);

  return rows.map(parseMessage);
}

function updateMessageState(messageId, viewer = null, input = {}) {
  const existing = getMessageById(messageId, viewer);
  if (!existing) {
    return null;
  }

  const fields = [];
  const params = [];

  if (input.isRead !== undefined) {
    fields.push('is_read = ?');
    params.push(input.isRead ? 1 : 0);
  }

  if (input.isStarred !== undefined) {
    fields.push('is_starred = ?');
    params.push(input.isStarred ? 1 : 0);
  }

  if (!fields.length) {
    return existing;
  }

  fields.push('updated_at = ?');
  params.push(now(), messageId);
  db.prepare(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  return getMessageById(messageId, viewer);
}

function updateMessageAttachments(messageId, viewer = null, attachments = []) {
  const existing = getMessageById(messageId, viewer);
  if (!existing) {
    return null;
  }

  db.prepare(`
    UPDATE messages
    SET attachments_json = ?, updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(Array.isArray(attachments) ? attachments : []), now(), messageId);

  return getMessageById(messageId, viewer);
}

function updateMessagesState(messageIds, viewer = null, input = {}) {
  const normalizedIds = Array.from(
    new Set((messageIds || []).map((messageId) => String(messageId || '').trim()).filter(Boolean)),
  );

  if (!normalizedIds.length) {
    return [];
  }

  const fields = [];
  const params = [];

  if (input.isRead !== undefined) {
    fields.push('is_read = ?');
    params.push(input.isRead ? 1 : 0);
  }

  if (input.isStarred !== undefined) {
    fields.push('is_starred = ?');
    params.push(input.isStarred ? 1 : 0);
  }

  const { conditions, params: scopeParams } = buildMessageScope(viewer);
  conditions.unshift(`msg.id IN (${normalizedIds.map(() => '?').join(', ')})`);
  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const visibleRows = db.prepare(`
    SELECT msg.id
    FROM messages msg
    JOIN mailboxes mailbox ON mailbox.id = msg.mailbox_id
    ${whereClause}
  `).all(...normalizedIds, ...scopeParams);
  const visibleIds = visibleRows.map((row) => row.id);

  if (!visibleIds.length) {
    return [];
  }

  if (fields.length) {
    fields.push('updated_at = ?');
    params.push(now());
    db.prepare(`
      UPDATE messages
      SET ${fields.join(', ')}
      WHERE id IN (${visibleIds.map(() => '?').join(', ')})
    `).run(...params, ...visibleIds);
  }

  return visibleIds
    .map((messageId) => getMessageById(messageId, viewer))
    .filter(Boolean);
}

function getDashboardSummary(viewer) {
  const mailboxScope = buildMailboxScope(viewer);
  const mailboxWhere = mailboxScope.conditions.length
    ? `WHERE ${mailboxScope.conditions.join(' AND ')}`
    : '';
  const messageScope = buildMessageScope(viewer);
  const messageWhere = messageScope.conditions.length
    ? `WHERE ${messageScope.conditions.join(' AND ')}`
    : '';

  const mailboxStats = db.prepare(`
    SELECT
      COUNT(*) AS total_mailboxes,
      SUM(CASE WHEN m.status = 'error' THEN 1 ELSE 0 END) AS error_mailboxes
    FROM mailboxes m
    ${mailboxWhere}
  `).get(...mailboxScope.params);

  const messageStats = db.prepare(`
    SELECT
      SUM(CASE WHEN ${normalMessageFolderSql()} THEN 1 ELSE 0 END) AS total_messages,
      SUM(CASE WHEN ${normalMessageFolderSql()} AND msg.is_read = 0 THEN 1 ELSE 0 END) AS unread_messages
    FROM messages msg
    JOIN mailboxes mailbox ON mailbox.id = msg.mailbox_id
    ${messageWhere}
  `).get(...messageScope.params);

  const recentMessages = listMessages({ viewer, limit: 6 });
  const recentMailboxes = listMailboxes({ viewer, limit: 6, order: 'recent' });

  return {
    stats: {
      totalMailboxes: mailboxStats.total_mailboxes ?? 0,
      errorMailboxes: mailboxStats.error_mailboxes ?? 0,
      totalMessages: messageStats.total_messages ?? 0,
      unreadMessages: messageStats.unread_messages ?? 0,
      activeUsers:
        viewer.role === 'admin'
          ? db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'active'").get().c
          : null,
    },
    recentMessages,
    recentMailboxes,
  };
}

module.exports = {
  bootstrapAdmin,
  checkpointDatabase,
  cleanupExpiredSessions,
  closeDatabaseConnection,
  clearMailboxMessages,
  clearMailboxFolderMessages,
  createBackupRecord,
  createEmailAuthCode,
  createMailbox,
  createSession,
  createUser,
  databaseFile,
  deleteBackupRecord,
  deleteExpiredEmailAuthCodes,
  deleteMailbox,
  deleteSessionByToken,
  getDashboardSummary,
  getBackupRecordById,
  getLatestEmailAuthCode,
  getMailboxById,
  getMailboxSyncState,
  getMessageById,
  getMessageFolderStats,
  getMessagesByIds,
  getNotificationTarget,
  getSessionUserByToken,
  getSystemSettings,
  getUserAuthByEmail,
  getUserAuthByUsername,
  getUserByEmail,
  getUserById,
  getUserByUsername,
  listBackupRecords,
  listAttachmentMetadata,
  listMailboxes,
  listMailboxesForSync,
  listMessagesWithAttachments,
  listMessages,
  listNotificationTargets,
  listUsers,
  markMailboxSyncError,
  markMailboxSyncStart,
  markMailboxSyncSuccess,
  markUserLoggedIn,
  pruneFolderMessages,
  reopenDatabaseConnection,
  saveMessage,
  upsertMailboxSyncState,
  updateMessageAttachments,
  updateMessageState,
  updateMessagesState,
  updateMailbox,
  updateMailboxDisplay,
  updateMailboxSortOrders,
  updateMailboxOAuthState,
  updateMailboxSyncInterval,
  updateBackupRecord,
  consumeEmailAuthCode,
  updateSystemSettings,
  updateUser,
  upsertNotificationTarget,
  upsertMailbox,
  normalizeGoogleClientId,
  normalizeStorageSyncPolicy,
};
