#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(__filename);

const originalEnv = {
  HUB_LLM_GEMINI_DISABLED: process.env.HUB_LLM_GEMINI_DISABLED,
  HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI: process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI,
  HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE: process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE,
};
const originalFetch = globalThis.fetch;

async function main() {
  process.env.HUB_LLM_GEMINI_DISABLED = 'true';

  const selector = require('../src/llm-selector.ts');
  const unified = require('../lib/llm/unified-caller.ts');
  const oauthDirect = require('../lib/llm/oauth-direct.ts');
  const oauthMonitor = require('./run-oauth-monitor.ts')._testOnly;

  assert.equal(selector.isGeminiDisabled(), true);
  assert.equal(Object.prototype.hasOwnProperty.call(selector.getActiveProviderTiers(), 'gemini-cli-oauth'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(selector.getActiveProviderTiers(), 'gemini-codeassist-oauth'), false);

  const mixedSelection = selector.resolveHubLlmSelection({
    callerTeam: 'hub',
    agent: 'oauth-monitor',
    chain: [
      { provider: 'gemini-cli-oauth', model: 'gemini-2.5-flash' },
      { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
    ],
  }, { allowAdhocChain: true });
  assert.equal(mixedSelection.ok, true);
  assert.equal(mixedSelection.disabledProvidersRemoved, 1);
  assert.deepEqual(mixedSelection.chain.map((entry: any) => entry.provider), ['openai-oauth']);

  const allGeminiSelection = selector.resolveHubLlmSelection({
    callerTeam: 'hub',
    agent: 'oauth-monitor',
    chain: [
      { provider: 'gemini-codeassist-oauth', model: 'gemini-2.5-pro' },
      { provider: 'gemini-oauth', model: 'gemini-2.5-flash' },
    ],
  }, { allowAdhocChain: true });
  assert.equal(allGeminiSelection.ok, false);
  assert.equal(allGeminiSelection.error, 'gemini_provider_disabled');
  assert.equal(allGeminiSelection.disabledProvidersRemoved, 2);

  assert.equal(unified._testOnly._isGeminiProvider('gemini-oauth'), true);
  assert.equal(unified._testOnly._isGeminiProvider('gemini-cli-oauth'), true);
  assert.equal(unified._testOnly._isGeminiProvider('gemini-codeassist-oauth'), true);
  assert.equal(unified._testOnly._isGeminiProvider('openai-oauth'), false);

  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('disabled Gemini guard must return before network');
  }) as typeof fetch;

  for (const result of [
    await oauthDirect.callGeminiOAuth({ model: 'gemini-oauth/gemini-2.5-flash', prompt: 'x' }),
    await oauthDirect.callGeminiCliOAuth({ model: 'gemini-cli-oauth/gemini-2.5-flash', prompt: 'x' }),
    await oauthDirect.callGeminiCodeAssistOAuth({ model: 'gemini-codeassist-oauth/gemini-2.5-pro', prompt: 'x' }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.error, 'gemini_provider_disabled');
  }
  assert.equal(fetchCalls, 0);

  process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI = 'true';
  process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE = 'true';
  assert.equal(oauthMonitor.geminiLlmDisabled(), true);
  assert.equal(oauthMonitor.geminiCliMonitorRequired(), false);
  assert.equal(oauthMonitor.geminiCodeAssistServiceRequired(), false);

  const monitorResult = await oauthMonitor.checkGeminiCliOAuth();
  assert.equal(monitorResult.healthy, true);
  assert.equal(monitorResult.skipped, true);
  assert.equal(monitorResult.disabled, true);
  assert.equal(monitorResult.needs_refresh, false);
  assert.equal(monitorResult.credential_refresh_ok, null);
  assert.equal(monitorResult.live_refresh_attempts, 0);
  assert.equal(monitorResult.error, 'gemini_provider_disabled');

  const serviceResult = await oauthMonitor.checkGeminiCodeAssistService();
  assert.equal(serviceResult.healthy, true);
  assert.equal(serviceResult.skipped, true);
  assert.equal(serviceResult.required, false);
  assert.equal(serviceResult.error, 'gemini_provider_disabled');

  const probeResult = await oauthMonitor.runGeminiCliLiveRefreshProbe();
  assert.equal(probeResult.ok, false);
  assert.equal(probeResult.skipped, true);
  assert.equal(probeResult.attempts, 0);
  assert.equal(probeResult.error, 'gemini_provider_disabled');

  console.log(JSON.stringify({
    ok: true,
    geminiDisabled: selector.isGeminiDisabled(),
    mixedSelectionProviders: mixedSelection.chain.map((entry: any) => entry.provider),
    disabledDirectCalls: 3,
    oauthMonitorSkipped: true,
  }));
}

main()
  .catch((error) => {
    console.error('[gemini-disabled-guard-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv.HUB_LLM_GEMINI_DISABLED == null) delete process.env.HUB_LLM_GEMINI_DISABLED;
    else process.env.HUB_LLM_GEMINI_DISABLED = originalEnv.HUB_LLM_GEMINI_DISABLED;
    if (originalEnv.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI == null) delete process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI;
    else process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI = originalEnv.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI;
    if (originalEnv.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE == null) delete process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE;
    else process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE = originalEnv.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE;
  });
