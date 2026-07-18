'use strict';

describe('unified caller provider admission wiring', () => {
  test('classifies limiter backpressure separately from provider failures', () => {
    jest.resetModules();
    const { _testOnly } = require('../lib/llm/unified-caller.ts');
    const providerScoped = {
      ok: false,
      error: 'shared_limiter_full:provider:groq',
      admissionScope: 'provider:groq',
      limiterBackpressure: true,
    };
    const teamScoped = {
      ok: false,
      error: 'shared_limiter_full:team:darwin',
      admissionScope: 'team:darwin',
      limiterBackpressure: true,
    };
    const providerBackendFailure = {
      ok: false,
      error: 'shared_limiter_file_error:provider:groq',
      admissionScope: 'provider:groq',
      limiterBackpressure: true,
    };

    expect(_testOnly._shouldRecordProviderCircuitFailure('groq', providerScoped.error)).toBe(false);
    expect(_testOnly._isProviderRateLimitError('groq', {
      error: 'upstream rejected request',
      upstreamStatus: 429,
    })).toBe(true);
    expect(_testOnly._shouldRecordProviderCircuitFailure('groq', {
      error: 'upstream rejected request',
      upstreamStatus: 429,
    })).toBe(false);
    expect(_testOnly._sharedAdmissionDisposition(providerScoped)).toBe('continue');
    expect(_testOnly._sharedAdmissionDisposition(teamScoped)).toBe('stop');
    expect(_testOnly._sharedAdmissionDisposition(providerBackendFailure)).toBe('stop');
    expect(_testOnly._sharedAdmissionDisposition({
      error: 'provider_termination_unconfirmed',
      limiterBackpressure: true,
      providerAttempted: true,
    })).toBe('stop');
    expect(_testOnly._actualProviderAttempts([
      { provider: 'openai-oauth/gpt-5.4', providerAttempted: false },
      { provider: 'groq/qwen/qwen3-32b', providerAttempted: true },
    ])).toEqual([{ provider: 'groq/qwen/qwen3-32b', providerAttempted: true }]);
    expect(_testOnly._sharedAdmissionResponse([{
      provider: 'groq/qwen/qwen3-32b',
      error: providerScoped.error,
      admissionScope: providerScoped.admissionScope,
      retryAfterMs: 250,
      sharedAdmission: true,
    }])).toMatchObject({
      error: providerScoped.error,
      retryAfterMs: 250,
      admissionScope: providerScoped.admissionScope,
      limiterBackpressure: true,
    });
    expect(_testOnly._admissionRejections([
      {
        provider: 'openai-oauth/gpt-5.4',
        error: 'shared_limiter_full:provider:openai-oauth',
        admissionScope: 'provider:openai-oauth',
        retryAfterMs: 250,
        sharedAdmission: true,
        providerAttempted: false,
      },
      { provider: 'groq/qwen/qwen3-32b', providerAttempted: true },
    ])).toEqual([{
      provider: 'openai-oauth/gpt-5.4',
      error: 'shared_limiter_full:provider:openai-oauth',
      admissionScope: 'provider:openai-oauth',
      retryAfterMs: 250,
    }]);
    expect(_testOnly._sharedAdmissionResponse([{
      provider: 'openai-oauth/gpt-5.4',
      error: 'shared_limiter_full:provider:openai-oauth',
      admissionScope: 'provider:openai-oauth',
      retryAfterMs: 250,
      sharedAdmission: true,
      providerAttempted: false,
      providerTerminationUnconfirmed: true,
      limiterLeaseQuarantined: true,
    }])).toMatchObject({
      attempted_providers: [],
      fallbackCount: 0,
      admissionFallbackCount: 1,
      admissionRejections: [{
        provider: 'openai-oauth/gpt-5.4',
        admissionScope: 'provider:openai-oauth',
      }],
      providerTerminationUnconfirmed: true,
      limiterLeaseQuarantined: true,
    });
  });

  test('fallback exhaustion message separates actual calls from admission rejections', () => {
    jest.resetModules();
    const { _testOnly } = require('../lib/llm/unified-caller.ts');
    const message = _testOnly._buildFallbackExhaustionMessage({ agent: 'writer' }, [
      {
        provider: 'openai-oauth/gpt-5.4',
        error: 'shared_limiter_full:provider:openai-oauth',
        providerAttempted: false,
        sharedAdmission: true,
        admissionScope: 'provider:openai-oauth',
      },
      {
        provider: 'groq/qwen3-32b',
        error: 'Groq 429',
        providerAttempted: true,
      },
    ], 'blog');

    expect(message).toContain('실제 시도: groq/qwen3-32b');
    expect(message).toContain('admission 거절: openai-oauth/gpt-5.4');
    expect(message).not.toContain('실제 시도: openai-oauth/gpt-5.4');
  });

  test('preserves structured backpressure from the last actual provider attempt', () => {
    jest.resetModules();
    const { _testOnly } = require('../lib/llm/unified-caller.ts');
    const metadata = _testOnly._lastActualProviderFailureMetadata([
      {
        provider: 'openai-oauth/gpt-5.4',
        error: 'upstream unavailable',
        upstreamStatus: 503,
        retryAfterMs: 4_000,
        providerAttempted: true,
      },
      {
        provider: 'groq/qwen3-32b',
        error: 'shared_limiter_full:provider:groq',
        retryAfterMs: 250,
        providerAttempted: false,
        sharedAdmission: true,
      },
    ]);

    expect(metadata).toEqual({ upstreamStatus: 503, retryAfterMs: 4_000 });
    expect(_testOnly._sharedAdmissionResponse([
      {
        provider: 'openai-oauth/gpt-5.4',
        error: 'upstream unavailable',
        upstreamStatus: 503,
        retryAfterMs: 4_000,
        providerAttempted: true,
      },
      {
        provider: 'groq/qwen3-32b',
        error: 'shared_limiter_full:provider:groq',
        admissionScope: 'provider:groq',
        retryAfterMs: 250,
        providerAttempted: false,
        sharedAdmission: true,
      },
    ])).toBeNull();
  });

  test('uses the resolved fallback provider instead of a caller hint', async () => {
    jest.resetModules();
    const identities = [];
    const groqCall = jest.fn(async () => ({ ok: true, provider: 'groq', result: 'ok', durationMs: 1 }));
    jest.doMock('../lib/llm/provider-attempt-admission.ts', () => ({
      runWithProviderAdmission: async (identity, execute) => {
        identities.push(identity);
        return execute({ signal: new AbortController().signal, scopes: [] });
      },
    }));
    jest.doMock('../lib/llm/groq-fallback.ts', () => ({
      callGroqFallback: groqCall,
    }));

    const { _testOnly } = require('../lib/llm/unified-caller.ts');
    const result = await _testOnly._callRoute('groq/qwen/qwen3-32b', {
      callerTeam: 'darwin',
      provider: 'openai-oauth',
      prompt: 'test',
      abstractModel: 'anthropic_sonnet',
      _deadlineAt: Date.now() + 5_000,
    }, 2_000, {});

    expect(result.ok).toBe(true);
    expect(identities).toEqual([{ team: 'darwin', provider: 'groq' }]);
    expect(groqCall).toHaveBeenCalledTimes(1);
  });

  test('passes the provider admission signal to local embeddings', async () => {
    jest.resetModules();
    const controller = new AbortController();
    const createEmbeddingBatch = jest.fn(async () => [[0.1, 0.2]]);
    jest.doMock('../../../packages/core/lib/rag.ts', () => ({ createEmbeddingBatch }));
    jest.doMock('../lib/llm/provider-attempt-admission.ts', () => ({
      runWithProviderAdmission: async (_identity, execute) => execute({ signal: controller.signal, scopes: [] }),
    }));

    const { _testOnly } = require('../lib/llm/unified-caller.ts');
    const result = await _testOnly._callRoute('local-embedding/qwen3-embed-0.6b', {
      callerTeam: 'hub',
      prompt: 'embedding test',
      abstractModel: 'anthropic_haiku',
      _deadlineAt: Date.now() + 5_000,
    }, 2_000, {});

    expect(result.ok).toBe(true);
    expect(createEmbeddingBatch).toHaveBeenCalledWith(['embedding test'], { signal: controller.signal });
  });

  test('does not count cooldown skips as provider attempts', async () => {
    jest.resetModules();
    const { noteRateLimitCooldown, _testOnly } = require('../lib/llm/unified-caller.ts');
    noteRateLimitCooldown('groq', 5_000);
    try {
      const result = await _testOnly._callRoute('groq/qwen/qwen3-32b', {
        callerTeam: 'darwin',
        prompt: 'test',
        abstractModel: 'anthropic_sonnet',
        _deadlineAt: Date.now() + 5_000,
      }, 2_000, {});

      expect(result).toMatchObject({
        ok: false,
        error: 'provider_rate_limit_cooling_down:groq',
        providerAttempted: false,
      });
    } finally {
      _testOnly._clearRateLimitCooldowns();
    }
  });
});
