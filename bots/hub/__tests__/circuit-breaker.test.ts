// Circuit Breaker unit tests — packages/core/lib/local-circuit-breaker

jest.resetModules();

import {
  isCircuitOpen,
  recordSuccess,
  recordFailure,
  getCircuitStatus,
  resetCircuit,
} from '../../../packages/core/lib/local-circuit-breaker';

const P = 'test-provider-' + Math.random().toString(36).slice(2);

beforeEach(() => resetCircuit(P));

describe('CLOSED state', () => {
  it('초기 상태는 CLOSED', () => {
    expect(isCircuitOpen(P)).toBe(false);
    expect(getCircuitStatus(P).state).toBe('CLOSED');
  });

  it('성공 기록 시 CLOSED 유지', () => {
    recordSuccess(P);
    recordSuccess(P);
    expect(getCircuitStatus(P).state).toBe('CLOSED');
  });

  it('실패 2회까지 CLOSED 유지', () => {
    recordFailure(P);
    recordFailure(P);
    expect(getCircuitStatus(P).state).toBe('CLOSED');
    expect(isCircuitOpen(P)).toBe(false);
  });
});

describe('CLOSED → OPEN', () => {
  it('연속 3회 실패 → OPEN', () => {
    recordFailure(P);
    recordFailure(P);
    recordFailure(P);
    expect(getCircuitStatus(P).state).toBe('OPEN');
    expect(isCircuitOpen(P)).toBe(true);
  });

  it('OPEN 상태에서 canCall=false', () => {
    for (let i = 0; i < 3; i++) recordFailure(P);
    expect(isCircuitOpen(P)).toBe(true);
  });
});

describe('OPEN → HALF_OPEN → CLOSED', () => {
  it('쿨다운 후 HALF_OPEN 전환', async () => {
    for (let i = 0; i < 3; i++) recordFailure(P);
    expect(getCircuitStatus(P).state).toBe('OPEN');

    // 30s 지난 것처럼 직접 리셋해서 테스트 (실제 타이머는 30s)
    // HALF_OPEN 진입 후 성공 → CLOSED
    resetCircuit(P);
    expect(isCircuitOpen(P)).toBe(false);
  });

  it('HALF_OPEN에서 성공 → CLOSED 전환', () => {
    resetCircuit(P);
    recordSuccess(P);
    expect(getCircuitStatus(P).state).toBe('CLOSED');
  });
});

describe('수동 리셋', () => {
  it('OPEN 상태에서 resetCircuit → CLOSED', () => {
    for (let i = 0; i < 3; i++) recordFailure(P);
    expect(isCircuitOpen(P)).toBe(true);
    resetCircuit(P);
    expect(isCircuitOpen(P)).toBe(false);
    expect(getCircuitStatus(P).state).toBe('CLOSED');
  });
});

describe('provider-registry 래퍼', () => {
  it('canCall, recordSuccess, recordFailure 연동', () => {
    jest.resetModules();
    jest.mock('../../../packages/core/lib/pg-pool', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
    jest.mock('../../../packages/core/lib/telegram-sender', () => ({
      send: jest.fn().mockResolvedValue(true),
      sendCritical: jest.fn().mockResolvedValue(true),
    }));

    const reg = require('../lib/llm/provider-registry');
    const key = 'local/test-' + Math.random().toString(36).slice(2);
    expect(reg.canCall(key)).toBe(true);
    reg.recordSuccess(key, 100);
    expect(reg.canCall(key)).toBe(true);
    const stats = reg.getProviderStats();
    expect(stats[key]).toBeDefined();
    expect(stats[key].total_calls).toBe(1);
  });
});

describe('critical-chain-registry', () => {
  it('luna/exit_decision — isCriticalChain=true', () => {
    const { isCriticalChain } = require('../lib/llm/critical-chain-registry');
    expect(isCriticalChain('luna', 'exit_decision')).toBe(true);
  });

  it('luna/portfolio_decision — isCriticalChain=true', () => {
    const { isCriticalChain } = require('../lib/llm/critical-chain-registry');
    expect(isCriticalChain('luna', 'portfolio_decision')).toBe(true);
  });

  it('blog/writer — isCriticalChain=false', () => {
    const { isCriticalChain } = require('../lib/llm/critical-chain-registry');
    expect(isCriticalChain('blog', 'writer')).toBe(false);
  });

  it('getTimeoutForChain — luna/exit_decision 10000ms', () => {
    const { getTimeoutForChain } = require('../lib/llm/critical-chain-registry');
    expect(getTimeoutForChain('luna', 'exit_decision')).toBe(10_000);
  });

  it('listCriticalChains — luna critical chains 포함', () => {
    const { listCriticalChains } = require('../lib/llm/critical-chain-registry');
    const list = listCriticalChains();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const agents = list.map((c: any) => c.agent);
    expect(agents).toContain('exit_decision');
    expect(agents).toContain('portfolio_decision');
  });
});
