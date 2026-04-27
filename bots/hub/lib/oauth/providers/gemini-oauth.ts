const { getProviderRecord } = require('../token-store');

function isGeminiOAuthEnabled() {
  return ['1', 'true', 'yes', 'y', 'on'].includes(
    String(process.env.HUB_ENABLE_GEMINI_OAUTH || '').trim().toLowerCase(),
  );
}

function parseExpiryMs(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Date.parse(String(value));
}

function getGeminiOAuthProjectId(record) {
  return String(
    process.env.GEMINI_OAUTH_PROJECT_ID
      || process.env.GOOGLE_CLOUD_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
      || record?.metadata?.quota_project_id
      || record?.metadata?.project_id
      || record?.token?.quota_project_id
      || record?.token?.project_id
      || '',
  ).trim();
}

function getGeminiOAuthBaseUrl() {
  return String(process.env.GEMINI_OAUTH_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
}

async function getGeminiOauthStatus() {
  const record = getProviderRecord('gemini-oauth');
  const token = record?.token || null;
  const expiresAt = token?.expires_at || token?.expiresAt || null;
  const expiresMs = parseExpiryMs(expiresAt);
  const expired = Number.isFinite(expiresMs) ? expiresMs <= Date.now() : false;
  const hasToken = Boolean(token?.access_token);
  const projectId = getGeminiOAuthProjectId(record);
  const startFlowEnabled = isGeminiOAuthEnabled();

  return {
    provider: 'gemini-oauth',
    stable_default: false,
    experimental: true,
    enabled: startFlowEnabled || hasToken,
    start_flow_enabled: startFlowEnabled,
    has_token: hasToken,
    expired,
    quota_project_configured: Boolean(projectId),
    token,
    metadata: record?.metadata || {},
    canary: record?.canary || null,
  };
}

async function runGeminiOauthCanary() {
  const status = await getGeminiOauthStatus();
  if (!status.enabled) {
    return { ok: false, skipped: true, error: 'gemini_oauth_disabled', details: { enabled: false } };
  }
  if (!status.has_token) {
    return { ok: false, error: 'missing_token', details: { enabled: true } };
  }
  if (status.expired) {
    return { ok: false, error: 'token_expired', details: { enabled: true } };
  }

  const record = getProviderRecord('gemini-oauth');
  const projectId = getGeminiOAuthProjectId(record);
  if (!projectId) {
    return {
      ok: false,
      error: 'missing_quota_project',
      details: {
        enabled: true,
        required_env: ['GEMINI_OAUTH_PROJECT_ID', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_CLOUD_PROJECT'],
      },
    };
  }

  const baseUrl = getGeminiOAuthBaseUrl();
  const endpoint = 'v1/models';
  const url = `${baseUrl}/${endpoint}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${status.token.access_token}`,
        Accept: 'application/json',
        'x-goog-user-project': projectId,
      },
      signal: AbortSignal.timeout(Number(process.env.GEMINI_OAUTH_CANARY_TIMEOUT_MS || 15_000)),
    });
    const payload = await response.json().catch(() => ({}));
    const message = String(payload?.error?.message || payload?.message || '').slice(0, 400);
    const models = Array.isArray(payload?.models) ? payload.models.length : null;
    return {
      ok: response.ok,
      ...(response.ok ? {} : { error: 'gemini_oauth_canary_failed' }),
      details: {
        enabled: true,
        source: status.metadata?.source || 'hub_token_store',
        canary_mode: 'gemini_oauth_models_list',
        endpoint,
        status: response.status,
        quota_project_configured: true,
        ...(models != null ? { model_count: models } : {}),
        ...(message ? { message } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: 'gemini_oauth_canary_error',
      details: {
        enabled: true,
        canary_mode: 'gemini_oauth_models_list',
        endpoint,
        quota_project_configured: true,
        message: String(error?.message || error).slice(0, 400),
      },
    };
  }
}

module.exports = {
  getGeminiOauthStatus,
  runGeminiOauthCanary,
};
