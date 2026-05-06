#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PROFILES } = require('../../hub/lib/runtime-profiles.ts');
const { describeLLMSelector } = require('../../../packages/core/lib/llm-model-selector.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLAUDE_CONFIG_PATH = path.join(ROOT, 'bots', 'claude', 'config.json');
const CLAUDE_SELECTOR_KEYS = [
  'claude.archer.tech_analysis',
  'claude.lead.system_issue_triage',
  'claude.dexter.ai_analyst',
];

function routeProvider(route) {
  const text = String(route || '').trim();
  if (text.startsWith('claude-code/')) return 'claude-code';
  if (text.startsWith('openai-oauth/')) return 'openai-oauth';
  if (text.startsWith('groq/')) return 'groq';
  if (text.startsWith('gemini-cli-oauth/')) return 'gemini-cli-oauth';
  return '';
}

function assertNoClaudeCode(label, entries) {
  const offenders = entries
    .map((entry) => {
      if (typeof entry === 'string') return { provider: routeProvider(entry), model: entry };
      return { provider: String(entry?.provider || ''), model: String(entry?.model || '') };
    })
    .filter((entry) => entry.provider === 'claude-code' || entry.model.startsWith('claude-code/'));
  assert.deepStrictEqual(offenders, [], `${label} must not route automatic Claude-team work to Claude Code`);
}

function assertOpenAiPrimary(label, entries) {
  const first = entries[0];
  const provider = typeof first === 'string' ? routeProvider(first) : String(first?.provider || '');
  assert.strictEqual(provider, 'openai-oauth', `${label} must use OpenAI OAuth as primary`);
}

function checkRuntimeProfiles() {
  for (const [profileName, profile] of Object.entries(PROFILES.claude || {})) {
    const primary = profile?.primary_routes || [];
    const fallback = profile?.fallback_routes || [];
    assertOpenAiPrimary(`hub runtime profile claude.${profileName}`, primary);
    assertNoClaudeCode(`hub runtime profile claude.${profileName}`, [...primary, ...fallback]);
  }
}

function checkClaudeConfig() {
  const config = JSON.parse(fs.readFileSync(CLAUDE_CONFIG_PATH, 'utf8'));
  const overrides = config?.runtime_config?.llmSelectorOverrides || {};
  for (const key of CLAUDE_SELECTOR_KEYS) {
    const chain = overrides?.[key]?.chain || [];
    assert.ok(chain.length > 0, `claude config override missing chain: ${key}`);
    assertOpenAiPrimary(`claude config ${key}`, chain);
    assertNoClaudeCode(`claude config ${key}`, chain);
  }
}

function checkCoreSelector() {
  for (const selectorVersion of ['v2_legacy', 'v3_oauth_4']) {
    for (const key of CLAUDE_SELECTOR_KEYS) {
      const description = describeLLMSelector(key, { selectorVersion });
      const chain = description?.chain || [description?.primary, ...(description?.fallbacks || [])].filter(Boolean);
      assert.ok(chain.length > 0, `core selector returned empty chain: ${selectorVersion}:${key}`);
      assertOpenAiPrimary(`core selector ${selectorVersion}:${key}`, chain);
      assertNoClaudeCode(`core selector ${selectorVersion}:${key}`, chain);
    }
  }
}

checkRuntimeProfiles();
checkClaudeConfig();
checkCoreSelector();

console.log(JSON.stringify({
  ok: true,
  checked: {
    runtime_profiles: Object.keys(PROFILES.claude || {}).length,
    config_selectors: CLAUDE_SELECTOR_KEYS.length,
    core_selector_versions: 2,
  },
  policy: 'claude_team_automatic_routes_use_openai_oauth_primary_without_claude_code_fallback',
}, null, 2));
