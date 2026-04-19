'use strict';

// local-ollama.ts 단위 테스트 — Circuit Breaker 연동 + 빈응답 감지

jest.mock('../../../packages/core/lib/pg-pool', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../../../packages/core/lib/telegram-sender', () => ({
  send: jest.fn().mockResolvedValue(true),
  sendCritical: jest.fn().mockResolvedValue(true),
}));

const { resetCircuit } = require('../../../packages/core/lib/local-circuit-breaker');

describe('callLocalOllama', () => {
  const MODEL = 'qwen2.5-7b';
  const PROVIDER_KEY = `local/${MODEL}`;

  beforeEach(() => {
    resetCircuit(PROVIDER_KEY);
    global.fetch = jest.fn();
  });

  it('정상 응답 → ok:true, result 반환', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '안녕하세요 테스트 응답입니다' } }] }),
    });
    const { callLocalOllama } = require('../lib/llm/local-ollama');
    const result = await callLocalOllama({ prompt: '안녕', model: MODEL });
    expect(result.ok).toBe(true);
    expect(result.result).toBe('안녕하세요 테스트 응답입니다');
    expect(result.totalCostUsd).toBe(0);
  });

  it('빈응답 → ok:false, empty_response 에러', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    });
    const { callLocalOllama } = require('../lib/llm/local-ollama');
    const result = await callLocalOllama({ prompt: '안녕', model: MODEL });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty_response');
  });

  it('HTTP 5xx → ok:false, http_5xx 에러', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const { callLocalOllama } = require('../lib/llm/local-ollama');
    const result = await callLocalOllama({ prompt: '안녕', model: MODEL });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('http_5xx');
  });

  it('네트워크 오류 → ok:false, network 에러', async () => {
    const err = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    global.fetch.mockRejectedValueOnce(err);
    const { callLocalOllama } = require('../lib/llm/local-ollama');
    const result = await callLocalOllama({ prompt: '안녕', model: MODEL });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('network');
  });

  it('Circuit Breaker OPEN 시 즉시 circuit_open 반환 (fetch 미호출)', async () => {
    const err = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    global.fetch.mockRejectedValue(err);
    const { callLocalOllama } = require('../lib/llm/local-ollama');
    for (let i = 0; i < 3; i++) await callLocalOllama({ prompt: '안녕', model: MODEL });

    global.fetch.mockClear();
    const result = await callLocalOllama({ prompt: '안녕', model: MODEL });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('circuit_open');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
