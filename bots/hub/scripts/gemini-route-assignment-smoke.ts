#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function firstProviderFromSelector(description) {
  return String(description?.chain?.[0]?.provider || '').trim();
}

function hasProvider(description, provider) {
  return Array.isArray(description?.chain) && description.chain.some((entry) => entry.provider === provider);
}

async function main() {
  const { PROFILES } = await import('../lib/runtime-profiles.ts');
  const selector = await import('../../../packages/core/lib/llm-model-selector.ts');
  const drillSource = read('bots/hub/scripts/team-llm-route-drill.ts');

  const runtimeSummary = PROFILES?.orchestrator?.summary;
  assert(runtimeSummary, 'orchestrator.summary runtime profile is required');
  assert.equal(
    runtimeSummary.primary_routes?.[0],
    'openai-oauth/gpt-5.4-mini',
    'orchestrator.summary runtime primary must use the stable OpenAI OAuth summary route',
  );
  assert(
    runtimeSummary.fallback_routes?.includes('gemini-cli-oauth/gemini-2.5-flash'),
    'orchestrator.summary runtime must keep Gemini CLI OAuth as a low-cost fallback',
  );

  const selected = selector.describeAgentModel('orchestrator', 'summary');
  assert.equal(
    firstProviderFromSelector(selected),
    'openai-oauth',
    'orchestrator/summary selector primary must use the stable OpenAI OAuth summary route',
  );
  assert(
    hasProvider(selected, 'gemini-cli-oauth'),
    'orchestrator/summary selector must keep Gemini CLI OAuth fallback',
  );
  assert(
    hasProvider(selected, 'groq'),
    'orchestrator/summary selector must keep Groq fallback while Claude Code quota is saturated',
  );

  assert(
    drillSource.includes('geminiPrimary'),
    'team LLM drill must include at least one Gemini-primary profile check when present',
  );

  console.log(JSON.stringify({
    ok: true,
    runtime_profile: 'orchestrator.summary',
    primary_provider: 'openai-oauth',
    fallbacks: ['gemini-cli-oauth', 'groq'],
  }));
}

main().catch((error) => {
  console.error('[gemini-route-assignment-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
