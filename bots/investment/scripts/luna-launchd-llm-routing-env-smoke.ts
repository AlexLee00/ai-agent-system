#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildHubLlmCallPayload } from '../shared/hub-llm-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector.js');

const LUNA_LAUNCHD_PLISTS = [
  'bots/investment/launchd/ai.investment.commander.plist',
  'bots/investment/launchd/ai.investment.runtime-autopilot.plist',
  'bots/investment/launchd/ai.luna.ops-scheduler.plist',
  'bots/investment/launchd/ai.luna.marketdata-mcp.plist',
];

const RETIRED_LABELS = new Set([
  'ai.investment.crypto',
  'ai.investment.crypto.validation',
  'ai.investment.domestic',
  'ai.investment.domestic.validation',
  'ai.investment.overseas',
  'ai.investment.overseas.validation',
]);

function readPlist(file) {
  const fullPath = path.join(repoRoot, file);
  const raw = execFileSync('plutil', ['-convert', 'json', '-o', '-', fullPath], {
    encoding: 'utf8',
  });
  return JSON.parse(raw);
}

function getEnv(plist) {
  return plist.EnvironmentVariables || {};
}

function buildPayloadWithRouting(enabled) {
  const previousHubEnabled = process.env.INVESTMENT_LLM_HUB_ENABLED;
  const previousRoutingEnabled = process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
  process.env.INVESTMENT_LLM_HUB_ENABLED = 'true';
  process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = enabled ? 'true' : 'false';
  try {
    return buildHubLlmCallPayload(
      'luna',
      'system',
      'reply with ok',
      {
        market: 'binance',
        symbol: 'BIO/USDT',
        taskType: 'final_decision',
        maxTokens: 64,
      },
    );
  } finally {
    if (previousHubEnabled == null) delete process.env.INVESTMENT_LLM_HUB_ENABLED;
    else process.env.INVESTMENT_LLM_HUB_ENABLED = previousHubEnabled;
    if (previousRoutingEnabled == null) delete process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
    else process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = previousRoutingEnabled;
  }
}

function buildAgentPayloadWithRouting(agentName, taskType, enabled) {
  const previousHubEnabled = process.env.INVESTMENT_LLM_HUB_ENABLED;
  const previousRoutingEnabled = process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
  process.env.INVESTMENT_LLM_HUB_ENABLED = 'true';
  process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = enabled ? 'true' : 'false';
  try {
    return buildHubLlmCallPayload(
      agentName,
      'system',
      'reply with ok',
      {
        market: 'binance',
        symbol: 'BIO/USDT',
        taskType,
        maxTokens: 64,
      },
    );
  } finally {
    if (previousHubEnabled == null) delete process.env.INVESTMENT_LLM_HUB_ENABLED;
    else process.env.INVESTMENT_LLM_HUB_ENABLED = previousHubEnabled;
    if (previousRoutingEnabled == null) delete process.env.LUNA_AGENT_LLM_ROUTING_ENABLED;
    else process.env.LUNA_AGENT_LLM_ROUTING_ENABLED = previousRoutingEnabled;
  }
}

function selectorProviders(selectorKey, agentName) {
  return selectLLMChain(String(selectorKey), {
    agentName,
    selectorVersion: 'v3.0_oauth_4',
    rolloutPercent: 100,
  }).map((entry) => entry.provider);
}

export function runLunaLaunchdLlmRoutingEnvSmoke() {
  const plistChecks = LUNA_LAUNCHD_PLISTS.map((file) => {
    const plist = readPlist(file);
    const env = getEnv(plist);
    const label = plist.Label || '';
    assert.equal(
      RETIRED_LABELS.has(label),
      false,
      `${file} must not reintroduce a retired Luna market cycle label`,
    );
    const oauthPrimary = String(env.LLM_USE_OAUTH_PRIMARY || '').toLowerCase() === 'true';
    const teamSelectorPercent = Number(env.LLM_TEAM_SELECTOR_AB_PERCENT || 0);
    if (label === 'ai.investment.commander') {
      assert.equal(oauthPrimary, true, `${file} must keep OAuth primary enabled`);
      assert.equal(teamSelectorPercent, 100, `${file} must keep team selector at 100%`);
      assert.equal(String(env.INVESTMENT_LLM_HUB_ENABLED || '').toLowerCase(), 'true', `${file} must keep Hub LLM enabled`);
      assert.equal(String(env.LUNA_AGENT_LLM_ROUTING_ENABLED || '').toLowerCase(), 'true', `${file} must keep agent LLM routing enabled`);
      assert.equal(String(env.INVESTMENT_LLM_DIRECT_FALLBACK || '').toLowerCase(), 'false', `${file} must keep direct LLM fallback disabled`);
    }
    if (label === 'ai.luna.marketdata-mcp') {
      assert.equal(
        String(env.KIS_USE_MCP || '').toLowerCase(),
        'false',
        `${file} must not route KIS requests back through the KIS MCP bridge`,
      );
    }
    return { file, label, oauthPrimary, teamSelectorPercent };
  });

  const legacyPayload = buildPayloadWithRouting(false);
  assert.equal(legacyPayload.selectorKey, 'investment.luna', 'disabled routing must still delegate to Hub selector key');
  assert.equal(legacyPayload.chain, undefined, 'disabled routing must not materialize legacy chain client-side');
  const legacyProviders = selectorProviders(legacyPayload.selectorKey, 'luna');
  assert.ok(
    legacyProviders.includes('groq'),
    'disabled routing keeps Groq available through Hub selector',
  );
  assert.ok(
    !legacyProviders.includes('claude-code'),
    'disabled routing must not leak Luna selector calls to Claude Code',
  );

  const routedPayload = buildPayloadWithRouting(true);
  assert.equal(routedPayload.selectorKey, 'investment.luna', 'enabled routing must delegate to Hub selector key');
  assert.equal(routedPayload.chain, undefined, 'enabled routing must not materialize selector chain client-side');
  const providers = selectorProviders(routedPayload.selectorKey, 'luna');
  assert.ok(providers.length >= 3, 'enabled routing should keep a provider fallback chain in Hub selector');
  assert.ok(!providers.includes('claude-code'), 'enabled routing should not include Claude Code fallback');
  assert.ok(providers.includes('openai-oauth'), 'enabled routing should include OpenAI OAuth fallback');
  assert.ok(providers.includes('groq'), 'enabled routing should include Groq fallback');

  const zeusPayload = buildAgentPayloadWithRouting('zeus', 'debate_bull', false);
  assert.equal(zeusPayload.selectorKey, 'investment.zeus', 'disabled zeus routing must still delegate to Hub selector key');
  assert.equal(zeusPayload.chain, undefined, 'disabled zeus routing must not materialize chain client-side');
  const zeusProviders = selectorProviders(zeusPayload.selectorKey, 'zeus');
  assert.ok(zeusProviders.length >= 3, 'disabled zeus routing should still keep Hub fallback chain');
  assert.equal(zeusProviders[0], 'groq', 'disabled zeus routing should use Hub selector primary');
  assert.ok(!zeusProviders.includes('claude-code'), 'disabled zeus routing must not leak to Claude Code');

  const sentimentPayload = buildAgentPayloadWithRouting('sophia', 'sentiment', true);
  assert.equal(sentimentPayload.selectorKey, 'investment.sophia', 'sentiment routing must delegate to Hub selector key');
  assert.equal(sentimentPayload.chain, undefined, 'sentiment routing must not materialize chain client-side');
  const sentimentProviders = selectorProviders(sentimentPayload.selectorKey, 'sophia');
  assert.equal(
    sentimentProviders[0],
    'groq',
    'sentiment routing should use Groq primary; OpenAI/Gemini remain fallback only',
  );
  assert.equal(
    sentimentProviders.includes('gemini-cli-oauth'),
    true,
    'sentiment routing should keep Gemini CLI OAuth as a fallback',
  );
  assert.equal(
    sentimentProviders.includes('gemini-oauth'),
    false,
    'sentiment routing should not include disabled direct gemini-oauth',
  );

  return {
    ok: true,
    smoke: 'luna-launchd-llm-routing-env',
    plists: plistChecks,
    legacyProviders,
    routedProviders: providers,
    zeusProviders,
    sentimentProviders,
  };
}

async function main() {
  const result = runLunaLaunchdLlmRoutingEnvSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-launchd-llm-routing-env-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-launchd-llm-routing-env-smoke 실패:',
  });
}
