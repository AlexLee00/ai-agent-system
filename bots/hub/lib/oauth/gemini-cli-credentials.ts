const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GEMINI_CLI_CREDENTIALS_RELATIVE_PATH = '.gemini/oauth_creds.json';
const GEMINI_CLI_ENCRYPTED_CREDENTIALS_RELATIVE_PATH = '.gemini/gemini-credentials.json';
const GEMINI_CLI_KEYCHAIN_SERVICE = 'gemini-cli-oauth';
const GEMINI_CLI_MAIN_ACCOUNT = 'main-account';
const GEMINI_CLI_KEYTAR_CANDIDATES = [
  process.env.GEMINI_CLI_KEYTAR_MODULE,
  '/opt/homebrew/lib/node_modules/@google/gemini-cli/node_modules/@github/keytar/lib/keytar.js',
  '/usr/local/lib/node_modules/@google/gemini-cli/node_modules/@github/keytar/lib/keytar.js',
].filter(Boolean);

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

function defaultGeminiCliEncryptedCredentialsPath() {
  return path.join(os.homedir(), GEMINI_CLI_ENCRYPTED_CREDENTIALS_RELATIVE_PATH);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureOwnerOnlyFileMode(filePath) {
  try {
    const currentMode = fs.statSync(filePath).mode & 0o777;
    if ((currentMode & 0o077) !== 0) {
      fs.chmodSync(filePath, 0o600);
    }
    const nextMode = fs.statSync(filePath).mode & 0o777;
    return {
      ok: (nextMode & 0o077) === 0,
      mode: nextMode.toString(8).padStart(3, '0'),
    };
  } catch (error) {
    return {
      ok: false,
      mode: null,
      error: String(error?.message || error).slice(0, 160),
    };
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

function sanitizeServerName(serverName) {
  return String(serverName || '').replace(/[^a-zA-Z0-9-_.]/g, '_');
}

function parseCredentialJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function normalizeCredentialPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const tokenPayload = payload.token && typeof payload.token === 'object' ? payload.token : {};
  const accessToken = String(
    payload.access_token
      || payload.accessToken
      || tokenPayload.accessToken
      || tokenPayload.access_token
      || '',
  ).trim();
  const refreshToken = String(
    payload.refresh_token
      || payload.refreshToken
      || tokenPayload.refreshToken
      || tokenPayload.refresh_token
      || '',
  ).trim();
  const expiresAt = parseExpiresAt(
    payload.expiry_date
      || payload.expires_at
      || payload.expiresAt
      || tokenPayload.expiresAt
      || tokenPayload.expires_at
      || tokenPayload.expiry_date,
  );
  if (!accessToken) return { ok: false, error: 'gemini_cli_access_token_missing' };
  if (!refreshToken) return { ok: false, error: 'gemini_cli_refresh_token_missing' };
  if (!expiresAt) return { ok: false, error: 'gemini_cli_expiry_missing' };

  const idPayload = decodeJwtPayload(payload.id_token || payload.idToken || tokenPayload.idToken || tokenPayload.id_token);
  const sub = typeof idPayload?.sub === 'string' ? idPayload.sub.trim() : '';
  const email = typeof idPayload?.email === 'string' ? idPayload.email.trim().toLowerCase() : '';
  const accountName = String(options.account || payload.serverName || '').trim();
  const identitySeed = sub || email || (accountName && accountName !== GEMINI_CLI_MAIN_ACCOUNT ? accountName : '');
  const scopes = normalizeScopes(payload.scope || payload.scopes || tokenPayload.scope || tokenPayload.scopes);
  const quotaProjectId = String(
    options.projectId
      || process.env.GEMINI_OAUTH_PROJECT_ID
      || process.env.GOOGLE_CLOUD_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
      || payload.quota_project_id
      || payload.quotaProjectId
      || payload.project_id
      || payload.projectId
      || tokenPayload.quota_project_id
      || tokenPayload.quotaProjectId
      || '',
  ).trim();

  const token = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    token_type: String(payload.token_type || payload.tokenType || tokenPayload.tokenType || tokenPayload.token_type || 'Bearer'),
    ...(quotaProjectId ? { quota_project_id: quotaProjectId } : {}),
    ...(scopes.length ? { scopes } : {}),
  };

  return {
    ok: true,
    token,
    expires_at: expiresAt,
    quota_project_configured: Boolean(quotaProjectId),
    identity_present: Boolean(identitySeed),
    identity_hash: identitySeed ? sha256(identitySeed) : '',
    email,
    account_name: accountName,
  };
}

function buildCredentialResult(normalized, options = {}) {
  const provider = String(options.provider || process.env.GEMINI_CLI_OAUTH_STORE_PROVIDER || 'gemini-cli-oauth').trim()
    || 'gemini-cli-oauth';
  const fileMode = options.filePath ? ensureOwnerOnlyFileMode(options.filePath) : null;
  const metadata = {
    provider,
    provider_name: 'gemini-cli',
    source: options.source,
    cli_provider: 'google-gemini-cli',
    runtime_enabled: true,
    quota_project_configured: Boolean(normalized.quota_project_configured),
    ...(normalized.token.quota_project_id ? { quota_project_id: normalized.token.quota_project_id } : {}),
    identity_present: Boolean(normalized.identity_present),
    storage_type: options.storageType || options.source,
    ...(options.filePath ? { credential_path: options.filePath } : {}),
    ...(fileMode?.ok != null ? { credential_file_owner_only: Boolean(fileMode.ok) } : {}),
    ...(fileMode?.mode ? { credential_file_mode: fileMode.mode } : {}),
    ...(normalized.identity_hash ? { account_identity_hash: normalized.identity_hash } : {}),
    ...(normalized.email ? { account_email_hash: sha256(normalized.email), account_email_domain: emailDomain(normalized.email) } : {}),
    ...(options.keychain_service ? { keychain_service: options.keychain_service } : {}),
    ...(options.keychain_account ? { keychain_account_hash: sha256(options.keychain_account) } : {}),
  };

  return {
    ok: true,
    source: options.source,
    filePath: options.filePath || null,
    token: normalized.token,
    metadata,
    expires_at: normalized.expires_at,
    quota_project_configured: Boolean(normalized.quota_project_configured),
  };
}

function readLegacyGeminiCliCredentials(options = {}) {
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

  const normalized = normalizeCredentialPayload(payload, options);
  if (!normalized?.ok) {
    return { ok: false, error: normalized?.error || 'gemini_cli_credentials_invalid', filePath };
  }
  return buildCredentialResult(normalized, {
    ...options,
    source: 'gemini_cli_oauth_creds',
    storageType: 'legacy_oauth_file',
    filePath,
  });
}

function decryptGeminiCliEncryptedFile(filePath) {
  const encryptedData = fs.readFileSync(filePath, 'utf8').trim();
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('gemini_cli_encrypted_credentials_invalid_format');
  }
  const salt = `${os.hostname()}-${os.userInfo().username}-gemini-cli`;
  const key = crypto.scryptSync('gemini-cli-oauth', salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
  let decrypted = decipher.update(parts[2], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

function readEncryptedGeminiCliCredentials(options = {}) {
  const filePath = resolveUserPath(
    options.encryptedCredentialsFile
      || process.env.GEMINI_CLI_ENCRYPTED_CREDS_FILE
      || process.env.GEMINI_CLI_ENCRYPTED_CREDENTIALS_FILE
      || defaultGeminiCliEncryptedCredentialsPath(),
  );
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: 'gemini_cli_encrypted_credentials_missing', filePath };
  }

  let data;
  try {
    data = decryptGeminiCliEncryptedFile(filePath);
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error).slice(0, 160) || 'gemini_cli_encrypted_credentials_decrypt_failed',
      filePath,
    };
  }

  const account = sanitizeServerName(options.account || process.env.GEMINI_CLI_OAUTH_ACCOUNT || GEMINI_CLI_MAIN_ACCOUNT);
  const service = String(options.keychainService || process.env.GEMINI_CLI_OAUTH_KEYCHAIN_SERVICE || GEMINI_CLI_KEYCHAIN_SERVICE).trim()
    || GEMINI_CLI_KEYCHAIN_SERVICE;
  const rawCredential = data?.[service]?.[account] || data?.[GEMINI_CLI_KEYCHAIN_SERVICE]?.[account];
  const payload = parseCredentialJson(rawCredential);
  if (!payload) {
    return { ok: false, error: 'gemini_cli_encrypted_credentials_account_missing', filePath };
  }

  const normalized = normalizeCredentialPayload(payload, { ...options, account });
  if (!normalized?.ok) {
    return { ok: false, error: normalized?.error || 'gemini_cli_encrypted_credentials_invalid', filePath };
  }
  return buildCredentialResult(normalized, {
    ...options,
    source: 'gemini_cli_encrypted_credentials',
    storageType: 'encrypted_file',
    filePath,
    keychain_service: service,
    keychain_account: account,
  });
}

function readKeychainGeminiCliCredentials(options = {}) {
  const service = String(options.keychainService || process.env.GEMINI_CLI_OAUTH_KEYCHAIN_SERVICE || GEMINI_CLI_KEYCHAIN_SERVICE).trim()
    || GEMINI_CLI_KEYCHAIN_SERVICE;
  const account = sanitizeServerName(options.account || process.env.GEMINI_CLI_OAUTH_ACCOUNT || GEMINI_CLI_MAIN_ACCOUNT);
  const candidates = [
    options.keytarModule,
    ...GEMINI_CLI_KEYTAR_CANDIDATES,
  ].map((candidate) => String(candidate || '').trim()).filter(Boolean);

  for (const keytarModule of candidates) {
    if (!fs.existsSync(keytarModule)) continue;
    const helper = `
      (async () => {
        const mod = await import(process.env.KEYTAR_MODULE);
        const keytar = mod.default || mod;
        const password = await keytar.getPassword(process.env.KEYTAR_SERVICE, process.env.KEYTAR_ACCOUNT);
        process.stdout.write(JSON.stringify({ ok: Boolean(password), password: password || null }));
      })().catch((error) => {
        process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message || error).slice(0, 160) }));
        process.exitCode = 1;
      });
    `;
    const result = spawnSync(process.execPath, ['-e', helper], {
      encoding: 'utf8',
      timeout: Number(process.env.GEMINI_CLI_KEYCHAIN_READ_TIMEOUT_MS || 3000),
      maxBuffer: 256 * 1024,
      env: {
        ...process.env,
        KEYTAR_MODULE: keytarModule,
        KEYTAR_SERVICE: service,
        KEYTAR_ACCOUNT: account,
      },
    });
    if (result.status !== 0 && !result.stdout) continue;
    const output = parseCredentialJson(result.stdout);
    const payload = parseCredentialJson(output?.password);
    if (!payload) continue;
    const normalized = normalizeCredentialPayload(payload, { ...options, account });
    if (!normalized?.ok) {
      return { ok: false, error: normalized?.error || 'gemini_cli_keychain_credentials_invalid' };
    }
    return buildCredentialResult(normalized, {
      ...options,
      source: 'gemini_cli_keychain',
      storageType: 'keychain',
      keychain_service: service,
      keychain_account: account,
    });
  }

  return { ok: false, error: 'gemini_cli_keychain_credentials_missing' };
}

function readGeminiCliCredentials(options = {}) {
  const attempts = [
    readKeychainGeminiCliCredentials(options),
    readEncryptedGeminiCliCredentials(options),
    readLegacyGeminiCliCredentials(options),
  ];
  const found = attempts.find((attempt) => attempt?.ok);
  if (found) return found;

  return attempts.find((attempt) => attempt?.filePath) || attempts[attempts.length - 1] || {
    ok: false,
    error: 'gemini_cli_credentials_missing',
    filePath: defaultGeminiCliCredentialsPath(),
  };
}

function readGeminiCliCredentialsLegacyOnly(options = {}) {
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

  const fileMode = ensureOwnerOnlyFileMode(filePath);
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
    credential_file_owner_only: Boolean(fileMode.ok),
    ...(fileMode.mode ? { credential_file_mode: fileMode.mode } : {}),
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
  defaultGeminiCliEncryptedCredentialsPath,
  readGeminiCliCredentials,
  readGeminiCliCredentialsLegacyOnly,
  resolveUserPath,
  _testOnly_decryptGeminiCliEncryptedFile: decryptGeminiCliEncryptedFile,
  _testOnly_normalizeCredentialPayload: normalizeCredentialPayload,
};
