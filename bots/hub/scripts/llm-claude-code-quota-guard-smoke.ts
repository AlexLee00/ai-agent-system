#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const selector = require('../../../packages/core/lib/llm-model-selector.ts');

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous == null) delete process.env[name];
    else process.env[name] = previous;
  }
}

function main(): void {
  const legacyKey = 'hub.alarm.interpreter.critical';
  const legacyChain = selector.selectLLMChain(legacyKey, {
    selectorVersion: 'v2_legacy',
    rolloutPercent: 100,
  });
  assert.equal(legacyChain[0]?.provider, 'claude-code', 'fixture must start with legacy claude-code primary');

  withEnv('LLM_CLAUDE_CODE_QUOTA_MODE', 'avoid', () => {
    const guarded = selector.selectLLMChain(legacyKey, {
      selectorVersion: 'v2_legacy',
      rolloutPercent: 100,
    });
    assert.equal(guarded[0]?.provider, 'openai-oauth', 'quota guard must replace claude-code primary');
    assert(!guarded.some((entry: any) => entry?.provider === 'claude-code'), 'quota guard must remove claude-code entries');
  });

  withEnv('LLM_CLAUDE_CODE_DISABLED', 'true', () => {
    const described = selector.describeLLMSelector(legacyKey, {
      selectorVersion: 'v2_legacy',
      rolloutPercent: 100,
    });
    assert.equal(described.primary?.provider, 'openai-oauth', 'selector description must reflect runtime guard');
  });

  console.log(JSON.stringify({ ok: true, checked: legacyKey }, null, 2));
}

try {
  main();
} catch (error: any) {
  console.error('[llm-claude-code-quota-guard-smoke] failed:', error?.message || error);
  process.exit(1);
}
