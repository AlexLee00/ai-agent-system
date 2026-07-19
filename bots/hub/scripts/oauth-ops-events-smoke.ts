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
    manual_reauth_required: true,
    error: {
      kind: 'auth_required',
      status: 401,
      message: 'token_expired',
    },
    access_token: 'secret-access-token',
  },
  openai_oauth: {
    healthy: true,
    needs_refresh: true,
    expires_in_hours: 0.9,
    refresh_ok: true,
    refresh_token: 'secret-refresh-token',
  },
  gemini_cli_oauth: {
    healthy: true,
    skipped: true,
    disabled: true,
    retired: true,
    error: 'gemini_provider_disabled',
    nested: {
      authorization: 'Bearer secret',
    },
  },
  gemini_codeassist_service: {
    healthy: true,
    skipped: true,
    disabled: true,
    retired: true,
    error: 'gemini_provider_disabled',
  },
};

const events = buildProviderEvents(report);
const claudeManualReauth = events.find((event) => event.kind === 'manual_reauth_required' && event.provider === 'claude-code-oauth');
assert(claudeManualReauth, 'Claude auth failure must emit manual reauth event');
assert.match(claudeManualReauth.message, /auth_required/);
assert(events.some((event) => event.kind === 'refresh_success' && event.provider === 'openai-oauth'), 'recovered near-expiry provider should emit refresh success');
assert(!events.some((event) => event.kind === 'near_expiry' && event.provider === 'openai-oauth'), 'recovered near-expiry provider should not emit near-expiry warning');
assert(!events.some((event) => event.provider.includes('gemini')), 'retired Gemini providers must not emit OAuth ops events');

const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-ops-events-'));
process.env.AI_AGENT_WORKSPACE = tmpWorkspace;
const repeatedInfoEvent = events.find((event) => event.kind === 'refresh_success' && event.provider === 'openai-oauth');
assert.equal(shouldSuppressRepeatedOauthEvent(repeatedInfoEvent), false, 'first refresh success event should pass');
assert.equal(shouldSuppressRepeatedOauthEvent(repeatedInfoEvent), true, 'second identical refresh success event should be deduped');
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
