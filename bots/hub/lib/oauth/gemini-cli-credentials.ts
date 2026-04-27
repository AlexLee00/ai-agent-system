const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GEMINI_CLI_CREDENTIALS_RELATIVE_PATH = '.gemini/oauth_creds.json';

function resolveUserPath(input) {
  const raw = String(input || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function defaultGeminiCliCredentialsPath() {
  return path.join(os.homedir(), GEMINI_CLI_CREDENTIALS_RELATIVE_PATH);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function sha256(value) {
  const raw = String(value || '').trim();
  return raw ? crypto.createHash('sha256').update(raw).digest('hex') : '';
}

function emailDomain(email) {
  const raw = String(email || '').trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  return at >= 0 && at < raw.length - 1 ? raw.slice(at + 1) : '';
}

function parseExpiresAt(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const ms = raw > 10_000_000_000 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeScopes(raw) {
  if (Array.isArray(raw)) return raw.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) return raw.trim().split(/\s+/);
  return [];
}

function readGeminiCliCredentials(options = {}) {
  const provider = String(options.provider || process.env.GEMINI_CLI_OAUTH_STORE_PROVIDER || 'gemini-cli-oauth').trim()
    || 'gemini-cli-oauth';
  const filePath = resolveUserPath(
    options.credentialsFile
      || process.env.GEMINI_CLI_OAUTH_CREDS_FILE
      || process.env.GEMINI_OAUTH_CLI_CREDENTIALS_FILE
      || defaultGeminiCliCredentialsPath(),
  );
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: 'gemini_cli_credentials_missing', filePath };
  }

  const payload = readJsonFile(filePath);
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'gemini_cli_credentials_invalid_json', filePath };
  }

  const accessToken = String(payload.access_token || payload.accessToken || '').trim();
  const refreshToken = String(payload.refresh_token || payload.refreshToken || '').trim();
  const expiresAt = parseExpiresAt(payload.expiry_date || payload.expires_at || payload.expiresAt);
  if (!accessToken) return { ok: false, error: 'gemini_cli_access_token_missing', filePath };
  if (!refreshToken) return { ok: false, error: 'gemini_cli_refresh_token_missing', filePath };
  if (!expiresAt) return { ok: false, error: 'gemini_cli_expiry_missing', filePath };

  const idPayload = decodeJwtPayload(payload.id_token || payload.idToken);
  const sub = typeof idPayload?.sub === 'string' ? idPayload.sub.trim() : '';
  const email = typeof idPayload?.email === 'string' ? idPayload.email.trim().toLowerCase() : '';
  const identitySeed = sub || email;
  const scopes = normalizeScopes(payload.scope || payload.scopes);
  const quotaProjectId = String(
    options.projectId
      || process.env.GEMINI_OAUTH_PROJECT_ID
      || process.env.GOOGLE_CLOUD_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
      || payload.quota_project_id
      || payload.project_id
      || '',
  ).trim();

  const token = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    token_type: String(payload.token_type || payload.tokenType || 'Bearer'),
    ...(quotaProjectId ? { quota_project_id: quotaProjectId } : {}),
    ...(scopes.length ? { scopes } : {}),
  };

  const metadata = {
    provider,
    provider_name: 'gemini-cli',
    source: 'gemini_cli_oauth_creds',
    cli_provider: 'google-gemini-cli',
    credential_path: filePath,
    runtime_enabled: true,
    quota_project_configured: Boolean(quotaProjectId),
    ...(quotaProjectId ? { quota_project_id: quotaProjectId } : {}),
    identity_present: Boolean(identitySeed),
    ...(identitySeed ? { account_identity_hash: sha256(identitySeed) } : {}),
    ...(email ? { account_email_hash: sha256(email), account_email_domain: emailDomain(email) } : {}),
  };

  return {
    ok: true,
    source: 'gemini_cli_oauth_creds',
    filePath,
    token,
    metadata,
    expires_at: expiresAt,
    quota_project_configured: Boolean(quotaProjectId),
  };
}

module.exports = {
  defaultGeminiCliCredentialsPath,
  readGeminiCliCredentials,
  resolveUserPath,
};
