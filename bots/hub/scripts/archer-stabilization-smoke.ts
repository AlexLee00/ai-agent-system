// @ts-nocheck
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { callHubLlm } from '../../../packages/core/lib/hub-client.ts';
import { describeLLMSelector } from '../../../packages/core/lib/llm-model-selector.ts';
import { resolveTokenBudget } from '../../../packages/core/lib/token-budget.ts';

const { parseLlmCallPayload } = require('../lib/llm/request-schema.ts');
const { loadTsSourceBridge } = require('../../claude/lib/ts-source-bridge.js');

const repoRoot = path.resolve(__dirname, '../../..');
const archerConfig = fs.readFileSync(path.join(repoRoot, 'bots/claude/lib/archer/config.ts'), 'utf8');
const unifiedCaller = fs.readFileSync(path.join(repoRoot, 'bots/hub/lib/llm/unified-caller.ts'), 'utf8');

function expectedArcherTimeoutMs() {
  const profilesEnabled = /^(1|true|yes|on)$/i.test(String(process.env.SELECTOR_TIMEOUT_PROFILES_ENABLED || '').trim());
  const fallback = profilesEnabled ? 300_000 : 240_000;
  const override = profilesEnabled
    ? (process.env.SELECTOR_TIMEOUT_MS_CLAUDE_ARCHER_TECH_ANALYSIS || process.env.ARCHER_TIMEOUT_MS)
    : null;
  const parsed = Number(override || fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(60_000, Math.min(300_000, Math.floor(parsed)));
}

const EXPECTED_ARCHER_TIMEOUT_MS = expectedArcherTimeoutMs();

assert.match(archerConfig, /ARCHER_TIMEOUT_MS/, 'Archer timeout must be env-gated');
assert.match(unifiedCaller, /claude\.archer\.tech_analysis/, 'Archer fallback exhaustion alarms must be suppressible');

const archerSelector = describeLLMSelector('claude.archer.tech_analysis', {
  selectorVersion: 'v3.0_oauth_4',
  rolloutPercent: 100,
});
assert.equal(
  archerSelector?.primary?.timeoutMs,
  EXPECTED_ARCHER_TIMEOUT_MS,
  'Archer selector primary route must use the effective profile timeout',
);

const archerBudget = resolveTokenBudget({
  callerTeam: 'claude',
  agent: 'archer',
  selectorKey: 'claude.archer.tech_analysis',
  taskType: 'architecture_review',
  timeoutMs: EXPECTED_ARCHER_TIMEOUT_MS,
  maxTokens: 4096,
  maxBudgetUsd: 0.08,
});
assert.equal(archerBudget.profileName, 'archer_batch_analysis');
assert.equal(archerBudget.timeoutMs, EXPECTED_ARCHER_TIMEOUT_MS);
assert.equal(archerBudget.perAttemptTimeoutMs, EXPECTED_ARCHER_TIMEOUT_MS);

const archerPayload = parseLlmCallPayload({
  callerTeam: 'claude',
  agent: 'archer',
  selectorKey: 'claude.archer.tech_analysis',
  abstractModel: 'anthropic_sonnet',
  prompt: 'fixture',
  timeoutMs: 300_000,
});
assert.equal(archerPayload.ok, true, 'Hub request schema must allow Archer 300s requests');

function assertArcherTimeoutEnvOverride() {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
    const path = require('node:path');
    const { loadTsSourceBridge } = require('./bots/claude/lib/ts-source-bridge.js');
    const { describeLLMSelector } = require('./packages/core/lib/llm-model-selector.ts');
    const { resolveTokenBudget } = require('./packages/core/lib/token-budget.ts');
    const config = loadTsSourceBridge(path.resolve('bots/claude/lib/archer'), 'config');
    const selector = describeLLMSelector('claude.archer.tech_analysis', {
      selectorVersion: 'v3.0_oauth_4',
      rolloutPercent: 100,
    });
    const budget = resolveTokenBudget({
      callerTeam: 'claude',
      agent: 'archer',
      selectorKey: 'claude.archer.tech_analysis',
      timeoutMs: 120000,
    });
    console.log(JSON.stringify({
      config: config.THRESHOLDS.openaiTimeout,
      selector: selector.primary.timeoutMs,
      budget: budget.timeoutMs,
      perAttempt: budget.perAttemptTimeoutMs,
    }));
  `], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SELECTOR_TIMEOUT_PROFILES_ENABLED: 'true',
      ARCHER_TIMEOUT_MS: '120000',
    },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(String(child.stdout || '{}'));
  assert.deepEqual(result, {
    config: 120000,
    selector: 120000,
    budget: 120000,
    perAttempt: 120000,
  });
}

async function assertAnalyzerUsesArcherTimeout() {
  const hubClientBridgePath = path.join(repoRoot, 'packages/core/lib/hub-client.js');
  const resolvedHubClient = require.resolve(hubClientBridgePath);
  const originalCacheEntry = require.cache[resolvedHubClient];
  const capturedAnalyzerRequests: any[] = [];

  require.cache[resolvedHubClient] = {
    id: resolvedHubClient,
    filename: resolvedHubClient,
    loaded: true,
    exports: {
      callHubLlm: async (request: any) => {
        capturedAnalyzerRequests.push(request);
        return {
          text: JSON.stringify({
            patches: [],
            security: [],
            llm_api: [],
            ai_techniques: [],
            web_highlights: [],
            summary: 'fixture',
          }),
          provider: 'fixture',
          model: 'fixture-model',
          fallbackCount: 0,
          selected_route: 'fixture/model',
        };
      },
    },
  } as Module;

  try {
    const analyzer = loadTsSourceBridge(path.join(repoRoot, 'bots/claude/lib/archer'), 'analyzer');
    await analyzer.analyze({
      github: {},
      npm: {},
      webSources: [],
      audit: { total: 0, summary: {}, vulnerabilities: {} },
    }, {});
  } finally {
    if (originalCacheEntry) {
      require.cache[resolvedHubClient] = originalCacheEntry;
    } else {
      delete require.cache[resolvedHubClient];
    }
  }

  assert.equal(
    capturedAnalyzerRequests[0]?.timeoutMs,
    EXPECTED_ARCHER_TIMEOUT_MS,
    'Archer analyzer must pass THRESHOLDS.openaiTimeout to Hub LLM',
  );
}

const originalFetch = globalThis.fetch;
const captured: any[] = [];

async function main() {
  await assertAnalyzerUsesArcherTimeout();
  assertArcherTimeoutEnvOverride();

  globalThis.fetch = async (_url: string, init: any = {}) => {
    const body = JSON.parse(String(init.body || '{}'));
    captured.push(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: 'OK',
        provider: 'fixture',
        selected_route: 'fixture/model',
        durationMs: 1,
      }),
    } as any;
  };

  try {
    await callHubLlm({
      callerTeam: 'claude',
      agent: 'archer',
      selectorKey: 'claude.archer.tech_analysis',
      prompt: 'fixture',
      timeoutMs: EXPECTED_ARCHER_TIMEOUT_MS,
    });
    await callHubLlm({
      callerTeam: 'claude',
      agent: 'dexter',
      selectorKey: 'claude.dexter.ai_analyst',
      prompt: 'fixture',
      timeoutMs: 300_000,
    });
    await callHubLlm({
      callerTeam: 'blog',
      agent: 'pos',
      selectorKey: 'blog.pos.writer',
      prompt: 'fixture',
      timeoutMs: 600_000,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured[0]?.timeoutMs, EXPECTED_ARCHER_TIMEOUT_MS, 'Archer request should keep env-gated timeout');
  assert.equal(captured[1]?.timeoutMs, 180_000, 'non-Archer request should stay capped at 180s');
  assert.equal(captured[2]?.timeoutMs, 600_000, 'blog writer long-running exception should remain unchanged');

  console.log(JSON.stringify({
    ok: true,
    archer_timeout_ms: captured[0]?.timeoutMs,
    default_cap_ms: captured[1]?.timeoutMs,
    blog_writer_cap_ms: captured[2]?.timeoutMs,
    fallback_alarm_suppression_marker: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
