const { getProviderRecord } = require('../token-store');

function isOpenAiPublicApiEnabled() {
  return ['1', 'true', 'yes', 'y', 'on'].includes(
    String(process.env.HUB_ENABLE_OPENAI_PUBLIC_API || '').trim().toLowerCase(),
  );
}

async function getOpenAiApiKeyStatus() {
  const record = getProviderRecord('openai-api-key');
  const enabled = isOpenAiPublicApiEnabled();
  const envKey = enabled ? String(process.env.OPENAI_API_KEY || '').trim() : '';
  const storeKey = enabled ? String(record?.token?.api_key || '').trim() : '';
  const hasApiKey = Boolean(envKey || storeKey);

  return {
    provider: 'openai-api-key',
    stable_default: true,
    experimental: false,
    enabled,
    source: envKey ? 'env' : (storeKey ? 'hub_store' : 'missing'),
    has_api_key: hasApiKey,
    token: hasApiKey ? { api_key: envKey || storeKey } : null,
    metadata: record?.metadata || {},
    canary: record?.canary || null,
  };
}

async function runOpenAiApiKeyCanary() {
  const status = await getOpenAiApiKeyStatus();
  if (!status.enabled) {
    return {
      ok: false,
      skipped: true,
      error: 'openai_public_api_disabled',
      details: { source: status.source },
    };
  }
  if (!status.has_api_key) {
    return {
      ok: false,
      error: 'missing_openai_api_key',
      details: { source: status.source },
    };
  }
  return {
    ok: true,
    details: { source: status.source },
  };
}

module.exports = {
  getOpenAiApiKeyStatus,
  runOpenAiApiKeyCanary,
};
