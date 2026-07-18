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

  test('accepts long timeout for blog writer batch work', () => {
    const parsed = parseLlmCallPayload({
      prompt: 'write a long lecture draft',
      abstractModel: 'anthropic_sonnet',
      timeoutMs: 600000,
      callerTeam: 'blog',
      agent: 'pos',
      selectorKey: 'blog.pos.writer',
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.data.timeoutMs).toBe(600000);
  });

  test('uses trusted request context when validating a header-only blog writer timeout', () => {
    const parsed = parseLlmCallPayload({
      prompt: 'write a long lecture draft',
      abstractModel: 'anthropic_sonnet',
      timeoutMs: 600000,
      selectorKey: 'blog.pos.writer',
    }, {
      callerTeam: 'blog',
      agent: 'pos',
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.data.timeoutMs).toBe(600000);
  });

  test('keeps non-blog llm timeout capped at 180 seconds', () => {
    const parsed = parseLlmCallPayload({
      prompt: 'risk check',
      abstractModel: 'anthropic_sonnet',
      timeoutMs: 600000,
      callerTeam: 'luna',
      agent: 'risk',
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.error.details.fieldErrors.timeoutMs[0]).toContain('180000');
  });

  test('does not allow non-blog callers to bypass timeout cap with blog selector', () => {
    const parsed = parseLlmCallPayload({
      prompt: 'risk check',
      abstractModel: 'anthropic_sonnet',
      timeoutMs: 600000,
      callerTeam: 'luna',
      agent: 'risk',
      selectorKey: 'blog.pos.writer',
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.error.details.fieldErrors.timeoutMs[0]).toContain('180000');
  });
});
