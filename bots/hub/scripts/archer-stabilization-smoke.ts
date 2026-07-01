// @ts-nocheck
import assert from 'node:assert/strict';
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

assert.match(archerConfig, /openaiTimeout:\s*240000/, 'Archer LLM timeout must be 240 seconds');
assert.match(unifiedCaller, /claude\.archer\.tech_analysis/, 'Archer fallback exhaustion alarms must be suppressible');

const archerSelector = describeLLMSelector('claude.archer.tech_analysis', {
  selectorVersion: 'v3.0_oauth_4',
  rolloutPercent: 100,
});
assert.equal(
  archerSelector?.primary?.timeoutMs,
  240_000,
  'Archer selector primary route must not retain the old 60s timeout',
);

const archerBudget = resolveTokenBudget({
  callerTeam: 'claude',
  agent: 'archer',
  selectorKey: 'claude.archer.tech_analysis',
  taskType: 'architecture_review',
  timeoutMs: 240_000,
  maxTokens: 4096,
  maxBudgetUsd: 0.08,
});
assert.equal(archerBudget.profileName, 'archer_batch_analysis');
assert.equal(archerBudget.timeoutMs, 240_000);
assert.equal(archerBudget.perAttemptTimeoutMs, 240_000);

const archerPayload = parseLlmCallPayload({
  callerTeam: 'claude',
  agent: 'archer',
  selectorKey: 'claude.archer.tech_analysis',
  abstractModel: 'anthropic_sonnet',
  prompt: 'fixture',
  timeoutMs: 240_000,
});
assert.equal(archerPayload.ok, true, 'Hub request schema must allow Archer 240s requests');

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
    240_000,
    'Archer analyzer must pass THRESHOLDS.openaiTimeout to Hub LLM',
  );
}

const originalFetch = globalThis.fetch;
const captured: any[] = [];

async function main() {
  await assertAnalyzerUsesArcherTimeout();

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
      timeoutMs: 240_000,
    });
    await callHubLlm({
      callerTeam: 'claude',
      agent: 'dexter',
      selectorKey: 'claude.dexter.ai_analyst',
      prompt: 'fixture',
      timeoutMs: 240_000,
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

  assert.equal(captured[0]?.timeoutMs, 240_000, 'Archer request should keep 240s timeout');
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
