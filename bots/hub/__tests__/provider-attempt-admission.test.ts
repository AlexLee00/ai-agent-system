'use strict';

const { runWithProviderAdmission } = require('../lib/llm/provider-attempt-admission.ts');

describe('provider attempt admission', () => {
  test('acquires the resolved provider scope and releases after execution', async () => {
    const acquired = [];
    let released = 0;
    const result = await runWithProviderAdmission({ team: 'darwin', provider: 'groq' }, async () => ({ ok: true }), {
      acquire: async (identity) => {
        acquired.push(identity);
        return {
          ok: true,
          scopes: ['global', 'team:darwin', 'provider:groq'],
          signal: new AbortController().signal,
          isValid: () => true,
          release: () => { released += 1; },
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(acquired).toEqual([{ team: 'darwin', provider: 'groq' }]);
    expect(released).toBe(1);
  });

  test('does not invoke provider when admission is rejected', async () => {
    const execute = jest.fn();
    const result = await runWithProviderAdmission({ team: 'blog', provider: 'openai-oauth' }, execute, {
      acquire: async () => ({
        ok: false,
        reason: 'shared_limiter_full',
        scope: 'provider:openai-oauth',
        retryAfterMs: 750,
      }),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: 'shared_limiter_full:provider:openai-oauth',
      retryAfterMs: 750,
      limiterBackpressure: true,
    });
  });

  test('converts an admission backend exception into retryable backpressure', async () => {
    const execute = jest.fn();
    const result = await runWithProviderAdmission({ team: 'blog', provider: 'groq' }, execute, {
      acquire: async () => { throw new Error('backend unavailable'); },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: 'shared_limiter_acquire_failed',
      limiterBackpressure: true,
      providerAttempted: false,
    });
  });

  test('does not execute after the total deadline expires during admission', async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = jest.fn();
    const release = jest.fn();
    const result = await runWithProviderAdmission({ team: 'blog', provider: 'groq' }, execute, {
      signal: controller.signal,
      acquire: async () => ({
        ok: true,
        scopes: ['global', 'team:blog', 'provider:groq'],
        signal: new AbortController().signal,
        isValid: () => true,
        release,
      }),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: 'llm_total_deadline_exceeded:admission',
      providerAttempted: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('awaits async lease release before returning', async () => {
    let released = false;
    const result = await runWithProviderAdmission({ team: 'blog', provider: 'groq' }, async () => ({ ok: true }), {
      acquire: async () => ({
        ok: true,
        scopes: ['global'],
        signal: new AbortController().signal,
        isValid: () => true,
        release: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          released = true;
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(released).toBe(true);
  });

  test('deadline wins over a provider result returned after abort', async () => {
    const controller = new AbortController();
    const result = await runWithProviderAdmission({ team: 'blog', provider: 'groq' }, async () => {
      controller.abort();
      return { ok: true, provider: 'groq' };
    }, {
      signal: controller.signal,
      acquire: async () => ({
        ok: true,
        scopes: ['global'],
        signal: new AbortController().signal,
        isValid: () => true,
        release: () => {},
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'llm_total_deadline_exceeded:provider_attempt',
      providerAttempted: true,
    });
  });

  test('deadline also wins when the aborted provider throws', async () => {
    const controller = new AbortController();
    const result = await runWithProviderAdmission({ team: 'blog', provider: 'groq' }, async () => {
      controller.abort();
      throw new Error('aborted');
    }, {
      signal: controller.signal,
      acquire: async () => ({
        ok: true,
        scopes: ['global'],
        signal: new AbortController().signal,
        isValid: () => true,
        release: () => {},
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'llm_total_deadline_exceeded:provider_attempt',
      providerAttempted: true,
    });
  });

  test('classifies a per-attempt timeout without consuming the total deadline', async () => {
    const deadlineController = new AbortController();
    const attemptController = new AbortController();
    const result = await runWithProviderAdmission({ team: 'blog', provider: 'groq' }, async () => {
      attemptController.abort();
      return { ok: true, provider: 'groq' };
    }, {
      deadlineSignal: deadlineController.signal,
      attemptSignal: attemptController.signal,
      acquire: async () => ({
        ok: true,
        scopes: ['global'],
        signal: new AbortController().signal,
        isValid: () => true,
        release: () => {},
      }),
    });

    expect(deadlineController.signal.aborted).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      error: 'llm_provider_attempt_timeout:provider_attempt',
      providerAttempted: true,
    });
  });

  test('preserves a successful provider result when lease release stalls', async () => {
    const run = runWithProviderAdmission({ team: 'blog', provider: 'groq' }, async () => ({ ok: true }), {
      releaseTimeoutMs: 5,
      acquire: async () => ({
        ok: true,
        scopes: ['global'],
        signal: new AbortController().signal,
        isValid: () => true,
        release: () => new Promise(() => {}),
      }),
    });
    const outcome = await Promise.race([
      run,
      new Promise((resolve) => setTimeout(() => resolve('test_timeout'), 50)),
    ]);

    expect(outcome).toMatchObject({
      ok: true,
      limiterReleaseWarning: true,
      limiterReleaseUncertain: true,
      releaseError: 'shared_limiter_release_timeout',
    });
  });

  test('stops fallback when release fails after an unsuccessful provider attempt', async () => {
    const result = await runWithProviderAdmission({ team: 'blog', provider: 'groq' }, async () => ({
      ok: false,
      provider: 'failed',
      error: 'provider_failed',
    }), {
      acquire: async () => ({
        ok: true,
        scopes: ['global'],
        signal: new AbortController().signal,
        isValid: () => true,
        release: async () => { throw new Error('release failed'); },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'shared_limiter_release_failed',
      limiterBackpressure: true,
      providerAttempted: true,
    });
  });

  test('preserves providerAttempted false when execution declines after admission', async () => {
    const result = await runWithProviderAdmission({ team: 'blog', provider: 'groq' }, async () => ({
      ok: false,
      provider: 'failed',
      error: 'llm_provider_attempt_timeout:admission',
      providerAttempted: false,
    }), {
      acquire: async () => ({
        ok: true,
        scopes: ['global'],
        signal: new AbortController().signal,
        isValid: () => true,
        release: async () => { throw new Error('release failed'); },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'shared_limiter_release_failed',
      providerAttempted: false,
    });
  });

  test('preserves providerAttempted false when the deadline races an execution decline', async () => {
    const controller = new AbortController();
    const result = await runWithProviderAdmission({ team: 'blog', provider: 'groq' }, async () => {
      controller.abort();
      return {
        ok: false,
        provider: 'failed',
        error: 'llm_total_deadline_exceeded:admission',
        providerAttempted: false,
      };
    }, {
      signal: controller.signal,
      acquire: async () => ({
        ok: true,
        scopes: ['global'],
        signal: new AbortController().signal,
        isValid: () => true,
        release: () => {},
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'llm_total_deadline_exceeded:provider_attempt',
      providerAttempted: false,
    });
  });

  test('returns a terminal error and quarantines the lease until a stuck provider settles', async () => {
    const controller = new AbortController();
    let settleProvider;
    let released = 0;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const run = runWithProviderAdmission({ team: 'blog', provider: 'openai-oauth' }, () => new Promise((resolve) => {
      settleProvider = resolve;
      markStarted();
    }), {
      signal: controller.signal,
      terminationGraceMs: 5,
      acquire: async () => ({
        ok: true,
        scopes: ['global', 'team:blog', 'provider:openai-oauth'],
        signal: new AbortController().signal,
        isValid: () => true,
        release: () => { released += 1; },
      }),
    });
    await started;
    controller.abort();

    const result = await Promise.race([
      run,
      new Promise((resolve) => setTimeout(() => resolve('test_timeout'), 100)),
    ]);
    expect(result).toMatchObject({
      ok: false,
      error: 'provider_termination_unconfirmed',
      limiterBackpressure: true,
      providerAttempted: true,
      limiterLeaseQuarantined: true,
    });
    expect(released).toBe(0);

    settleProvider({ ok: false, provider: 'failed', error: 'late_abort' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(released).toBe(1);
  });

  test('releases normally when an aborted provider settles within the termination grace', async () => {
    const controller = new AbortController();
    let released = 0;
    const result = await runWithProviderAdmission({ team: 'blog', provider: 'groq' }, ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ ok: false, provider: 'failed', error: 'aborted' }), { once: true });
      controller.abort();
    }), {
      signal: controller.signal,
      terminationGraceMs: 20,
      acquire: async () => ({
        ok: true,
        scopes: ['global'],
        signal: new AbortController().signal,
        isValid: () => true,
        release: () => { released += 1; },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'llm_total_deadline_exceeded:provider_attempt',
    });
    expect(released).toBe(1);
  });

  test('handles a quarantined late rejection and releases exactly once', async () => {
    const controller = new AbortController();
    let rejectProvider;
    let markStarted;
    let released = 0;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const run = runWithProviderAdmission({ team: 'blog', provider: 'openai-oauth' }, () => new Promise((_resolve, reject) => {
      rejectProvider = reject;
      markStarted();
    }), {
      signal: controller.signal,
      terminationGraceMs: 5,
      acquire: async () => ({
        ok: true,
        scopes: ['global'],
        signal: new AbortController().signal,
        isValid: () => true,
        release: () => { released += 1; },
      }),
    });
    await started;
    controller.abort();
    const result = await run;
    expect(result).toMatchObject({ error: 'provider_termination_unconfirmed', limiterLeaseQuarantined: true });
    expect(released).toBe(0);

    rejectProvider(new Error('late provider rejection'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(released).toBe(1);
  });
});
