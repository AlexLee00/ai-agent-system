#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildProviderEvents,
  shouldSuppressRepeatedOauthEvent,
  scrubOAuthOpsPayload,
} = require('../lib/oauth/ops-events.ts');

const report = {
  claude_code_oauth: {
    healthy: false,
    error: 'token_expired',
    access_token: 'secret-access-token',
  },
  openai_oauth: {
    healthy: true,
    needs_refresh: true,
    expires_in_hours: 0.9,
    refresh_ok: true,
    refresh_token: 'secret-refresh-token',
  },
  gemini_oauth: {
    healthy: true,
    needs_refresh: true,
    expires_in_hours: 0.4,
    refresh_ok: false,
    reimport_ok: false,
  },
  gemini_cli_oauth: {
    healthy: true,
    local_credential_needs_refresh: true,
    live_refresh_ok: true,
    post_probe_reimport_ok: true,
    nested: {
      authorization: 'Bearer secret',
    },
  },
  gemini_codeassist_service: {
    healthy: true,
    local_credential_needs_refresh: true,
    live_refresh_ok: true,
    post_probe_reimport_ok: false,
  },
};

const events = buildProviderEvents(report);
assert(events.some((event) => event.kind === 'failure' && event.provider === 'claude-code-oauth'), 'must emit failure event');
assert(events.some((event) => event.kind === 'refresh_success' && event.provider === 'openai-oauth'), 'recovered near-expiry provider should emit refresh success');
assert(!events.some((event) => event.kind === 'near_expiry' && event.provider === 'openai-oauth'), 'recovered near-expiry provider should not emit near-expiry warning');
assert(events.some((event) => event.kind === 'near_expiry' && event.provider === 'gemini-oauth'), 'unrecovered near-expiry provider must remain visible');
assert(events.some((event) => event.kind === 'reimport_success' && event.provider === 'gemini-cli-oauth'), 'gemini local credential stale state should emit reimport success');
assert(!events.some((event) => event.kind === 'near_expiry' && event.provider === 'gemini-cli-oauth'), 'local credential stale state alone should not be treated as near-expiry');
assert(!events.some((event) => event.kind === 'live_probe_success' && event.provider === 'gemini-cli-oauth'), 'live probe success should not emit by default');
assert(events.some((event) => event.kind === 'degraded' && event.provider === 'gemini-codeassist-service'), 'live refresh success without reimport must remain visible as degraded');

const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-ops-events-'));
process.env.AI_AGENT_WORKSPACE = tmpWorkspace;
const repeatedInfoEvent = events.find((event) => event.kind === 'reimport_success' && event.provider === 'gemini-cli-oauth');
assert.equal(shouldSuppressRepeatedOauthEvent(repeatedInfoEvent), false, 'first reimport success event should pass');
assert.equal(shouldSuppressRepeatedOauthEvent(repeatedInfoEvent), true, 'second identical reimport success event should be deduped');
delete process.env.AI_AGENT_WORKSPACE;

const scrubbed = scrubOAuthOpsPayload(report);
const serialized = JSON.stringify(scrubbed);
assert(!serialized.includes('secret-access-token'), 'access token must be redacted');
assert(!serialized.includes('secret-refresh-token'), 'refresh token must be redacted');
assert(!serialized.includes('Bearer secret'), 'authorization value must be redacted');
assert(serialized.includes('[redacted]'), 'redaction marker must be present');

console.log(JSON.stringify({
  ok: true,
  event_count: events.length,
  dedupe: 'ok',
  redaction: 'ok',
}));
