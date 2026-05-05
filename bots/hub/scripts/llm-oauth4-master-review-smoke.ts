#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { buildReport } from './llm-oauth4-master-review';

const selectorSnapshot = {
  selector_version: 'v3_oauth_4',
  rollout_percent: 100,
  checked: {
    selector_keys: 64,
    agent_routes: 130,
    total_primary_routes: 194,
  },
  primary_provider_counts: {
    'claude-code': 39,
    'openai-oauth': 111,
    'gemini-cli-oauth': 30,
    groq: 14,
  },
  primary_provider_shares: {
    'claude-code': 20.1,
    'openai-oauth': 57.22,
    'gemini-cli-oauth': 15.46,
    groq: 7.22,
  },
  primary_model_counts: {
    'claude-code/haiku': 27,
    'claude-code/opus': 7,
    'claude-code/sonnet': 5,
    'openai-oauth/gpt-5.4': 70,
    'openai-oauth/gpt-4o-mini': 41,
    'gemini-cli-oauth/gemini-2.5-flash': 20,
    'gemini-cli-oauth/gemini-2.5-flash-lite': 10,
    'groq/llama-3.1-8b-instant': 14,
  },
  primary_model_shares: {
    'claude-code/haiku': 13.92,
    'claude-code/opus': 3.61,
    'claude-code/sonnet': 2.58,
    'openai-oauth/gpt-5.4': 36.08,
    'openai-oauth/gpt-4o-mini': 21.13,
    'gemini-cli-oauth/gemini-2.5-flash': 10.31,
    'gemini-cli-oauth/gemini-2.5-flash-lite': 5.15,
    'groq/llama-3.1-8b-instant': 7.22,
  },
  chain_provider_counts: {},
  chain_model_counts: {},
  claude_code_primary_share_pct: 20.1,
  claude_code_sonnet_primary_count: 5,
  claude_code_sonnet_primary_share_pct: 2.58,
  anthropic_primary_findings: [],
  anthropic_chain_findings: [],
  findings: [],
};

function main(): void {
  const trafficMixReport = buildReport({
    ok: true,
    summary: [
      { provider: 'groq', total_calls: 200, success_count: 200, total_cost_usd: 1.23 },
      { provider: 'claude-code-oauth', total_calls: 5, success_count: 5, total_cost_usd: 10.5 },
      { provider: 'openai-oauth', total_calls: 10, success_count: 10, total_cost_usd: 0 },
      { provider: 'failed', total_calls: 1, success_count: 0, total_cost_usd: 0 },
    ],
  }, { selectorSnapshot });

  assert.equal(trafficMixReport.ok, true, 'historical traffic mix/cost must not fail current OAuth4 selector review');
  assert.equal(trafficMixReport.verdict.selector_claude_code_share_ok, true);
  assert.equal(trafficMixReport.verdict.selector_claude_code_sonnet_share_ok, true);
  assert.equal(trafficMixReport.verdict.runtime_anthropic_zero_ok, true);
  assert.equal(trafficMixReport.verdict.reported_cost_accounting_only, true);
  assert.ok(trafficMixReport.warnings.includes('runtime_reported_cost_is_accounting_or_cli_imputed_cost_not_oauth4_billing_gate'));

  const anthropicRuntimeReport = buildReport({
    ok: true,
    summary: [
      { provider: 'anthropic', total_calls: 1, success_count: 1, total_cost_usd: 0.02 },
      { provider: 'claude-code-oauth', total_calls: 10, success_count: 10, total_cost_usd: 0 },
    ],
  }, { selectorSnapshot });
  assert.equal(anthropicRuntimeReport.ok, false, 'runtime anthropic provider calls must remain a hard failure');
  assert.equal(anthropicRuntimeReport.verdict.runtime_anthropic_zero_ok, false);

  const selectorAnthropicReport = buildReport({
    ok: true,
    summary: [
      { provider: 'claude-code-oauth', total_calls: 10, success_count: 10, total_cost_usd: 0 },
    ],
  }, {
    selectorSnapshot: {
      ...selectorSnapshot,
      anthropic_primary_findings: [{ key: 'bad.selector', provider: 'anthropic', primary: true }],
      anthropic_chain_findings: [{ key: 'bad.selector', provider: 'anthropic', primary: true }],
    },
  });
  assert.equal(selectorAnthropicReport.ok, false, 'selector anthropic findings must fail the review');
  assert.equal(selectorAnthropicReport.verdict.selector_anthropic_primary_zero_ok, false);

  const sonnetCapReport = buildReport({
    ok: true,
    summary: [
      { provider: 'claude-code-oauth', total_calls: 10, success_count: 10, total_cost_usd: 0 },
    ],
  }, {
    selectorSnapshot: {
      ...selectorSnapshot,
      claude_code_sonnet_primary_share_pct: 25,
    },
  });
  assert.equal(sonnetCapReport.ok, false, 'selector Sonnet primary share above cap must fail review');
  assert.equal(sonnetCapReport.verdict.selector_claude_code_sonnet_share_ok, false);

  console.log(JSON.stringify({
    ok: true,
    smoke: 'llm-oauth4-master-review',
    cases: ['traffic_mix_cost_warning', 'runtime_anthropic_blocker', 'selector_anthropic_blocker', 'sonnet_cap_blocker'],
  }, null, 2));
}

try {
  main();
} catch (error: any) {
  console.error('[llm-oauth4-master-review-smoke] failed:', error?.message || error);
  process.exit(1);
}
