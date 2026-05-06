const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} = require('node:crypto');

const DEFAULT_SECRET = 'development-only-secret';

function getKey() {
  const secret = process.env.APP_SECRET || DEFAULT_SECRET;
  return createHash('sha256').update(secret).digest();
}

function encrypt(plainText) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decrypt(cipherText) {
  try {
    const [ivBase64, tagBase64, payloadBase64] = String(cipherText).split(':');
    const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivBase64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagBase64, 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(payloadBase64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    const wrapped = new Error('Encrypted data cannot be decrypted with the current APP_SECRET.');
    wrapped.code = 'APP_SECRET_DECRYPT_FAILED';
    wrapped.cause = error;
    throw wrapped;
  }
}

function toBase64Url(value) {
  return Buffer.from(String(value || ''), 'utf8')
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function fromBase64Url(value) {
  const normalized = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signTokenPayload(payload) {
  return createHmac('sha256', getKey()).update(String(payload || '')).digest('base64url');
}

function createSignedToken(payload) {
  const serialized = JSON.stringify(payload || {});
  const encodedPayload = toBase64Url(serialized);
  const signature = signTokenPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifySignedToken(token) {
  const [encodedPayload = '', providedSignature = ''] = String(token || '').split('.');
  if (!encodedPayload || !providedSignature) {
    return null;
  }

  const expectedSignature = signTokenPayload(encodedPayload);
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  if (
    expectedBuffer.length !== providedBuffer.length
    || !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return null;
  }

  try {
    return JSON.parse(fromBase64Url(encodedPayload));
  } catch (_) {
    return null;
  }
}

module.exports = {
  createSignedToken,
  DEFAULT_SECRET,
  decrypt,
  encrypt,
  verifySignedToken,
};
