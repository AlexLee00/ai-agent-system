#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.LLM_TEAM_SELECTOR_VERSION = 'v3.0_oauth_4';
process.env.LLM_TEAM_SELECTOR_AB_PERCENT = '100';
process.env.HUB_BUDGET_GUARDIAN_ENABLED = 'false';

const require = createRequire(import.meta.url);
const selector = require('../../../packages/core/lib/llm-model-selector.ts');
const groqFallback = require('../lib/llm/groq-fallback.ts');

const SELECTOR_OPTIONS = { selectorVersion: 'v3.0_oauth_4', rolloutPercent: 100 };
const CLAUDE_FIRST_WRITING_SELECTORS = new Set([
  'blog.pos.writer',
  'blog.gems.writer',
  'blog.curriculum.generate',
  'blog.book_review.preview',
]);

function providerOf(entry: any): string {
  return String(entry?.provider || '').trim();
}

function isGemini(entry: any): boolean {
  const provider = providerOf(entry);
  const model = String(entry?.model || '').trim();
  return provider === 'gemini-cli-oauth'
    || provider === 'gemini-oauth'
    || provider === 'gemini-codeassist-oauth'
    || model.startsWith('gemini-')
    || model.startsWith('gemini-cli-oauth/')
    || model.startsWith('gemini-codeassist-oauth/');
}

function chainFor(key: string, extra: Record<string, unknown> = {}): any[] {
  return selector.selectLLMChain(key, { ...SELECTOR_OPTIONS, rolloutKey: `routing-optimization:${key}`, ...extra });
}

const selectorKeys = selector.listLLMSelectorKeys();
const unexpectedGeminiRoutes: string[] = [];
const staleGroqRoutes: string[] = [];
for (const key of selectorKeys) {
  const chain = chainFor(key);
  const hasGemini = chain.some(isGemini);
  const staleGroqModels = chain
    .filter((entry) => /llama-4-scout-17b-16e-instruct/.test(String(entry?.model || '')))
    .map((entry) => `${entry.provider}/${entry.model}`);
  if (staleGroqModels.length > 0) staleGroqRoutes.push(`${key}:${staleGroqModels.join('|')}`);
  if (hasGemini) unexpectedGeminiRoutes.push(key);
}
assert.equal(unexpectedGeminiRoutes.length, 0, `selectors must not route to retired Gemini: ${unexpectedGeminiRoutes.join(', ')}`);
assert.equal(staleGroqRoutes.length, 0, `selectors must not route to stale Groq Scout model: ${staleGroqRoutes.join(', ')}`);

for (const key of ['claude._default', 'claude.archer.tech_analysis', 'claude.lead.system_issue_triage', 'claude.dexter.ai_analyst']) {
  const chain = chainFor(key);
  assert.equal(providerOf(chain[0]), 'openai-oauth', `${key} must use OpenAI primary`);
  assert(!chain.some(isGemini), `${key} must not fall back to Gemini`);
  assert(!chain.some((entry) => providerOf(entry) === 'claude-code'), `${key} must not use Claude Code after Claude-team OpenAI override`);
}

for (const { selectorKey, agentName } of [
  { selectorKey: 'darwin.agent_policy', agentName: 'darwin.planner' },
  { selectorKey: 'darwin.agent_policy', agentName: 'darwin.evaluator' },
  { selectorKey: 'darwin.agent_policy', agentName: 'darwin.scanner' },
  { selectorKey: 'sigma.agent_policy', agentName: 'skill.causal' },
  { selectorKey: 'sigma.agent_policy', agentName: 'mapek.monitor' },
]) {
  const chain = chainFor(selectorKey, { agentName });
  assert.equal(providerOf(chain[0]), 'openai-oauth', `${selectorKey}/${agentName} must use OpenAI primary to avoid Groq pool exhaustion`);
  assert(chain.some((entry) => providerOf(entry) === 'groq'), `${selectorKey}/${agentName} must retain Groq Scout fallback behind OpenAI`);
  assert(!chain.some((entry) => providerOf(entry) === 'local'), `${selectorKey}/${agentName} must not use local generative fallback`);
  assert(!chain.some(isGemini), `${selectorKey}/${agentName} must not fall back to Gemini`);
}

{
  const chain = chainFor('darwin.agent_policy', { agentName: 'darwin.synthesis' });
  assert.equal(providerOf(chain[0]), 'groq', 'darwin.agent_policy/darwin.synthesis must start on Groq account-pool routing');
  assert(chain.some((entry) => providerOf(entry) === 'openai-oauth'), 'darwin.agent_policy/darwin.synthesis must retain OpenAI quality fallback');
  assert(!chain.some((entry) => providerOf(entry) === 'local'), 'darwin.agent_policy/darwin.synthesis must not use local generative fallback');
  assert(!chain.some(isGemini), 'darwin.agent_policy/darwin.synthesis must not fall back to Gemini');
}

for (const key of CLAUDE_FIRST_WRITING_SELECTORS) {
  const chain = chainFor(key);
  assert.equal(providerOf(chain[0]), 'claude-code', `${key} must use Claude first for long-form writing`);
  assert(!chain.some(isGemini), `${key} must not fall back to Gemini`);
  assert(!chain.some((entry) => providerOf(entry) === 'groq' && Number(entry.maxTokens || 0) > 4096), `${key} must not use Groq for high-token writing`);
}

const speedSensitive = [
  'hub.alarm.classifier',
  'hub.alarm.interpreter.work',
  'orchestrator.jay.summary',
  'blog.social.caption',
  'blog.social.summarize',
];
for (const key of speedSensitive) {
  const chain = chainFor(key);
  assert(['groq', 'openai-oauth', 'local'].includes(providerOf(chain[0])), `${key} must use fast non-Gemini primary`);
  assert.notEqual(providerOf(chain[0]), 'claude-code', `${key} must not put Claude on speed-sensitive path`);
  assert(!chain.some(isGemini), `${key} must not fall back to Gemini`);
}

const chronosDirect = chainFor('investment.chronos');
assert.notEqual(
  providerOf(chronosDirect[0]),
  'local-embedding',
  'investment.chronos structured judgment route must remain generative',
);
const chronosPolicy = chainFor('investment.agent_policy', { agentName: 'chronos' });
assert.notEqual(
  providerOf(chronosPolicy[0]),
  'local-embedding',
  'investment.agent_policy/chronos structured judgment route must remain generative',
);
const chronosBacktest = chainFor('chronos.backtest');
assert.deepEqual(
  chronosBacktest.map((entry) => `${entry.provider}/${entry.model}`),
  ['local-embedding/qwen3-embed-0.6b'],
  'chronos.backtest must be fixed to local embedding only',
);
const chronosBacktestEmbedding = chainFor('investment.agent_policy', {
  agentName: 'chronos',
  taskType: 'backtest_embedding',
});
assert.deepEqual(
  chronosBacktestEmbedding.map((entry) => `${entry.provider}/${entry.model}`),
  ['local-embedding/qwen3-embed-0.6b'],
  'investment.agent_policy/chronos backtest_embedding must remain local embedding only',
);

const highTokenGroqGuard = groqFallback._testOnly.resolveGroqTokenGuard({
  prompt: 'short prompt',
  model: 'qwen/qwen3-32b',
  maxTokens: 12000,
});
assert.equal(highTokenGroqGuard.ok, false, 'Groq token guard must reject high completion-token requests');
assert.equal(highTokenGroqGuard.reason, 'completion_token_limit');

console.log(JSON.stringify({
  ok: true,
  checked_selector_keys: selectorKeys.length,
  gemini_routes: 0,
  claude_first_writing_selectors: [...CLAUDE_FIRST_WRITING_SELECTORS],
  chronos_route: chronosDirect.map((entry) => `${entry.provider}/${entry.model}`),
  chronos_backtest_route: chronosBacktest.map((entry) => `${entry.provider}/${entry.model}`),
  groq_token_guard: highTokenGroqGuard,
}, null, 2));
