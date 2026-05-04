const { fetchWithOutboundProxy } = require('./outbound-network');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_MAIL_SCOPE = 'https://mail.google.com/';
const GOOGLE_OAUTH_SCOPES = ['openid', 'email', 'profile', GOOGLE_MAIL_SCOPE];

function base64UrlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function decodeGoogleIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length < 2) {
    return {};
  }

  try {
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch (_) {
    return {};
  }
}

function buildGoogleAuthorizeUrl(options = {}) {
  const params = new URLSearchParams({
    client_id: String(options.clientId || '').trim(),
    redirect_uri: String(options.redirectUri || '').trim(),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    state: String(options.state || '').trim(),
  });

  if (options.loginHint) {
    params.set('login_hint', String(options.loginHint).trim());
  }

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function readGoogleError(response) {
  let payload = null;

  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  const detail =
    payload?.error_description ||
    payload?.error?.message ||
    payload?.error ||
    response.statusText ||
    'Unknown Google OAuth error.';

  return `${response.status} ${detail}`;
}

async function exchangeGoogleCode(options = {}) {
  const form = new URLSearchParams({
    code: String(options.code || '').trim(),
    client_id: String(options.clientId || '').trim(),
    client_secret: String(options.clientSecret || '').trim(),
    redirect_uri: String(options.redirectUri || '').trim(),
    grant_type: 'authorization_code',
  });

  let response = null;
  try {
    response = await fetchWithOutboundProxy(
      GOOGLE_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
      {
        timeoutMs: 20000,
      },
    );
  } catch (error) {
    throw new Error(
      `Google OAuth2 无法连接到令牌接口，请检查系统设置 -> 外网代理。${String(error?.cause?.message || error?.message || error || '').trim()}`,
    );
  }

  if (!response.ok) {
    throw new Error(`Google 授权换取令牌失败：${await readGoogleError(response)}`);
  }

  return response.json();
}

async function refreshGoogleAccessToken(options = {}) {
  const form = new URLSearchParams({
    client_id: String(options.clientId || '').trim(),
    client_secret: String(options.clientSecret || '').trim(),
    refresh_token: String(options.refreshToken || '').trim(),
    grant_type: 'refresh_token',
  });

  let response = null;
  try {
    response = await fetchWithOutboundProxy(
      GOOGLE_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
      {
        timeoutMs: 20000,
      },
    );
  } catch (error) {
    throw new Error(
      `Google OAuth2 刷新令牌时无法连接到 Google，请检查系统设置 -> 外网代理。${String(error?.cause?.message || error?.message || error || '').trim()}`,
    );
  }

  if (!response.ok) {
    throw new Error(`Google OAuth2 刷新访问令牌失败：${await readGoogleError(response)}`);
  }

  return response.json();
}

function isGoogleOAuthMailbox(mailbox) {
  return String(mailbox?.provider || '').trim().toLowerCase() === 'gmail' &&
    String(mailbox?.authType || '').trim().toLowerCase() === 'gmail_oauth';
}

module.exports = {
  GOOGLE_MAIL_SCOPE,
  GOOGLE_OAUTH_SCOPES,
  buildGoogleAuthorizeUrl,
  decodeGoogleIdToken,
  exchangeGoogleCode,
  isGoogleOAuthMailbox,
  refreshGoogleAccessToken,
};
