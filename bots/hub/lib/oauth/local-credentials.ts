const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

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
    id_token: typeof tokens?.id_token === 'string' ? tokens.id_token : undefined,
    token_type: 'Bearer',
  };
}

function buildCodexAuthRecord(token, previousRaw = {}) {
  const accessToken = token?.access_token || token?.accessToken;
  const refreshToken = token?.refresh_token || token?.refreshToken || previousRaw?.tokens?.refresh_token;
  const accountId = token?.account_id || token?.accountId || previousRaw?.tokens?.account_id;
  const idToken = token?.id_token || token?.idToken || previousRaw?.tokens?.id_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    return { ok: false, error: 'missing_access_token' };
  }
  if (typeof refreshToken !== 'string' || !refreshToken) {
    return { ok: false, error: 'missing_refresh_token' };
  }

  return {
    ok: true,
    auth: {
      ...previousRaw,
      auth_mode: previousRaw?.auth_mode || 'chatgpt',
      tokens: {
        ...(previousRaw?.tokens || {}),
        access_token: accessToken,
        refresh_token: refreshToken,
        ...(typeof accountId === 'string' && accountId ? { account_id: accountId } : {}),
        ...(typeof idToken === 'string' && idToken ? { id_token: idToken } : {}),
      },
      last_refresh: new Date().toISOString(),
    },
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
    ...(Array.isArray(rawOauth.scopes) && rawOauth.scopes.length ? { scopes: rawOauth.scopes.filter(Boolean).map(String) } : {}),
    ...(typeof rawOauth.subscriptionType === 'string' && rawOauth.subscriptionType ? { subscription_type: rawOauth.subscriptionType } : {}),
    ...(typeof rawOauth.rateLimitTier === 'string' && rawOauth.rateLimitTier ? { rate_limit_tier: rawOauth.rateLimitTier } : {}),
  };
}

function buildClaudeKeychainOauth(token, previousOauth = {}) {
  const accessToken = token?.access_token || token?.accessToken;
  const expiresAtRaw = token?.expires_at || token?.expiresAt;
  const expiresAtMs = typeof expiresAtRaw === 'number'
    ? expiresAtRaw
    : new Date(expiresAtRaw || 0).getTime();
  if (typeof accessToken !== 'string' || !accessToken) {
    return { ok: false, error: 'missing_access_token' };
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
    return { ok: false, error: 'missing_expires_at' };
  }

  const refreshToken = token?.refresh_token || token?.refreshToken || previousOauth?.refreshToken || '';
  const scopes = Array.isArray(token?.scopes)
    ? token.scopes
    : (Array.isArray(previousOauth?.scopes) ? previousOauth.scopes : undefined);
  const subscriptionType = token?.subscription_type || token?.subscriptionType || previousOauth?.subscriptionType;
  const rateLimitTier = token?.rate_limit_tier || token?.rateLimitTier || previousOauth?.rateLimitTier;

  return {
    ok: true,
    oauth: {
      accessToken,
      ...(typeof refreshToken === 'string' && refreshToken ? { refreshToken } : {}),
      expiresAt: expiresAtMs,
      ...(scopes?.length ? { scopes: scopes.filter(Boolean).map(String) } : {}),
      ...(subscriptionType ? { subscriptionType } : {}),
      ...(rateLimitTier ? { rateLimitTier } : {}),
    },
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

function writeJsonFileAtomic(filePath, payload, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode });
  fs.renameSync(tmpFile, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Best effort for filesystems that do not support chmod.
  }
}

function writeOpenAiCodexLocalCredentials(token, options = {}) {
  if (options.allowFileWrite !== true) {
    return { ok: false, error: 'local_file_write_not_allowed' };
  }

  const codexHome = resolveCodexHomePath(options.codexHome);
  const authPath = path.join(codexHome, CODEX_CLI_AUTH_FILENAME);
  const previousRaw = readJsonFile(authPath) || {};
  const normalized = buildCodexAuthRecord(token, previousRaw);
  if (!normalized.ok) return normalized;

  try {
    writeJsonFileAtomic(authPath, normalized.auth, 0o600);
    return {
      ok: true,
      source: 'codex_auth_file',
      auth_path: authPath,
      codex_home: codexHome,
    };
  } catch (error) {
    return {
      ok: false,
      source: 'codex_auth_file',
      error: String(error?.message || error).slice(0, 240),
    };
  }
}

function writeClaudeCodeLocalCredentials(token, options = {}) {
  if (options.allowFileWrite !== true) {
    return { ok: false, error: 'local_file_write_not_allowed' };
  }

  const credentialPath = resolveClaudeCredentialPath(options.homeDir);
  const previousRaw = readJsonFile(credentialPath) || {};
  const normalized = buildClaudeKeychainOauth(token, previousRaw?.claudeAiOauth || {});
  if (!normalized.ok) return normalized;

  try {
    writeJsonFileAtomic(credentialPath, {
      ...previousRaw,
      claudeAiOauth: normalized.oauth,
    }, 0o600);
    return {
      ok: true,
      source: 'claude_credentials_file',
      credential_path: credentialPath,
      expires_at: toIsoTime(normalized.oauth.expiresAt),
    };
  } catch (error) {
    return {
      ok: false,
      source: 'claude_credentials_file',
      error: String(error?.message || error).slice(0, 240),
    };
  }
}

function writeClaudeCodeKeychainCredentials(token, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') {
    return { ok: false, error: 'keychain_not_supported' };
  }
  if (options.allowKeychainPrompt !== true) {
    return { ok: false, error: 'keychain_write_not_allowed' };
  }

  const previousRaw = readKeychainJson(CLAUDE_CLI_KEYCHAIN_SERVICE, undefined, options) || {};
  const normalized = buildClaudeKeychainOauth(token, previousRaw?.claudeAiOauth || {});
  if (!normalized.ok) return normalized;

  const account = options.account || os.userInfo().username || 'claude-code';
  const payload = {
    ...previousRaw,
    claudeAiOauth: normalized.oauth,
  };

  try {
    const impl = options.execFileSync || execFileSync;
    impl('security', [
      'add-generic-password',
      '-s',
      CLAUDE_CLI_KEYCHAIN_SERVICE,
      '-a',
      account,
      '-w',
      JSON.stringify(payload),
      '-U',
    ], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      ok: true,
      source: 'claude_keychain',
      keychain_service: CLAUDE_CLI_KEYCHAIN_SERVICE,
      keychain_account: account,
      expires_at: toIsoTime(normalized.oauth.expiresAt),
    };
  } catch (error) {
    return {
      ok: false,
      source: 'claude_keychain',
      error: String(error?.message || error).slice(0, 240),
    };
  }
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
  writeOpenAiCodexLocalCredentials,
  writeClaudeCodeLocalCredentials,
  writeClaudeCodeKeychainCredentials,
  readLocalCredentialsForProvider,
};
