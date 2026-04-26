// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { readOpenAiCodexLocalCredentials } = require('../bots/hub/lib/oauth/local-credentials.ts');

const STORE_PATH = path.join(__dirname, '..', 'bots', 'hub', 'secrets-store.json');

function loadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function sync() {
  const credentials = readOpenAiCodexLocalCredentials({ allowKeychainPrompt: process.env.ALLOW_KEYCHAIN_PROMPT === 'true' });
  if (!credentials?.ok || !credentials.token?.access_token) {
    throw new Error(`openai-codex OAuth 프로필을 찾지 못했습니다: ${credentials?.error || 'missing_token'}`);
  }

  const store = loadJson(STORE_PATH, {}) || {};
  store.openai_oauth = {
    access_token: credentials.token.access_token || '',
    refresh_token: credentials.token.refresh_token || '',
    model: 'gpt-5.4',
    provider: 'openai-codex',
    synced_at: new Date().toISOString(),
    expires: credentials.token.expires_at || null,
    account_id: credentials.token.account_id || null,
    source: credentials.source,
  };

  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    provider: store.openai_oauth.provider,
    model: store.openai_oauth.model,
    hasAccessToken: !!store.openai_oauth.access_token,
    expires: store.openai_oauth.expires,
  }, null, 2));
}

try {
  sync();
} catch (error) {
  console.error(`[sync-openai-oauth] ${error.message}`);
  process.exit(1);
}
