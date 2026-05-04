const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const ftp = require('basic-ftp');
const { decrypt } = require('./crypto');
const { fetchWithOutboundProxy } = require('./outbound-network');

function trimString(value) {
  return String(value || '').trim();
}

function normalizeStorageProvider(value, fallback = 'local') {
  const normalized = trimString(value || fallback || 'local').toLowerCase();
  return ['local', 's3', 'webdav', 'ftp'].includes(normalized) ? normalized : 'local';
}

function normalizeStorageRemotePathPrefix(value, fallback = 'mail-union') {
  const normalized = trimString(value ?? fallback ?? 'mail-union')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]+/g, '-'))
    .filter(Boolean)
    .join('/');
  return normalized || 'mail-union';
}

function normalizeOptionalHttpUrl(value) {
  const url = trimString(value);
  if (!url) {
    return '';
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('远程存储地址必须以 http:// 或 https:// 开头。');
  }
  return url.replace(/\/+$/g, '');
}

function normalizeOptionalHostname(value) {
  return trimString(value).replace(/^https?:\/\//i, '').replace(/\/+$/g, '').slice(0, 255);
}

function normalizeBooleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return Boolean(fallback);
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = trimString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return Boolean(fallback);
}

function normalizePort(value, fallback = 21) {
  const port = Number(value || fallback || 21);
  if (!Number.isFinite(port)) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(port), 1), 65535);
}

function decryptMaybe(value) {
  const cipherText = trimString(value);
  if (!cipherText) {
    return '';
  }

  try {
    return decrypt(cipherText);
  } catch (_) {
    return '';
  }
}

function resolveRemoteStorageConfig(settings = {}) {
  return {
    provider: normalizeStorageProvider(settings.storageProvider, 'local'),
    remotePathPrefix: normalizeStorageRemotePathPrefix(
      settings.storageRemotePathPrefix,
      'mail-union',
    ),
    s3Bucket: trimString(settings.storageS3Bucket),
    s3Region: trimString(settings.storageS3Region),
    s3Endpoint: normalizeOptionalHttpUrl(settings.storageS3Endpoint),
    s3AccessKey: trimString(settings.storageS3AccessKey),
    s3Secret: trimString(settings.storageS3Secret) || decryptMaybe(settings.storageS3SecretEncrypted),
    s3ForcePathStyle: normalizeBooleanValue(settings.storageS3ForcePathStyle, false),
    webdavUrl: normalizeOptionalHttpUrl(settings.storageWebdavUrl),
    webdavUsername: trimString(settings.storageWebdavUsername),
    webdavPassword:
      trimString(settings.storageWebdavPassword)
      || decryptMaybe(settings.storageWebdavPasswordEncrypted),
    ftpHost: normalizeOptionalHostname(settings.storageFtpHost),
    ftpPort: normalizePort(settings.storageFtpPort, 21),
    ftpSecure: normalizeBooleanValue(settings.storageFtpSecure, false),
    ftpUsername: trimString(settings.storageFtpUsername),
    ftpPassword: trimString(settings.storageFtpPassword) || decryptMaybe(settings.storageFtpPasswordEncrypted),
  };
}

function validateRemoteStorageConfig(settings = {}) {
  const config = resolveRemoteStorageConfig(settings);

  if (config.provider === 'local') {
    return config;
  }

  if (config.provider === 's3') {
    if (!config.s3Bucket || !config.s3Region || !config.s3AccessKey || !config.s3Secret) {
      throw new Error('S3 存储请至少填写 Bucket、Region、Access Key 和 Secret Key。');
    }
    return config;
  }

  if (config.provider === 'webdav') {
    if (!config.webdavUrl || !config.webdavUsername || !config.webdavPassword) {
      throw new Error('WebDAV 存储请填写服务器地址、用户名和密码。');
    }
    return config;
  }

  if (config.provider === 'ftp') {
    if (!config.ftpHost || !config.ftpUsername || !config.ftpPassword) {
      throw new Error('FTP 存储请填写主机、用户名和密码。');
    }
    return config;
  }

  return config;
}

function sanitizeRemoteRelativePath(relativePath = '') {
  const normalized = trimString(relativePath)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .join('/');

  if (!normalized) {
    throw new Error('远程存储路径不能为空。');
  }

  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('远程存储路径不合法。');
  }

  return normalized;
}

function buildRemoteStoragePath(settings = {}, relativePath = '') {
  const config = resolveRemoteStorageConfig(settings);
  const normalizedRelativePath = sanitizeRemoteRelativePath(relativePath);
  return [config.remotePathPrefix, normalizedRelativePath].filter(Boolean).join('/');
}

function encodePathSegments(relativePath = '') {
  return sanitizeRemoteRelativePath(relativePath)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function ensureWebdavDirectory(config, targetDirectoryPath) {
  const normalizedDirectoryPath = sanitizeRemoteRelativePath(targetDirectoryPath);
  const segments = normalizedDirectoryPath.split('/');
  const headers = {
    authorization: basicAuthHeader(config.webdavUsername, config.webdavPassword),
  };
  let current = '';

  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const response = await fetchWithOutboundProxy(
      `${config.webdavUrl}/${encodePathSegments(current)}`,
      {
        method: 'MKCOL',
        headers,
      },
      {
        timeoutMs: 20000,
      },
    );

    if (![200, 201, 204, 301, 405].includes(response.status)) {
      const text = trimString(await response.text());
      throw new Error(
        `WebDAV 目录创建失败（${response.status}）${text ? `：${text.slice(0, 160)}` : '。'}`,
      );
    }
  }
}

async function uploadToS3(config, localPath, remotePath, contentType = '') {
  const client = new S3Client({
    region: config.s3Region,
    endpoint: config.s3Endpoint || undefined,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3Secret,
    },
  });

  await client.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: remotePath,
      Body: fs.createReadStream(localPath),
      ContentType: contentType || undefined,
    }),
  );

  return {
    provider: 's3',
    remotePath,
    remoteUrl:
      config.s3Endpoint && config.s3Bucket
        ? `${config.s3Endpoint.replace(/\/+$/g, '')}/${config.s3Bucket}/${encodePathSegments(remotePath)}`
        : '',
  };
}

async function uploadToWebdav(config, localPath, remotePath, contentType = '') {
  const remoteDirectory = path.posix.dirname(remotePath);
  if (remoteDirectory && remoteDirectory !== '.') {
    await ensureWebdavDirectory(config, remoteDirectory);
  }

  const response = await fetchWithOutboundProxy(
    `${config.webdavUrl}/${encodePathSegments(remotePath)}`,
    {
      method: 'PUT',
      headers: {
        authorization: basicAuthHeader(config.webdavUsername, config.webdavPassword),
        'content-type': contentType || 'application/octet-stream',
      },
      body: fs.createReadStream(localPath),
    },
    {
      timeoutMs: 30000,
    },
  );

  if (!response.ok) {
    const text = trimString(await response.text());
    throw new Error(
      `WebDAV 上传失败（${response.status}）${text ? `：${text.slice(0, 160)}` : '。'}`,
    );
  }

  return {
    provider: 'webdav',
    remotePath,
    remoteUrl: `${config.webdavUrl}/${encodePathSegments(remotePath)}`,
  };
}

async function uploadToFtp(config, localPath, remotePath) {
  const client = new ftp.Client(30_000);
  client.ftp.verbose = false;

  try {
    await client.access({
      host: config.ftpHost,
      port: config.ftpPort,
      user: config.ftpUsername,
      password: config.ftpPassword,
      secure: config.ftpSecure,
    });

    const remoteDirectory = path.posix.dirname(remotePath);
    if (remoteDirectory && remoteDirectory !== '.') {
      await client.ensureDir(remoteDirectory);
      await client.cd('/');
    }
    await client.uploadFrom(localPath, remotePath);

    return {
      provider: 'ftp',
      remotePath,
      remoteUrl: `ftp://${config.ftpHost}:${config.ftpPort}/${remotePath}`,
    };
  } finally {
    client.close();
  }
}

async function uploadLocalFileToRemote(settings = {}, localPath = '', relativePath = '', options = {}) {
  const config = validateRemoteStorageConfig(settings);
  if (config.provider === 'local') {
    return {
      provider: 'local',
      remotePath: '',
      remoteUrl: '',
      skipped: true,
    };
  }

  const resolvedLocalPath = path.resolve(localPath);
  if (!fs.existsSync(resolvedLocalPath)) {
    throw new Error('要上传的本地文件不存在。');
  }

  const remotePath = buildRemoteStoragePath(config, relativePath);
  if (config.provider === 's3') {
    return uploadToS3(config, resolvedLocalPath, remotePath, trimString(options.contentType));
  }
  if (config.provider === 'webdav') {
    return uploadToWebdav(config, resolvedLocalPath, remotePath, trimString(options.contentType));
  }
  if (config.provider === 'ftp') {
    return uploadToFtp(config, resolvedLocalPath, remotePath);
  }

  return {
    provider: 'local',
    remotePath: '',
    remoteUrl: '',
    skipped: true,
  };
}

async function deleteFromS3(config, remotePath) {
  const client = new S3Client({
    region: config.s3Region,
    endpoint: config.s3Endpoint || undefined,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: {
      accessKeyId: config.s3AccessKey,
      secretAccessKey: config.s3Secret,
    },
  });
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.s3Bucket,
      Key: remotePath,
    }),
  );
}

async function deleteFromWebdav(config, remotePath) {
  const response = await fetchWithOutboundProxy(
    `${config.webdavUrl}/${encodePathSegments(remotePath)}`,
    {
      method: 'DELETE',
      headers: {
        authorization: basicAuthHeader(config.webdavUsername, config.webdavPassword),
      },
    },
    {
      timeoutMs: 20000,
    },
  );

  if (![200, 202, 204, 404].includes(response.status)) {
    const text = trimString(await response.text());
    throw new Error(
      `WebDAV 删除失败（${response.status}）${text ? `：${text.slice(0, 160)}` : '。'}`,
    );
  }
}

async function deleteFromFtp(config, remotePath) {
  const client = new ftp.Client(30_000);
  client.ftp.verbose = false;

  try {
    await client.access({
      host: config.ftpHost,
      port: config.ftpPort,
      user: config.ftpUsername,
      password: config.ftpPassword,
      secure: config.ftpSecure,
    });
    await client.remove(remotePath);
  } catch (error) {
    const text = trimString(error.message || error);
    if (!/not.?found|550/i.test(text)) {
      throw error;
    }
  } finally {
    client.close();
  }
}

async function deleteRemotePath(settings = {}, remotePath = '') {
  const config = validateRemoteStorageConfig(settings);
  if (config.provider === 'local') {
    return false;
  }

  const normalizedRemotePath = sanitizeRemoteRelativePath(remotePath);
  if (config.provider === 's3') {
    await deleteFromS3(config, normalizedRemotePath);
    return true;
  }
  if (config.provider === 'webdav') {
    await deleteFromWebdav(config, normalizedRemotePath);
    return true;
  }
  if (config.provider === 'ftp') {
    await deleteFromFtp(config, normalizedRemotePath);
    return true;
  }

  return false;
}

async function testRemoteStorageConnection(settings = {}) {
  const config = validateRemoteStorageConfig(settings);
  if (config.provider === 'local') {
    const probeId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const localProbeDirectory = path.join(process.cwd(), 'runtime', 'files', '_healthcheck');
    const localProbePath = path.join(localProbeDirectory, `storage-probe-${probeId}.txt`);

    fs.mkdirSync(localProbeDirectory, { recursive: true });
    fs.writeFileSync(
      localProbePath,
      [
        'Mail Union local storage probe',
        `prefix=${config.remotePathPrefix}`,
        `timestamp=${new Date().toISOString()}`,
      ].join('\n'),
      'utf8',
    );

    try {
      fs.unlinkSync(localProbePath);
      return {
        provider: 'local',
        writable: true,
        remotePath: localProbePath,
        remoteUrl: '',
        deleted: true,
        message: '本地附件目录测试通过，系统已成功写入并清理测试文件。',
      };
    } catch (error) {
      throw new Error(`本地附件目录可写，但清理测试文件失败：${String(error.message || error)}`);
    }
  }

  const probeId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const probeRelativePath = `_healthcheck/storage-probe-${probeId}.txt`;
  const probeLocalPath = path.join(os.tmpdir(), `mail-union-storage-probe-${probeId}.txt`);
  const probeContent = [
    'Mail Union remote storage probe',
    `provider=${config.provider}`,
    `prefix=${config.remotePathPrefix}`,
    `timestamp=${new Date().toISOString()}`,
  ].join('\n');

  let uploadResult = null;
  let deleted = false;

  fs.writeFileSync(probeLocalPath, probeContent, 'utf8');

  try {
    uploadResult = await uploadLocalFileToRemote(
      {
        ...settings,
        storageProvider: config.provider,
      },
      probeLocalPath,
      probeRelativePath,
      {
        contentType: 'text/plain; charset=utf-8',
      },
    );

    if (uploadResult?.remotePath) {
      try {
        deleted = await deleteRemotePath(
          {
            ...settings,
            storageProvider: config.provider,
          },
          uploadResult.remotePath,
        );
      } catch (cleanupError) {
        throw new Error(
          `远程连接已打通，但测试探针删除失败：${String(cleanupError.message || cleanupError)}`,
        );
      }
    }

    return {
      provider: config.provider,
      writable: true,
      remotePath: String(uploadResult?.remotePath || '').trim(),
      remoteUrl: String(uploadResult?.remoteUrl || '').trim(),
      deleted,
      message: '远程存储测试通过，已成功上传并清理测试文件。',
    };
  } finally {
    try {
      if (fs.existsSync(probeLocalPath)) {
        fs.unlinkSync(probeLocalPath);
      }
    } catch (_) {
      // Ignore temp probe cleanup failures on the local machine.
    }
  }
}

module.exports = {
  buildRemoteStoragePath,
  deleteRemotePath,
  normalizeStorageProvider,
  normalizeStorageRemotePathPrefix,
  resolveRemoteStorageConfig,
  testRemoteStorageConnection,
  uploadLocalFileToRemote,
  validateRemoteStorageConfig,
};
