#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');

const {
  resolveClaudeCodeMaxBudgetUsd,
  resolveClaudeCodeTimeoutMs,
} = require('../lib/llm/unified-caller.ts');
const {
  resolveClaudeCodeFallbackTimeoutMs,
} = require('../../../packages/core/lib/llm-fallback');

function main() {
  assert.equal(resolveClaudeCodeTimeoutMs(30_000, 'sonnet'), 90_000);
  assert.equal(resolveClaudeCodeTimeoutMs(120_000, 'sonnet'), 120_000);
  assert.equal(resolveClaudeCodeTimeoutMs(undefined, 'haiku'), 90_000);

  assert.equal(resolveClaudeCodeMaxBudgetUsd(0.01, 'haiku'), 0.05);
  assert.equal(resolveClaudeCodeMaxBudgetUsd(0.05, 'sonnet'), 0.2);
  assert.equal(resolveClaudeCodeMaxBudgetUsd(0.2, 'sonnet'), 0.2);
  assert.equal(resolveClaudeCodeMaxBudgetUsd(0.05, 'opus'), 0.5);
  assert.equal(resolveClaudeCodeMaxBudgetUsd(undefined, 'sonnet'), undefined);

  assert.equal(resolveClaudeCodeFallbackTimeoutMs(45_000), 90_000);
  assert.equal(resolveClaudeCodeFallbackTimeoutMs(120_000), 120_000);

  console.log(JSON.stringify({
    ok: true,
    claude_code_oauth_policy: true,
    unified_timeout_floor_ms: resolveClaudeCodeTimeoutMs(30_000, 'sonnet'),
    unified_sonnet_budget_floor_usd: resolveClaudeCodeMaxBudgetUsd(0.05, 'sonnet'),
    core_fallback_timeout_floor_ms: resolveClaudeCodeFallbackTimeoutMs(45_000),
  }));
}

main();
