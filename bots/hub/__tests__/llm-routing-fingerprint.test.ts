'use strict';

const { _testOnly } = require('../lib/llm/unified-caller.ts');
const { computeHash } = require('../lib/llm/cache.ts');

describe('Hub LLM routing fingerprint', () => {
  const baseRequest = {
    callerTeam: 'blog',
    agent: 'pos',
    selectorKey: 'blog.pos.writer',
    prompt: 'write the post',
    systemPrompt: 'be precise',
    abstractModel: 'anthropic_sonnet',
  };

  test('separates requests whose routing policy differs', () => {
    const first = {
      ...baseRequest,
      runtimePurpose: 'draft',
      avoidProviders: ['groq'],
      policyOverride: { chain: [{ provider: 'openai-oauth', model: 'gpt-5.4' }] },
    };
    const second = {
      ...baseRequest,
      runtimePurpose: 'final',
      avoidProviders: ['openai-oauth'],
      policyOverride: { chain: [{ provider: 'groq', model: 'qwen/qwen3-32b' }] },
    };

    expect(_testOnly._inflightDedupeKey(first)).not.toBe(_testOnly._inflightDedupeKey(second));
    expect(_testOnly._cacheKey(first)).not.toEqual(_testOnly._cacheKey(second));
    expect(computeHash(_testOnly._cacheKey(first))).not.toBe(computeHash(_testOnly._cacheKey(second)));
  });

  test('separates authenticated principals', () => {
    expect(_testOnly._routingContractFingerprint(baseRequest)).toMatch(/^v2:/);
    expect(_testOnly._inflightDedupeKey({ ...baseRequest, authPrincipalId: 'blog-worker-a' }))
      .not.toBe(_testOnly._inflightDedupeKey({ ...baseRequest, authPrincipalId: 'blog-worker-b' }));
  });

  test('canonicalizes equivalent aliases and object key order', () => {
    const first = {
      ...baseRequest,
      runtimePurpose: 'synthesis',
      avoidProviders: ['groq', 'openai-oauth'],
      policyOverride: { temperature: 0.1, maxTokens: 1200 },
    };
    const second = {
      ...baseRequest,
      runtime_purpose: 'synthesis',
      avoidProviders: ['openai-oauth', 'groq'],
      policyOverride: { maxTokens: 1200, temperature: 0.1 },
    };

    expect(_testOnly._inflightDedupeKey(first)).toBe(_testOnly._inflightDedupeKey(second));
    expect(_testOnly._cacheKey(first)).toEqual(_testOnly._cacheKey(second));
  });

  test('does not split reuse only because request trace identifiers differ', () => {
    const first = { ...baseRequest, traceId: 'trace-a', requestId: 'request-a' };
    const second = { ...baseRequest, traceId: 'trace-b', requestId: 'request-b' };

    expect(_testOnly._inflightDedupeKey(first)).toBe(_testOnly._inflightDedupeKey(second));
    expect(_testOnly._cacheKey(first)).toEqual(_testOnly._cacheKey(second));
  });

  test('isolates only the actual routing arms during a partial rollout', () => {
    const fingerprints = new Set();
    for (let index = 0; index < 200; index += 1) {
      fingerprints.add(_testOnly._routingContractFingerprint({
        callerTeam: 'hub',
        agent: 'default',
        selectorKey: 'hub._default',
        prompt: 'evaluate market',
        abstractModel: 'anthropic_sonnet',
        selectorVersion: 'v3.0_oauth_4',
        rolloutPercent: 50,
        rolloutKey: `rollout-seed-${index}`,
      }));
    }

    expect(fingerprints.size).toBe(2);
  });
});
