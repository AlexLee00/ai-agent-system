function isSensitiveCredentialKey(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) return false;
  const lower = key.toLowerCase();
  if (lower === 'token') return true;
  if (lower === 'access_token' || lower === 'refresh_token' || lower === 'id_token') return true;
  if (lower === 'secret' || lower === 'client_secret') return true;
  if (lower === 'password') return true;
  if (lower === 'authorization' || lower === 'bearer') return true;
  if (lower === 'api_key' || lower === 'apikey') return true;
  if (/^api[_-]?key/i.test(key)) return true;
  if (/token$/i.test(key) && lower !== 'has_token') return true;
  if (/secret$/i.test(key)) return true;
  return false;
}

function redactString(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 6) return '***';
  const prefix = text.slice(0, 3);
  const suffix = text.slice(-2);
  return `${prefix}...${suffix}`;
}

function redactLeafValue(value) {
  if (typeof value === 'string') return redactString(value);
  if (value == null) return value;
  return '[redacted]';
}

function redactOAuthSecrets(value, forceRedact = false) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    if (forceRedact) return value.map((item) => redactLeafValue(item));
    return value.map((item) => redactOAuthSecrets(item, false));
  }
  if (typeof value !== 'object') {
    return forceRedact ? redactLeafValue(value) : value;
  }

  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    const shouldRedact = forceRedact || isSensitiveCredentialKey(key);
    if (shouldRedact) {
      if (Array.isArray(raw)) output[key] = raw.map((item) => redactLeafValue(item));
      else if (raw && typeof raw === 'object') output[key] = redactOAuthSecrets(raw, true);
      else output[key] = redactLeafValue(raw);
      continue;
    }
    output[key] = redactOAuthSecrets(raw, false);
  }
  return output;
}

function sanitizeOAuthStatusPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const cloned = JSON.parse(JSON.stringify(payload));
  return redactOAuthSecrets(cloned, false);
}

module.exports = {
  redactOAuthSecrets,
  sanitizeOAuthStatusPayload,
};
