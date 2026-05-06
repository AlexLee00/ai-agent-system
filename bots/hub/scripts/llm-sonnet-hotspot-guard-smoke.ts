#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert');
const { PROFILES } = require('../lib/runtime-profiles.ts');

const HOTSPOT_PROFILES = {
  claude: ['default', 'reporting', 'triage', 'lead'],
  darwin: ['default', 'research', 'synthesis', 'review'],
  luna: [
    'default',
    'analyst',
    'validator',
    'commander',
    'exit_decision',
    'portfolio_decision',
    'decision_rationale',
    'nemesis_risk',
    'sentiment_multilingual',
    'deep_reasoning',
    'debate_agent',
  ],
};

function routeProvider(route) {
  const text = String(route || '').trim();
  if (text.startsWith('claude-code/')) return 'claude-code';
  if (text.startsWith('openai-oauth/')) return 'openai-oauth';
  if (text.startsWith('gemini-cli-oauth/')) return 'gemini-cli-oauth';
  if (text.startsWith('groq/')) return 'groq';
  return '';
}

function routeList(profile) {
  return [
    ...(profile?.primary_routes || []),
    ...(profile?.fallback_routes || []),
  ];
}

const checked = [];
for (const [team, profiles] of Object.entries(HOTSPOT_PROFILES)) {
  for (const profileName of profiles) {
    const profile = PROFILES?.[team]?.[profileName];
    assert.ok(profile, `missing runtime hotspot profile: ${team}.${profileName}`);
    const routes = routeList(profile);
    assert.ok(routes.length > 0, `empty runtime hotspot profile routes: ${team}.${profileName}`);
    const offenders = routes.filter((route) => routeProvider(route) === 'claude-code');
    assert.deepStrictEqual(offenders, [], `hotspot profile must not route to Claude Code: ${team}.${profileName}`);
    checked.push(`${team}.${profileName}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  checked,
  policy: 'high_volume_llm_hotspots_do_not_use_claude_code_routes',
}, null, 2));
