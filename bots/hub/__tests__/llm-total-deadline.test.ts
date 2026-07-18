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
