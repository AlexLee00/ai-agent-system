'use strict';

// local-ollama.ts 단위 테스트 — Circuit Breaker 연동 + 빈응답 감지

jest.mock('../../../packages/core/lib/pg-pool', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../../../packages/core/lib/telegram-sender', () => ({
  send: jest.fn().mockResolvedValue(true),
  sendCritical: jest.fn().mockResolvedValue(true),
}));

// local-circuit-breaker mock (stateful)
const mockCircuitState = new Map();
jest.mock('../../../packages/core/lib/local-circuit-breaker', () => ({
  isCircuitOpen: jest.fn((key) => { const s = mockCircuitState.get(key); return s && s.state === 'OPEN'; }),
  recordSuccess: jest.fn((key) => mockCircuitState.set(key, { state: 'CLOSED', failures: 0 })),
  recordFailure: jest.fn((key) => {
    const s = mockCircuitState.get(key) || { state: 'CLOSED', failures: 0 };
    s.failures = (s.failures || 0) + 1;
    if (s.failures >= 3) s.state = 'OPEN';
    mockCircuitState.set(key, s);
  }),
  getCircuitStatus: jest.fn((key) => mockCircuitState.get(key) || { state: 'CLOSED', failures: 0 }),
  resetCircuit: jest.fn((key) => mockCircuitState.delete(key)),
}));

const MODEL = 'qwen2.5-7b';
const PROVIDER_KEY = `local/${MODEL}`;

beforeEach(() => {
  mockCircuitState.clear();
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

it('ECONNREFUSED → ok:false, network 에러', async () => {
  const err = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
  global.fetch.mockRejectedValueOnce(err);
  const { callLocalOllama } = require('../lib/llm/local-ollama');
  const result = await callLocalOllama({ prompt: '안녕', model: MODEL });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('network');
});

it('Circuit OPEN 시 즉시 circuit_open 반환 (fetch 미호출)', async () => {
  // 3회 실패로 OPEN
  const netErr = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
  global.fetch.mockRejectedValue(netErr);
  const { callLocalOllama } = require('../lib/llm/local-ollama');
  for (let i = 0; i < 3; i++) await callLocalOllama({ prompt: '안녕', model: MODEL });

  global.fetch.mockClear();
  const result = await callLocalOllama({ prompt: '안녕', model: MODEL });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('circuit_open');
  expect(global.fetch).not.toHaveBeenCalled();
});
