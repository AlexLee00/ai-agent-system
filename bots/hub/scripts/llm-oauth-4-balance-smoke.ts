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
        const provider = providerFromChain('investment.agent_policy', { rolloutKey: `ab-${i}`, agentName: 'default' });
        if (provider === 'groq') oauth4Hits += 1;
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

  withEnv(
    {
      LLM_USE_OAUTH_PRIMARY: 'true',
      LLM_TEAM_SELECTOR_VERSION: 'v3.0_oauth_4',
      LLM_TEAM_SELECTOR_AB_PERCENT: '',
      LLM_TEAM_SELECTOR_VERSION_PCT: '',
    },
    () => {
      assert.equal(
        providerFromChain('investment.agent_policy', { agentName: 'default' }),
        'groq',
        'oauth4 selector without explicit percent must default to the role-balanced v3 route, not OpenAI-heavy legacy',
      );
    },
  );

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
  const localOnlyAlarmInterpreters = new Set([
    'hub.alarm.interpreter.work',
    'hub.alarm.interpreter.report',
    'hub.alarm.interpreter.error',
    'hub.alarm.interpreter.critical',
  ]);

  for (const key of hubKeys) {
    const chain = selector.selectLLMChain(key, selectorOptions);
    assert(chain.length > 0, `${key} chain must be non-empty`);
    assert.notEqual(chain[0]?.provider, 'anthropic', `${key} primary must not use anthropic provider`);
    if (localOnlyAlarmInterpreters.has(key)) {
      assert.deepEqual(
        chain.map((entry: any) => entry.provider),
        ['local'],
        `${key} must stay local-only so alarm enrichment cannot amplify provider outages`,
      );
    }
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
    local: 0,
    'local-embedding': 0,
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
    if (['zeus', 'athena', 'nemesis', 'hermes', 'sophia'].includes(agentName)) {
      assert.equal(
        chain.some((entry: any) => entry.provider === 'claude-code'),
        false,
        `investment/${agentName} hot path must not fall back to claude-code while Sonnet quota is saturated`,
      );
    }
    const provider = String(chain[0]?.provider || '');
    if (providerCounts[provider] != null) providerCounts[provider] += 1;
    else providerCounts.other += 1;
  }

  const chronosBacktestProvider = providerFromChain('chronos.backtest', selectorOptions);
  if (providerCounts[chronosBacktestProvider] != null) providerCounts[chronosBacktestProvider] += 1;
  else providerCounts.other += 1;

  const investmentReporterChain = selector.selectLLMChain('investment.agent_policy', {
    ...selectorOptions,
    agentName: 'reporter',
    openaiPerfModel: 'smoke-openai-perf',
    policyOverride: {
      openaiMiniModel: 'smoke-openai-mini',
    },
  });
  assert.equal(
    investmentReporterChain[0]?.model,
    'smoke-openai-mini',
    'investment/reporter must start on OpenAI mini to avoid Stage D reporter latency hotspots',
  );
  assert.ok(
    investmentReporterChain.some((entry: any) => entry.provider === 'groq'),
    'investment/reporter must keep Groq as the first non-OpenAI fallback',
  );
  assert.ok(
    investmentReporterChain.slice(1).some((entry: any) => entry.model === 'smoke-openai-perf'),
    'investment/reporter must keep OpenAI perf as a quality fallback instead of removing it',
  );

  for (const key of ['sigma.agent_policy', 'darwin.agent_policy']) {
    const chain = selector.selectLLMChain(key, { ...selectorOptions, agentName: 'commander' });
    assert(chain.length > 0, `${key} chain must be non-empty`);
    assert.equal(chain[0]?.provider, 'openai-oauth', `${key} commander primary should keep Sonnet as fallback, not default`);
  }

  const darwinEvaluatorChain = selector.selectLLMChain('darwin.agent_policy', {
    ...selectorOptions,
    agentName: 'darwin.evaluator',
  });
  assert.deepEqual(
    darwinEvaluatorChain.map((entry: any) => entry.provider),
    ['openai-oauth', 'groq'],
    'darwin.evaluator must avoid Groq primary during Groq pool/cooldown pressure',
  );
  assert.equal(
    darwinEvaluatorChain[1]?.model,
    'llama-3.1-8b-instant',
    'darwin.evaluator Groq fallback must avoid qwen/qwen3-32b capacity hotspots',
  );

  const darwinQueryPlannerChain = selector.selectLLMChain('darwin.agent_policy', {
    ...selectorOptions,
    agentName: 'darwin.rag.query_planner',
  });
  assert.deepEqual(
    darwinQueryPlannerChain.map((entry: any) => entry.provider),
    ['openai-oauth', 'groq'],
    'darwin.rag.query_planner must not depend on gemini-cli-oauth as a single route',
  );
  assert.equal(
    darwinQueryPlannerChain[1]?.model,
    'llama-3.1-8b-instant',
    'darwin.rag.query_planner Groq fallback must avoid qwen/qwen3-32b capacity hotspots',
  );

  const darwinSynthesisChain = selector.selectLLMChain('darwin.agent_policy', {
    ...selectorOptions,
    agentName: 'darwin.rag.synthesizer',
  });
  assert.deepEqual(
    darwinSynthesisChain.map((entry: any) => entry.provider),
    ['openai-oauth', 'groq'],
    'darwin.rag.synthesizer must not be Groq-only during Groq pool cooldown',
  );
  assert.equal(
    darwinSynthesisChain[1]?.model,
    'llama-3.1-8b-instant',
    'darwin.rag.synthesizer Groq fallback must avoid qwen/qwen3-32b capacity hotspots',
  );

  const { PROFILES } = require('../lib/runtime-profiles.ts');
  const darwinSynthesisRuntimeRoutes = [
    ...(PROFILES?.darwin?.synthesis?.primary_routes || []),
    ...(PROFILES?.darwin?.synthesis?.fallback_routes || []),
  ];
  assert.ok(
    String(darwinSynthesisRuntimeRoutes[0] || '').startsWith('openai-oauth/'),
    'darwin/synthesis runtime profile must use the synthesis selector, not planner/Gemini routing',
  );
  assert.ok(
    darwinSynthesisRuntimeRoutes.some((route) => String(route).startsWith('groq/')),
    'darwin/synthesis runtime profile must keep Groq as fallback for OpenAI outage coverage',
  );

  const total = Object.values(providerCounts).reduce((acc, value) => acc + value, 0);
  const shares = {
    claudeCodePct: Number(pct(providerCounts['claude-code'], total).toFixed(2)),
    openaiPct: Number(pct(providerCounts['openai-oauth'], total).toFixed(2)),
    geminiPct: Number(pct(providerCounts['gemini-cli-oauth'], total).toFixed(2)),
    localPct: Number(pct(providerCounts.local, total).toFixed(2)),
    localEmbeddingPct: Number(pct(providerCounts['local-embedding'], total).toFixed(2)),
    groqPct: Number(pct(providerCounts.groq, total).toFixed(2)),
  };

  assert(shares.claudeCodePct >= 0 && shares.claudeCodePct <= 10, `claude-code share out of range: ${shares.claudeCodePct}%`);
  assert(shares.openaiPct >= 20 && shares.openaiPct <= 60, `openai share out of range: ${shares.openaiPct}%`);
  assert.equal(shares.geminiPct, 0, `gemini share must be zero for non-diagnostic agent routing: ${shares.geminiPct}%`);
  assert(shares.localPct > 0, 'local share must cover Hub alarm interpreter fail-open enrichment');
  assert(shares.groqPct >= 25 && shares.groqPct <= 75, `groq share out of range: ${shares.groqPct}%`);
  assert(shares.localEmbeddingPct > 0, 'local embedding share must cover Chronos backtest');
  assert.equal(providerCounts.other, 0, 'unexpected provider should not appear in oauth4 matrix');

  const sonnetPrimaryProfiles: string[] = [];
  const allowedSonnetPrimaryProfiles = new Set(['blog.writer']);
  for (const [team, profiles] of Object.entries(PROFILES || {})) {
    for (const [profile, config] of Object.entries(profiles as Record<string, any>)) {
      if ((config as any)?.primary_routes?.[0] === 'claude-code/sonnet') {
        sonnetPrimaryProfiles.push(`${team}.${profile}`);
      }
    }
  }
  const unexpectedSonnetPrimaryProfiles = sonnetPrimaryProfiles.filter((profile) => !allowedSonnetPrimaryProfiles.has(profile));
  assert.equal(unexpectedSonnetPrimaryProfiles.length, 0, `runtime profiles must not start with Sonnet: ${unexpectedSonnetPrimaryProfiles.join(', ')}`);

  console.log(JSON.stringify({
    ok: true,
    selector_version: 'v3.0_oauth_4',
    staged_rollout: staged,
    provider_counts: providerCounts,
    provider_shares: shares,
    sonnet_primary_profiles: sonnetPrimaryProfiles.length,
    allowed_sonnet_primary_profiles: Array.from(allowedSonnetPrimaryProfiles).filter((profile) => sonnetPrimaryProfiles.includes(profile)),
    anthropic_primary: 0,
  }, null, 2));
}

try {
  main();
} catch (error: any) {
  console.error('[llm-oauth-4-balance-smoke] failed:', error?.message || error);
  process.exit(1);
}
