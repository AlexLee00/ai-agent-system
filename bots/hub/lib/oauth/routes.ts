const crypto = require('crypto');
const { sanitizeOAuthStatusPayload } = require('./token-redaction');
const {
  getProviderRecord,
  clearProviderToken,
  setProviderCanary,
  setProviderToken,
} = require('./token-store');
const { readLocalCredentialsForProvider } = require('./local-credentials');
const { getOpenAiApiKeyStatus, runOpenAiApiKeyCanary } = require('./providers/openai-api-key');
const { getOpenAiCodexOauthStatus, runOpenAiCodexOauthCanary } = require('./providers/openai-codex-oauth');
const { getClaudeCodeCliStatus, runClaudeCodeCliCanary } = require('./providers/claude-code-cli');

const pendingStateByProvider = new Map();

const PROVIDER_ALIASES = {
  openai: 'openai-api-key',
  'openai-api-key': 'openai-api-key',
  'openai-codex': 'openai-codex-oauth',
  'openai-codex-oauth': 'openai-codex-oauth',
  claude: 'claude-code-cli',
  'claude-code': 'claude-code-cli',
  'claude-code-cli': 'claude-code-cli',
};

const PROVIDER_REGISTRY = {
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

function normalizeProvider(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return null;
  return PROVIDER_ALIASES[key] || null;
}

function buildOAuthStatusResponse(provider, status, canary) {
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

async function resolveProviderStatus(provider) {
  const entry = PROVIDER_REGISTRY[provider];
  if (!entry) return null;
  const status = await entry.resolveStatus();
  return status;
}

async function runProviderCanary(provider) {
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

function parseBooleanFlag(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function buildLocalImportOptions(req) {
  const body = req.body || {};
  const query = req.query || {};
  return {
    allowKeychainPrompt: parseBooleanFlag(body.allow_keychain_prompt ?? query.allow_keychain_prompt, false),
    codexHome: body.codex_home || query.codex_home || undefined,
    homeDir: body.home_dir || query.home_dir || undefined,
  };
}

async function oauthStatusRoute(req, res) {
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

async function oauthImportLocalRoute(req, res) {
  const provider = normalizeProvider(req.params?.provider);
  if (!provider || !PROVIDER_REGISTRY[provider]) {
    return res.status(404).json({ ok: false, error: { code: 'unknown_provider', message: 'unsupported provider' } });
  }
  if (!['openai-codex-oauth', 'claude-code-cli'].includes(provider)) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 'local_import_not_supported',
        message: `${provider} does not support OpenClaw-compatible local import`,
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
        message: 'OpenClaw-compatible local credential source was not found or could not be parsed',
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

async function oauthStartRoute(req, res) {
  const provider = normalizeProvider(req.params?.provider);
  if (!provider || !PROVIDER_REGISTRY[provider]) {
    return res.status(404).json({ ok: false, error: { code: 'unknown_provider', message: 'unsupported provider' } });
  }

  if (provider !== 'openai-codex-oauth') {
    return res.status(400).json({
      ok: false,
      error: {
        code: 'oauth_start_not_supported',
        message: `${provider} does not support start flow`,
      },
    });
  }

  if (!isCodexOAuthEnabled()) {
    return res.status(403).json({
      ok: false,
      error: {
        code: 'experimental_disabled',
        message: 'openai-codex-oauth is disabled (set HUB_ENABLE_OPENAI_CODEX_OAUTH=true)',
      },
    });
  }

  const state = crypto.randomBytes(16).toString('hex');
  pendingStateByProvider.set(provider, state);
  return res.json({
    ok: true,
    provider,
    mode: 'skeleton',
    auth_url: 'https://auth.openai.com/oauth/authorize?response_type=code',
    state,
  });
}

async function oauthCallbackRoute(req, res) {
  const provider = normalizeProvider(req.params?.provider);
  if (!provider || !PROVIDER_REGISTRY[provider]) {
    return res.status(404).json({ ok: false, error: { code: 'unknown_provider', message: 'unsupported provider' } });
  }

  const receivedState = String(req.query?.state || '');
  const expectedState = pendingStateByProvider.get(provider) || '';
  if (!receivedState || !expectedState || receivedState !== expectedState) {
    return res.status(400).json({ ok: false, error: { code: 'invalid_state', message: 'state mismatch' } });
  }
  pendingStateByProvider.delete(provider);

  return res.status(501).json({
    ok: false,
    error: {
      code: 'oauth_exchange_not_implemented',
      message: 'OAuth code exchange skeleton only (Phase 4 pending)',
    },
  });
}

async function oauthRefreshRoute(req, res) {
  const provider = normalizeProvider(req.params?.provider);
  if (!provider || !PROVIDER_REGISTRY[provider]) {
    return res.status(404).json({ ok: false, error: { code: 'unknown_provider', message: 'unsupported provider' } });
  }

  if (provider !== 'openai-codex-oauth') {
    return res.status(400).json({
      ok: false,
      error: {
        code: 'refresh_not_supported',
        message: `${provider} does not support refresh`,
      },
    });
  }

  return res.status(501).json({
    ok: false,
    error: {
      code: 'refresh_not_implemented',
      message: 'refresh flow skeleton only (Phase 4 pending)',
    },
  });
}

async function oauthRevokeLocalRoute(req, res) {
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
};
