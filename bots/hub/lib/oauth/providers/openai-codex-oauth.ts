const { getProviderRecord } = require('../token-store');
const {
  inspectOpenAiCodexLocalSources,
  readOpenAiCodexLocalCredentials,
} = require('../local-credentials');

function isCodexOAuthEnabled() {
  return String(process.env.HUB_ENABLE_OPENAI_CODEX_OAUTH || '').toLowerCase() === 'true';
}

async function getOpenAiCodexOauthStatus() {
  const record = getProviderRecord('openai-codex-oauth');
  const token = record?.token || null;
  const expiresAt = token?.expires_at || token?.expiresAt || null;
  const now = Date.now();
  const expiresMs = expiresAt ? Date.parse(String(expiresAt)) : NaN;
  const expired = Number.isFinite(expiresMs) ? expiresMs <= now : false;
  const hasToken = Boolean(token?.access_token);
  const startFlowEnabled = isCodexOAuthEnabled();

  return {
    provider: 'openai-codex-oauth',
    stable_default: false,
    experimental: true,
    enabled: startFlowEnabled || hasToken,
    start_flow_enabled: startFlowEnabled,
    has_token: hasToken,
    expired,
    token,
    local_sources: inspectOpenAiCodexLocalSources({ allowKeychainPrompt: false }),
    metadata: record?.metadata || {},
    canary: record?.canary || null,
  };
}

function getOpenAiOAuthCanaryMode() {
  return String(process.env.OPENAI_OAUTH_ENDPOINT_MODE || process.env.OPENAI_OAUTH_API_MODE || 'responses').trim().toLowerCase();
}

function getOpenAiOAuthCanaryModel() {
  return String(process.env.OPENAI_CODEX_OAUTH_CANARY_MODEL || process.env.OPENAI_OAUTH_CANARY_MODEL || 'gpt-5.4-mini').trim();
}

function getOpenAiOAuthBaseUrl() {
  return String(process.env.OPENAI_OAUTH_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

async function runOpenAiApiCanary(token, source) {
  const mode = getOpenAiOAuthCanaryMode();
  const model = getOpenAiOAuthCanaryModel();
  const baseUrl = getOpenAiOAuthBaseUrl();
  const endpoint = mode === 'chat' || mode === 'chat_completions' || mode === 'chat-completions'
    ? 'chat/completions'
    : 'responses';
  const url = `${baseUrl}/${endpoint}`;
  const body = endpoint === 'chat/completions'
    ? {
      model,
      messages: [{ role: 'user', content: 'Reply exactly OK' }],
      max_tokens: 8,
    }
    : {
      model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply exactly OK' }] }],
      max_output_tokens: 8,
    };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.OPENAI_OAUTH_CANARY_TIMEOUT_MS || 15_000)),
    });
    const payload = await response.json().catch(() => ({}));
    const message = String(payload?.error?.message || payload?.message || '').slice(0, 400);
    return {
      ok: response.ok,
      ...(response.ok ? {} : { error: 'api_canary_failed' }),
      details: {
        enabled: true,
        source,
        endpoint,
        model,
        status: response.status,
        ...(message ? { message } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: 'api_canary_error',
      details: {
        enabled: true,
        source,
        endpoint,
        model,
        message: String(error?.message || error).slice(0, 400),
      },
    };
  }
}

async function runOpenAiCodexOauthCanary() {
  const status = await getOpenAiCodexOauthStatus();
  if (!status.enabled) {
    return { ok: false, error: 'experimental_disabled', details: { enabled: false } };
  }
  if (status.expired) {
    return { ok: false, error: 'token_expired', details: { enabled: true } };
  }
  if (status.has_token) {
    return runOpenAiApiCanary(status.token?.access_token, status.metadata?.source || 'hub_token_store');
  }

  const local = readOpenAiCodexLocalCredentials({ allowKeychainPrompt: false });
  if (local.ok) {
    return runOpenAiApiCanary(local.token?.access_token, local.source);
  }
  return {
    ok: false,
    error: 'missing_token',
    details: {
      enabled: true,
      importable: false,
      local_sources: local.details || status.local_sources,
    },
  };
}

module.exports = {
  getOpenAiCodexOauthStatus,
  runOpenAiCodexOauthCanary,
};
