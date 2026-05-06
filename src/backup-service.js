const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const zlib = require('node:zlib');
const archiver = require('archiver');
const {
  checkpointDatabase,
  closeDatabaseConnection,
  createBackupRecord,
  databaseFile,
  deleteBackupRecord,
  getBackupRecordById,
  getSystemSettings,
  listBackupRecords,
  reopenDatabaseConnection,
  updateBackupRecord,
} = require('./db');
const { deleteRemotePath, uploadLocalFileToRemote } = require('./remote-storage');
const { STORAGE_ROOT } = require('./storage');

const BACKUP_ROOT = path.join(process.cwd(), 'runtime', 'backups');
const RESTORE_WORK_ROOT = path.join(process.cwd(), 'runtime', 'restore-workspaces');
const BACKUP_TICK_MS = 60 * 1000;
const ENV_FILE = path.join(process.cwd(), '.env');
const LOGS_ROOT = path.join(process.cwd(), 'logs');
const DATABASE_SIDE_FILES = [`${databaseFile}-wal`, `${databaseFile}-shm`];

function ensureBackupRoot() {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
}

function ensureRestoreWorkRoot() {
  fs.mkdirSync(RESTORE_WORK_ROOT, { recursive: true });
}

function nowIsoCompact() {
  return new Date().toISOString().replace(/[:.]/g, '-');
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

function normalizeRestoreMode(value, fallback = 'full_site_data') {
  const normalized = String(value || fallback || 'full_site_data').trim().toLowerCase();
  return ['full_site_data', 'database_only', 'attachments_only'].includes(normalized)
    ? normalized
    : 'full_site_data';
}

function normalizeRetentionCount(value, fallback = 10) {
  const count = Number(value || fallback || 10);
  if (!Number.isFinite(count)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(count), 1), 200);
}

function normalizeIntervalHours(value, fallback = 24) {
  const hours = Number(value || fallback || 24);
  if (!Number.isFinite(hours)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(hours), 1), 24 * 30);
}

function resolveBackupContentPlan(settings = {}) {
  const contentMode = normalizeBackupContentMode(
    settings.backupContentMode,
    Boolean(settings.backupIncludeRuntimeFiles) ? 'database_and_site' : 'database_only',
  );

  return {
    contentMode,
    includeDatabase: contentMode === 'database_only' || contentMode === 'database_and_site',
    includeSiteData: contentMode === 'site_only' || contentMode === 'database_and_site',
  };
}

function resolveEffectiveBackupSettings(settings = {}, options = {}) {
  const contentMode = normalizeBackupContentMode(
    options.backupContentMode,
    settings.backupContentMode || (Boolean(settings.backupIncludeRuntimeFiles) ? 'database_and_site' : 'database_only'),
  );

  return {
    ...settings,
    backupContentMode: contentMode,
    backupIncludeRuntimeFiles: contentMode !== 'database_only',
  };
}

function buildBackupManifest(settings = {}) {
  const plan = resolveBackupContentPlan(settings);
  return {
    generatedAt: new Date().toISOString(),
    siteName: String(settings.siteName || 'Mail Union').trim() || 'Mail Union',
    version: '2',
    contentMode: plan.contentMode,
    includes: {
      database: plan.includeDatabase && fs.existsSync(databaseFile),
      envFile: plan.includeSiteData && fs.existsSync(ENV_FILE),
      runtimeFiles: plan.includeSiteData && fs.existsSync(STORAGE_ROOT),
      logs: plan.includeSiteData && fs.existsSync(LOGS_ROOT),
    },
  };
}

function ensureParentDirectory(targetPath = '') {
  const parentDirectory = path.dirname(targetPath);
  if (parentDirectory) {
    fs.mkdirSync(parentDirectory, { recursive: true });
  }
}

function safeRemovePath(targetPath = '') {
  const normalizedPath = String(targetPath || '').trim();
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return;
  }

  const stats = fs.lstatSync(normalizedPath);
  if (stats.isDirectory()) {
    fs.rmSync(normalizedPath, { recursive: true, force: true });
    return;
  }

  fs.rmSync(normalizedPath, { force: true });
}

function resetDirectory(directoryPath = '') {
  safeRemovePath(directoryPath);
  fs.mkdirSync(directoryPath, { recursive: true });
}

function createArchive(archivePath, settings = {}) {
  ensureBackupRoot();
  const plan = resolveBackupContentPlan(settings);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(archivePath);
    const archive = archiver('zip', {
      zlib: { level: 9 },
    });

    output.on('close', () => resolve(archive.pointer()));
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);

    if (plan.includeDatabase && fs.existsSync(databaseFile)) {
      checkpointDatabase('TRUNCATE');
      archive.file(databaseFile, { name: 'data/mail-union.sqlite' });
    }

    if (plan.includeSiteData && fs.existsSync(ENV_FILE)) {
      archive.file(ENV_FILE, { name: '.env' });
    }

    if (plan.includeSiteData && fs.existsSync(STORAGE_ROOT)) {
      archive.directory(STORAGE_ROOT, 'runtime/files');
    }

    if (plan.includeSiteData && fs.existsSync(LOGS_ROOT)) {
      archive.directory(LOGS_ROOT, 'logs');
    }

    archive.append(JSON.stringify(buildBackupManifest(settings), null, 2), {
      name: 'manifest.json',
    });

    archive.finalize().catch(reject);
  });
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readJsonFile(filePath = '') {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function backupLooksRecognizable(rootPath = '') {
  return (
    fs.existsSync(path.join(rootPath, 'manifest.json')) ||
    fs.existsSync(path.join(rootPath, 'data', 'mail-union.sqlite')) ||
    fs.existsSync(path.join(rootPath, '.env')) ||
    fs.existsSync(path.join(rootPath, 'runtime', 'files')) ||
    fs.existsSync(path.join(rootPath, 'logs'))
  );
}

function resolveExtractedArchiveRoot(extractRoot = '') {
  if (backupLooksRecognizable(extractRoot)) {
    return extractRoot;
  }

  const entries = fs.existsSync(extractRoot)
    ? fs.readdirSync(extractRoot, { withFileTypes: true })
    : [];
  const nestedDirectories = entries.filter((entry) => entry.isDirectory());
  if (nestedDirectories.length === 1) {
    const nestedRoot = path.join(extractRoot, nestedDirectories[0].name);
    if (backupLooksRecognizable(nestedRoot)) {
      return nestedRoot;
    }
  }

  return extractRoot;
}

function readManifestIfExists(extractRoot = '') {
  const manifestPath = path.join(extractRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  return readJsonFile(manifestPath);
}

function manifestDeclaresComponent(manifest, key, detectedPresent) {
  if (
    manifest &&
    manifest.includes &&
    Object.prototype.hasOwnProperty.call(manifest.includes, key)
  ) {
    return Boolean(manifest.includes[key]);
  }

  return Boolean(detectedPresent);
}

function inspectExtractedBackup(extractRoot = '') {
  const resolvedRoot = resolveExtractedArchiveRoot(extractRoot);
  const manifest = readManifestIfExists(resolvedRoot);
  const detected = {
    database: fs.existsSync(path.join(resolvedRoot, 'data', 'mail-union.sqlite')),
    envFile: fs.existsSync(path.join(resolvedRoot, '.env')),
    runtimeFiles: fs.existsSync(path.join(resolvedRoot, 'runtime', 'files')),
    logs: fs.existsSync(path.join(resolvedRoot, 'logs')),
  };
  const hasSiteArtifacts = detected.envFile || detected.runtimeFiles || detected.logs;
  const inferredContentMode = detected.database
    ? hasSiteArtifacts
      ? 'database_and_site'
      : 'database_only'
    : 'site_only';
  const contentMode = normalizeBackupContentMode(manifest?.contentMode, inferredContentMode);
  const includeDatabase = contentMode === 'database_only' || contentMode === 'database_and_site';
  const includeSiteData = contentMode === 'site_only' || contentMode === 'database_and_site';
  const declared = {
    database: includeDatabase,
    envFile: includeSiteData && manifestDeclaresComponent(manifest, 'envFile', detected.envFile),
    runtimeFiles: includeSiteData && manifestDeclaresComponent(manifest, 'runtimeFiles', detected.runtimeFiles),
    logs: includeSiteData && manifestDeclaresComponent(manifest, 'logs', detected.logs),
  };

  if (!includeDatabase && !includeSiteData) {
    throw new Error('备份包没有可识别的还原内容。');
  }

  if (includeDatabase && !detected.database) {
    throw new Error('备份包声明包含数据库，但没有找到 data/mail-union.sqlite。');
  }

  if (declared.envFile && !detected.envFile) {
    throw new Error('备份包声明包含 .env 文件，但实际缺失。');
  }

  if (declared.runtimeFiles && !detected.runtimeFiles) {
    throw new Error('备份包声明包含本地附件目录，但实际缺失 runtime/files。');
  }

  if (declared.logs && !detected.logs) {
    throw new Error('备份包声明包含日志目录，但实际缺失 logs。');
  }

  if (!declared.database && !declared.envFile && !declared.runtimeFiles && !declared.logs) {
    throw new Error('备份包里没有可用于系统还原的数据库、配置或站点数据。');
  }

  return {
    rootPath: resolvedRoot,
    manifest,
    contentMode,
    includeDatabase,
    includeSiteData,
    declared,
    detected,
    sources: {
      database: path.join(resolvedRoot, 'data', 'mail-union.sqlite'),
      envFile: path.join(resolvedRoot, '.env'),
      runtimeFiles: path.join(resolvedRoot, 'runtime', 'files'),
      logs: path.join(resolvedRoot, 'logs'),
    },
  };
}

function readUInt16LE(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function normalizeZipEntryName(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function ensureExtractPathInsideRoot(rootPath = '', entryName = '') {
  const normalizedEntryName = normalizeZipEntryName(entryName);
  if (!normalizedEntryName) {
    return '';
  }

  const resolvedRoot = path.resolve(rootPath);
  const targetPath = path.resolve(resolvedRoot, normalizedEntryName);
  if (targetPath !== resolvedRoot && !targetPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`ZIP entry is outside restore workspace: ${entryName}`);
  }

  return targetPath;
}

function findZipEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset;
    }
  }

  return -1;
}

function extractZipWithNode(archivePath, extractRoot) {
  const archiveBuffer = fs.readFileSync(archivePath);
  const eocdOffset = findZipEndOfCentralDirectory(archiveBuffer);
  if (eocdOffset < 0) {
    throw new Error('This file is not a valid ZIP archive.');
  }

  const entryCount = readUInt16LE(archiveBuffer, eocdOffset + 10);
  const centralDirectoryOffset = readUInt32LE(archiveBuffer, eocdOffset + 16);
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32LE(archiveBuffer, cursor) !== 0x02014b50) {
      throw new Error('ZIP central directory is invalid.');
    }

    const compressionMethod = readUInt16LE(archiveBuffer, cursor + 10);
    const compressedSize = readUInt32LE(archiveBuffer, cursor + 20);
    const fileNameLength = readUInt16LE(archiveBuffer, cursor + 28);
    const extraFieldLength = readUInt16LE(archiveBuffer, cursor + 30);
    const fileCommentLength = readUInt16LE(archiveBuffer, cursor + 32);
    const externalAttributes = readUInt32LE(archiveBuffer, cursor + 38);
    const localHeaderOffset = readUInt32LE(archiveBuffer, cursor + 42);
    const fileName = archiveBuffer
      .subarray(cursor + 46, cursor + 46 + fileNameLength)
      .toString('utf8');
    const normalizedFileName = normalizeZipEntryName(fileName);
    const isDirectory =
      fileName.endsWith('/') ||
      fileName.endsWith('\\') ||
      ((externalAttributes >>> 16) & 0o040000) === 0o040000;

    cursor += 46 + fileNameLength + extraFieldLength + fileCommentLength;

    if (!normalizedFileName) {
      continue;
    }

    const targetPath = ensureExtractPathInsideRoot(extractRoot, normalizedFileName);
    if (isDirectory) {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }

    if (readUInt32LE(archiveBuffer, localHeaderOffset) !== 0x04034b50) {
      throw new Error(`ZIP local header is invalid: ${normalizedFileName}`);
    }

    const localFileNameLength = readUInt16LE(archiveBuffer, localHeaderOffset + 26);
    const localExtraFieldLength = readUInt16LE(archiveBuffer, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
    const dataEnd = dataStart + compressedSize;
    const compressedData = archiveBuffer.subarray(dataStart, dataEnd);
    let fileBuffer;

    if (compressionMethod === 0) {
      fileBuffer = compressedData;
    } else if (compressionMethod === 8) {
      fileBuffer = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod}: ${normalizedFileName}`);
    }

    ensureParentDirectory(targetPath);
    fs.writeFileSync(targetPath, fileBuffer);
  }
}

function runExtractionAttempt(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const output = String(result.stderr || result.stdout || '').trim();
    throw new Error(output || `${command} exited with code ${result.status}`);
  }
}

function extractArchive(archivePath, extractRoot) {
  resetDirectory(extractRoot);

  try {
    extractZipWithNode(archivePath, extractRoot);
    return;
  } catch (error) {
    const nodeZipError = `node-zip: ${String(error.message || error)}`;
    const attempts = process.platform === 'win32'
      ? [
          {
            command: 'powershell.exe',
            args: [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              'param([string]$zip,[string]$dest) Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force',
              archivePath,
              extractRoot,
            ],
          },
          {
            command: 'tar.exe',
            args: ['-xf', archivePath, '-C', extractRoot],
          },
        ]
      : [
          {
            command: 'unzip',
            args: ['-oq', archivePath, '-d', extractRoot],
          },
          {
            command: 'tar',
            args: ['-xf', archivePath, '-C', extractRoot],
          },
        ];

    const errors = [nodeZipError];
    for (const attempt of attempts) {
      try {
        resetDirectory(extractRoot);
        runExtractionAttempt(attempt.command, attempt.args);
        return;
      } catch (attemptError) {
        errors.push(`${attempt.command}: ${String(attemptError.message || attemptError)}`);
      }
    }

    throw new Error(`备份压缩包解压失败：${errors.join(' | ')}`);
  }

  const attempts = process.platform === 'win32'
    ? [
        {
          command: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'param([string]$zip,[string]$dest) Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force',
            archivePath,
            extractRoot,
          ],
        },
        {
          command: 'tar.exe',
          args: ['-xf', archivePath, '-C', extractRoot],
        },
      ]
    : [
        {
          command: 'unzip',
          args: ['-oq', archivePath, '-d', extractRoot],
        },
        {
          command: 'tar',
          args: ['-xf', archivePath, '-C', extractRoot],
        },
      ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      runExtractionAttempt(attempt.command, attempt.args);
      return;
    } catch (error) {
      errors.push(`${attempt.command}: ${String(error.message || error)}`);
    }
  }

  throw new Error(`备份压缩包解压失败：${errors.join(' | ')}`);
}

function appendDatabaseRestoreActions(actions, inspection) {
  actions.push({
    key: 'database',
    label: 'database',
    kind: 'file',
    restore: true,
    clearOnly: false,
    sourcePath: inspection.sources.database,
    targetPath: databaseFile,
    includeInSummary: true,
  });
  DATABASE_SIDE_FILES.forEach((sideFilePath, index) => {
    actions.push({
      key: `database-side-${index + 1}`,
      label: index === 0 ? 'databaseWal' : 'databaseShm',
      kind: 'file',
      restore: false,
      clearOnly: true,
      sourcePath: '',
      targetPath: sideFilePath,
      includeInSummary: false,
    });
  });
}

function appendSiteDataRestoreActions(actions, inspection) {
  [
    {
      key: 'envFile',
      label: 'envFile',
      kind: 'file',
      sourcePath: inspection.sources.envFile,
      targetPath: ENV_FILE,
    },
    {
      key: 'runtimeFiles',
      label: 'runtimeFiles',
      kind: 'directory',
      sourcePath: inspection.sources.runtimeFiles,
      targetPath: STORAGE_ROOT,
    },
    {
      key: 'logs',
      label: 'logs',
      kind: 'directory',
      sourcePath: inspection.sources.logs,
      targetPath: LOGS_ROOT,
    },
  ].forEach((entry) => {
    const shouldRestore = Boolean(inspection.declared[entry.key]);
    const shouldClear = Boolean(inspection.manifest) && !shouldRestore;
    if (!shouldRestore && !shouldClear) {
      return;
    }

    actions.push({
      ...entry,
      restore: shouldRestore,
      clearOnly: !shouldRestore,
      includeInSummary: true,
    });
  });
}

function buildRestoreActions(inspection, restoreMode = 'full_site_data') {
  const resolvedRestoreMode = normalizeRestoreMode(restoreMode, 'full_site_data');
  const actions = [];

  if (resolvedRestoreMode === 'database_only') {
    if (!inspection.declared.database) {
      throw new Error('当前备份包不包含数据库，无法执行“仅导入数据库”。');
    }
    appendDatabaseRestoreActions(actions, inspection);
    return actions;
  }

  if (resolvedRestoreMode === 'attachments_only') {
    if (!inspection.declared.runtimeFiles) {
      throw new Error('当前备份包不包含本地附件目录，无法执行“仅导入网站附件”。');
    }
    actions.push({
      key: 'runtimeFiles',
      label: 'runtimeFiles',
      kind: 'directory',
      restore: true,
      clearOnly: false,
      sourcePath: inspection.sources.runtimeFiles,
      targetPath: STORAGE_ROOT,
      includeInSummary: true,
    });
    return actions;
  }

  if (inspection.declared.database) {
    appendDatabaseRestoreActions(actions, inspection);
  }

  if (inspection.includeSiteData) {
    appendSiteDataRestoreActions(actions, inspection);
  }

  return actions;
}

function rollbackFileNameForAction(action, index) {
  return `${String(index + 1).padStart(2, '0')}-${action.key}`;
}

function applyRestoreActions(actions = [], workRoot = '') {
  const rollbackRoot = path.join(workRoot, 'rollback');
  fs.mkdirSync(rollbackRoot, { recursive: true });
  const rollbackEntries = [];

  try {
    actions.forEach((action, index) => {
      if (fs.existsSync(action.targetPath)) {
        const rollbackPath = path.join(rollbackRoot, rollbackFileNameForAction(action, index));
        ensureParentDirectory(rollbackPath);
        fs.renameSync(action.targetPath, rollbackPath);
        rollbackEntries.push({
          targetPath: action.targetPath,
          rollbackPath,
        });
      }

      if (!action.restore) {
        return;
      }

      if (action.kind === 'directory') {
        ensureParentDirectory(action.targetPath);
        fs.cpSync(action.sourcePath, action.targetPath, {
          recursive: true,
          force: true,
        });
        return;
      }

      ensureParentDirectory(action.targetPath);
      fs.copyFileSync(action.sourcePath, action.targetPath);
    });

    return rollbackEntries;
  } catch (error) {
    actions
      .slice()
      .reverse()
      .forEach((action) => {
        safeRemovePath(action.targetPath);
      });

    rollbackEntries
      .slice()
      .reverse()
      .forEach((entry) => {
        if (!fs.existsSync(entry.rollbackPath)) {
          return;
        }
        ensureParentDirectory(entry.targetPath);
        fs.renameSync(entry.rollbackPath, entry.targetPath);
      });

    throw error;
  }
}

function cleanupRollbackEntries(entries = []) {
  entries.forEach((entry) => {
    safeRemovePath(entry.rollbackPath);
  });
}

class BackupService {
  constructor() {
    this.timer = null;
    this.runningPromise = null;
  }

  #resolvedBackupRoot() {
    return path.resolve(BACKUP_ROOT);
  }

  #cleanupLocalBackupFile(localPath = '') {
    const normalizedPath = String(localPath || '').trim();
    if (!normalizedPath) {
      return '';
    }

    const resolvedBackupRoot = this.#resolvedBackupRoot();
    const resolvedTargetPath = path.resolve(normalizedPath);
    if (
      resolvedTargetPath !== resolvedBackupRoot
      && !resolvedTargetPath.startsWith(`${resolvedBackupRoot}${path.sep}`)
    ) {
      throw new Error('备份文件路径不在系统备份目录内，已跳过删除。');
    }

    if (fs.existsSync(resolvedTargetPath)) {
      fs.unlinkSync(resolvedTargetPath);
    }

    return resolvedTargetPath;
  }

  async #cleanupBackupArtifacts(record, settings = {}) {
    const warnings = [];

    try {
      this.#cleanupLocalBackupFile(record?.localPath || '');
    } catch (error) {
      warnings.push(`本地备份文件删除失败：${String(error.message || error)}`);
    }

    if (String(record?.remotePath || '').trim()) {
      try {
        await deleteRemotePath(settings, record.remotePath);
      } catch (error) {
        warnings.push(`远程备份删除失败：${String(error.message || error)}`);
      }
    }

    return warnings;
  }

  start() {
    ensureBackupRoot();
    this.refreshSchedule();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  refreshSchedule() {
    this.stop();
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        console.warn('[backup] scheduled tick failed:', String(error.message || error));
      });
    }, BACKUP_TICK_MS);

    this.tick().catch((error) => {
      console.warn('[backup] initial tick failed:', String(error.message || error));
    });
  }

  async tick() {
    const settings = getSystemSettings();
    if (!settings.backupEnabled) {
      return;
    }

    const latestRecord = listBackupRecords(1)[0];
    const intervalMs = normalizeIntervalHours(settings.backupIntervalHours, 24) * 60 * 60 * 1000;
    const lastRunAt = latestRecord?.createdAt ? Date.parse(latestRecord.createdAt) : 0;

    if (this.runningPromise) {
      return;
    }

    if (!lastRunAt || Number.isNaN(lastRunAt) || Date.now() - lastRunAt >= intervalMs) {
      await this.runBackup({
        destination: normalizeBackupTarget(settings.backupTarget, 'local'),
        triggerSource: 'scheduled',
      });
    }
  }

  async runBackup(options = {}) {
    if (this.runningPromise) {
      return this.runningPromise;
    }

    this.runningPromise = this.#runBackupOnce(options).finally(() => {
      this.runningPromise = null;
    });
    return this.runningPromise;
  }

  async #runBackupOnce(options = {}) {
    const settings = getSystemSettings();
    const effectiveSettings = resolveEffectiveBackupSettings(settings, options);
    const destination = normalizeBackupTarget(options.destination, settings.backupTarget || 'local');
    const triggerSource = String(options.triggerSource || 'manual').trim() || 'manual';
    const filename = `mail-union-backup-${nowIsoCompact()}.zip`;
    const archivePath = path.join(BACKUP_ROOT, filename);
    const record = createBackupRecord({
      filename,
      status: 'running',
      triggerSource,
      destination,
      localPath: archivePath,
    });

    try {
      const sizeBytes = await createArchive(archivePath, effectiveSettings);
      const sha256 = await hashFile(archivePath);
      let remotePath = '';

      if (destination === 'remote' || destination === 'both') {
        const remoteResult = await uploadLocalFileToRemote(
          settings,
          archivePath,
          path.posix.join('backups', filename),
          {
            contentType: 'application/zip',
          },
        );
        remotePath = String(remoteResult.remotePath || '').trim();
      }

      const completed = updateBackupRecord(record.id, {
        status: 'completed',
        sizeBytes,
        sha256,
        remotePath,
        error: '',
      });

      await this.pruneBackups(settings);
      return completed;
    } catch (error) {
      const failed = updateBackupRecord(record.id, {
        status: 'failed',
        error: String(error.message || error),
      });
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        backupRecord: failed,
      });
    }
  }

  async restoreBackupArchive(archivePath, options = {}) {
    const normalizedArchivePath = String(archivePath || '').trim();
    if (!normalizedArchivePath || !fs.existsSync(normalizedArchivePath)) {
      throw new Error('未找到要还原的备份压缩包。');
    }

    const restoreMode = normalizeRestoreMode(options.restoreMode, 'full_site_data');
    ensureBackupRoot();
    ensureRestoreWorkRoot();

    const workRoot = path.join(RESTORE_WORK_ROOT, `restore-${nowIsoCompact()}`);
    const extractRoot = path.join(workRoot, 'extract');
    let inspection = null;
    let databaseClosed = false;
    let rollbackEntries = [];
    let safetyBackup = null;

    try {
      extractArchive(normalizedArchivePath, extractRoot);
      inspection = inspectExtractedBackup(extractRoot);
      safetyBackup = await this.runBackup({
        destination: 'local',
        backupContentMode: 'database_and_site',
        triggerSource: 'pre_restore',
      });

      const restoreActions = buildRestoreActions(inspection, restoreMode);
      const restoreIncludesDatabase = restoreActions.some((action) => action.key === 'database');
      if (restoreIncludesDatabase) {
        closeDatabaseConnection();
        databaseClosed = true;
      }

      rollbackEntries = applyRestoreActions(restoreActions, workRoot);
      if (restoreIncludesDatabase) {
        reopenDatabaseConnection();
        databaseClosed = false;
      }

      cleanupRollbackEntries(rollbackEntries);
      const restoreTouchesEnv = restoreActions.some((action) => action.label === 'envFile');

      return {
        restoreMode,
        contentMode: inspection.contentMode,
        restoredComponents: restoreActions
          .filter((action) => action.restore && action.includeInSummary)
          .map((action) => action.label),
        clearedComponents: restoreActions
          .filter((action) => action.clearOnly && action.includeInSummary)
          .map((action) => action.label),
        restartRecommended: restoreTouchesEnv,
        requiresReauth: restoreIncludesDatabase,
        safetyBackup,
      };
    } catch (error) {
      if (rollbackEntries.length) {
        rollbackEntries
          .slice()
          .reverse()
          .forEach((entry) => {
            safeRemovePath(entry.targetPath);
            if (fs.existsSync(entry.rollbackPath)) {
              ensureParentDirectory(entry.targetPath);
              fs.renameSync(entry.rollbackPath, entry.targetPath);
            }
          });
      }

      if (databaseClosed) {
        try {
          reopenDatabaseConnection();
          databaseClosed = false;
        } catch (reopenError) {
          throw new Error(`${String(error.message || error)}；同时数据库重连失败：${String(reopenError.message || reopenError)}`);
        }
      }

      throw error;
    } finally {
      safeRemovePath(workRoot);
    }
  }

  async pruneBackups(settings = {}) {
    const retainCount = normalizeRetentionCount(settings.backupRetentionCount, 10);
    const records = listBackupRecords(500).filter((item) => item.status === 'completed');
    const expired = records.slice(retainCount);

    for (const record of expired) {
      const warnings = await this.#cleanupBackupArtifacts(record, settings);
      warnings.forEach((warning) => {
        console.warn('[backup] cleanup warning:', warning);
      });

      deleteBackupRecord(record.id);
    }
  }

  async deleteBackup(id) {
    const record = getBackupRecordById(id);
    if (!record) {
      return null;
    }

    if (String(record.status || '').trim() === 'running') {
      throw new Error('当前备份正在执行，请稍后再删除。');
    }

    const warnings = await this.#cleanupBackupArtifacts(record, getSystemSettings());
    deleteBackupRecord(record.id);

    return {
      record,
      warnings,
    };
  }

  getBackupRecord(id) {
    return getBackupRecordById(id);
  }
}

module.exports = {
  BACKUP_ROOT,
  BackupService,
  ensureBackupRoot,
};
