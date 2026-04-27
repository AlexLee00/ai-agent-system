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

async function main() {
  const { PROFILES } = await import('../lib/runtime-profiles.ts');
  const selector = await import('../../../packages/core/lib/llm-model-selector.ts');
  const drillSource = read('bots/hub/scripts/team-llm-route-drill.ts');

  const runtimeSummary = PROFILES?.orchestrator?.summary;
  assert(runtimeSummary, 'orchestrator.summary runtime profile is required');
  assert.equal(
    runtimeSummary.primary_routes?.[0],
    'gemini-oauth/gemini-2.5-flash',
    'orchestrator.summary runtime primary must be Gemini OAuth',
  );

  const selected = selector.describeAgentModel('orchestrator', 'summary');
  assert.equal(
    firstProviderFromSelector(selected),
    'gemini-oauth',
    'orchestrator/summary selector primary must be Gemini OAuth',
  );
  assert(
    Array.isArray(selected.chain) && selected.chain.some((entry) => entry.provider === 'openai-oauth'),
    'orchestrator/summary selector must keep OpenAI OAuth fallback',
  );
  assert(
    Array.isArray(selected.chain) && selected.chain.some((entry) => entry.provider === 'claude-code'),
    'orchestrator/summary selector must keep Claude Code fallback',
  );

  assert(
    drillSource.includes('geminiPrimary'),
    'team LLM drill must include at least one Gemini-primary profile check when present',
  );

  console.log(JSON.stringify({
    ok: true,
    runtime_profile: 'orchestrator.summary',
    primary_provider: 'gemini-oauth',
    fallbacks: ['openai-oauth', 'claude-code'],
  }));
}

main().catch((error) => {
  console.error('[gemini-route-assignment-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
