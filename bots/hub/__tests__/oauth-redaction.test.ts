'use strict';

const { redactOAuthSecrets, sanitizeOAuthStatusPayload } = require('../lib/oauth/token-redaction.ts');

describe('hub oauth redaction', () => {
  test('redactOAuthSecrets redacts nested token-like keys', () => {
    const redacted = redactOAuthSecrets({
      access_token: 'tok_live_abc123',
      refreshToken: 'refresh_abc123',
      profile: {
        api_key: 'sk-live-secret',
        nested: [{ secret: 'value' }],
      },
      scopes: ['read', 'write'],
    });

    const text = JSON.stringify(redacted);
    expect(text.includes('tok_live_abc123')).toBe(false);
    expect(text.includes('refresh_abc123')).toBe(false);
    expect(text.includes('sk-live-secret')).toBe(false);
    expect(text.includes('"read"')).toBe(true);
    expect(redacted.profile.nested[0].secret).toBe('***');
  });

  test('sanitizeOAuthStatusPayload hides token values in status envelope', () => {
    const payload = sanitizeOAuthStatusPayload({
      ok: true,
      provider: 'openai-codex-oauth',
      token: {
        access_token: 'openai_access_token_value',
        refresh_token: 'openai_refresh_token_value',
        expires_at: '2026-04-30T00:00:00.000Z',
      },
      canary: { ok: false, error: 'token_expired' },
    });

    const text = JSON.stringify(payload);
    expect(text.includes('openai_access_token_value')).toBe(false);
    expect(text.includes('openai_refresh_token_value')).toBe(false);
    expect(payload.token.access_token).toMatch(/\.\.\./);
  });

  test('sanitizeOAuthStatusPayload redacts nested status.token fields', () => {
    const payload = sanitizeOAuthStatusPayload({
      ok: true,
      provider: 'openai-api-key',
      status: {
        provider: 'openai-api-key',
        token: {
          api_key: 'fixture-api-key',
        },
        canary: {
          ok: true,
        },
      },
      token_store: {
        metadata: {
          owner: 'ops',
        },
      },
    });

    const text = JSON.stringify(payload);
    expect(text.includes('sk-live-very-sensitive')).toBe(false);
    expect(payload.status.provider).toBe('openai-api-key');
    expect(payload.status.token.api_key).toMatch(/\.\.\./);
    expect(payload.token_store.metadata.owner).toBe('ops');
  });
});
