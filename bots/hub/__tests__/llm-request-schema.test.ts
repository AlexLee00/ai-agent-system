'use strict';

const { parseLlmCallPayload } = require('../lib/llm/request-schema.ts');

describe('hub llm request schema', () => {
  test('accepts valid payload', () => {
    const parsed = parseLlmCallPayload({
      prompt: 'hello',
      abstractModel: 'anthropic_sonnet',
      timeoutMs: 3000,
      callerTeam: 'luna',
      agent: 'risk',
      priority: 'high',
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.data.abstractModel).toBe('anthropic_sonnet');
  });

  test('rejects invalid abstract model', () => {
    const parsed = parseLlmCallPayload({
      prompt: 'hello',
      abstractModel: 'gpt-4o',
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('invalid_llm_call_payload');
  });

  test('rejects empty prompt', () => {
    const parsed = parseLlmCallPayload({
      prompt: '',
      abstractModel: 'anthropic_sonnet',
    });
    expect(parsed.ok).toBe(false);
  });
});
