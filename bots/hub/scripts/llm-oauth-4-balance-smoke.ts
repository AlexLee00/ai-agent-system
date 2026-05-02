#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const selector = require('../../../packages/core/lib/llm-model-selector.ts');

function withEnv(overrides: Record<string, string>, fn: () => void): void {
  const backup: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    backup[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (backup[key] == null) delete process.env[key];
      else process.env[key] = backup[key];
    }
  }
}

function providerFromChain(key: string, options: Record<string, any>): string {
  const chain = selector.selectLLMChain(key, options);
  return String(chain?.[0]?.provider || '');
}

function pct(value: number, total: number): number {
  return total > 0 ? (value * 100) / total : 0;
}

function validateAbStage(percent: number, minPct: number, maxPct: number): { percent: number; sampledPct: number } {
  let oauth4Hits = 0;
  const samples = 2000;
  withEnv(
    {
      LLM_TEAM_SELECTOR_VERSION: 'v3.0_oauth_4',
      LLM_TEAM_SELECTOR_AB_PERCENT: String(percent),
    },
    () => {
      for (let i = 0; i < samples; i += 1) {
        const provider = providerFromChain('hub.alarm.classifier', { rolloutKey: `ab-${i}` });
        if (provider === 'gemini-cli-oauth') oauth4Hits += 1;
      }
    },
  );
  const sampledPct = pct(oauth4Hits, samples);
  assert(sampledPct >= minPct && sampledPct <= maxPct, `AB ${percent}% rollout sampled=${sampledPct.toFixed(2)}% (expected ${minPct}-${maxPct})`);
  return { percent, sampledPct: Number(sampledPct.toFixed(2)) };
}

function main(): void {
  const staged = [
    validateAbStage(1, 0.2, 3.0),
    validateAbStage(50, 45, 55),
    validateAbStage(100, 99.9, 100),
  ];

  const selectorOptions = { selectorVersion: 'v3.0_oauth_4', rolloutPercent: 100, rolloutKey: 'smoke-force-v3' };

  const hubKeys = [
    'hub.alarm.classifier',
    'hub.alarm.interpreter.work',
    'hub.alarm.interpreter.report',
    'hub.alarm.interpreter.error',
    'hub.alarm.interpreter.critical',
    'hub.roundtable.jay',
    'hub.roundtable.claude_lead',
    'hub.roundtable.team_commander',
    'hub.roundtable.judge',
    'hub._default',
  ];

  for (const key of hubKeys) {
    const chain = selector.selectLLMChain(key, selectorOptions);
    assert(chain.length > 0, `${key} chain must be non-empty`);
    assert.notEqual(chain[0]?.provider, 'anthropic', `${key} primary must not use anthropic provider`);
  }

  const investmentAgents = [
    'default',
    'luna',
    'nemesis',
    'oracle',
    'hermes',
    'sophia',
    'zeus',
    'athena',
    'argos',
    'scout',
    'chronos',
    'aria',
    'adaptive-risk',
    'sentinel',
    'hephaestos',
    'hanul',
    'budget',
    'kairos',
    'stock-flow',
    'sweeper',
  ];

  const providerCounts: Record<string, number> = {
    'claude-code': 0,
    'openai-oauth': 0,
    'gemini-cli-oauth': 0,
    groq: 0,
    other: 0,
  };

  for (const key of hubKeys) {
    const provider = providerFromChain(key, selectorOptions);
    if (providerCounts[provider] != null) providerCounts[provider] += 1;
    else providerCounts.other += 1;
  }

  const claudeKeys = [
    'claude._default',
    'claude.archer.tech_analysis',
    'claude.lead.system_issue_triage',
    'claude.dexter.ai_analyst',
  ];
  for (const key of claudeKeys) {
    const provider = providerFromChain(key, selectorOptions);
    if (providerCounts[provider] != null) providerCounts[provider] += 1;
    else providerCounts.other += 1;
  }

  for (const agentName of investmentAgents) {
    const chain = selector.selectLLMChain('investment.agent_policy', { ...selectorOptions, agentName });
    assert(chain.length > 0, `investment/${agentName} chain must be non-empty`);
    assert.notEqual(chain[0]?.provider, 'anthropic', `investment/${agentName} primary must not use anthropic`);
    const provider = String(chain[0]?.provider || '');
    if (providerCounts[provider] != null) providerCounts[provider] += 1;
    else providerCounts.other += 1;
  }

  for (const key of ['sigma.agent_policy', 'darwin.agent_policy']) {
    const chain = selector.selectLLMChain(key, { ...selectorOptions, agentName: 'commander' });
    assert(chain.length > 0, `${key} chain must be non-empty`);
    assert.equal(chain[0]?.provider, 'claude-code', `${key} primary must migrate to claude-code in oauth4`);
  }

  const total = Object.values(providerCounts).reduce((acc, value) => acc + value, 0);
  const shares = {
    claudeCodePct: Number(pct(providerCounts['claude-code'], total).toFixed(2)),
    openaiPct: Number(pct(providerCounts['openai-oauth'], total).toFixed(2)),
    geminiPct: Number(pct(providerCounts['gemini-cli-oauth'], total).toFixed(2)),
    groqPct: Number(pct(providerCounts.groq, total).toFixed(2)),
  };

  assert(shares.claudeCodePct >= 45 && shares.claudeCodePct <= 65, `claude-code share out of range: ${shares.claudeCodePct}%`);
  assert(shares.openaiPct >= 15 && shares.openaiPct <= 35, `openai share out of range: ${shares.openaiPct}%`);
  assert(shares.geminiPct >= 10 && shares.geminiPct <= 30, `gemini share out of range: ${shares.geminiPct}%`);
  assert(shares.groqPct >= 5 && shares.groqPct <= 20, `groq share out of range: ${shares.groqPct}%`);
  assert.equal(providerCounts.other, 0, 'unexpected provider should not appear in oauth4 matrix');

  console.log(JSON.stringify({
    ok: true,
    selector_version: 'v3.0_oauth_4',
    staged_rollout: staged,
    provider_counts: providerCounts,
    provider_shares: shares,
    anthropic_primary: 0,
  }, null, 2));
}

try {
  main();
} catch (error: any) {
  console.error('[llm-oauth-4-balance-smoke] failed:', error?.message || error);
  process.exit(1);
}
