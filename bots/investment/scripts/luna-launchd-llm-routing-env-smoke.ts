#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHubLlmCallPayload } from '../shared/hub-llm-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const LUNA_LAUNCHD_PLISTS = [
  'bots/investment/launchd/ai.investment.crypto.plist',
  'bots/investment/launchd/ai.investment.argos.plist',
  'bots/investment/launchd/ai.investment.domestic.plist',
  'bots/investment/launchd/ai.investment.overseas.plist',
  'bots/investment/launchd/ai.luna.commander.plist',
];

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

export function runLunaLaunchdLlmRoutingEnvSmoke() {
  const plistChecks = LUNA_LAUNCHD_PLISTS.map((file) => {
    const env = getEnv(readPlist(file));
    const hubEnabled = String(env.INVESTMENT_LLM_HUB_ENABLED || '').toLowerCase() === 'true';
    const routingEnabled = String(env.LUNA_AGENT_LLM_ROUTING_ENABLED || '').toLowerCase() === 'true';
    assert.equal(
      routingEnabled,
      true,
      `${file} must set LUNA_AGENT_LLM_ROUTING_ENABLED=true`,
    );
    if (hubEnabled) {
      assert.equal(
        routingEnabled,
        true,
        `${file} must not enable Hub while Luna agent routing is disabled`,
      );
    }
    return { file, hubEnabled, routingEnabled };
  });

  const legacyPayload = buildPayloadWithRouting(false);
  const legacyChain = Array.isArray(legacyPayload.chain) ? legacyPayload.chain : [];
  const legacyProviders = legacyChain.map((entry) => entry.provider);
  assert.ok(
    legacyChain.length >= 3,
    'disabled routing should still keep the Luna legacy safety fallback chain',
  );
  assert.equal(
    legacyProviders[0],
    'openai-oauth',
    'disabled routing keeps OpenAI OAuth as the Luna legacy primary',
  );
  assert.ok(
    legacyProviders.includes('groq'),
    'disabled routing keeps Groq as the Luna legacy fallback',
  );
  assert.ok(
    legacyProviders.includes('claude-code'),
    'disabled routing keeps Claude Code Haiku as the Luna legacy fallback',
  );

  const routedPayload = buildPayloadWithRouting(true);
  const routedChain = Array.isArray(routedPayload.chain) ? routedPayload.chain : [];
  const providers = routedChain.map((entry) => entry.provider);
  assert.ok(routedChain.length >= 3, 'enabled routing should keep a provider fallback chain');
  assert.ok(providers.includes('claude-code'), 'enabled routing should include Claude Code fallback');
  assert.ok(providers.includes('openai-oauth'), 'enabled routing should include OpenAI OAuth fallback');
  assert.ok(providers.includes('groq'), 'enabled routing should include Groq fallback');

  const sentimentPayload = buildAgentPayloadWithRouting('sophia', 'sentiment', true);
  const sentimentProviders = (Array.isArray(sentimentPayload.chain) ? sentimentPayload.chain : [])
    .map((entry) => entry.provider);
  assert.equal(
    sentimentProviders[0],
    'groq',
    'sentiment routing should use fast Groq primary; OAuth providers remain fallback only',
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
