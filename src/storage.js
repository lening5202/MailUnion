const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fetchWithOutboundProxy } = require('./outbound-network');

const STORAGE_ROOT = path.join(process.cwd(), 'runtime', 'files');
const STORAGE_ROOT_RESOLVED = path.resolve(STORAGE_ROOT);
const DEFAULT_SITE_LOGO_ASSET_PATH = path.join(process.cwd(), 'public', 'assets', 'brand', 'mail-union-default-logo.png');
const STORAGE_CATEGORIES = ['icons', 'images', 'audio', 'attachments'];
const REMOTE_ASSET_MAX_BYTES = 8 * 1024 * 1024;
const REMOTE_MIRRORABLE_CATEGORIES = new Set(STORAGE_CATEGORIES);

function ensureStorageDirectories() {
  fs.mkdirSync(STORAGE_ROOT_RESOLVED, { recursive: true });
  for (const category of STORAGE_CATEGORIES) {
    fs.mkdirSync(path.join(STORAGE_ROOT_RESOLVED, category), { recursive: true });
  }
}

function sanitizeBaseName(value, fallback = 'file') {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .toLowerCase();

  return normalized || fallback;
}

function extensionFromFilename(filename = '') {
  const extension = path.extname(String(filename || '')).trim().toLowerCase();
  if (!extension || extension.length > 12) {
    return '';
  }

  return extension;
}

function extensionFromContentType(contentType = '') {
  const normalized = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/ogg': '.ogg',
    'audio/mp4': '.m4a',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/zip': '.zip',
  };

  return map[normalized] || '';
}

function inferStorageCategory(contentType = '', filename = '') {
  const normalizedType = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const extension = extensionFromFilename(filename);

  if (
    normalizedType.startsWith('image/') ||
    ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'].includes(extension)
  ) {
    return 'images';
  }

  if (
    normalizedType.startsWith('audio/') ||
    ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(extension)
  ) {
    return 'audio';
  }

  return 'attachments';
}

function normalizeRelativePath(relativePath = '') {
  const normalized = String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .join('/');

  if (!normalized) {
    throw new Error('Stored file path is empty.');
  }

  const absolutePath = path.resolve(STORAGE_ROOT_RESOLVED, ...normalized.split('/'));
  const relativeToRoot = path.relative(STORAGE_ROOT_RESOLVED, absolutePath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error('Stored file path is outside the storage root.');
  }

  return normalized;
}

function absolutePathFromRelative(relativePath = '') {
  const normalized = normalizeRelativePath(relativePath);
  return path.resolve(STORAGE_ROOT_RESOLVED, ...normalized.split('/'));
}

function publicAssetPath(relativePath = '') {
  if (!relativePath) {
    return '';
  }

  const normalized = normalizeRelativePath(relativePath);
  return `/files/${normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function writeBufferAsset(buffer, options = {}) {
  ensureStorageDirectories();

  const contentBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const requestedCategory = String(options.category || '').trim().toLowerCase();
  const category = STORAGE_CATEGORIES.includes(requestedCategory) ? requestedCategory : 'attachments';
  const originalFilename = String(options.filename || '').trim() || 'file';
  const contentType = String(options.contentType || '').trim();
  const prefix = sanitizeBaseName(String(options.prefix || '').trim(), '');
  const baseName = sanitizeBaseName(path.parse(originalFilename).name, 'file');
  const extension =
    extensionFromContentType(contentType) || extensionFromFilename(originalFilename) || '.bin';
  const hash = createHash('sha1')
    .update(contentBuffer)
    .update(String(options.key || ''))
    .digest('hex')
    .slice(0, 16);
  const storedBaseName = [prefix, baseName].filter(Boolean).join('-').slice(0, 80) || 'file';
  const storedFilename = `${storedBaseName}-${hash}${extension}`;
  const relativePath = path.posix.join(category, storedFilename);
  const absolutePath = absolutePathFromRelative(relativePath);

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  if (!fs.existsSync(absolutePath)) {
    fs.writeFileSync(absolutePath, contentBuffer);
  }

  const result = {
    category,
    filename: originalFilename,
    size: contentBuffer.length,
    contentType,
    relativePath,
    publicPath: publicAssetPath(relativePath),
  };

  scheduleRemoteMirror(result, {
    contentType,
    remoteRelativePath:
      String(options.remoteRelativePath || '').trim()
      || path.posix.join(category, path.posix.basename(relativePath)),
  });

  return result;
}

function writeTextAsset(text, options = {}) {
  return writeBufferAsset(Buffer.from(String(text || ''), 'utf8'), options);
}

function parseDataUrl(dataUrl = '') {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
  if (!match) {
    throw new Error('Uploaded logo data is invalid.');
  }

  const contentType = String(match[1] || 'application/octet-stream').trim().toLowerCase();
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  const buffer = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');

  if (!buffer.length) {
    throw new Error('Uploaded logo image is empty.');
  }

  if (buffer.length > REMOTE_ASSET_MAX_BYTES) {
    throw new Error('Uploaded logo image is too large. Please keep it within 8 MB.');
  }

  return {
    buffer,
    contentType,
  };
}

function writeDataUrlAsset(dataUrl, options = {}) {
  const parsed = parseDataUrl(dataUrl);
  return writeBufferAsset(parsed.buffer, {
    ...options,
    contentType: parsed.contentType,
  });
}

async function downloadAssetFromUrl(url, options = {}) {
  const targetUrl = String(url || '').trim();
  if (!targetUrl) {
    throw new Error('Logo image URL cannot be empty.');
  }

  let buffer = null;
  let contentType = '';

  try {
    const response = await fetchWithOutboundProxy(
      targetUrl,
      {
        headers: {
          'user-agent': 'Mail Union/1.0',
        },
      },
      {
        timeoutMs: 20000,
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to download logo image: HTTP ${response.status}.`);
    }

    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
    contentType = response.headers.get('content-type') || '';
  } catch (_) {
    const fallbackResult = await downloadAssetFromUrlWithNode(targetUrl);
    buffer = fallbackResult.buffer;
    contentType = fallbackResult.contentType;
  }

  if (!buffer?.length) {
    throw new Error('Downloaded logo image is empty.');
  }

  if (buffer.length > REMOTE_ASSET_MAX_BYTES) {
    throw new Error('Logo image is too large. Please keep it within 8 MB.');
  }

  let filename = String(options.filename || '').trim() || 'site-logo';
  try {
    const parsedUrl = new URL(targetUrl);
    filename = decodeURIComponent(path.basename(parsedUrl.pathname || '')) || filename;
  } catch (_) {
    // Ignore URL parsing failures and fall back to the provided filename.
  }

  return writeBufferAsset(buffer, {
    ...options,
    filename,
    contentType,
    key: targetUrl,
  });
}

function downloadAssetFromUrlWithNode(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const transport = parsedUrl.protocol === 'http:' ? http : https;
    const request = transport.get(
      targetUrl,
      {
        headers: {
          'user-agent': 'Mail Union/1.0',
        },
        rejectUnauthorized: false,
      },
      (response) => {
        const statusCode = Number(response.statusCode || 0);
        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          response.headers.location &&
          redirectCount < 5
        ) {
          response.resume();
          const nextUrl = new URL(response.headers.location, targetUrl).toString();
          downloadAssetFromUrlWithNode(nextUrl, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`Failed to download logo image: HTTP ${statusCode}.`));
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        response.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > REMOTE_ASSET_MAX_BYTES) {
            request.destroy(new Error('Logo image is too large. Please keep it within 8 MB.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: String(response.headers['content-type'] || '').trim(),
          });
        });
      },
    );

    request.on('error', reject);
  });
}

function siteInitials(siteName = 'Mail Union') {
  const compact = String(siteName || '')
    .replace(/\s+/g, '')
    .trim();
  return (compact.slice(0, 2) || 'MU').toUpperCase();
}

function buildGeneratedSiteIconSvg(siteName = 'Mail Union') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Mail Union">
  <defs>
    <linearGradient id="mail-union-ring-a" x1="18%" y1="22%" x2="86%" y2="78%">
      <stop offset="0%" stop-color="#8ee8ff"/>
      <stop offset="48%" stop-color="#198cff"/>
      <stop offset="100%" stop-color="#0839d6"/>
    </linearGradient>
    <linearGradient id="mail-union-ring-b" x1="10%" y1="76%" x2="92%" y2="24%">
      <stop offset="0%" stop-color="#62dcff"/>
      <stop offset="48%" stop-color="#1168ff"/>
      <stop offset="100%" stop-color="#082ac2"/>
    </linearGradient>
    <linearGradient id="mail-union-envelope" x1="22%" y1="18%" x2="82%" y2="92%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="62%" stop-color="#eaf6ff"/>
      <stop offset="100%" stop-color="#b7dcff"/>
    </linearGradient>
    <linearGradient id="mail-union-check" x1="18%" y1="22%" x2="86%" y2="78%">
      <stop offset="0%" stop-color="#53d8ff"/>
      <stop offset="48%" stop-color="#116cff"/>
      <stop offset="100%" stop-color="#052cce"/>
    </linearGradient>
    <linearGradient id="mail-union-text" x1="28%" y1="0%" x2="78%" y2="100%">
      <stop offset="0%" stop-color="#0b43e6"/>
      <stop offset="100%" stop-color="#23ccff"/>
    </linearGradient>
    <filter id="mail-union-soft-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="22" stdDeviation="20" flood-color="#0b4fd8" flood-opacity="0.22"/>
    </filter>
    <filter id="mail-union-glow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#11a8ff" flood-opacity="0.38"/>
    </filter>
  </defs>
  <g filter="url(#mail-union-soft-shadow)">
    <path d="M310 219C430 132 604 126 745 199" fill="none" stroke="url(#mail-union-ring-a)" stroke-width="34" stroke-linecap="square"/>
    <path d="M338 247C450 170 594 164 713 224" fill="none" stroke="#9decff" stroke-width="13" stroke-linecap="square" opacity="0.68"/>
    <path d="M801 248C873 320 910 418 892 520" fill="none" stroke="url(#mail-union-ring-a)" stroke-width="40" stroke-linecap="square"/>
    <circle cx="786" cy="244" r="30" fill="url(#mail-union-check)" stroke="#82e5ff" stroke-width="4"/>
    <path d="M214 506C196 571 200 629 231 684" fill="none" stroke="url(#mail-union-ring-a)" stroke-width="42" stroke-linecap="square"/>
    <path d="M236 674C331 760 473 800 640 775" fill="none" stroke="url(#mail-union-ring-b)" stroke-width="42" stroke-linecap="square"/>
    <path d="M767 724C833 675 878 604 893 520" fill="none" stroke="#49cdf8" stroke-width="30" stroke-linecap="square"/>
    <path d="M185 666C355 559 600 477 844 421" fill="none" stroke="#0636d5" stroke-width="28" stroke-linecap="round"/>
    <path d="M176 674C354 586 585 512 814 466" fill="none" stroke="#67e3ff" stroke-width="11" stroke-linecap="round" opacity="0.78"/>
    <path d="M220 680L261 635L247 718Z" fill="#0734d8"/>
    <rect x="286" y="320" width="452" height="310" rx="56" fill="url(#mail-union-envelope)" stroke="#dff4ff" stroke-width="6"/>
    <path d="M300 600L461 462C492 436 533 436 563 462L724 600" fill="none" stroke="#4d8de8" stroke-width="10" opacity="0.72"/>
    <path d="M310 356L512 522L714 356" fill="none" stroke="#6aa8ff" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" opacity="0.58"/>
    <path d="M315 344L508 512C521 524 541 523 553 510L710 346" fill="none" stroke="url(#mail-union-check)" stroke-width="48" stroke-linecap="round" stroke-linejoin="round" filter="url(#mail-union-glow)"/>
    <path d="M315 344L508 512C521 524 541 523 553 510L710 346" fill="none" stroke="#55dfff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" opacity="0.52"/>
    <rect x="206" y="348" width="34" height="34" rx="3" fill="#13baf2" opacity="0.86"/>
    <rect x="250" y="316" width="24" height="24" rx="3" fill="#32d0ff" opacity="0.78"/>
    <rect x="248" y="377" width="28" height="28" rx="3" fill="#148cff" opacity="0.82"/>
    <rect x="282" y="348" width="20" height="20" rx="3" fill="#19c5ff" opacity="0.72"/>
    <rect x="244" y="418" width="17" height="17" rx="3" fill="#096dff" opacity="0.72"/>
    <path d="M615 626V687L575 728" fill="none" stroke="#1d83ff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M650 626V700L610 740" fill="none" stroke="#116cff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="615" cy="626" r="10" fill="#4ad6ff" stroke="#1d83ff" stroke-width="4"/>
    <circle cx="650" cy="626" r="10" fill="#4ad6ff" stroke="#116cff" stroke-width="4"/>
    <circle cx="575" cy="728" r="10" fill="#3abfff" stroke="#116cff" stroke-width="4"/>
    <circle cx="610" cy="740" r="10" fill="#3abfff" stroke="#0a4bdb" stroke-width="4"/>
  </g>
  <g>
    <text x="512" y="892" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="66" font-weight="700" letter-spacing="20" fill="url(#mail-union-text)">Mail Union</text>
    <path d="M142 864H226" stroke="url(#mail-union-text)" stroke-width="6" stroke-linecap="round"/>
    <path d="M798 864H882" stroke="url(#mail-union-text)" stroke-width="6" stroke-linecap="round"/>
    <path d="M176 880H226" stroke="#7ce7ff" stroke-width="4" stroke-linecap="round" opacity="0.72"/>
    <path d="M798 880H848" stroke="#7ce7ff" stroke-width="4" stroke-linecap="round" opacity="0.72"/>
  </g>
</svg>`;
}

function saveGeneratedSiteIcon(siteName = 'Mail Union') {
  const title = String(siteName || 'Mail Union').trim() || 'Mail Union';
  if (fs.existsSync(DEFAULT_SITE_LOGO_ASSET_PATH)) {
    return writeBufferAsset(fs.readFileSync(DEFAULT_SITE_LOGO_ASSET_PATH), {
      category: 'icons',
      filename: 'mail-union-default-logo.png',
      contentType: 'image/png',
      prefix: sanitizeBaseName(title, 'site'),
      key: `${title}:default-logo-png`,
    });
  }

  return writeTextAsset(buildGeneratedSiteIconSvg(title), {
    category: 'icons',
    filename: 'site-icon.svg',
    contentType: 'image/svg+xml',
    prefix: sanitizeBaseName(title, 'site'),
    key: title,
  });
}

function resolveStorageRequestPath(urlPathname = '') {
  if (!String(urlPathname || '').startsWith('/files/')) {
    return null;
  }

  try {
    const trimmedPath = String(urlPathname || '').slice('/files/'.length);
    if (!trimmedPath) {
      return null;
    }

    const relativePath = trimmedPath
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
      .join('/');

    return absolutePathFromRelative(relativePath);
  } catch (_) {
    return null;
  }
}

function scheduleRemoteMirror(asset = {}, options = {}) {
  if (!asset?.relativePath || !REMOTE_MIRRORABLE_CATEGORIES.has(String(asset.category || '').trim())) {
    return;
  }

  setImmediate(async () => {
    try {
      const { getSystemSettings } = require('./db');
      const { uploadLocalFileToRemote, normalizeStorageProvider } = require('./remote-storage');
      const systemSettings = getSystemSettings();
      const storageProvider = normalizeStorageProvider(systemSettings.storageProvider);
      const storageSyncPolicy = String(systemSettings.storageSyncPolicy || 'all_local').trim().toLowerCase() || 'all_local';
      if (storageProvider === 'local' || storageSyncPolicy === 'all_local') {
        return;
      }

      if (
        storageSyncPolicy === 'attachments_remote_only'
        && String(asset.category || '').trim().toLowerCase() !== 'attachments'
      ) {
        return;
      }

      const localPath = absolutePathFromRelative(asset.relativePath);
      await uploadLocalFileToRemote(
        systemSettings,
        localPath,
        String(options.remoteRelativePath || asset.relativePath).trim() || asset.relativePath,
        {
          contentType: String(options.contentType || asset.contentType || '').trim(),
        },
      );
    } catch (error) {
      console.warn('[storage] remote mirror skipped:', String(error.message || error));
    }
  });
}

ensureStorageDirectories();

module.exports = {
  STORAGE_ROOT: STORAGE_ROOT_RESOLVED,
  downloadAssetFromUrl,
  inferStorageCategory,
  publicAssetPath,
  resolveStorageRequestPath,
  saveGeneratedSiteIcon,
  writeDataUrlAsset,
  writeBufferAsset,
};
