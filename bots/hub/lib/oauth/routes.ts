const { sanitizeOAuthStatusPayload } = require('./token-redaction');
const {
  getProviderRecord,
  clearProviderToken,
  setProviderCanary,
  setProviderToken,
} = require('./token-store');
const { readLocalCredentialsForProvider } = require('./local-credentials');
const {
  buildAuthorizationUrl,
  buildOAuthProviderConfig,
  exchangeOAuthCode,
  normalizeOAuthToken,
  randomToken,
  refreshOAuthToken,
  sha256Base64Url,
} = require('./oauth-flow');
const { getOpenAiApiKeyStatus, runOpenAiApiKeyCanary } = require('./providers/openai-public-api');
const { getOpenAiCodexOauthStatus, runOpenAiCodexOauthCanary } = require('./providers/openai-codex-oauth');
const { getClaudeCodeCliStatus, runClaudeCodeCliCanary } = require('./providers/claude-code-cli');

type OAuthProvider = 'openai-api-key' | 'openai-codex-oauth' | 'claude-code-cli';
type HubRequest = {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  [key: string]: unknown;
};
type HubResponse = {
  status: (code: number) => HubResponse;
  json: (payload: unknown) => unknown;
};
type ProviderEntry = {
  resolveStatus: () => Promise<unknown> | unknown;
  runCanary: () => Promise<Record<string, unknown>> | Record<string, unknown>;
};
type OAuthConfig = {
  ok: true;
  provider: OAuthProvider;
  publicProviderName?: string;
  authUrl: string;
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  scope?: string;
  audience?: string;
  resource?: string;
  tokenBodyFormat?: string;
};
type OAuthConfigError = {
  ok: false;
  provider?: string;
  error?: string;
  missing?: string[];
  details?: Record<string, unknown>;
};
type OAuthConfigResult = OAuthConfig | OAuthConfigError;
type PendingOAuthState = {
  provider: OAuthProvider;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAtMs: number;
  expiresAtMs: number;
  config: OAuthConfig;
};
type TokenEndpointResponse = {
  ok: boolean;
  status: number;
};
type TokenPayload = Record<string, unknown> & {
  error_description?: string;
  error?: string | { message?: string };
};
type NormalizedTokenResult = {
  ok: boolean;
  error?: string;
  token?: Record<string, unknown> & { expires_at?: string };
};

const pendingOAuthStates = new Map<string, PendingOAuthState>();
const OAUTH_STATE_TTL_MS = Number(process.env.HUB_OAUTH_STATE_TTL_MS || 10 * 60 * 1000);

const PROVIDER_ALIASES: Record<string, OAuthProvider | null> = {
  openai: 'openai-api-key',
  'openai-api-key': 'openai-api-key',
  'openai-codex': 'openai-codex-oauth',
  'openai-codex-oauth': 'openai-codex-oauth',
  claude: 'claude-code-cli',
  'claude-code': 'claude-code-cli',
  'claude-code-oauth': 'claude-code-cli',
  'claude-code-cli': 'claude-code-cli',
  gemini: null,
  'gemini-oauth': null,
};

const PROVIDER_REGISTRY: Record<OAuthProvider, ProviderEntry> = {
  'openai-api-key': {
    resolveStatus: getOpenAiApiKeyStatus,
    runCanary: runOpenAiApiKeyCanary,
  },
  'openai-codex-oauth': {
    resolveStatus: getOpenAiCodexOauthStatus,
    runCanary: runOpenAiCodexOauthCanary,
  },
  'claude-code-cli': {
    resolveStatus: getClaudeCodeCliStatus,
    runCanary: runClaudeCodeCliCanary,
  },
};

function normalizeProvider(raw: unknown): OAuthProvider | null {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return null;
  return PROVIDER_ALIASES[key] || null;
}

function buildOAuthStatusResponse(provider: OAuthProvider, status: unknown, canary: unknown) {
  const record = getProviderRecord(provider);
  const payload = {
    ok: true,
    provider,
    status,
    canary,
    token_store: {
      has_token: Boolean(record?.token),
      updated_at: record?.updatedAt || null,
      metadata: record?.metadata || {},
    },
  };
  return sanitizeOAuthStatusPayload(payload);
}

async function resolveProviderStatus(provider: OAuthProvider) {
  const entry = PROVIDER_REGISTRY[provider];
  if (!entry) return null;
  const status = await entry.resolveStatus();
  return status;
}

async function runProviderCanary(provider: OAuthProvider) {
  const entry = PROVIDER_REGISTRY[provider];
  if (!entry) return null;
  const result = await entry.runCanary();
  setProviderCanary(provider, {
    ok: Boolean(result?.ok),
    ...(result?.error ? { error: String(result.error) } : {}),
    ...(result?.details ? { details: result.details } : {}),
  });
  return result;
}

function isCodexOAuthEnabled() {
  return String(process.env.HUB_ENABLE_OPENAI_CODEX_OAUTH || '').toLowerCase() === 'true';
}

function isOauthFlowProvider(provider: OAuthProvider): boolean {
  return provider === 'openai-codex-oauth' || provider === 'claude-code-cli';
}

function prunePendingOAuthStates(now = Date.now()) {
  for (const [state, entry] of pendingOAuthStates.entries()) {
    if (!entry?.expiresAtMs || entry.expiresAtMs <= now) pendingOAuthStates.delete(state);
  }
}

function createPendingOAuthState(provider: OAuthProvider, config: OAuthConfig) {
  prunePendingOAuthStates();
  const state = randomToken(24);
  const codeVerifier = randomToken(48);
  const codeChallenge = sha256Base64Url(codeVerifier);
  const createdAtMs = Date.now();
  const expiresAtMs = createdAtMs + OAUTH_STATE_TTL_MS;
  pendingOAuthStates.set(state, {
    provider,
    state,
    codeVerifier,
    redirectUri: config.redirectUri,
    createdAtMs,
    expiresAtMs,
    config: {
      provider,
      ok: true,
      publicProviderName: config.publicProviderName,
      authUrl: config.authUrl,
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      scope: config.scope,
      audience: config.audience,
      resource: config.resource,
      tokenBodyFormat: config.tokenBodyFormat,
    },
  });
  return {
    state,
    codeVerifier,
    codeChallenge,
    createdAtMs,
    expiresAtMs,
  };
}

function takePendingOAuthState(provider: OAuthProvider, state: string): PendingOAuthState | null {
  prunePendingOAuthStates();
  const entry = pendingOAuthStates.get(state);
  if (!entry || entry.provider !== provider) return null;
  pendingOAuthStates.delete(state);
  return entry;
}

function oauthFlowConfigErrorResponse(res: HubResponse, configResult: OAuthConfigError) {
  const statusCode = configResult?.error === 'oauth_flow_disabled' ? 403 : 503;
  return res.status(statusCode).json({
    ok: false,
    provider: configResult?.provider || null,
    error: {
      code: configResult?.error || 'oauth_config_missing',
      message: 'Hub OAuth flow is not fully configured for this provider',
      missing: configResult?.missing || [],
    },
    details: configResult?.details || {},
  });
}

function parseBooleanFlag(value: unknown, fallback = false): boolean {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function tokenPayloadErrorMessage(payload: TokenPayload, fallback: string): string {
  const rawError = payload?.error;
  if (payload?.error_description) return String(payload.error_description);
  if (rawError && typeof rawError === 'object' && 'message' in rawError) {
    return String(rawError.message || fallback);
  }
  return String(rawError || fallback);
}

function buildLocalImportOptions(req: HubRequest) {
  const body = req.body || {};
  const query = req.query || {};
  return {
    allowKeychainPrompt: parseBooleanFlag(body.allow_keychain_prompt ?? query.allow_keychain_prompt, false),
    codexHome: body.codex_home || query.codex_home || undefined,
    homeDir: body.home_dir || query.home_dir || undefined,
  };
}

async function oauthStatusRoute(req: HubRequest, res: HubResponse) {
  const provider = normalizeProvider(req.params?.provider);
  if (!provider || !PROVIDER_REGISTRY[provider]) {
    return res.status(404).json({ ok: false, error: { code: 'unknown_provider', message: 'unsupported provider' } });
  }

  const status = await resolveProviderStatus(provider);
  let canary = getProviderRecord(provider)?.canary || null;
  if (String(req.query?.canary || '') === '1') {
    canary = await runProviderCanary(provider);
  }

  return res.json(buildOAuthStatusResponse(provider, status, canary));
}

async function oauthImportLocalRoute(req: HubRequest, res: HubResponse) {
  const provider = normalizeProvider(req.params?.provider);
  if (!provider || !PROVIDER_REGISTRY[provider]) {
    return res.status(404).json({ ok: false, error: { code: 'unknown_provider', message: 'unsupported provider' } });
  }
  if (!['openai-codex-oauth', 'claude-code-cli'].includes(provider)) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 'local_import_not_supported',
        message: `${provider} does not support Hub local CLI credential import`,
      },
    });
  }

  const dryRun = parseBooleanFlag(req.body?.dry_run ?? req.query?.dry_run, false);
  const imported = readLocalCredentialsForProvider(provider, buildLocalImportOptions(req));
  if (!imported.ok || !imported.token) {
    setProviderCanary(provider, {
      ok: false,
      error: imported.error || 'local_import_failed',
      details: imported.details || {},
    });
    return res.status(404).json(sanitizeOAuthStatusPayload({
      ok: false,
      provider,
      dry_run: dryRun,
      error: {
        code: imported.error || 'local_import_failed',
        message: 'Hub local CLI credential source was not found or could not be parsed',
      },
      details: imported.details || {},
    }));
  }

  const metadata = {
    ...(imported.metadata || {}),
    provider,
    imported_at: new Date().toISOString(),
    runtime_enabled: true,
    start_flow_enabled: provider === 'openai-codex-oauth' ? isCodexOAuthEnabled() : null,
  };
  if (!dryRun) {
    setProviderToken(provider, imported.token, metadata);
  }
  setProviderCanary(provider, {
    ok: true,
    details: {
      source: imported.source,
      dry_run: dryRun,
      expires_at: imported.token?.expires_at || null,
    },
  });

  return res.json(sanitizeOAuthStatusPayload({
    ok: true,
    provider,
    dry_run: dryRun,
    imported: !dryRun,
    source: imported.source,
    token: imported.token,
    metadata,
  }));
}

async function oauthStartRoute(req: HubRequest, res: HubResponse) {
  const provider = normalizeProvider(req.params?.provider);
  if (!provider || !PROVIDER_REGISTRY[provider]) {
    return res.status(404).json({ ok: false, error: { code: 'unknown_provider', message: 'unsupported provider' } });
  }

  if (!isOauthFlowProvider(provider)) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 'oauth_start_not_supported',
        message: `${provider} does not support start flow`,
      },
    });
  }

  const configResult = buildOAuthProviderConfig(provider, req);
  if (!configResult.ok) return oauthFlowConfigErrorResponse(res, configResult);

  const pending = createPendingOAuthState(provider, configResult);
  const authUrl = buildAuthorizationUrl(configResult, pending.state, pending.codeChallenge);
  return res.json(sanitizeOAuthStatusPayload({
    ok: true,
    provider,
    mode: 'hub_native_pkce',
    auth_url: authUrl,
    state: pending.state,
    expires_at: new Date(pending.expiresAtMs).toISOString(),
    redirect_uri: configResult.redirectUri,
    scope: configResult.scope,
    code_challenge_method: 'S256',
  }));
}

async function oauthCallbackRoute(req: HubRequest, res: HubResponse) {
  const provider = normalizeProvider(req.params?.provider);
  if (!provider || !PROVIDER_REGISTRY[provider]) {
    return res.status(404).json({ ok: false, error: { code: 'unknown_provider', message: 'unsupported provider' } });
  }

  const receivedState = String(req.query?.state || '');
  const code = String(req.query?.code || '');
  if (!code) {
    return res.status(400).json({ ok: false, error: { code: 'missing_code', message: 'OAuth callback code is required' } });
  }

  const pending = takePendingOAuthState(provider, receivedState);
  if (!receivedState || !pending) {
    return res.status(400).json({ ok: false, error: { code: 'invalid_state', message: 'state mismatch' } });
  }

  try {
    const { response, payload } = await exchangeOAuthCode(pending.config, code, pending.codeVerifier) as {
      response: TokenEndpointResponse;
      payload: TokenPayload;
    };
    if (!response.ok) {
      return res.status(502).json(sanitizeOAuthStatusPayload({
        ok: false,
        provider,
        error: {
          code: 'oauth_exchange_failed',
          message: tokenPayloadErrorMessage(payload, 'token endpoint rejected authorization code').slice(0, 400),
        },
        details: { status: response.status },
      }));
    }

    const normalized = normalizeOAuthToken(provider, payload) as NormalizedTokenResult;
    if (!normalized.ok) {
      return res.status(502).json({
        ok: false,
        provider,
        error: {
          code: normalized.error,
          message: 'token endpoint response did not include a usable access token',
        },
      });
    }

    const metadata = {
      provider,
      provider_name: pending.config.publicProviderName,
      source: 'hub_oauth_authorization_code',
      runtime_enabled: true,
      oauth_flow: 'authorization_code_pkce',
      token_url: pending.config.tokenUrl,
      redirect_uri: pending.config.redirectUri,
      scope: pending.config.scope,
      exchanged_at: new Date().toISOString(),
    };
    setProviderToken(provider, normalized.token, metadata);
    setProviderCanary(provider, {
      ok: true,
      details: {
        source: metadata.source,
        expires_at: normalized.token?.expires_at || null,
      },
    });

    return res.json(sanitizeOAuthStatusPayload({
      ok: true,
      provider,
      stored: true,
      token: normalized.token,
      metadata,
    }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(502).json({
      ok: false,
      provider,
      error: {
        code: 'oauth_exchange_error',
        message: message.slice(0, 400),
      },
    });
  }
}

async function oauthRefreshRoute(req: HubRequest, res: HubResponse) {
  const provider = normalizeProvider(req.params?.provider);
  if (!provider || !PROVIDER_REGISTRY[provider]) {
    return res.status(404).json({ ok: false, error: { code: 'unknown_provider', message: 'unsupported provider' } });
  }

  if (!isOauthFlowProvider(provider)) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 'refresh_not_supported',
        message: `${provider} does not support refresh`,
      },
    });
  }

  const configResult = buildOAuthProviderConfig(provider, req);
  if (!configResult.ok) return oauthFlowConfigErrorResponse(res, configResult);

  const record = getProviderRecord(provider);
  const refreshToken = String(req.body?.refresh_token || record?.token?.refresh_token || '').trim();
  if (!refreshToken) {
    return res.status(400).json({
      ok: false,
      provider,
      error: {
        code: 'missing_refresh_token',
        message: 'No refresh token is available in request body or Hub token store',
      },
    });
  }

  try {
    const { response, payload } = await refreshOAuthToken(configResult, refreshToken) as {
      response: TokenEndpointResponse;
      payload: TokenPayload;
    };
    if (!response.ok) {
      return res.status(502).json(sanitizeOAuthStatusPayload({
        ok: false,
        provider,
        error: {
          code: 'oauth_refresh_failed',
          message: tokenPayloadErrorMessage(payload, 'token endpoint rejected refresh token').slice(0, 400),
        },
        details: { status: response.status },
      }));
    }
    const normalized = normalizeOAuthToken(provider, payload, record?.token || null) as NormalizedTokenResult;
    if (!normalized.ok) {
      return res.status(502).json({
        ok: false,
        provider,
        error: {
          code: normalized.error,
          message: 'token endpoint response did not include a usable access token',
        },
      });
    }
    const metadata = {
      ...(record?.metadata || {}),
      provider,
      provider_name: configResult.publicProviderName,
      source: 'hub_oauth_refresh',
      runtime_enabled: true,
      oauth_flow: 'refresh_token',
      token_url: configResult.tokenUrl,
      refreshed_at: new Date().toISOString(),
    };
    setProviderToken(provider, normalized.token, metadata);
    setProviderCanary(provider, {
      ok: true,
      details: {
        source: metadata.source,
        expires_at: normalized.token?.expires_at || null,
      },
    });

    return res.json(sanitizeOAuthStatusPayload({
      ok: true,
      provider,
      refreshed: true,
      token: normalized.token,
      metadata,
    }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(502).json({
      ok: false,
      provider,
      error: {
        code: 'oauth_refresh_error',
        message: message.slice(0, 400),
      },
    });
  }
}

async function oauthRevokeLocalRoute(req: HubRequest, res: HubResponse) {
  const provider = normalizeProvider(req.params?.provider);
  if (!provider || !PROVIDER_REGISTRY[provider]) {
    return res.status(404).json({ ok: false, error: { code: 'unknown_provider', message: 'unsupported provider' } });
  }
  clearProviderToken(provider);
  return res.json({
    ok: true,
    provider,
    revoked_local: true,
  });
}

module.exports = {
  buildOAuthStatusResponse,
  oauthStatusRoute,
  oauthImportLocalRoute,
  oauthStartRoute,
  oauthCallbackRoute,
  oauthRefreshRoute,
  oauthRevokeLocalRoute,
  _test: {
    pendingOAuthStates,
    prunePendingOAuthStates,
  },
};
