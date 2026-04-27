#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const {
  filterUntrustedEnvPatch,
  isBlockedRuntimeEnvKey,
  mergeTrustedEnvWithUntrustedPatch,
} = require('../../../packages/core/lib/runtime-env-policy');
const autoDev = require('../../claude/lib/auto-dev-pipeline.ts');

function main() {
  const patch = {
    SAFE_FEATURE_FLAG: '1',
    HUB_AUTH_TOKEN: 'must-not-pass',
    OPENAI_OAUTH_ACCESS_TOKEN: 'must-not-pass',
    GEMINI_OAUTH_REFRESH_TOKEN: 'must-not-pass',
    CLAUDE_CODE_SETTINGS: '/tmp/evil-settings.json',
    TELEGRAM_BOT_TOKEN: 'must-not-pass',
    PG_PASSWORD: 'must-not-pass',
    AI_AGENT_HOME: '/tmp/evil-home',
    OPENCLAW_BIN: '/tmp/openclaw',
    BROWSER_CONTROL_URL: 'http://127.0.0.1:1',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  };

  const filtered = filterUntrustedEnvPatch(patch, { source: 'smoke' });
  assert.equal(filtered.env.SAFE_FEATURE_FLAG, '1');
  assert.equal(filtered.env.HUB_AUTH_TOKEN, undefined);
  assert.equal(filtered.env.OPENAI_OAUTH_ACCESS_TOKEN, undefined);
  assert.equal(filtered.env.OPENCLAW_BIN, undefined);
  assert(filtered.blocked.length >= 9, 'expected runtime-control env keys to be blocked');
  assert.equal(isBlockedRuntimeEnvKey('OPENAI_PUBLIC_API_TOKEN'), true);
  assert.equal(isBlockedRuntimeEnvKey('SAFE_FEATURE_FLAG'), false);

  const merged = mergeTrustedEnvWithUntrustedPatch({ HUB_AUTH_TOKEN: 'trusted', PATH: '/bin' }, patch);
  assert.equal(merged.env.HUB_AUTH_TOKEN, 'trusted');
  assert.equal(merged.env.SAFE_FEATURE_FLAG, '1');

  const childEnv = autoDev._testOnly_buildAutoDevChildEnv({ envPatch: patch });
  assert.equal(childEnv.HUB_AUTH_TOKEN, process.env.HUB_AUTH_TOKEN);
  assert.equal(childEnv.SAFE_FEATURE_FLAG, '1');
  assert.notEqual(childEnv.OPENCLAW_BIN, '/tmp/openclaw');

  console.log(JSON.stringify({
    ok: true,
    blocked: filtered.blocked.map((item) => item.key).sort(),
    safe_env_passthrough: true,
    auto_dev_child_env_guarded: true,
  }));
}

main();

