'use strict';

// Hub LLM Load Tests — Jest 기반 부하 시뮬레이션

jest.mock('../../lib/llm/claude-code-oauth', () => ({ callClaudeCodeOAuth: jest.fn() }));
jest.mock('../../lib/llm/groq-fallback', () => ({ callGroqFallback: jest.fn() }));
jest.mock('../../lib/llm/local-ollama', () => ({ callLocalOllama: jest.fn() }));
jest.mock('../../../../packages/core/lib/pg-pool', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../../../../packages/core/lib/telegram-sender', () => ({
  send: jest.fn().mockResolvedValue(true),
  sendCritical: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../../packages/core/lib/llm-models', () => ({
  getGroqFallback: jest.fn().mockReturnValue('llama-3.3-70b-versatile'),
}));

const { callWithFallback } = require('../../lib/llm/unified-caller');
const { callClaudeCodeOAuth } = require('../../lib/llm/claude-code-oauth');
const { callGroqFallback } = require('../../lib/llm/groq-fallback');
const { callLocalOllama } = require('../../lib/llm/local-ollama');

const MOCK_OK = { ok: true, provider: 'claude-code-oauth', result: 'test response', durationMs: 100 };
const MOCK_FAIL = { ok: false, provider: 'failed', error: 'mock_error', durationMs: 50 };

function makeReq(team, agent) {
  return {
    prompt: '테스트 프롬프트',
    abstractModel: 'anthropic_sonnet',
    callerTeam: team || 'blog',
    agent: agent || 'default',
  };
}

describe('Scenario 1: Baseline — 순차 호출 성공률', () => {
  beforeEach(() => {
    callClaudeCodeOAuth.mockResolvedValue(MOCK_OK);
  });

  it('10회 순차 호출 — 전부 성공', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => callWithFallback(makeReq()))
    );
    const ok = results.filter(r => r.ok).length;
    expect(ok).toBe(10);
  });

  it('6팀 동시 호출 — 모두 성공', async () => {
    const teams = ['luna', 'blog', 'darwin', 'sigma', 'claude', 'ska'];
    const results = await Promise.all(
      teams.map(team => callWithFallback(makeReq(team)))
    );
    expect(results.every(r => r.ok)).toBe(true);
  });
});

describe('Scenario 2: Primary 실패 → Groq Fallback', () => {
  beforeEach(() => {
    callClaudeCodeOAuth.mockResolvedValue(MOCK_FAIL);
    callGroqFallback.mockResolvedValue({ ok: true, provider: 'groq', result: 'groq response', durationMs: 200 });
  });

  it('20회 호출 — primary 실패 시 groq fallback 동작', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => callWithFallback(makeReq()))
    );
    const ok = results.filter(r => r.ok).length;
    expect(ok).toBe(20);
  });

  it('fallback 횟수가 1로 기록됨', async () => {
    const result = await callWithFallback(makeReq());
    expect(result.ok).toBe(true);
    expect(result.fallbackCount).toBe(1);
  });
});

describe('Scenario 3: Chaos — 모든 provider 실패 (Fallback Exhaustion)', () => {
  beforeEach(() => {
    callClaudeCodeOAuth.mockResolvedValue(MOCK_FAIL);
    callGroqFallback.mockResolvedValue(MOCK_FAIL);
    callLocalOllama.mockResolvedValue(MOCK_FAIL);
  });

  it('모든 provider 실패 → fallback_exhausted 에러 반환', async () => {
    const result = await callWithFallback(makeReq());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('fallback_exhausted');
  });

  it('5회 chaos 호출 — 실패율 100%', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => callWithFallback(makeReq()))
    );
    expect(results.every(r => !r.ok)).toBe(true);
  });
});

describe('Scenario 4: Runtime-Profile Chain — local/ 경로 포함', () => {
  beforeEach(() => {
    callClaudeCodeOAuth.mockResolvedValue(MOCK_FAIL);
    callGroqFallback.mockResolvedValue(MOCK_FAIL);
    callLocalOllama.mockResolvedValue({ ok: true, provider: 'failed', result: 'local response', durationMs: 80 });
  });

  it('blog/writer: primary → groq 실패 → local 성공', async () => {
    const result = await callWithFallback(makeReq('blog', 'writer'));
    expect(result.ok).toBe(true);
    expect(callLocalOllama).toHaveBeenCalled();
  });
});

describe('Scenario 5: Luna Critical Chain — local 제외', () => {
  beforeEach(() => {
    callClaudeCodeOAuth.mockResolvedValue(MOCK_OK);
    callLocalOllama.mockResolvedValue({ ok: true, provider: 'failed', result: 'local', durationMs: 50 });
  });

  it('luna/exit_decision — local 경로 미사용', async () => {
    await callWithFallback(makeReq('luna', 'exit_decision'));
    expect(callLocalOllama).not.toHaveBeenCalled();
  });

  it('luna/portfolio_decision — local 경로 미사용', async () => {
    await callWithFallback(makeReq('luna', 'portfolio_decision'));
    expect(callLocalOllama).not.toHaveBeenCalled();
  });
});

describe('Scenario 6: 병렬 부하 — 50회 동시', () => {
  beforeEach(() => {
    callClaudeCodeOAuth.mockImplementation(() =>
      new Promise(resolve => setTimeout(() => resolve(MOCK_OK), 5 + Math.random() * 20))
    );
  });

  it('50회 병렬 호출 완료 < 2s, 실패율 < 5%', async () => {
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => callWithFallback(makeReq(i % 2 === 0 ? 'blog' : 'luna')))
    );
    const elapsed = Date.now() - start;
    const failRate = results.filter(r => !r.ok).length / results.length;
    expect(elapsed).toBeLessThan(2000);
    expect(failRate).toBeLessThan(0.05);
  }, 5000);
});
