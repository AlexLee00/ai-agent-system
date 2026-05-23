#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const unifiedCaller = require('../lib/llm/unified-caller.ts');
const safeFallback = unifiedCaller._testOnly._safeFallbackForSelectorExhaustion;
const unifiedCallerSource = fs.readFileSync(path.resolve(__dirname, '../lib/llm/unified-caller.ts'), 'utf8');

const attempts = [
  { provider: 'gemini-cli-oauth/gemini-2.5-flash', error: 'gemini_cli_empty_stdout', durationMs: 1000 },
  { provider: 'groq/llama-3.1-8b-instant', error: 'groq_522', durationMs: 500 },
  { provider: 'openai-oauth/gpt-5.4-mini', error: 'openai_codex_oauth_timeout_or_abort', durationMs: 2500 },
];

const result = safeFallback(
  { callerTeam: 'elsa', agent: 'chat', prompt: 'hello' },
  { selectorKey: 'elsa.chat.answer', providerTiers: [] },
  attempts,
  'elsa',
);

assert.equal(result.ok, true);
assert.equal(result.provider, 'safe-fallback');
assert.equal(result.selected_route, 'safe-fallback/elsa-chat-answer');
assert.equal(result.safeFallback, true);
assert.equal(result.degraded, true);
assert.equal(result.error, undefined, 'safe fallback responses must not expose error fields that downstream alarm mappers treat as failures');
assert.equal(result.degradedReason, 'selector_chain_exhausted');
assert.match(result.suppressedError, /fallback_exhausted: openai_codex_oauth_timeout_or_abort/);
assert.equal(result.fallbackExhaustionSuppressed, true);
assert.deepEqual(result.attempted_providers, attempts.map((attempt) => attempt.provider));
assert.ok(
  unifiedCallerSource.indexOf('const safeFallback = _safeFallbackForSelectorExhaustion') < unifiedCallerSource.indexOf('await _notifyFallbackExhaustion(req, attempts, team)'),
  'Elsa safe fallback must return before production fallback exhaustion critical alarm is emitted',
);
assert.equal(
  unifiedCaller._testOnly._shouldSuppressFallbackExhaustionAlarm(
    { callerTeam: 'elsa', agent: 'chat' },
    { selectorKey: 'elsa.chat.answer' },
  ),
  true,
  'Elsa chat exhaustion must not emit duplicate ops-emergency critical alarms',
);

assert.equal(
  safeFallback(
    { callerTeam: 'blog', agent: 'commenter', prompt: 'hello' },
    { selectorKey: 'blog.commenter.reply' },
    attempts,
    'blog',
  ),
  null,
  'non-Elsa selectors must continue surfacing fallback exhaustion',
);

assert.equal(
  safeFallback(
    { callerTeam: 'elsa', agent: 'chat', prompt: 'hello', jsonSchema: { type: 'object' } },
    { selectorKey: 'elsa.chat.answer' },
    attempts,
    'elsa',
  ),
  null,
  'structured Elsa requests must not receive a plain-text safe fallback',
);

process.env.HUB_ELSA_CHAT_SAFE_FALLBACK_ENABLED = 'false';
assert.equal(
  safeFallback(
    { callerTeam: 'elsa', agent: 'chat', prompt: 'hello' },
    { selectorKey: 'elsa.chat.answer' },
    attempts,
    'elsa',
  ),
  null,
  'operator flag must be able to disable Elsa safe fallback',
);

console.log(JSON.stringify({
  ok: true,
  selector: 'elsa.chat.answer',
  safe_fallback: 'safe-fallback/elsa-chat-answer',
}));
