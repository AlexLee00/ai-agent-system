#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROVIDER_TS = require.resolve('../lib/oauth/providers/gemini-oauth.ts');
const TOKEN_STORE_TS = require.resolve('../lib/oauth/token-store.ts');

const originalEnv: Record<string, string | undefined> = {
  HUB_OAUTH_STORE_FILE: process.env.HUB_OAUTH_STORE_FILE,
  GEMINI_OAUTH_PROJECT_ID: process.env.GEMINI_OAUTH_PROJECT_ID,
  GOOGLE_CLOUD_QUOTA_PROJECT: process.env.GOOGLE_CLOUD_QUOTA_PROJECT,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
};

function resetModules() {
  delete require.cache[PROVIDER_TS];
  delete require.cache[TOKEN_STORE_TS];
}

function writeStore(filePath: string, metadata: Record<string, unknown> = {}) {
  fs.writeFileSync(filePath, `${JSON.stringify({
    providers: {
      'gemini-oauth': {
        token: {
          access_token: 'gemini-oauth-project-readiness-token',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          token_type: 'Bearer',
        },
        metadata,
      },
    },
  })}\n`, 'utf8');
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gemini-project-readiness-'));
  const tokenStoreFile = path.join(tempRoot, 'token-store.json');

  try {
    process.env.HUB_OAUTH_STORE_FILE = tokenStoreFile;
    delete process.env.GEMINI_OAUTH_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_QUOTA_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;

    writeStore(tokenStoreFile);
    resetModules();
    let provider = require('../lib/oauth/providers/gemini-oauth.ts');
    let status = await provider.getGeminiOauthStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.quota_project_configured, false);
    let canary = await provider.runGeminiOauthCanary();
    assert.equal(canary.ok, false);
    assert.equal(canary.error, 'missing_quota_project');

    writeStore(tokenStoreFile, {
      source: 'gemini_cli_oauth_creds',
      quota_project_id: 'gemini-project-readiness-smoke',
    });
    resetModules();
    provider = require('../lib/oauth/providers/gemini-oauth.ts');
    status = await provider.getGeminiOauthStatus();
    assert.equal(status.quota_project_configured, true);

    console.log(JSON.stringify({
      ok: true,
      provider: 'gemini-oauth',
      missing_project_fail_closed_checked: true,
      metadata_project_readiness_checked: true,
    }));
  } finally {
    resetModules();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error) => {
  console.error('[gemini-oauth-project-readiness-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
