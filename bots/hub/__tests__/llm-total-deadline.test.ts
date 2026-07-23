'use strict';

const { _testOnly } = require('../lib/llm/unified-caller.ts');

describe('Hub LLM total deadline', () => {
  test('caps each attempt by the remaining request deadline', () => {
    const req = {};
    _testOnly._initializeTotalDeadline(req, { timeoutMs: 120_000 }, 1_000);
    expect(req._deadlineAt).toBe(121_000);
    expect(_testOnly._effectiveAttemptTimeoutMs(req, 90_000, 31_000)).toBe(90_000);
    expect(_testOnly._effectiveAttemptTimeoutMs(req, 90_000, 101_000)).toBe(20_000);
    expect(_testOnly._effectiveAttemptTimeoutMs(req, 90_000, 121_000)).toBe(0);
  });

  test('never extends a caller-provided earlier deadline', () => {
    const req = { _deadlineAt: 50_000 };
    _testOnly._initializeTotalDeadline(req, { timeoutMs: 120_000 }, 1_000);
    expect(req._deadlineAt).toBe(50_000);
  });

  test('does not raise fallback exhaustion when the request deadline prevents fallback', () => {
    const decision = _testOnly._fallbackExhaustionAlarmDecision([{
      provider: 'openai-oauth/gpt-5.4-mini',
      error: 'llm_total_deadline_exceeded:provider_attempt',
      providerAttempted: true,
    }], 2, 1);

    expect(decision).toMatchObject({
      notify: false,
      reason: 'request_deadline_before_chain_complete',
      fallbackCount: 0,
      fallbackUsed: false,
    });
  });

  test('keeps fallback exhaustion critical after every planned route was attempted', () => {
    const decision = _testOnly._fallbackExhaustionAlarmDecision([
      {
        provider: 'openai-oauth/gpt-5.4-mini',
        error: 'openai_oauth_timeout',
        providerAttempted: true,
      },
      {
        provider: 'groq/llama-3.1-8b-instant',
        error: 'llm_total_deadline_exceeded:provider_attempt',
        providerAttempted: true,
      },
    ], 2, 2);

    expect(decision).toMatchObject({
      notify: true,
      reason: null,
      fallbackCount: 1,
      fallbackUsed: true,
    });
  });

  test('interrupts retry backoff as soon as the request deadline aborts', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const pending = _testOnly._sleep(30_000, controller.signal);

    controller.abort();
    await pending;

    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
