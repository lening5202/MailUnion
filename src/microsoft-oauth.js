const { fetchWithOutboundProxy } = require('./outbound-network');

const MICROSOFT_LOGIN_BASE = 'https://login.microsoftonline.com';
const MICROSOFT_DEFAULT_TENANT = 'common';
const MICROSOFT_IMAP_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All';
const MICROSOFT_GRAPH_SCOPE = 'https://graph.microsoft.com/Mail.ReadWrite';
const MICROSOFT_IMAP_SCOPES = ['openid', 'email', 'profile', 'offline_access', MICROSOFT_IMAP_SCOPE];
const MICROSOFT_GRAPH_SCOPES = ['openid', 'email', 'profile', 'offline_access', MICROSOFT_GRAPH_SCOPE];
const MICROSOFT_IMAP_REFRESH_SCOPES = ['offline_access', MICROSOFT_IMAP_SCOPE];
const MICROSOFT_GRAPH_REFRESH_SCOPES = ['offline_access', MICROSOFT_GRAPH_SCOPE];
const MICROSOFT_SCOPE_SETS = {
  imap: MICROSOFT_IMAP_SCOPES,
  graph: MICROSOFT_GRAPH_SCOPES,
};
const MICROSOFT_REFRESH_SCOPE_SETS = {
  imap: MICROSOFT_IMAP_REFRESH_SCOPES,
  graph: MICROSOFT_GRAPH_REFRESH_SCOPES,
};
const MICROSOFT_OAUTH_SCOPES = MICROSOFT_IMAP_SCOPES;

function trimString(value) {
  return String(value || '').trim();
}

function normalizeMicrosoftTenantId(value) {
  return trimString(value) || MICROSOFT_DEFAULT_TENANT;
}

function normalizeMicrosoftScopeSet(value) {
  return String(value || 'imap').trim().toLowerCase() === 'graph' ? 'graph' : 'imap';
}

function buildMicrosoftScopes(options = {}) {
  if (Array.isArray(options.scopes) && options.scopes.length) {
    return options.scopes.map((scope) => trimString(scope)).filter(Boolean);
  }

  return MICROSOFT_SCOPE_SETS[normalizeMicrosoftScopeSet(options.scopeSet)];
}

function buildMicrosoftRefreshScopes(options = {}) {
  if (Array.isArray(options.scopes) && options.scopes.length) {
    return options.scopes.map((scope) => trimString(scope)).filter(Boolean);
  }

  return MICROSOFT_REFRESH_SCOPE_SETS[normalizeMicrosoftScopeSet(options.scopeSet)];
}

function microsoftAuthorizeUrl(tenantId) {
  return `${MICROSOFT_LOGIN_BASE}/${normalizeMicrosoftTenantId(tenantId)}/oauth2/v2.0/authorize`;
}

function microsoftTokenUrl(tenantId) {
  return `${MICROSOFT_LOGIN_BASE}/${normalizeMicrosoftTenantId(tenantId)}/oauth2/v2.0/token`;
}

function base64UrlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function decodeMicrosoftIdToken(idToken) {
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

function buildMicrosoftAuthorizeUrl(options = {}) {
  const params = new URLSearchParams({
    client_id: trimString(options.clientId),
    redirect_uri: trimString(options.redirectUri),
    response_type: 'code',
    response_mode: 'query',
    prompt: trimString(options.prompt) || 'select_account',
    scope: buildMicrosoftScopes(options).join(' '),
    state: trimString(options.state),
  });

  if (options.loginHint) {
    params.set('login_hint', trimString(options.loginHint));
  }

  return `${microsoftAuthorizeUrl(options.tenantId)}?${params.toString()}`;
}

async function readMicrosoftError(response) {
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
    'Unknown Microsoft OAuth error.';

  return `${response.status} ${detail}`;
}

async function exchangeMicrosoftCode(options = {}) {
  const form = new URLSearchParams({
    client_id: trimString(options.clientId),
    code: trimString(options.code),
    redirect_uri: trimString(options.redirectUri),
    grant_type: 'authorization_code',
    scope: buildMicrosoftScopes(options).join(' '),
  });
  const clientSecret = trimString(options.clientSecret);
  if (clientSecret) {
    form.set('client_secret', clientSecret);
  }

  let response = null;
  try {
    response = await fetchWithOutboundProxy(
      microsoftTokenUrl(options.tenantId),
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
      `Microsoft OAuth2 无法连接到令牌接口，请检查系统设置 -> 外网代理。${String(error?.cause?.message || error?.message || error || '').trim()}`,
    );
  }

  if (!response.ok) {
    throw new Error(`Microsoft 授权换取令牌失败：${await readMicrosoftError(response)}`);
  }

  return response.json();
}

async function refreshMicrosoftAccessToken(options = {}) {
  const form = new URLSearchParams({
    client_id: trimString(options.clientId),
    refresh_token: trimString(options.refreshToken),
    grant_type: 'refresh_token',
    scope: buildMicrosoftRefreshScopes(options).join(' '),
  });
  const clientSecret = trimString(options.clientSecret);
  if (clientSecret) {
    form.set('client_secret', clientSecret);
  }

  let response = null;
  try {
    response = await fetchWithOutboundProxy(
      microsoftTokenUrl(options.tenantId),
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
      `Microsoft OAuth2 刷新令牌时无法连接到 Microsoft，请检查系统设置 -> 外网代理。${String(error?.cause?.message || error?.message || error || '').trim()}`,
    );
  }

  if (!response.ok) {
    throw new Error(`Microsoft OAuth2 刷新访问令牌失败：${await readMicrosoftError(response)}`);
  }

  return response.json();
}

function isMicrosoftOAuthMailbox(mailbox) {
  return (
    String(mailbox?.provider || '').trim().toLowerCase() === 'outlook' &&
    String(mailbox?.authType || '').trim().toLowerCase() === 'microsoft_oauth'
  );
}

module.exports = {
  MICROSOFT_DEFAULT_TENANT,
  MICROSOFT_GRAPH_SCOPE,
  MICROSOFT_GRAPH_SCOPES,
  MICROSOFT_GRAPH_REFRESH_SCOPES,
  MICROSOFT_IMAP_SCOPE,
  MICROSOFT_IMAP_SCOPES,
  MICROSOFT_IMAP_REFRESH_SCOPES,
  MICROSOFT_OAUTH_SCOPES,
  buildMicrosoftAuthorizeUrl,
  buildMicrosoftRefreshScopes,
  buildMicrosoftScopes,
  decodeMicrosoftIdToken,
  exchangeMicrosoftCode,
  isMicrosoftOAuthMailbox,
  normalizeMicrosoftScopeSet,
  normalizeMicrosoftTenantId,
  refreshMicrosoftAccessToken,
};
