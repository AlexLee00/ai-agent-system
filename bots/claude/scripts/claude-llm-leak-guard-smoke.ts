#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PROFILES } = require('../../hub/lib/runtime-profiles.ts');
const { describeAgentModel, describeLLMSelector } = require('../../../packages/core/lib/llm-model-selector.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLAUDE_CONFIG_PATH = path.join(ROOT, 'bots', 'claude', 'config.json');
const CLAUDE_COMMANDER_PATH = path.join(ROOT, 'bots', 'claude', 'src', 'claude-commander.ts');
const CLAUDE_SELECTOR_KEYS = [
  'claude.archer.tech_analysis',
  'claude.lead.system_issue_triage',
  'claude.dexter.ai_analyst',
];
const CLAUDE_CODE_CRITICAL_SELECTOR_KEYS = [
  'claude.refactorer.code_refactor',
  'claude.auto_dev.code_fix',
  'claude.reviewer.code_review',
  'claude.doctor.recovery',
];
const CLAUDE_OPENAI_ONLY_SELECTOR_KEYS = [
  ...CLAUDE_SELECTOR_KEYS,
  'claude.guardian.safety',
];
const CLAUDE_AGENT_SELECTOR_EXPECTATIONS = {
  refactorer: 'claude.refactorer.code_refactor',
  'auto-dev': 'claude.auto_dev.code_fix',
  reviewer: 'claude.reviewer.code_review',
  doctor: 'claude.doctor.recovery',
  guardian: 'claude.guardian.safety',
};

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

function assertClaudeCodeOpusFallback(label, entries) {
  const normalized = entries.map((entry) => {
    if (typeof entry === 'string') return { provider: routeProvider(entry), model: entry };
    return { provider: String(entry?.provider || ''), model: String(entry?.model || '') };
  });
  assert.ok(
    normalized.some((entry) => entry.provider === 'claude-code' && entry.model === 'claude-code/opus'),
    `${label} must include claude-code/opus fallback`,
  );
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
  for (const key of CLAUDE_OPENAI_ONLY_SELECTOR_KEYS) {
    const chain = overrides?.[key]?.chain || [];
    assert.ok(chain.length > 0, `claude config override missing chain: ${key}`);
    assertOpenAiPrimary(`claude config ${key}`, chain);
    assertNoClaudeCode(`claude config ${key}`, chain);
  }
  for (const key of CLAUDE_CODE_CRITICAL_SELECTOR_KEYS) {
    const chain = overrides?.[key]?.chain || [];
    assert.ok(chain.length > 0, `claude config override missing chain: ${key}`);
    assertOpenAiPrimary(`claude config ${key}`, chain);
    assertClaudeCodeOpusFallback(`claude config ${key}`, chain);
  }
  assert.strictEqual(overrides['claude.refactorer.code_refactor']?.chain?.[0]?.model, 'gpt-5.5');
  assert.strictEqual(overrides['claude.auto_dev.code_fix']?.chain?.[0]?.model, 'gpt-5.5');
}

function checkCoreSelector() {
  for (const selectorVersion of ['v2_legacy', 'v3_oauth_4']) {
    for (const key of CLAUDE_OPENAI_ONLY_SELECTOR_KEYS) {
      const description = describeLLMSelector(key, { selectorVersion, claudeCodeDisabled: false, claudeCodeQuotaMode: 'allow' });
      const chain = description?.chain || [description?.primary, ...(description?.fallbacks || [])].filter(Boolean);
      assert.ok(chain.length > 0, `core selector returned empty chain: ${selectorVersion}:${key}`);
      assertOpenAiPrimary(`core selector ${selectorVersion}:${key}`, chain);
      assertNoClaudeCode(`core selector ${selectorVersion}:${key}`, chain);
    }
    for (const key of CLAUDE_CODE_CRITICAL_SELECTOR_KEYS) {
      const description = describeLLMSelector(key, { selectorVersion, claudeCodeDisabled: false, claudeCodeQuotaMode: 'allow' });
      const chain = description?.chain || [description?.primary, ...(description?.fallbacks || [])].filter(Boolean);
      assert.ok(chain.length > 0, `core selector returned empty chain: ${selectorVersion}:${key}`);
      assertOpenAiPrimary(`core selector ${selectorVersion}:${key}`, chain);
      assertClaudeCodeOpusFallback(`core selector ${selectorVersion}:${key}`, chain);
    }
  }
}

function checkAgentSelectorConnections() {
  for (const [agent, expectedSelector] of Object.entries(CLAUDE_AGENT_SELECTOR_EXPECTATIONS)) {
    const description = describeAgentModel('claude', agent, {
      [expectedSelector]: { claudeCodeDisabled: false, claudeCodeQuotaMode: 'allow' },
    });
    assert.strictEqual(description.selectorKey, expectedSelector, `claude agent ${agent} selector mismatch`);
    assert.ok(description.selected, `claude agent ${agent} selector must resolve`);
  }
}

function checkCommanderDefault() {
  const source = fs.readFileSync(CLAUDE_COMMANDER_PATH, 'utf8');
  assert.ok(
    source.includes("argOverrideRaw || envOverrideRaw || 'openai-oauth/gpt-5.4'"),
    'claude commander default must use OpenAI OAuth, not Claude Code Sonnet',
  );
  assert.ok(
    source.includes("if (input === 'gpt-5.4') return 'openai-oauth/gpt-5.4'"),
    'claude commander must accept OpenAI OAuth model aliases',
  );
  assert.ok(
    source.includes("if (input === 'gpt-5.5') return 'openai-oauth/gpt-5.5'"),
    'claude commander must accept gpt-5.5 OpenAI OAuth alias',
  );
  assert.ok(
    source.includes("'openai-oauth/gpt-5.5': { provider: 'openai-oauth', model: 'openai-oauth/gpt-5.5', selectorKey: 'claude.lead.system_issue_triage' }"),
    'claude commander gpt-5.5 override must keep commander/lead selector semantics',
  );
}

checkRuntimeProfiles();
checkClaudeConfig();
checkCoreSelector();
checkAgentSelectorConnections();
checkCommanderDefault();

console.log(JSON.stringify({
  ok: true,
  checked: {
    runtime_profiles: Object.keys(PROFILES.claude || {}).length,
    config_selectors: CLAUDE_OPENAI_ONLY_SELECTOR_KEYS.length + CLAUDE_CODE_CRITICAL_SELECTOR_KEYS.length,
    core_selector_versions: 2,
    agent_selector_connections: Object.keys(CLAUDE_AGENT_SELECTOR_EXPECTATIONS).length,
    commander_default: true,
  },
  policy: 'claude_team_routes_use_openai_oauth_primary_with_claude_code_opus_only_for_code_critical_selectors',
}, null, 2));
