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
const unexpectedClaudeCodeRoutes: string[] = [];
const unexpectedGeminiRoutes: string[] = [];

const claudeFirstWritingSelectors = new Set([
  'blog.pos.writer',
  'blog.gems.writer',
  'blog.curriculum.generate',
  'blog.book_review.preview',
]);

const claudeCodeFallbackSelectors = new Set([
  'claude.refactorer.code_refactor',
  'claude.auto_dev.code_fix',
  'claude.reviewer.code_review',
  'claude.doctor.recovery',
]);

function isGeminiProvider(provider: string): boolean {
  return provider === 'gemini-cli-oauth' || provider === 'gemini-oauth' || provider === 'gemini-codeassist-oauth';
}

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
  const routeLabel = `${target.team}.${target.agent}:${target.selectorKey}`;
  if (
    chain.some((entry: any) => providerOf(entry) === 'claude-code')
    && !claudeFirstWritingSelectors.has(target.selectorKey)
    && !claudeCodeFallbackSelectors.has(target.selectorKey)
  ) {
    unexpectedClaudeCodeRoutes.push(routeLabel);
  }
  if (chain.some((entry: any) => isGeminiProvider(providerOf(entry)))) {
    unexpectedGeminiRoutes.push(routeLabel);
  }
}

const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
const openAiShare = total > 0 ? (counts['openai-oauth'] || 0) / total : 0;

assert.equal(unexpectedClaudeCodeRoutes.length, 0, `Claude Code must stay limited to approved writing/code selectors: ${unexpectedClaudeCodeRoutes.join(', ')}`);
assert.equal(unexpectedGeminiRoutes.length, 0, `automatic role routing must not include Gemini routes: ${unexpectedGeminiRoutes.join(', ')}`);
assert(openAiShare <= 0.7, `OpenAI primary share must stay <= 70%, got ${(openAiShare * 100).toFixed(1)}%`);
assert((counts.groq || 0) > 0, 'Groq must carry some primary routes');
assert((counts['claude-code'] || 0) > 0, 'Claude Code must carry approved long-form writing primary routes');

console.log(JSON.stringify({
  ok: true,
  total,
  counts,
  openai_primary_share_pct: Number((openAiShare * 100).toFixed(2)),
  openai_primary_routes: openAiPrimary,
}, null, 2));
