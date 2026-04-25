const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getProviderRecord } = require('../token-store');
const {
  inspectClaudeCodeLocalSources,
  readClaudeCodeLocalCredentials,
} = require('../local-credentials');

function resolveCredentialPath() {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

function detectClaudeCli() {
  try {
    const version = spawnSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      available: version.status === 0,
      version: String(version.stdout || '').trim() || null,
      error: version.status === 0 ? null : (String(version.stderr || '').trim() || `exit_${version.status}`),
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      error: error?.message || String(error),
    };
  }
}

async function getClaudeCodeCliStatus() {
  const record = getProviderRecord('claude-code-cli');
  const credentialPath = resolveCredentialPath();
  const credentialFileExists = fs.existsSync(credentialPath);
  const cli = detectClaudeCli();
  const hasToken = Boolean(record?.token?.access_token);

  return {
    provider: 'claude-code-cli',
    stable_default: true,
    experimental: false,
    source: 'local_cli',
    credential_file_exists: credentialFileExists,
    credential_path: credentialPath,
    local_sources: inspectClaudeCodeLocalSources({ allowKeychainPrompt: false }),
    cli_available: cli.available,
    cli_version: cli.version,
    cli_error: cli.error,
    has_token: hasToken,
    token: record?.token || null,
    metadata: record?.metadata || {},
    canary: record?.canary || null,
  };
}

async function runClaudeCodeCliCanary() {
  const status = await getClaudeCodeCliStatus();
  if (!status.cli_available) {
    return {
      ok: false,
      error: 'claude_cli_unavailable',
      details: { cli_error: status.cli_error || 'unknown' },
    };
  }
  if (status.has_token) {
    return {
      ok: true,
      details: {
        cli_version: status.cli_version || 'unknown',
        importable: true,
        source: status.metadata?.source || 'hub_token_store',
      },
    };
  }
  if (!status.credential_file_exists) {
    const local = readClaudeCodeLocalCredentials({ allowKeychainPrompt: false });
    if (!local.ok) {
      return {
        ok: false,
        error: 'claude_credentials_missing',
        details: { credential_path: status.credential_path, local_sources: local.details || status.local_sources },
      };
    }
  }
  return {
    ok: true,
    details: {
      cli_version: status.cli_version || 'unknown',
      importable: true,
      source: readClaudeCodeLocalCredentials({ allowKeychainPrompt: false }).source || 'claude_credentials_file',
    },
  };
}

module.exports = {
  getClaudeCodeCliStatus,
  runClaudeCodeCliCanary,
};
