'use strict';

const path = require('path');
process.env.PROJECT_ROOT = path.resolve(__dirname, '../../..');

jest.mock('../../../packages/core/lib/env', () => ({
  PROJECT_ROOT: require('path').resolve(__dirname, '../../..'),
  MODE: 'test',
}));

const mockCallHubLlm = jest.fn();
jest.mock('../../../packages/core/lib/hub-client', () => ({
  callHubLlm: mockCallHubLlm,
}));

const { callLegal, selectJustinProfile } = require('../lib/llm-helper');

describe('callLegal — Hub LLM routing', () => {
  afterEach(() => jest.clearAllMocks());

  test('Justin Hub runtime profile로 호출한다', async () => {
    mockCallHubLlm.mockResolvedValue({ text: '테스트 응답', provider: 'claude-code-oauth' });

    await callLegal({ systemPrompt: 'sys', userPrompt: 'user', agent: 'justin', requestType: 'test' });

    expect(mockCallHubLlm).toHaveBeenCalledTimes(1);
    expect(mockCallHubLlm.mock.calls[0][0]).toMatchObject({
      callerTeam: 'justin',
      agent: 'default',
      taskType: 'test',
      abstractModel: 'anthropic_sonnet',
      systemPrompt: 'sys',
      prompt: 'user',
    });
  });

  test('<think> 태그를 응답에서 제거한다', async () => {
    mockCallHubLlm.mockResolvedValue({
      text: '<think>내부 사고 과정</think>\n최종 응답',
      provider: 'groq',
    });

    const result = await callLegal({ systemPrompt: 'sys', userPrompt: 'user', agent: 'test', requestType: 'test' });
    expect(result.text).toBe('최종 응답');
    expect(result.text).not.toContain('<think>');
  });

  test('requestType에 따라 Justin profile을 선택한다', async () => {
    mockCallHubLlm.mockResolvedValue({ text: '응답', provider: 'claude-code-oauth' });

    await callLegal({ systemPrompt: 'sys', userPrompt: 'user', agent: 'garam', requestType: 'domestic_case_search' });
    await callLegal({ systemPrompt: 'sys', userPrompt: 'user', agent: 'balance', requestType: 'report_review' });
    await callLegal({ systemPrompt: 'sys', userPrompt: 'user', agent: 'lens', requestType: 'source_code_analysis' });

    expect(mockCallHubLlm.mock.calls[0][0].agent).toBe('citation');
    expect(mockCallHubLlm.mock.calls[1][0].agent).toBe('opinion');
    expect(mockCallHubLlm.mock.calls[2][0].agent).toBe('analysis');
  });

  test('maxTokens를 Hub 요청에 상한 적용해 전달한다', async () => {
    mockCallHubLlm.mockResolvedValue({ text: '응답', provider: 'claude-code-oauth' });

    await callLegal({ systemPrompt: 'sys', userPrompt: 'user', agent: 'quill', requestType: 'draft', maxTokens: 9000 });

    expect(mockCallHubLlm.mock.calls[0][0].maxTokens).toBe(8192);
    expect(mockCallHubLlm.mock.calls[0][0].timeoutMs).toBe(60000);
  });

  test('profile selector helper 기본 매핑', () => {
    expect(selectJustinProfile('atlas', 'foreign_case_search')).toBe('citation');
    expect(selectJustinProfile('quill', 'final_report_draft')).toBe('opinion');
    expect(selectJustinProfile('contro', 'contract_analysis')).toBe('analysis');
    expect(selectJustinProfile('justin', 'test')).toBe('default');
  });
});
