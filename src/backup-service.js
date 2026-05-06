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
const STALE_RUNNING_BACKUP_MS = 30 * 60 * 1000;
const ENV_FILE = path.join(process.cwd(), '.env');
const FIXED_RUNTIME_PORT = '52080';
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
      logs: false,
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

function clearDirectoryContents(directoryPath = '') {
  const normalizedPath = String(directoryPath || '').trim();
  if (!normalizedPath) {
    return;
  }

  fs.mkdirSync(normalizedPath, { recursive: true });
  fs.readdirSync(normalizedPath).forEach((entryName) => {
    safeRemovePath(path.join(normalizedPath, entryName));
  });
}

function copyDirectoryContents(sourceDirectory = '', targetDirectory = '') {
  const normalizedSource = String(sourceDirectory || '').trim();
  const normalizedTarget = String(targetDirectory || '').trim();
  if (!normalizedSource || !normalizedTarget || !fs.existsSync(normalizedSource)) {
    return;
  }

  fs.mkdirSync(normalizedTarget, { recursive: true });
  fs.readdirSync(normalizedSource, { withFileTypes: true }).forEach((entry) => {
    const sourcePath = path.join(normalizedSource, entry.name);
    const targetPath = path.join(normalizedTarget, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
      return;
    }

    if (entry.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(sourcePath);
      ensureParentDirectory(targetPath);
      try {
        fs.symlinkSync(linkTarget, targetPath);
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }
      }
      return;
    }

    ensureParentDirectory(targetPath);
    fs.copyFileSync(sourcePath, targetPath);
  });
}

function movePathSafely(sourcePath = '', targetPath = '', expectedKind = '') {
  const normalizedSource = String(sourcePath || '').trim();
  const normalizedTarget = String(targetPath || '').trim();
  if (!normalizedSource || !normalizedTarget || !fs.existsSync(normalizedSource)) {
    return;
  }

  ensureParentDirectory(normalizedTarget);
  try {
    fs.renameSync(normalizedSource, normalizedTarget);
    return;
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      throw error;
    }
  }

  // Docker volumes can put /app/data and /app/runtime on different devices.
  // In that case rename cannot cross devices, so copy first and remove after.
  const sourceStats = fs.lstatSync(normalizedSource);
  safeRemovePath(normalizedTarget);

  if (sourceStats.isDirectory()) {
    fs.mkdirSync(normalizedTarget, { recursive: true });
    copyDirectoryContents(normalizedSource, normalizedTarget);
    safeRemovePath(normalizedSource);
    return;
  }

  if (sourceStats.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(normalizedSource);
    fs.symlinkSync(linkTarget, normalizedTarget);
    safeRemovePath(normalizedSource);
    return;
  }

  if (expectedKind === 'directory') {
    fs.mkdirSync(normalizedTarget, { recursive: true });
    safeRemovePath(normalizedSource);
    return;
  }

  fs.copyFileSync(normalizedSource, normalizedTarget);
  safeRemovePath(normalizedSource);
}

function readEnvPairs(filePath = '') {
  if (!filePath || !fs.existsSync(filePath)) {
    return new Map();
  }

  const pairs = new Map();
  String(fs.readFileSync(filePath, 'utf8') || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const normalizedLine = line.replace(/^\uFEFF/, '').trim();
      if (!normalizedLine || normalizedLine.startsWith('#')) {
        return;
      }

      const match = normalizedLine.match(/^([^#=\s]+)\s*=\s*(.*)$/);
      if (match) {
        pairs.set(match[1], match[2]);
      }
    });

  return pairs;
}

function serializeEnvPairs(pairs = new Map()) {
  return `${Array.from(pairs.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

function mergeRestoredEnvFile(sourcePath = '', targetPath = '', options = {}) {
  const restoredPairs = readEnvPairs(sourcePath);
  const currentPairs = options.currentPairs instanceof Map ? options.currentPairs : readEnvPairs(targetPath);
  const mergedPairs = new Map(restoredPairs);

  mergedPairs.set('PORT', FIXED_RUNTIME_PORT);
  if (!options.restoreDatabase && currentPairs.has('APP_SECRET')) {
    mergedPairs.set('APP_SECRET', currentPairs.get('APP_SECRET'));
  }

  ensureParentDirectory(targetPath);
  fs.writeFileSync(targetPath, serializeEnvPairs(mergedPairs), 'utf8');
}

function syncProcessSecretFromEnvFile(filePath = ENV_FILE) {
  const envPairs = readEnvPairs(filePath);
  const restoredSecret = String(envPairs.get('APP_SECRET') || '').trim();
  if (restoredSecret) {
    process.env.APP_SECRET = restoredSecret;
  }
}

function mergeRestoredAppSecret(sourcePath = '', targetPath = '') {
  const restoredPairs = readEnvPairs(sourcePath);
  const restoredSecret = String(restoredPairs.get('APP_SECRET') || '').trim();
  if (!restoredSecret) {
    return;
  }

  const currentPairs = readEnvPairs(targetPath);
  currentPairs.set('APP_SECRET', restoredSecret);
  currentPairs.set('PORT', FIXED_RUNTIME_PORT);
  ensureParentDirectory(targetPath);
  fs.writeFileSync(targetPath, serializeEnvPairs(currentPairs), 'utf8');
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
    fs.existsSync(path.join(rootPath, 'runtime', 'files'))
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
  const hasSiteArtifacts = detected.envFile || detected.runtimeFiles;
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
    logs: false,
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

  if (!declared.database && !declared.envFile && !declared.runtimeFiles) {
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
    if (inspection.detected.envFile) {
      actions.push({
        key: 'appSecret',
        label: 'appSecret',
        kind: 'file',
        restore: true,
        clearOnly: false,
        sourcePath: inspection.sources.envFile,
        targetPath: ENV_FILE,
        includeInSummary: false,
      });
    }
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
  const touchedActions = [];
  const restoreDatabase = actions.some((action) => action.key === 'database' && action.restore);

  try {
    actions.forEach((action, index) => {
      const currentEnvPairs = action.key === 'envFile' ? readEnvPairs(action.targetPath) : null;
      if (fs.existsSync(action.targetPath)) {
        const rollbackPath = path.join(rollbackRoot, rollbackFileNameForAction(action, index));
        if (action.kind === 'directory') {
          fs.mkdirSync(rollbackPath, { recursive: true });
          copyDirectoryContents(action.targetPath, rollbackPath);
          clearDirectoryContents(action.targetPath);
        } else {
          movePathSafely(action.targetPath, rollbackPath, action.kind);
        }
        rollbackEntries.push({
          targetPath: action.targetPath,
          rollbackPath,
          kind: action.kind,
        });
      }

      if (!action.restore) {
        return;
      }

      if (action.kind === 'directory') {
        fs.mkdirSync(action.targetPath, { recursive: true });
        copyDirectoryContents(action.sourcePath, action.targetPath);
        touchedActions.push(action);
        return;
      }

      if (action.key === 'envFile') {
        mergeRestoredEnvFile(action.sourcePath, action.targetPath, { currentPairs: currentEnvPairs, restoreDatabase });
        touchedActions.push(action);
        return;
      }

      if (action.key === 'appSecret') {
        mergeRestoredAppSecret(action.sourcePath, action.targetPath);
        touchedActions.push(action);
        return;
      }

      ensureParentDirectory(action.targetPath);
      fs.copyFileSync(action.sourcePath, action.targetPath);
      touchedActions.push(action);
    });

    return rollbackEntries;
  } catch (error) {
    touchedActions
      .slice()
      .reverse()
      .forEach((action) => {
        if (action.kind === 'directory') {
          clearDirectoryContents(action.targetPath);
          return;
        }

        safeRemovePath(action.targetPath);
      });

    rollbackEntries
      .slice()
      .reverse()
      .forEach((entry) => {
        if (!fs.existsSync(entry.rollbackPath)) {
          return;
        }
        if (entry.kind === 'directory') {
          clearDirectoryContents(entry.targetPath);
          copyDirectoryContents(entry.rollbackPath, entry.targetPath);
          return;
        }

        ensureParentDirectory(entry.targetPath);
        movePathSafely(entry.rollbackPath, entry.targetPath, entry.kind);
      });

    throw error;
  }
}

function cleanupRollbackEntries(entries = []) {
  entries.forEach((entry) => {
    safeRemovePath(entry.rollbackPath);
  });
}

function backupRecordAgeMs(record = {}) {
  const timestamp = Date.parse(record.updatedAt || record.createdAt || '');
  return Number.isFinite(timestamp) ? Math.max(Date.now() - timestamp, 0) : Number.POSITIVE_INFINITY;
}

function isStaleRunningBackupRecord(record = {}) {
  return (
    String(record?.status || '').trim() === 'running'
    && backupRecordAgeMs(record) >= STALE_RUNNING_BACKUP_MS
  );
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
    this.markStaleRunningBackups();
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

    this.markStaleRunningBackups();
    const latestRecord =
      listBackupRecords(20).find((item) => String(item.status || '').trim() === 'completed')
      || listBackupRecords(1)[0];
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
        syncProcessSecretFromEnvFile(ENV_FILE);
      }
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
            if (entry.kind === 'directory') {
              clearDirectoryContents(entry.targetPath);
            } else {
              safeRemovePath(entry.targetPath);
            }

            if (fs.existsSync(entry.rollbackPath)) {
              if (entry.kind === 'directory') {
                fs.mkdirSync(entry.targetPath, { recursive: true });
                clearDirectoryContents(entry.targetPath);
                copyDirectoryContents(entry.rollbackPath, entry.targetPath);
                return;
              }

              ensureParentDirectory(entry.targetPath);
              movePathSafely(entry.rollbackPath, entry.targetPath, entry.kind);
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

    if (isStaleRunningBackupRecord(record)) {
      updateBackupRecord(record.id, {
        status: 'failed',
        error: '备份任务异常中断，系统已自动标记为失败，可手动删除这条记录。',
      });
      record.status = 'failed';
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

  markStaleRunningBackups() {
    listBackupRecords(500)
      .filter(isStaleRunningBackupRecord)
      .forEach((record) => {
        updateBackupRecord(record.id, {
          status: 'failed',
          error: '备份任务异常中断，系统已自动标记为失败，可手动删除这条记录。',
        });
      });
  }
}

module.exports = {
  BACKUP_ROOT,
  BackupService,
  ensureBackupRoot,
};
