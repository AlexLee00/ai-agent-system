const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CODEX_CLI_AUTH_FILENAME = 'auth.json';
const CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH = path.join('.claude', '.credentials.json');
const CODEX_KEYCHAIN_SERVICE = 'Codex Auth';
const CLAUDE_CLI_KEYCHAIN_SERVICE = 'Claude Code-credentials';

function resolveUserPath(input) {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolveCodexHomePath(codexHome) {
  const configured = codexHome || process.env.CODEX_HOME || '~/.codex';
  const expanded = resolveUserPath(configured);
  try {
    return fs.realpathSync.native(expanded);
  } catch {
    return expanded;
  }
}

function resolveClaudeCredentialPath(homeDir) {
  return path.join(resolveUserPath(homeDir || '~'), CLAUDE_CLI_CREDENTIALS_RELATIVE_PATH);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function decodeJwtExpiryMs(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload?.exp === 'number' && Number.isFinite(payload.exp) && payload.exp > 0) {
      return payload.exp * 1000;
    }
  } catch {
    return null;
  }
  return null;
}

function toIsoTime(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function computeCodexKeychainAccount(codexHome) {
  return `cli|${crypto.createHash('sha256').update(codexHome).digest('hex').slice(0, 16)}`;
}

function buildKeychainCommand(service, account) {
  const escapedService = String(service).replace(/"/g, '\\"');
  if (!account) return `security find-generic-password -s "${escapedService}" -w`;
  const escapedAccount = String(account).replace(/"/g, '\\"');
  return `security find-generic-password -s "${escapedService}" -a "${escapedAccount}" -w`;
}

function readKeychainJson(service, account, options) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return null;
  if (options.allowKeychainPrompt !== true) return null;

  try {
    const impl = options.execSync || execSync;
    const raw = impl(buildKeychainCommand(service, account), {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(String(raw || '').trim());
  } catch {
    return null;
  }
}

function parseCodexAuthRecord(raw, fallbackExpiryMs) {
  const tokens = raw?.tokens;
  const accessToken = tokens?.access_token;
  const refreshToken = tokens?.refresh_token;
  if (typeof accessToken !== 'string' || !accessToken) return null;
  if (typeof refreshToken !== 'string' || !refreshToken) return null;

  const lastRefreshRaw = raw?.last_refresh;
  const lastRefreshMs = typeof lastRefreshRaw === 'string' || typeof lastRefreshRaw === 'number'
    ? new Date(lastRefreshRaw).getTime()
    : NaN;
  const fallback = Number.isFinite(fallbackExpiryMs)
    ? fallbackExpiryMs
    : (Number.isFinite(lastRefreshMs) ? lastRefreshMs + 3600 * 1000 : Date.now() + 3600 * 1000);
  const expiresMs = decodeJwtExpiryMs(accessToken) || fallback;

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: toIsoTime(expiresMs),
    account_id: typeof tokens?.account_id === 'string' ? tokens.account_id : undefined,
    token_type: 'Bearer',
  };
}

function parseClaudeOauth(rawOauth) {
  if (!rawOauth || typeof rawOauth !== 'object') return null;
  const accessToken = rawOauth.accessToken;
  const refreshToken = rawOauth.refreshToken;
  const expiresAt = rawOauth.expiresAt;
  if (typeof accessToken !== 'string' || !accessToken) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;

  return {
    access_token: accessToken,
    ...(typeof refreshToken === 'string' && refreshToken ? { refresh_token: refreshToken } : {}),
    expires_at: toIsoTime(expiresAt),
    token_type: 'Bearer',
    credential_type: typeof refreshToken === 'string' && refreshToken ? 'oauth' : 'token',
  };
}

function codexSourceMetadata(source, codexHome, authPath, account) {
  return {
    source,
    imported_from: 'hub_local_cli_credentials',
    codex_home: codexHome,
    auth_path: authPath,
    keychain_service: CODEX_KEYCHAIN_SERVICE,
    keychain_account: account,
  };
}

function claudeSourceMetadata(source, credentialPath) {
  return {
    source,
    imported_from: 'hub_local_cli_credentials',
    credential_path: credentialPath,
    keychain_service: CLAUDE_CLI_KEYCHAIN_SERVICE,
    runtime_contract: 'hub_uses_claude_code_cli_adapter_for_calls',
  };
}

function inspectOpenAiCodexLocalSources(options = {}) {
  const codexHome = resolveCodexHomePath(options.codexHome);
  const authPath = path.join(codexHome, CODEX_CLI_AUTH_FILENAME);
  const keychainAccount = computeCodexKeychainAccount(codexHome);
  return {
    codex_home: codexHome,
    auth_path: authPath,
    auth_file_exists: fs.existsSync(authPath),
    keychain_service: CODEX_KEYCHAIN_SERVICE,
    keychain_account: keychainAccount,
    keychain_checked: options.allowKeychainPrompt === true && (options.platform || process.platform) === 'darwin',
  };
}

function inspectClaudeCodeLocalSources(options = {}) {
  const credentialPath = resolveClaudeCredentialPath(options.homeDir);
  return {
    credential_path: credentialPath,
    credential_file_exists: fs.existsSync(credentialPath),
    keychain_service: CLAUDE_CLI_KEYCHAIN_SERVICE,
    keychain_checked: options.allowKeychainPrompt === true && (options.platform || process.platform) === 'darwin',
  };
}

function readOpenAiCodexLocalCredentials(options = {}) {
  const sources = inspectOpenAiCodexLocalSources(options);
  const keychainRaw = readKeychainJson(CODEX_KEYCHAIN_SERVICE, sources.keychain_account, options);
  const keychainToken = parseCodexAuthRecord(keychainRaw, null);
  if (keychainToken) {
    return {
      ok: true,
      provider: 'openai-codex-oauth',
      source: 'codex_keychain',
      token: keychainToken,
      metadata: codexSourceMetadata('codex_keychain', sources.codex_home, sources.auth_path, sources.keychain_account),
    };
  }

  const fileRaw = readJsonFile(sources.auth_path);
  let fileFallbackExpiry = Date.now() + 3600 * 1000;
  try {
    fileFallbackExpiry = fs.statSync(sources.auth_path).mtimeMs + 3600 * 1000;
  } catch {
    // Keep a conservative one-hour fallback when the token payload lacks exp.
  }
  const fileToken = parseCodexAuthRecord(fileRaw, fileFallbackExpiry);
  if (fileToken) {
    return {
      ok: true,
      provider: 'openai-codex-oauth',
      source: 'codex_auth_file',
      token: fileToken,
      metadata: codexSourceMetadata('codex_auth_file', sources.codex_home, sources.auth_path, sources.keychain_account),
    };
  }

  return {
    ok: false,
    provider: 'openai-codex-oauth',
    error: 'missing_local_credentials',
    details: sources,
  };
}

function readClaudeCodeLocalCredentials(options = {}) {
  const sources = inspectClaudeCodeLocalSources(options);
  const keychainRaw = readKeychainJson(CLAUDE_CLI_KEYCHAIN_SERVICE, undefined, options);
  const keychainToken = parseClaudeOauth(keychainRaw?.claudeAiOauth);
  if (keychainToken) {
    return {
      ok: true,
      provider: 'claude-code-cli',
      source: 'claude_keychain',
      token: keychainToken,
      metadata: claudeSourceMetadata('claude_keychain', sources.credential_path),
    };
  }

  const fileRaw = readJsonFile(sources.credential_path);
  const fileToken = parseClaudeOauth(fileRaw?.claudeAiOauth);
  if (fileToken) {
    return {
      ok: true,
      provider: 'claude-code-cli',
      source: 'claude_credentials_file',
      token: fileToken,
      metadata: claudeSourceMetadata('claude_credentials_file', sources.credential_path),
    };
  }

  return {
    ok: false,
    provider: 'claude-code-cli',
    error: 'missing_local_credentials',
    details: sources,
  };
}

function readLocalCredentialsForProvider(provider, options = {}) {
  if (provider === 'openai-codex-oauth') return readOpenAiCodexLocalCredentials(options);
  if (provider === 'claude-code-cli') return readClaudeCodeLocalCredentials(options);
  return {
    ok: false,
    provider,
    error: 'local_import_not_supported',
    details: { provider },
  };
}

module.exports = {
  computeCodexKeychainAccount,
  inspectOpenAiCodexLocalSources,
  inspectClaudeCodeLocalSources,
  readOpenAiCodexLocalCredentials,
  readClaudeCodeLocalCredentials,
  readLocalCredentialsForProvider,
};
