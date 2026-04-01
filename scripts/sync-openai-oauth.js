#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const AUTH_PATH = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
const STORE_PATH = path.join(__dirname, '..', 'bots', 'hub', 'secrets-store.json');

function loadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function pickOpenAIOAuthProfile(authData) {
  const profiles = authData?.profiles || {};
  const lastGood = authData?.lastGood || {};
  const preferredKey = lastGood['openai-codex'];
  const preferred = preferredKey ? profiles[preferredKey] : null;
  if (preferred?.type === 'oauth' && preferred?.provider === 'openai-codex' && preferred?.access) {
    return preferred;
  }

  for (const profile of Object.values(profiles)) {
    if (profile?.type === 'oauth' && profile?.provider === 'openai-codex' && profile?.access) {
      return profile;
    }
  }
  return null;
}

function sync() {
  const authData = loadJson(AUTH_PATH, {});
  const profile = pickOpenAIOAuthProfile(authData);
  if (!profile) {
    throw new Error('openai-codex OAuth 프로필을 찾지 못했습니다');
  }

  const store = loadJson(STORE_PATH, {}) || {};
  store.openai_oauth = {
    access_token: profile.access || '',
    model: 'gpt-5.4',
    provider: 'openai-codex',
    synced_at: new Date().toISOString(),
    expires: profile.expires || null,
    account_id: profile.accountId || null,
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
