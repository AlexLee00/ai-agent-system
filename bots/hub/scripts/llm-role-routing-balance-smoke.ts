#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.LLM_TEAM_SELECTOR_VERSION = 'v3.0_oauth_4';
process.env.LLM_TEAM_SELECTOR_AB_PERCENT = '100';

const require = createRequire(import.meta.url);
const selector = require('../../../packages/core/lib/llm-model-selector.ts');

function providerOf(entry: any): string {
  return String(entry?.provider || '').trim();
}

const targets = selector.listLlmRouteTargets({
  includeInternal: true,
  includeAliases: true,
  includeBlocked: false,
});

const counts: Record<string, number> = {};
const openAiPrimary: string[] = [];
const claudeCodeRoutes: string[] = [];

for (const target of targets) {
  if (!target.selectorKey) continue;
  const chain = selector.selectLLMChain(target.selectorKey, {
    selectorVersion: 'v3.0_oauth_4',
    rolloutPercent: 100,
    agentName: target.agent,
    team: target.team,
    rolloutKey: `role-routing-balance:${target.team}:${target.agent}`,
  });
  const primaryProvider = providerOf(chain[0]);
  counts[primaryProvider] = (counts[primaryProvider] || 0) + 1;
  if (primaryProvider === 'openai-oauth') openAiPrimary.push(`${target.team}.${target.agent}:${target.selectorKey}`);
  if (chain.some((entry: any) => providerOf(entry) === 'claude-code')) {
    claudeCodeRoutes.push(`${target.team}.${target.agent}:${target.selectorKey}`);
  }
}

const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
const openAiShare = total > 0 ? (counts['openai-oauth'] || 0) / total : 0;

assert.equal(claudeCodeRoutes.length, 0, 'automatic role routing must not include Claude Code routes');
assert(openAiShare <= 0.2, `OpenAI primary share must stay <= 20%, got ${(openAiShare * 100).toFixed(1)}%`);
assert((counts.groq || 0) > 0, 'Groq must carry some primary routes');
assert((counts['gemini-cli-oauth'] || 0) > 0, 'Gemini CLI OAuth must carry some primary routes');

console.log(JSON.stringify({
  ok: true,
  total,
  counts,
  openai_primary_share_pct: Number((openAiShare * 100).toFixed(2)),
  openai_primary_routes: openAiPrimary,
}, null, 2));
