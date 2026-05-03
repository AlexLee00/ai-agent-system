'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function makeJwt(expSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

describe('Hub local OAuth import', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-oauth-import-'));
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.HUB_OAUTH_STORE_FILE;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('reads OpenAI Codex OAuth from ~/.codex/auth.json-compatible file', () => {
    const codexHome = path.join(tempRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: makeJwt(1893456000),
        refresh_token: 'codex-refresh-token',
        account_id: 'acct_123',
      },
      last_refresh: '2026-04-25T00:00:00.000Z',
    }), 'utf8');

    const { readOpenAiCodexLocalCredentials } = require('../lib/oauth/local-credentials.ts');
    const result = readOpenAiCodexLocalCredentials({ codexHome, allowKeychainPrompt: false });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('codex_auth_file');
    expect(result.token.access_token).toContain('.sig');
    expect(result.token.refresh_token).toBe('codex-refresh-token');
    expect(result.token.account_id).toBe('acct_123');
    expect(result.token.expires_at).toBe('2030-01-01T00:00:00.000Z');
  });

  test('uses Codex Keychain service/account when explicitly allowed', () => {
    const codexHome = path.join(tempRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const execSync = jest.fn(() => JSON.stringify({
      tokens: {
        access_token: makeJwt(1893456000),
        refresh_token: 'kc-refresh-token',
      },
      last_refresh: '2026-04-25T00:00:00.000Z',
    }));

    const {
      computeCodexKeychainAccount,
      readOpenAiCodexLocalCredentials,
    } = require('../lib/oauth/local-credentials.ts');
    const result = readOpenAiCodexLocalCredentials({
      codexHome,
      allowKeychainPrompt: true,
      platform: 'darwin',
      execSync,
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('codex_keychain');
    expect(result.token.refresh_token).toBe('kc-refresh-token');
    const resolvedCodexHome = fs.realpathSync.native(codexHome);
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining(`security find-generic-password -s "Codex Auth" -a "${computeCodexKeychainAccount(resolvedCodexHome)}" -w`),
      expect.any(Object),
    );
  });

  test('writes refreshed OpenAI Codex OAuth back to auth.json shape', () => {
    const codexHome = path.join(tempRoot, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const authPath = path.join(codexHome, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        access_token: 'old-codex-access-token',
        refresh_token: 'old-codex-refresh-token',
        account_id: 'acct_existing',
        id_token: 'old-id-token',
      },
      last_refresh: '2026-04-25T00:00:00.000Z',
    }), 'utf8');

    const { writeOpenAiCodexLocalCredentials } = require('../lib/oauth/local-credentials.ts');
    const result = writeOpenAiCodexLocalCredentials({
      access_token: 'new-codex-access-token',
      refresh_token: 'new-codex-refresh-token',
      account_id: 'acct_new',
      id_token: 'new-id-token',
    }, {
      codexHome,
      allowFileWrite: true,
    });

    expect(result.ok).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    expect(persisted.auth_mode).toBe('chatgpt');
    expect(persisted.OPENAI_API_KEY).toBe(null);
    expect(persisted.tokens.access_token).toBe('new-codex-access-token');
    expect(persisted.tokens.refresh_token).toBe('new-codex-refresh-token');
    expect(persisted.tokens.account_id).toBe('acct_new');
    expect(persisted.tokens.id_token).toBe('new-id-token');
    expect(new Date(persisted.last_refresh).getTime()).toBeGreaterThan(0);
  });

  test('reads Claude Code OAuth from ~/.claude/.credentials.json-compatible file', () => {
    const homeDir = path.join(tempRoot, 'home');
    const claudeDir = path.join(homeDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'claude-access-token',
        refreshToken: 'claude-refresh-token',
        expiresAt: 1893456000000,
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    }), 'utf8');

    const { readClaudeCodeLocalCredentials } = require('../lib/oauth/local-credentials.ts');
    const result = readClaudeCodeLocalCredentials({ homeDir, allowKeychainPrompt: false });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('claude_credentials_file');
    expect(result.token.access_token).toBe('claude-access-token');
    expect(result.token.refresh_token).toBe('claude-refresh-token');
    expect(result.token.expires_at).toBe('2030-01-01T00:00:00.000Z');
    expect(result.token.scopes).toContain('user:inference');
    expect(result.token.subscription_type).toBe('max');
    expect(result.token.rate_limit_tier).toBe('default_claude_max_20x');
  });

  test('writes refreshed Claude Code OAuth back to Keychain shape', () => {
    const execSync = jest.fn(() => JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-claude-access-token',
        refreshToken: 'old-claude-refresh-token',
        expiresAt: 1770000000000,
        scopes: ['user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    }));
    const execFileSync = jest.fn(() => '');

    const { writeClaudeCodeKeychainCredentials } = require('../lib/oauth/local-credentials.ts');
    const result = writeClaudeCodeKeychainCredentials({
      access_token: 'new-claude-access-token',
      refresh_token: 'new-claude-refresh-token',
      expires_at: '2030-01-01T00:00:00.000Z',
      scopes: ['user:profile', 'user:inference'],
      subscription_type: 'max',
      rate_limit_tier: 'default_claude_max_20x',
    }, {
      allowKeychainPrompt: true,
      platform: 'darwin',
      account: 'test-user',
      execSync,
      execFileSync,
    });

    expect(result.ok).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [bin, args] = execFileSync.mock.calls[0];
    expect(bin).toBe('security');
    expect(args.slice(0, 6)).toEqual([
      'add-generic-password',
      '-s',
      'Claude Code-credentials',
      '-a',
      'test-user',
      '-w',
    ]);
    expect(args.at(-1)).toBe('-U');
    const payload = JSON.parse(args[6]);
    expect(payload.claudeAiOauth.accessToken).toBe('new-claude-access-token');
    expect(payload.claudeAiOauth.refreshToken).toBe('new-claude-refresh-token');
    expect(payload.claudeAiOauth.expiresAt).toBe(1893456000000);
    expect(payload.claudeAiOauth.subscriptionType).toBe('max');
    expect(payload.claudeAiOauth.rateLimitTier).toBe('default_claude_max_20x');
  });

  test('writes refreshed Claude Code OAuth back to ~/.claude credentials file', () => {
    const homeDir = path.join(tempRoot, 'claude-home');
    const credentialPath = path.join(homeDir, '.claude', '.credentials.json');
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
    fs.writeFileSync(credentialPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'old-file-access-token',
        refreshToken: 'old-file-refresh-token',
        expiresAt: 1770000000000,
        scopes: ['user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
      preservedField: true,
    }), 'utf8');

    const { writeClaudeCodeLocalCredentials } = require('../lib/oauth/local-credentials.ts');
    const result = writeClaudeCodeLocalCredentials({
      access_token: 'new-file-access-token',
      refresh_token: 'new-file-refresh-token',
      expires_at: '2030-01-01T00:00:00.000Z',
      scopes: ['user:profile', 'user:inference'],
      subscription_type: 'max',
      rate_limit_tier: 'default_claude_max_20x',
    }, {
      homeDir,
      allowFileWrite: true,
    });

    expect(result.ok).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    expect(persisted.preservedField).toBe(true);
    expect(persisted.claudeAiOauth.accessToken).toBe('new-file-access-token');
    expect(persisted.claudeAiOauth.refreshToken).toBe('new-file-refresh-token');
    expect(persisted.claudeAiOauth.expiresAt).toBe(1893456000000);
    expect(persisted.claudeAiOauth.scopes).toContain('user:inference');
    expect((fs.statSync(credentialPath).mode & 0o777).toString(8)).toBe('600');
  });

  test('import-local route stores tokens but redacts response payload', async () => {
    const codexHome = path.join(tempRoot, '.codex');
    const storeFile = path.join(tempRoot, 'token-store.json');
    process.env.HUB_OAUTH_STORE_FILE = storeFile;
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: makeJwt(1893456000),
        refresh_token: 'route-refresh-token',
      },
      last_refresh: '2026-04-25T00:00:00.000Z',
    }), 'utf8');

    const { oauthImportLocalRoute } = require('../lib/oauth/routes.ts');
    const req = {
      params: { provider: 'openai-codex' },
      query: {},
      body: {
        codex_home: codexHome,
        allow_keychain_prompt: false,
      },
    };
    const res = makeRes();
    await oauthImportLocalRoute(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.ok).toBe(true);
    expect(res.payload.imported).toBe(true);
    expect(JSON.stringify(res.payload)).not.toContain('route-refresh-token');

    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    expect(store.providers['openai-codex-oauth'].token.refresh_token).toBe('route-refresh-token');
    expect(store.providers['openai-codex-oauth'].metadata.source).toBe('codex_auth_file');
  });

  test('import-local dry run does not persist tokens', async () => {
    const homeDir = path.join(tempRoot, 'home');
    const claudeDir = path.join(homeDir, '.claude');
    const storeFile = path.join(tempRoot, 'token-store.json');
    process.env.HUB_OAUTH_STORE_FILE = storeFile;
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'dry-claude-access-token',
        expiresAt: 1893456000000,
      },
    }), 'utf8');

    const { oauthImportLocalRoute } = require('../lib/oauth/routes.ts');
    const res = makeRes();
    await oauthImportLocalRoute({
      params: { provider: 'claude' },
      query: {},
      body: {
        home_dir: homeDir,
        dry_run: true,
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.dry_run).toBe(true);
    expect(res.payload.imported).toBe(false);
    expect(JSON.stringify(res.payload)).not.toContain('dry-claude-access-token');
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    expect(store.providers['claude-code-cli'].token || null).toBe(null);
  });
});
