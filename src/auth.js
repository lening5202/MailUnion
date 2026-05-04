const {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require('node:crypto');

const SESSION_COOKIE_NAME = 'mail_union_session';
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TTL_DAYS = Math.max(Number(process.env.SESSION_TTL_DAYS) || 7, 1);
const SESSION_TIMEOUT_UNITS = new Set(['minute', 'hour', 'day', 'month', 'year']);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 4) {
    throw new Error('密码至少需要 4 位。');
  }

  return value;
}

function hashPassword(password) {
  const value = validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(value, salt, PASSWORD_KEY_LENGTH).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const value = String(password || '');
  const [algorithm, salt, expectedHashHex] = String(storedHash || '').split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHashHex) {
    return false;
  }

  const expectedHash = Buffer.from(expectedHashHex, 'hex');
  const actualHash = scryptSync(value, salt, expectedHash.length);
  return timingSafeEqual(actualHash, expectedHash);
}

function createSessionToken() {
  return randomBytes(32).toString('hex');
}

function hashSessionToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function parseCookies(cookieHeader) {
  const cookies = {};
  const source = String(cookieHeader || '');
  if (!source) {
    return cookies;
  }

  for (const part of source.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name) {
      continue;
    }

    cookies[name] = decodeURIComponent(rest.join('=') || '');
  }

  return cookies;
}

function createSessionCookie(token, expiresAt) {
  const expires = new Date(expiresAt);
  const maxAgeSeconds = Math.max(Math.floor((expires.getTime() - Date.now()) / 1000), 0);
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

function clearSessionCookie() {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

function normalizeSessionTimeoutValue(value, fallback = SESSION_TTL_DAYS) {
  const fallbackNumber = Number.isFinite(Number(fallback)) ? Number(fallback) : SESSION_TTL_DAYS;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return Math.max(Math.round(fallbackNumber), 1);
  }

  return Math.min(Math.max(Math.round(numeric), 1), 1000);
}

function normalizeSessionTimeoutUnit(value, fallback = 'day') {
  const fallbackUnit = String(fallback || 'day').trim().toLowerCase();
  const normalized = String(value || fallbackUnit || 'day').trim().toLowerCase();
  if (SESSION_TIMEOUT_UNITS.has(normalized)) {
    return normalized;
  }

  return SESSION_TIMEOUT_UNITS.has(fallbackUnit) ? fallbackUnit : 'day';
}

function addCalendarMonths(date, count) {
  const next = new Date(date.getTime());
  const originalDay = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + count);
  const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(originalDay, maxDay));
  return next;
}

function addCalendarYears(date, count) {
  const next = new Date(date.getTime());
  const originalMonth = next.getMonth();
  const originalDay = next.getDate();
  next.setDate(1);
  next.setFullYear(next.getFullYear() + count, originalMonth, 1);
  const maxDay = new Date(next.getFullYear(), originalMonth + 1, 0).getDate();
  next.setDate(Math.min(originalDay, maxDay));
  return next;
}

function createSessionExpiry(options = {}) {
  const expiresAt = new Date();
  const value = normalizeSessionTimeoutValue(options.value, SESSION_TTL_DAYS);
  const unit = normalizeSessionTimeoutUnit(options.unit, 'day');

  if (unit === 'minute') {
    expiresAt.setMinutes(expiresAt.getMinutes() + value);
  } else if (unit === 'hour') {
    expiresAt.setHours(expiresAt.getHours() + value);
  } else if (unit === 'month') {
    return addCalendarMonths(expiresAt, value).toISOString();
  } else if (unit === 'year') {
    return addCalendarYears(expiresAt, value).toISOString();
  } else {
    expiresAt.setDate(expiresAt.getDate() + value);
  }

  return expiresAt.toISOString();
}

module.exports = {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  createSessionCookie,
  createSessionExpiry,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeEmail,
  normalizeUsername,
  parseCookies,
  validatePassword,
  verifyPassword,
};
