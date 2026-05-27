#!/usr/bin/env tsx
// @ts-nocheck

import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

process.env.LLM_TEAM_SELECTOR_VERSION = process.env.LLM_TEAM_SELECTOR_VERSION || 'v3.0_oauth_4';
process.env.LLM_TEAM_SELECTOR_AB_PERCENT = process.env.LLM_TEAM_SELECTOR_AB_PERCENT || '100';
process.env.HUB_BUDGET_GUARDIAN_ENABLED = process.env.HUB_BUDGET_GUARDIAN_ENABLED || 'false';

const require = createRequire(import.meta.url);
const selector = require('../../../packages/core/lib/llm-model-selector.ts');
const { callWithFallback } = require('../lib/llm/unified-caller.ts');

const args = new Set(process.argv.slice(2));
const live = args.has('--live');
const candidates = [
  { id: 'hub_alarm_fast', callerTeam: 'hub', agent: 'alarm-classifier', selectorKey: 'hub.alarm.classifier', maxTokens: 16 },
  { id: 'hub_control_planner', callerTeam: 'hub', agent: 'control-planner', selectorKey: 'hub.control.planner', maxTokens: 16 },
  { id: 'claude_team_openai', callerTeam: 'claude', agent: 'lead', selectorKey: 'claude.lead.system_issue_triage', maxTokens: 16 },
  { id: 'blog_writer_quality', callerTeam: 'blog', agent: 'pos', selectorKey: 'blog.pos.writer', maxTokens: 32 },
  { id: 'luna_chronos_embedding', callerTeam: 'investment', agent: '', selectorKey: 'investment.chronos', maxTokens: 0 },
];

function routeLabel(entry: any): string {
  if (!entry?.provider || !entry?.model) return '';
  const model = String(entry.model);
  return model.startsWith(`${entry.provider}/`) ? model : `${entry.provider}/${model}`;
}

async function runLive(candidate: any): Promise<Record<string, unknown>> {
  const started = performance.now();
  const result = await callWithFallback({
    callerTeam: candidate.callerTeam,
    agent: candidate.agent,
    selectorKey: candidate.selectorKey,
    taskType: 'llm_speed_probe',
    abstractModel: 'anthropic_haiku',
    prompt: 'Reply exactly: OK',
    maxTokens: candidate.maxTokens,
    temperature: 0,
    timeoutMs: 45_000,
    cacheEnabled: false,
    suppressFallbackExhaustionAlarm: true,
  });
  return {
    id: candidate.id,
    selectorKey: candidate.selectorKey,
    ok: Boolean(result.ok),
    provider: result.provider || null,
    selected_route: result.selected_route || null,
    duration_ms: Math.round(performance.now() - started),
    error: result.error || null,
  };
}

async function main(): Promise<void> {
  const plan = candidates.map((candidate) => {
    const chain = selector.selectLLMChain(candidate.selectorKey, {
      selectorVersion: 'v3.0_oauth_4',
      rolloutPercent: 100,
      agentName: candidate.agent,
      maxTokens: candidate.maxTokens,
      rolloutKey: `llm-speed:${candidate.id}`,
    });
    return {
      id: candidate.id,
      selectorKey: candidate.selectorKey,
      route_order: chain.map(routeLabel),
      primary_provider: chain[0]?.provider || null,
      live_probe_tokens: candidate.maxTokens,
    };
  });

  if (!live) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'dry-run',
      note: 'Use --live to measure provider latency with real Hub calls.',
      plan,
    }, null, 2));
    return;
  }

  const results = [];
  for (const candidate of candidates) results.push(await runLive(candidate));
  console.log(JSON.stringify({ ok: results.every((item) => item.ok), mode: 'live', results }, null, 2));
}

main().catch((error) => {
  console.error('[llm-model-speed-test] failed:', error?.message || error);
  process.exit(1);
});
