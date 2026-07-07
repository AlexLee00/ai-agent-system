#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const oauthDirect = require('../lib/llm/oauth-direct.ts');
const { sseGuardLogSeverity } = oauthDirect._testOnly;

assert.equal(
  sseGuardLogSeverity({
    malformed_fragments: 0,
    oversized_fragments: 0,
    untrusted_events: [],
  }),
  'none',
  'clean SSE summary must not log',
);

assert.equal(
  sseGuardLogSeverity({
    malformed_fragments: 0,
    oversized_fragments: 0,
    untrusted_events: ['response.output_text.delta'],
  }),
  'debug',
  'untrusted-only SSE guard summary must be downgraded to debug',
);

assert.equal(
  sseGuardLogSeverity({
    malformed_fragments: 1,
    oversized_fragments: 0,
    untrusted_events: [],
  }),
  'warn',
  'malformed SSE guard summary must stay warn',
);

assert.equal(
  sseGuardLogSeverity({
    malformed_fragments: 0,
    oversized_fragments: 1,
    untrusted_events: ['response.output_text.delta'],
  }),
  'warn',
  'oversized SSE guard summary must stay warn even with untrusted events',
);

console.log(JSON.stringify({
  ok: true,
  smoke: 'oauth-direct-sse-guard',
  untrustedOnly: 'debug',
  malformedOrOversized: 'warn',
}, null, 2));
