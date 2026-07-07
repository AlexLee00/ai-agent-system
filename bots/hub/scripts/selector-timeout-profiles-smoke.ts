#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildSelectorTimeoutTunerReport } from './selector-timeout-tuner.ts';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function runFixture(envPatch = {}) {
  const env = { ...process.env, ...envPatch };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined || env[key] === null) delete env[key];
  }
  const child = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
    const path = require('node:path');
    const { loadTsSourceBridge } = require('./bots/claude/lib/ts-source-bridge.js');
    const selector = require('./packages/core/lib/llm-model-selector.ts');
    const timeoutProfiles = require('./packages/core/lib/selector-timeout-profiles.ts');
    const { resolveTokenBudget } = require('./packages/core/lib/token-budget.ts');
    const archerConfig = loadTsSourceBridge(path.resolve('bots/claude/lib/archer'), 'config');

    const selectorOptions = { selectorVersion: 'v3.0_oauth_4', rolloutPercent: 100 };
    const archer = selector.describeLLMSelector('claude.archer.tech_analysis', selectorOptions);
    const classifier = selector.describeLLMSelector('hub.alarm.classifier', selectorOptions);
    const luna = selector.describeLLMSelector('investment.luna', { ...selectorOptions, agentName: 'luna' });
    const blogPos = selector.describeLLMSelector('blog.pos.writer', selectorOptions);
    const archerBudget = resolveTokenBudget({
      callerTeam: 'claude',
      agent: 'archer',
      selectorKey: 'claude.archer.tech_analysis',
      maxTokens: 4096,
    });
    const blogBudget = resolveTokenBudget({
      callerTeam: 'blog',
      agent: 'pos',
      selectorKey: 'blog.pos.writer',
      maxTokens: 4096,
    });
    console.log(JSON.stringify({
      archerTimeout: archer.primary && archer.primary.timeoutMs,
      archerProfile: timeoutProfiles.resolveSelectorTimeoutProfile('claude.archer.tech_analysis', {
        fallbackTimeoutMs: archer.primary && archer.primary.timeoutMs,
      }),
      archerBudgetTimeout: archerBudget.timeoutMs,
      archerBudgetPerAttempt: archerBudget.perAttemptTimeoutMs,
      archerConfigTimeout: archerConfig.THRESHOLDS.openaiTimeout,
      classifierTimeout: classifier.primary && classifier.primary.timeoutMs,
      classifierProfile: classifier.timeoutProfile,
      lunaTimeout: luna.primary && luna.primary.timeoutMs,
      lunaProfile: luna.timeoutProfile,
      blogPosTimeout: blogPos.primary?.timeoutMs ?? null,
      blogPosProfile: blogPos.timeoutProfile,
      blogBudgetTimeout: blogBudget.timeoutMs,
      blogBudgetPerAttempt: blogBudget.perAttemptTimeoutMs,
    }));
  `], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(String(child.stdout || '{}'));
}

const off = runFixture({
  SELECTOR_TIMEOUT_PROFILES_ENABLED: undefined,
  ARCHER_TIMEOUT_MS: undefined,
  SELECTOR_TIMEOUT_MS_CLAUDE_ARCHER_TECH_ANALYSIS: undefined,
});
assert.equal(off.archerTimeout, 240_000, 'OFF must preserve current Archer selector timeout');
assert.equal(off.archerBudgetTimeout, 240_000, 'OFF must preserve current Archer token-budget timeout');
assert.equal(off.archerBudgetPerAttempt, 240_000, 'OFF must preserve current Archer per-attempt timeout');
assert.equal(off.archerConfigTimeout, 240_000, 'OFF must preserve current Archer client timeout');
assert.equal(off.archerProfile.enabled, false, 'OFF must not activate selector timeout profiles');

const on = runFixture({
  SELECTOR_TIMEOUT_PROFILES_ENABLED: 'true',
  ARCHER_TIMEOUT_MS: undefined,
  SELECTOR_TIMEOUT_MS_CLAUDE_ARCHER_TECH_ANALYSIS: undefined,
});
assert.equal(on.archerTimeout, 300_000, 'Archer must use deep profile when enabled');
assert.equal(on.archerBudgetTimeout, 300_000, 'Archer token budget must use deep profile when enabled');
assert.equal(on.archerBudgetPerAttempt, 300_000, 'Archer per-attempt budget must use deep profile when enabled');
assert.equal(on.archerConfigTimeout, 300_000, 'Archer client timeout must use deep profile when enabled');
assert.equal(on.archerProfile.source, 'declaration', 'Archer profile must come from selector declaration');
assert.equal(on.classifierTimeout, 15_000, 'Hub alarm classifier must use fast profile');
assert.equal(on.classifierProfile.source, 'declaration');
assert.equal(on.lunaTimeout, 60_000, 'Luna selector must use standard profile');
assert.equal(on.lunaProfile.source, 'declaration');
assert.equal(on.blogPosTimeout, null, 'undeclared selectors must keep their existing chain timeout');
assert.equal(on.blogPosProfile.enabled, false, 'undeclared selectors must not receive the default tier overlay');
assert.equal(on.blogBudgetTimeout, 600_000, 'undeclared long-running blog budget must not be reduced by selector profiles');
assert.equal(on.blogBudgetPerAttempt, 420_000, 'blog writer runtime profile must apply 420s per-attempt timeout');

const override = runFixture({
  SELECTOR_TIMEOUT_PROFILES_ENABLED: 'true',
  SELECTOR_TIMEOUT_MS_CLAUDE_ARCHER_TECH_ANALYSIS: '120000',
  ARCHER_TIMEOUT_MS: undefined,
});
assert.equal(override.archerTimeout, 120_000, 'selector-specific env must override declaration');
assert.equal(override.archerBudgetTimeout, 120_000);
assert.equal(override.archerConfigTimeout, 120_000);
assert.equal(override.archerProfile.source, 'env');
assert.equal(override.archerProfile.envName, 'SELECTOR_TIMEOUT_MS_CLAUDE_ARCHER_TECH_ANALYSIS');

const compatOverride = runFixture({
  SELECTOR_TIMEOUT_PROFILES_ENABLED: 'true',
  SELECTOR_TIMEOUT_MS_CLAUDE_ARCHER_TECH_ANALYSIS: undefined,
  ARCHER_TIMEOUT_MS: '90000',
});
assert.equal(compatOverride.archerTimeout, 90_000, 'ARCHER_TIMEOUT_MS must remain a compatibility override');
assert.equal(compatOverride.archerProfile.envName, 'ARCHER_TIMEOUT_MS');

const tunerReport = buildSelectorTimeoutTunerReport([
  {
    selector_key: 'claude.archer.tech_analysis',
    sample: 20,
    avg_duration_ms: 40_000,
    p95_duration_ms: 70_000,
    p99_duration_ms: 80_000,
    max_duration_ms: 90_000,
  },
  {
    selector_key: 'hub.alarm.classifier',
    sample: 2,
    avg_duration_ms: 1000,
    p95_duration_ms: 1200,
    p99_duration_ms: 1500,
    max_duration_ms: 1800,
  },
], { days: 14, minSamples: 10, generatedAt: '2026-07-03T00:00:00.000Z' });
const archerSuggestion = tunerReport.suggestions.find((item) => item.selectorKey === 'claude.archer.tech_analysis');
assert.equal(archerSuggestion.proposedTimeoutMs, 120_000, 'tuner must propose p99*1.5 clamped by tier bounds');
const classifierSuggestion = tunerReport.suggestions.find((item) => item.selectorKey === 'hub.alarm.classifier');
assert.equal(classifierSuggestion.status, 'insufficient_samples_keep_current');
assert.equal(classifierSuggestion.proposedTimeoutMs, 15_000);

console.log(JSON.stringify({
  ok: true,
  smoke: 'selector-timeout-profiles',
  off: {
    archerTimeout: off.archerTimeout,
    source: off.archerProfile.source,
  },
  on: {
    archerTimeout: on.archerTimeout,
    classifierTimeout: on.classifierTimeout,
    lunaTimeout: on.lunaTimeout,
    blogBudgetTimeout: on.blogBudgetTimeout,
    blogBudgetPerAttempt: on.blogBudgetPerAttempt,
  },
  override: {
    archerTimeout: override.archerTimeout,
    source: override.archerProfile.source,
  },
  tuner: {
    archerProposedTimeoutMs: archerSuggestion.proposedTimeoutMs,
    classifierStatus: classifierSuggestion.status,
  },
}, null, 2));
