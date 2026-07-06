#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const selector = require('../src/llm-selector.ts');
const unified = require('../lib/llm/unified-caller.ts');
const providerRegistry = require('../lib/llm/provider-registry.ts');
const lifecycle = require('../lib/alarm/lifecycle.ts');
const telemetry = require('../lib/telemetry.ts');

function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] == null) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertSelectorFallback() {
  const fallback = selector.resolveHubLlmSelection({
    callerTeam: 'unknownteam',
    agent: 'missing-profile-smoke',
    taskType: 'missing-purpose-smoke',
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.selectorKey, 'hub._default');
  assert.equal(fallback.selectorFallbackReason, 'selector_chain_required_defaulted');
  assert.ok(fallback.chain.length > 0);

  const profileFallback = selector.resolveHubLlmSelection({
    callerTeam: 'blog',
    agent: 'missing-profile-smoke',
    taskType: 'missing-purpose-smoke',
  });
  assert.equal(profileFallback.ok, true);
  assert.equal(profileFallback.runtimeProfile, 'blog.default');

  const nonLlm = selector.resolveHubLlmSelection({
    callerTeam: 'investment',
    agent: 'sweeper',
  });
  assert.equal(nonLlm.ok, false);
  assert.equal(nonLlm.error, 'llm_non_llm_target_blocked');

  const adhocBlocked = selector.resolveHubLlmSelection({
    callerTeam: 'hub',
    chain: [{ provider: 'openai-oauth', model: 'manual' }],
  });
  assert.equal(adhocBlocked.ok, false);
  assert.equal(adhocBlocked.error, 'llm_adhoc_chain_blocked');
}

function assertResiliencePlan() {
  const chain = [
    { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 900 },
    { provider: 'groq', model: 'openai/gpt-oss-20b', maxTokens: 300 },
    { provider: 'local', model: 'qwen2.5-7b', maxTokens: 200 },
    { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 200 },
  ];
  const off = withEnv({ HUB_RESILIENCE_ENABLED: null }, () =>
    unified._testOnly._buildResilienceFallbackPlan(chain, { selectorKey: 'hub._default' }, { abstractModel: 'anthropic_haiku' }));
  assert.equal(off.mode, 'off');
  assert.deepEqual(off.routes, [
    'openai-oauth/gpt-5.4',
    'groq/openai/gpt-oss-20b',
    'local/qwen2.5-7b',
    'openai-oauth/gpt-5.4-mini',
  ]);

  const on = withEnv({ HUB_RESILIENCE_ENABLED: 'true' }, () =>
    unified._testOnly._buildResilienceFallbackPlan(chain, { selectorKey: 'hub._default' }, { abstractModel: 'anthropic_haiku' }));
  assert.equal(on.mode, 'enabled');
  assert.deepEqual(on.routes, [
    'openai-oauth/gpt-5.4',
    'openai-oauth/gpt-5.4-mini',
    'groq/openai/gpt-oss-20b',
    'local/qwen2.5-7b',
  ]);
}

function assertCircuitThresholds() {
  const defaultProvider = 'hub-remodel-default-circuit-smoke';
  withEnv({ HUB_RESILIENCE_ENABLED: null }, () => {
    providerRegistry.resetProviderCircuit(defaultProvider);
    providerRegistry.recordFailure(defaultProvider, 'smoke', 1);
    providerRegistry.recordFailure(defaultProvider, 'smoke', 1);
    assert.equal(providerRegistry.canCall(defaultProvider), true);
    providerRegistry.recordFailure(defaultProvider, 'smoke', 1);
    assert.equal(providerRegistry.canCall(defaultProvider), false);
    providerRegistry.resetProviderCircuit(defaultProvider);
  });

  const resilienceProvider = 'hub-remodel-resilience-circuit-smoke';
  withEnv({ HUB_RESILIENCE_ENABLED: 'true' }, () => {
    providerRegistry.resetProviderCircuit(resilienceProvider);
    for (let i = 0; i < 4; i += 1) providerRegistry.recordFailure(resilienceProvider, 'smoke', 1);
    assert.equal(providerRegistry.canCall(resilienceProvider), true);
    providerRegistry.recordFailure(resilienceProvider, 'smoke', 1);
    assert.equal(providerRegistry.canCall(resilienceProvider), false);
    providerRegistry.resetProviderCircuit(resilienceProvider);
  });
}

function assertLoggingSourceMarkers() {
  const source = fs.readFileSync(path.join(repoRoot, 'bots/hub/lib/routes/llm.ts'), 'utf8');
  assert.match(source, /routingLogStandardColumnsExist/);
  assert.match(source, /routing_source/);
  assert.match(source, /fallback_used/);
  assert.match(source, /latency_ms/);
  const migration = fs.readFileSync(path.join(repoRoot, 'bots/hub/migrations/20260706000001_llm_routing_log_standard_columns.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS routing_source/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS fallback_used/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS latency_ms/);
}

function assertAlarmLifecycle() {
  const fpA = lifecycle.buildAlarmLifecycleFingerprint({
    team: 'claude',
    alarmType: 'error',
    incidentKey: 'claude:alarm:hashabcdef123456',
    title: 'claude alarm 123',
  });
  const fpB = lifecycle.buildAlarmLifecycleFingerprint({
    team: 'claude',
    alarmType: 'error',
    incidentKey: 'claude:alarm:hash999999999999',
    title: 'claude alarm 456',
  });
  assert.equal(fpA.fingerprint, fpB.fingerprint);
  const repeat = lifecycle.buildRepeatDecision({
    previousAt: '2026-07-06T00:00:00.000Z',
    now: '2026-07-06T03:00:00.000Z',
  });
  assert.equal(repeat.repeatIntervalMinutes, 360);
  assert.equal(repeat.suppress, true);
  const ttl = lifecycle.buildTtlAutoResolvePlan([
    { id: 1, status: 'new', metadata: { ttl_auto_resolve_at: '2026-07-06T00:00:00.000Z' } },
  ], { now: '2026-07-06T01:00:00.000Z' });
  assert.equal(ttl[0].shouldResolve, true);
}

async function assertTelemetryAndDocs() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-telemetry-smoke-'));
  const filePath = path.join(temp, 'telemetry.jsonl');
  withEnv({ HUB_TELEMETRY_PATH: filePath }, () => {
    const result = telemetry.recordHubTelemetry('smoke', { token: 'secret', nested: { ok: true } });
    assert.equal(result.ok, true);
  });
  await telemetry.flushHubTelemetry();
  const line = fs.readFileSync(filePath, 'utf8').trim();
  assert.ok(line.includes('"stage":"smoke"'));
  assert.ok(line.includes('[redacted]'));

  const skillPath = path.join(repoRoot, 'bots/hub/skills/hub-ops/SKILL.md');
  const skillLines = fs.readFileSync(skillPath, 'utf8').trim().split(/\r?\n/).length;
  assert.ok(skillLines <= 41, `hub skill too long: ${skillLines}`);
  for (const command of fs.readdirSync(path.join(repoRoot, 'bots/hub/skills/hub-ops/commands'))) {
    const lines = fs.readFileSync(path.join(repoRoot, 'bots/hub/skills/hub-ops/commands', command), 'utf8').trim().split(/\r?\n/).length;
    assert.ok(lines <= 120, `${command} too long: ${lines}`);
  }

  const card = JSON.parse(fs.readFileSync(path.join(repoRoot, 'bots/hub/a2a/hub-card.json'), 'utf8'));
  const skillIds = new Set(card.skills.map((skill) => skill.id));
  assert.equal(skillIds.has('hub-sigma-llm-feed'), true);
  assert.equal(skillIds.has('hub-alarm-lifecycle'), true);
  assert.equal(skillIds.has('hub-resilience-status'), true);

  const guide = fs.readFileSync(path.join(repoRoot, 'docs/hub/MODEL_SELECTION_GUIDE.md'), 'utf8');
  assert.match(guide, /LLM_AUTO_ROUTING_ENABLED=shadow/);
  assert.match(guide, /hub\._default/);
}

async function assertSigmaFeedDryRun() {
  const { runSigmaHubLlmFeed } = await import('../../sigma/scripts/runtime-sigma-hub-llm-feed.ts');
  const report = await runSigmaHubLlmFeed({
    dryRun: true,
    queryReadonly: async () => [
      {
        caller_team: 'hub',
        agent: 'smoke',
        selector_key: 'hub._default',
        route: 'openai-oauth/model',
        error: 'fallback_exhausted: provider_circuit_open:openai-oauth',
        count: 5,
        fallback_sum: 5,
      },
    ],
  });
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.persisted.attempted, 0);
  assert.ok(report.proposals[0].includes('provider circuit open'));
  assert.equal(report.vaultCandidate.meta.domain, 'hub_llm');
}

async function main() {
  assertSelectorFallback();
  assertResiliencePlan();
  assertCircuitThresholds();
  assertLoggingSourceMarkers();
  assertAlarmLifecycle();
  await assertTelemetryAndDocs();
  await assertSigmaFeedDryRun();
  const result = {
    ok: true,
    smoke: 'hub-remodel-hbs1-hbs4',
    checks: [
      'selector_default_guarantee',
      'resilience_off_on_plan',
      'circuit_threshold_gate',
      'routing_log_standard_columns',
      'alarm_lifecycle_simulation',
      'telemetry_skill_a2a',
      'sigma_feed_dry_run',
    ],
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('hub-remodel-hbs1-hbs4-smoke ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
