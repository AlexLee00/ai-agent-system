const crypto = require('crypto');

const DEFAULT_OPENAI_CODEX_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const DEFAULT_OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_OAUTH_SCOPE = 'openid profile email offline_access';
const DEFAULT_CLAUDE_CODE_AUTH_URL = 'https://claude.com/cai/oauth/authorize';
const DEFAULT_CLAUDE_CODE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const DEFAULT_CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_CLAUDE_CODE_SCOPE = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
const DEFAULT_GEMINI_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_GEMINI_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_GEMINI_SCOPE = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever';

const PROVIDER_FLOW_CONFIG = {
  'openai-codex-oauth': {
    enabledEnv: ['HUB_ENABLE_OPENAI_CODEX_OAUTH'],
    authUrlEnv: ['HUB_OPENAI_CODEX_OAUTH_AUTH_URL', 'OPENAI_CODEX_OAUTH_AUTH_URL'],
    tokenUrlEnv: ['HUB_OPENAI_CODEX_OAUTH_TOKEN_URL', 'OPENAI_CODEX_OAUTH_TOKEN_URL'],
    clientIdEnv: ['HUB_OPENAI_CODEX_OAUTH_CLIENT_ID', 'OPENAI_CODEX_OAUTH_CLIENT_ID'],
    clientSecretEnv: ['HUB_OPENAI_CODEX_OAUTH_CLIENT_SECRET', 'OPENAI_CODEX_OAUTH_CLIENT_SECRET'],
    redirectUriEnv: ['HUB_OPENAI_CODEX_OAUTH_REDIRECT_URI', 'OPENAI_CODEX_OAUTH_REDIRECT_URI'],
    scopeEnv: ['HUB_OPENAI_CODEX_OAUTH_SCOPES', 'OPENAI_CODEX_OAUTH_SCOPES'],
    defaultAuthUrl: DEFAULT_OPENAI_CODEX_AUTH_URL,
    defaultTokenUrl: DEFAULT_OPENAI_CODEX_TOKEN_URL,
    defaultClientId: '',
    defaultScope: DEFAULT_OAUTH_SCOPE,
    tokenBodyFormat: 'form',
    publicProviderName: 'openai-codex',
  },
  'claude-code-cli': {
    enabledEnv: ['HUB_ENABLE_CLAUDE_CODE_OAUTH'],
    authUrlEnv: ['HUB_CLAUDE_CODE_OAUTH_AUTH_URL', 'CLAUDE_CODE_OAUTH_AUTH_URL'],
    tokenUrlEnv: ['HUB_CLAUDE_CODE_OAUTH_TOKEN_URL', 'CLAUDE_CODE_OAUTH_TOKEN_URL'],
    clientIdEnv: ['HUB_CLAUDE_CODE_OAUTH_CLIENT_ID', 'CLAUDE_CODE_OAUTH_CLIENT_ID'],
    clientSecretEnv: ['HUB_CLAUDE_CODE_OAUTH_CLIENT_SECRET', 'CLAUDE_CODE_OAUTH_CLIENT_SECRET'],
    redirectUriEnv: ['HUB_CLAUDE_CODE_OAUTH_REDIRECT_URI', 'CLAUDE_CODE_OAUTH_REDIRECT_URI'],
    scopeEnv: ['HUB_CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_OAUTH_SCOPES'],
    defaultAuthUrl: DEFAULT_CLAUDE_CODE_AUTH_URL,
    defaultTokenUrl: DEFAULT_CLAUDE_CODE_TOKEN_URL,
    defaultClientId: DEFAULT_CLAUDE_CODE_CLIENT_ID,
    defaultScope: DEFAULT_CLAUDE_CODE_SCOPE,
    tokenBodyFormat: 'json',
    enabledDefault: true,
    publicProviderName: 'claude-code',
  },
  'gemini-oauth': {
    enabledEnv: ['HUB_ENABLE_GEMINI_OAUTH'],
    authUrlEnv: ['HUB_GEMINI_OAUTH_AUTH_URL', 'GEMINI_OAUTH_AUTH_URL'],
    tokenUrlEnv: ['HUB_GEMINI_OAUTH_TOKEN_URL', 'GEMINI_OAUTH_TOKEN_URL'],
    clientIdEnv: ['HUB_GEMINI_OAUTH_CLIENT_ID', 'GEMINI_OAUTH_CLIENT_ID'],
    clientSecretEnv: ['HUB_GEMINI_OAUTH_CLIENT_SECRET', 'GEMINI_OAUTH_CLIENT_SECRET'],
    redirectUriEnv: ['HUB_GEMINI_OAUTH_REDIRECT_URI', 'GEMINI_OAUTH_REDIRECT_URI'],
    scopeEnv: ['HUB_GEMINI_OAUTH_SCOPES', 'GEMINI_OAUTH_SCOPES'],
    defaultAuthUrl: DEFAULT_GEMINI_AUTH_URL,
    defaultTokenUrl: DEFAULT_GEMINI_TOKEN_URL,
    defaultClientId: '',
    defaultScope: DEFAULT_GEMINI_SCOPE,
    tokenBodyFormat: 'form',
    publicProviderName: 'gemini',
  },
};

function envFlag(name) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function firstEnv(names) {
  for (const name of names || []) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function isAbsoluteHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function requestBaseUrl(req) {
  const explicit = String(process.env.HUB_PUBLIC_BASE_URL || process.env.HUB_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;

  const host = typeof req?.get === 'function'
    ? req.get('host')
    : (req?.headers?.host || req?.headers?.Host);
  const proto = typeof req?.get === 'function'
    ? (req.get('x-forwarded-proto') || req.protocol || 'http')
    : (req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http');
  if (host) return `${String(proto).split(',')[0]}://${host}`;
  return 'http://127.0.0.1:7788';
}

function providerPathSegment(provider) {
  if (provider === 'openai-codex-oauth') return 'openai-codex';
  if (provider === 'claude-code-cli') return 'claude-code';
  if (provider === 'gemini-oauth') return 'gemini';
  return provider;
}

function resolveRedirectUri(provider, req, baseConfig) {
  const requestOverride = String(req?.body?.redirect_uri || req?.query?.redirect_uri || '').trim();
  const configured = firstEnv(baseConfig.redirectUriEnv);
  const redirectUri = requestOverride
    || configured
    || `${requestBaseUrl(req)}/hub/oauth/${providerPathSegment(provider)}/callback`;
  return redirectUri;
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function sha256Base64Url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function buildOAuthProviderConfig(provider, req) {
  const template = PROVIDER_FLOW_CONFIG[provider];
  if (!template) {
    return { ok: false, error: 'oauth_flow_not_supported', missing: ['provider'] };
  }

  const enabled = template.enabledDefault === true || template.enabledEnv.some(envFlag);
  const authUrl = firstEnv(template.authUrlEnv) || template.defaultAuthUrl;
  const tokenUrl = firstEnv(template.tokenUrlEnv) || template.defaultTokenUrl;
  const clientId = firstEnv(template.clientIdEnv) || template.defaultClientId || '';
  const clientSecret = firstEnv(template.clientSecretEnv);
  const scope = String(req?.body?.scope || req?.query?.scope || firstEnv(template.scopeEnv) || template.defaultScope).trim();
  const redirectUri = resolveRedirectUri(provider, req, template);
  const audience = String(req?.body?.audience || req?.query?.audience || firstEnv([`HUB_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_AUDIENCE`]) || '').trim();
  const resource = String(req?.body?.resource || req?.query?.resource || firstEnv([`HUB_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_RESOURCE`]) || '').trim();

  const missing = [];
  if (!enabled) missing.push(template.enabledEnv[0]);
  if (!clientId) missing.push(template.clientIdEnv[0]);
  if (!authUrl || !isAbsoluteHttpUrl(authUrl)) missing.push(template.authUrlEnv[0]);
  if (!tokenUrl || !isAbsoluteHttpUrl(tokenUrl)) missing.push(template.tokenUrlEnv[0]);
  if (!redirectUri || !isAbsoluteHttpUrl(redirectUri)) missing.push(template.redirectUriEnv[0] || 'redirect_uri');
  if (missing.length > 0) {
    return {
      ok: false,
      provider,
      error: enabled ? 'oauth_config_missing' : 'oauth_flow_disabled',
      missing,
      details: {
        enabled,
        auth_url_configured: Boolean(authUrl && isAbsoluteHttpUrl(authUrl)),
        token_url_configured: Boolean(tokenUrl && isAbsoluteHttpUrl(tokenUrl)),
        client_id_configured: Boolean(clientId),
        redirect_uri_configured: Boolean(redirectUri && isAbsoluteHttpUrl(redirectUri)),
      },
    };
  }

  return {
    ok: true,
    provider,
    publicProviderName: template.publicProviderName,
    authUrl,
    tokenUrl,
    clientId,
    clientSecret,
    redirectUri,
    scope,
    audience,
    resource,
    tokenBodyFormat: template.tokenBodyFormat || 'form',
  };
}

function buildTokenRequestInit(config, bodyObject, timeoutEnvName) {
  const timeoutMs = Number(process.env[timeoutEnvName] || 20_000);
  if (config.tokenBodyFormat === 'json') {
    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(bodyObject),
      signal: AbortSignal.timeout(timeoutMs),
    };
  }

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(bodyObject)) {
    if (value !== undefined && value !== null && String(value) !== '') body.set(key, String(value));
  }
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  };
}

function buildAuthorizationUrl(config, state, codeChallenge) {
  const url = new URL(config.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (config.scope) url.searchParams.set('scope', config.scope);
  if (config.audience) url.searchParams.set('audience', config.audience);
  if (config.resource) url.searchParams.set('resource', config.resource);
  return url.toString();
}

function normalizeOAuthToken(provider, payload, previousToken = null) {
  const accessToken = payload?.access_token || payload?.accessToken;
  if (typeof accessToken !== 'string' || !accessToken) {
    return { ok: false, error: 'missing_access_token' };
  }

  const refreshToken = payload?.refresh_token || payload?.refreshToken || previousToken?.refresh_token || previousToken?.refreshToken || '';
  const tokenType = payload?.token_type || payload?.tokenType || previousToken?.token_type || 'Bearer';
  const expiresIn = Number(payload?.expires_in ?? payload?.expiresIn ?? NaN);
  const expiresAtRaw = payload?.expires_at || payload?.expiresAt || null;
  const parsedExpiresAtMs = expiresAtRaw ? new Date(expiresAtRaw).getTime() : NaN;
  const expiresAt = Number.isFinite(parsedExpiresAtMs)
    ? new Date(parsedExpiresAtMs).toISOString()
    : (Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : previousToken?.expires_at || previousToken?.expiresAt || null);

  const rawScopes = payload?.scope || payload?.scopes || previousToken?.scopes || null;
  const scopes = Array.isArray(rawScopes)
    ? rawScopes.filter(Boolean).map(String)
    : (typeof rawScopes === 'string' && rawScopes.trim() ? rawScopes.trim().split(/\s+/) : null);

  return {
    ok: true,
    token: {
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(expiresAt ? { expires_at: expiresAt } : {}),
      token_type: tokenType,
      ...(typeof payload?.account_id === 'string' && payload.account_id ? { account_id: payload.account_id } : {}),
      ...(typeof payload?.id_token === 'string' && payload.id_token ? { id_token: payload.id_token } : {}),
      ...(scopes?.length ? { scopes } : {}),
      ...(provider === 'claude-code-cli' && (payload?.subscriptionType || previousToken?.subscription_type || previousToken?.subscriptionType)
        ? { subscription_type: payload?.subscriptionType || previousToken?.subscription_type || previousToken?.subscriptionType }
        : {}),
      ...(provider === 'claude-code-cli' && (payload?.rateLimitTier || previousToken?.rate_limit_tier || previousToken?.rateLimitTier)
        ? { rate_limit_tier: payload?.rateLimitTier || previousToken?.rate_limit_tier || previousToken?.rateLimitTier }
        : {}),
      ...(provider === 'claude-code-cli' ? { credential_type: refreshToken ? 'oauth' : 'token' } : {}),
    },
  };
}

async function exchangeOAuthCode(config, code, codeVerifier) {
  const body = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  };
  if (config.clientSecret) body.client_secret = config.clientSecret;

  const response = await fetch(
    config.tokenUrl,
    buildTokenRequestInit(config, body, 'HUB_OAUTH_TOKEN_EXCHANGE_TIMEOUT_MS'),
  );
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function refreshOAuthToken(config, refreshToken) {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    ...(config.scope ? { scope: config.scope } : {}),
  };
  if (config.clientSecret) body.client_secret = config.clientSecret;

  const response = await fetch(
    config.tokenUrl,
    buildTokenRequestInit(config, body, 'HUB_OAUTH_TOKEN_REFRESH_TIMEOUT_MS'),
  );
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

module.exports = {
  buildAuthorizationUrl,
  buildOAuthProviderConfig,
  exchangeOAuthCode,
  normalizeOAuthToken,
  randomToken,
  refreshOAuthToken,
  sha256Base64Url,
};
