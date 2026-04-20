'use strict';

const path = require('path');
process.env.PROJECT_ROOT = path.resolve(__dirname, '../../..');

jest.mock('../../../packages/core/lib/env', () => ({
  PROJECT_ROOT: require('path').resolve(__dirname, '../../..'),
  MODE: 'test',
}));

jest.mock('../../../packages/core/lib/llm-keys', () => ({
  initHubConfig: jest.fn().mockResolvedValue(undefined),
}));

const mockCallWithFallback = jest.fn();
jest.mock('../../../packages/core/lib/llm-fallback', () => ({
  callWithFallback: mockCallWithFallback,
}));

const { callLegal } = require('../lib/llm-helper');

describe('callLegal — 폴백 체인', () => {
  afterEach(() => jest.clearAllMocks());

  test('callWithFallback을 올바른 체인 순서로 호출한다', async () => {
    mockCallWithFallback.mockResolvedValue({ text: '테스트 응답', provider: 'claude-code' });

    await callLegal({ systemPrompt: 'sys', userPrompt: 'user', agent: 'justin', requestType: 'test' });

    expect(mockCallWithFallback).toHaveBeenCalledTimes(1);
    const chain = mockCallWithFallback.mock.calls[0][0].chain;

    expect(chain[0].provider).toBe('claude-code');
    expect(chain[1].provider).toBe('anthropic');
    expect(chain[2].provider).toBe('groq');
    expect(chain[3].provider).toBe('openai-oauth');
  });

  test('<think> 태그를 응답에서 제거한다', async () => {
    mockCallWithFallback.mockResolvedValue({
      text: '<think>내부 사고 과정</think>\n최종 응답',
      provider: 'groq',
    });

    const result = await callLegal({ systemPrompt: 'sys', userPrompt: 'user', agent: 'test', requestType: 'test' });
    expect(result.text).toBe('최종 응답');
    expect(result.text).not.toContain('<think>');
  });

  test('logMeta에 team:legal과 bot이 포함된다', async () => {
    mockCallWithFallback.mockResolvedValue({ text: '응답', provider: 'local' });

    await callLegal({ systemPrompt: 'sys', userPrompt: 'user', agent: 'balance', requestType: 'review' });

    const logMeta = mockCallWithFallback.mock.calls[0][0].logMeta;
    expect(logMeta.team).toBe('legal');
    expect(logMeta.bot).toBe('balance');
    expect(logMeta.requestType).toBe('review');
  });

  test('maxTokens를 체인 내 각 항목에 적용한다', async () => {
    mockCallWithFallback.mockResolvedValue({ text: '응답', provider: 'claude-code' });

    await callLegal({ systemPrompt: 'sys', userPrompt: 'user', agent: 'quill', requestType: 'draft', maxTokens: 2048 });

    const chain = mockCallWithFallback.mock.calls[0][0].chain;
    for (const entry of chain) {
      expect(entry.maxTokens).toBeLessThanOrEqual(2048);
    }
  });
});
