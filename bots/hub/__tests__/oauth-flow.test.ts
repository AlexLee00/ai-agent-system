'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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

function resetOAuthEnv() {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('HUB_OPENAI_CODEX_OAUTH_')
      || key.startsWith('OPENAI_CODEX_OAUTH_')
      || key.startsWith('HUB_CLAUDE_CODE_OAUTH_')
      || key.startsWith('CLAUDE_CODE_OAUTH_')
      || key === 'HUB_ENABLE_OPENAI_CODEX_OAUTH'
      || key === 'HUB_ENABLE_CLAUDE_CODE_OAUTH'
      || key === 'HUB_PUBLIC_BASE_URL'
      || key === 'HUB_BASE_URL'
      || key === 'HUB_OAUTH_STORE_FILE'
    ) {
      delete process.env[key];
    }
  }
}

describe('Hub native OAuth flow', () => {
  let tempRoot;
  let originalFetch;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-oauth-flow-'));
    originalFetch = globalThis.fetch;
    resetOAuthEnv();
    jest.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetOAuthEnv();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function configureOpenAi(storeFile) {
    process.env.HUB_OAUTH_STORE_FILE = storeFile;
    process.env.HUB_ENABLE_OPENAI_CODEX_OAUTH = 'true';
    process.env.HUB_OPENAI_CODEX_OAUTH_CLIENT_ID = 'codex-client-id';
    process.env.HUB_OPENAI_CODEX_OAUTH_AUTH_URL = 'https://auth.openai.test/oauth/authorize';
    process.env.HUB_OPENAI_CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.test/oauth/token';
    process.env.HUB_PUBLIC_BASE_URL = 'https://hub.local';
  }

  function configureClaude(storeFile) {
    process.env.HUB_OAUTH_STORE_FILE = storeFile;
    process.env.HUB_ENABLE_CLAUDE_CODE_OAUTH = 'true';
    process.env.HUB_CLAUDE_CODE_OAUTH_CLIENT_ID = 'claude-client-id';
    process.env.HUB_CLAUDE_CODE_OAUTH_AUTH_URL = 'https://auth.claude.test/oauth/authorize';
    process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN_URL = 'https://auth.claude.test/oauth/token';
    process.env.HUB_PUBLIC_BASE_URL = 'https://hub.local';
  }

  test('OpenAI Codex start/callback exchanges code with PKCE and stores redacted token', async () => {
    const storeFile = path.join(tempRoot, 'token-store.json');
    configureOpenAi(storeFile);
    const { oauthStartRoute, oauthCallbackRoute } = require('../lib/oauth/routes.ts');

    const startRes = makeRes();
    await oauthStartRoute({ params: { provider: 'openai-codex' }, query: {}, body: {} }, startRes);

    expect(startRes.statusCode).toBe(200);
    expect(startRes.payload.mode).toBe('hub_native_pkce');
    expect(startRes.payload.redirect_uri).toBe('https://hub.local/hub/oauth/openai-codex/callback');
    const authUrl = new URL(startRes.payload.auth_url);
    expect(authUrl.origin + authUrl.pathname).toBe('https://auth.openai.test/oauth/authorize');
    expect(authUrl.searchParams.get('client_id')).toBe('codex-client-id');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('state')).toBe(startRes.payload.state);

    const tokenCalls = [];
    globalThis.fetch = jest.fn(async (input, init) => {
      const body = new URLSearchParams(String(init.body));
      tokenCalls.push({ url: String(input), body });
      expect(String(input)).toBe('https://auth.openai.test/oauth/token');
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth-code-1');
      expect(body.get('client_id')).toBe('codex-client-id');
      expect(body.get('redirect_uri')).toBe('https://hub.local/hub/oauth/openai-codex/callback');
      expect(String(body.get('code_verifier') || '').length).toBeGreaterThan(20);
      return new Response(JSON.stringify({
        access_token: 'openai-access-token',
        refresh_token: 'openai-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        account_id: 'acct_test',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const callbackRes = makeRes();
    await oauthCallbackRoute({
      params: { provider: 'openai-codex' },
      query: { state: startRes.payload.state, code: 'auth-code-1' },
    }, callbackRes);

    expect(callbackRes.statusCode).toBe(200);
    expect(callbackRes.payload.ok).toBe(true);
    expect(JSON.stringify(callbackRes.payload)).not.toContain('openai-access-token');
    expect(JSON.stringify(callbackRes.payload)).not.toContain('openai-refresh-token');
    expect(tokenCalls).toHaveLength(1);

    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    expect(store.providers['openai-codex-oauth'].token.access_token).toBe('openai-access-token');
    expect(store.providers['openai-codex-oauth'].token.refresh_token).toBe('openai-refresh-token');
    expect(store.providers['openai-codex-oauth'].token.account_id).toBe('acct_test');
    expect(store.providers['openai-codex-oauth'].metadata.source).toBe('hub_oauth_authorization_code');
    expect((fs.statSync(storeFile).mode & 0o777).toString(8)).toBe('600');
  });

  test('refresh uses stored refresh token and preserves it when token endpoint omits a new one', async () => {
    const storeFile = path.join(tempRoot, 'token-store.json');
    configureOpenAi(storeFile);
    const { setProviderToken } = require('../lib/oauth/token-store.ts');
    const { oauthRefreshRoute } = require('../lib/oauth/routes.ts');
    setProviderToken('openai-codex-oauth', {
      access_token: 'old-access-token',
      refresh_token: 'stored-refresh-token',
      expires_at: '2026-04-27T00:00:00.000Z',
      token_type: 'Bearer',
    }, { source: 'fixture' });

    globalThis.fetch = jest.fn(async (_input, init) => {
      const body = new URLSearchParams(String(init.body));
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('stored-refresh-token');
      return new Response(JSON.stringify({
        access_token: 'new-access-token',
        expires_in: 7200,
        token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const res = makeRes();
    await oauthRefreshRoute({ params: { provider: 'openai-codex' }, query: {}, body: {} }, res);

    expect(res.statusCode).toBe(200);
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    expect(store.providers['openai-codex-oauth'].token.access_token).toBe('new-access-token');
    expect(store.providers['openai-codex-oauth'].token.refresh_token).toBe('stored-refresh-token');
    expect(store.providers['openai-codex-oauth'].metadata.source).toBe('hub_oauth_refresh');
    expect(JSON.stringify(res.payload)).not.toContain('new-access-token');
  });

  test('Claude Code OAuth alias uses Hub-native start/callback when explicitly configured', async () => {
    const storeFile = path.join(tempRoot, 'token-store.json');
    configureClaude(storeFile);
    const { oauthStartRoute, oauthCallbackRoute } = require('../lib/oauth/routes.ts');

    const startRes = makeRes();
    await oauthStartRoute({ params: { provider: 'claude-code-oauth' }, query: {}, body: {} }, startRes);

    expect(startRes.statusCode).toBe(200);
    const authUrl = new URL(startRes.payload.auth_url);
    expect(authUrl.origin + authUrl.pathname).toBe('https://auth.claude.test/oauth/authorize');
    expect(authUrl.searchParams.get('client_id')).toBe('claude-client-id');

    globalThis.fetch = jest.fn(async (_input, init) => {
      const body = JSON.parse(String(init.body));
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(body.grant_type).toBe('authorization_code');
      expect(body.client_id).toBe('claude-client-id');
      return new Response(JSON.stringify({
        access_token: 'claude-access-token',
        refresh_token: 'claude-refresh-token',
        expires_at: '2030-01-01T00:00:00.000Z',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const callbackRes = makeRes();
    await oauthCallbackRoute({
      params: { provider: 'claude-code-oauth' },
      query: { state: startRes.payload.state, code: 'claude-code' },
    }, callbackRes);

    expect(callbackRes.statusCode).toBe(200);
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    expect(store.providers['claude-code-cli'].token.access_token).toBe('claude-access-token');
    expect(store.providers['claude-code-cli'].token.credential_type).toBe('oauth');
    expect(store.providers['claude-code-cli'].metadata.provider_name).toBe('claude-code');
    expect(JSON.stringify(callbackRes.payload)).not.toContain('claude-access-token');
  });

  test('Claude Code refresh uses public client defaults and JSON body', async () => {
    const storeFile = path.join(tempRoot, 'token-store.json');
    process.env.HUB_OAUTH_STORE_FILE = storeFile;
    const { setProviderToken } = require('../lib/oauth/token-store.ts');
    const { oauthRefreshRoute } = require('../lib/oauth/routes.ts');
    setProviderToken('claude-code-cli', {
      access_token: 'old-claude-access-token',
      refresh_token: 'stored-claude-refresh-token',
      expires_at: '2026-04-27T00:00:00.000Z',
      token_type: 'Bearer',
      credential_type: 'oauth',
      scopes: ['user:profile', 'user:inference'],
      subscription_type: 'max',
      rate_limit_tier: 'default_claude_max_20x',
    }, { source: 'fixture' });

    globalThis.fetch = jest.fn(async (input, init) => {
      expect(String(input)).toBe('https://platform.claude.com/v1/oauth/token');
      expect(init.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(String(init.body));
      expect(body.grant_type).toBe('refresh_token');
      expect(body.refresh_token).toBe('stored-claude-refresh-token');
      expect(body.client_id).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      expect(body.scope).toContain('user:inference');
      return new Response(JSON.stringify({
        access_token: 'new-claude-access-token',
        refresh_token: 'new-claude-refresh-token',
        expires_in: 28800,
        scope: 'user:profile user:inference user:sessions:claude_code',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const res = makeRes();
    await oauthRefreshRoute({ params: { provider: 'claude-code-oauth' }, query: {}, body: {} }, res);

    expect(res.statusCode).toBe(200);
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    expect(store.providers['claude-code-cli'].token.access_token).toBe('new-claude-access-token');
    expect(store.providers['claude-code-cli'].token.refresh_token).toBe('new-claude-refresh-token');
    expect(store.providers['claude-code-cli'].token.scopes).toContain('user:sessions:claude_code');
    expect(store.providers['claude-code-cli'].token.subscription_type).toBe('max');
    expect(store.providers['claude-code-cli'].token.rate_limit_tier).toBe('default_claude_max_20x');
    expect(store.providers['claude-code-cli'].metadata.source).toBe('hub_oauth_refresh');
    expect(JSON.stringify(res.payload)).not.toContain('new-claude-access-token');
    expect(JSON.stringify(res.payload)).not.toContain('new-claude-refresh-token');
  });

  test('start flow fails closed when provider runtime configuration is missing', async () => {
    const storeFile = path.join(tempRoot, 'token-store.json');
    process.env.HUB_OAUTH_STORE_FILE = storeFile;
    const { oauthStartRoute } = require('../lib/oauth/routes.ts');

    const res = makeRes();
    await oauthStartRoute({ params: { provider: 'openai-codex' }, query: {}, body: {} }, res);

    expect(res.statusCode).toBe(403);
    expect(res.payload.ok).toBe(false);
    expect(res.payload.error.code).toBe('oauth_flow_disabled');
    expect(res.payload.error.missing).toContain('HUB_ENABLE_OPENAI_CODEX_OAUTH');
  });
});
