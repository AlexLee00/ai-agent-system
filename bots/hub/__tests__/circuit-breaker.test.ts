'use strict';

// Circuit Breaker + Provider Registry + Critical Chain Registry 단위 테스트

jest.mock('../../../packages/core/lib/pg-pool', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../../../packages/core/lib/telegram-sender', () => ({
  send: jest.fn().mockResolvedValue(true),
  sendCritical: jest.fn().mockResolvedValue(true),
}));

// mock runtime-profiles for critical-chain-registry
jest.mock('../lib/runtime-profiles', () => ({
  PROFILES: {
    luna: {
      default: { primary_routes: ['claude-code/sonnet'], fallback_routes: ['groq/qwen3'] },
      exit_decision: { primary_routes: ['claude-code/sonnet'], fallback_routes: ['groq/qwen3'], critical: true, timeout_ms: 10_000 },
      portfolio_decision: { primary_routes: ['claude-code/sonnet'], fallback_routes: ['groq/qwen3'], critical: true, timeout_ms: 10_000 },
      decision_rationale: { primary_routes: ['claude-code/sonnet'], fallback_routes: ['groq/qwen3', 'local/qwen2.5-7b'] },
    },
    blog: {
      default: { primary_routes: ['claude-code/sonnet'], fallback_routes: ['local/qwen2.5-7b'] },
      writer: { primary_routes: ['claude-code/sonnet'], fallback_routes: ['local/qwen2.5-7b'] },
    },
  },
  selectRuntimeProfile: jest.fn((team, agent) => {
    const profiles = {
      luna: {
        exit_decision: { primary_routes: ['claude-code/sonnet'], fallback_routes: ['groq/qwen3'], critical: true, timeout_ms: 10_000 },
        portfolio_decision: { primary_routes: ['claude-code/sonnet'], fallback_routes: ['groq/qwen3'], critical: true, timeout_ms: 10_000 },
        decision_rationale: { primary_routes: ['claude-code/sonnet'], fallback_routes: ['groq/qwen3', 'local/qwen2.5-7b'] },
        default: { primary_routes: ['claude-code/sonnet'], fallback_routes: ['groq/qwen3', 'local/qwen2.5-7b'] },
      },
      blog: {
        writer: { primary_routes: ['claude-code/sonnet'], fallback_routes: ['local/qwen2.5-7b'] },
        default: { primary_routes: ['claude-code/sonnet'], fallback_routes: ['local/qwen2.5-7b'] },
      },
    };
    return (profiles[team] && profiles[team][agent]) || null;
  }),
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

beforeEach(() => {
  mockCircuitState.clear();
  jest.clearAllMocks();
  // re-wire mock implementations after clearAllMocks
  const cb = require('../../../packages/core/lib/local-circuit-breaker');
  cb.isCircuitOpen.mockImplementation((key) => { const s = mockCircuitState.get(key); return s && s.state === 'OPEN'; });
  cb.recordSuccess.mockImplementation((key) => mockCircuitState.set(key, { state: 'CLOSED', failures: 0 }));
  cb.recordFailure.mockImplementation((key) => {
    const s = mockCircuitState.get(key) || { state: 'CLOSED', failures: 0 };
    s.failures = (s.failures || 0) + 1;
    if (s.failures >= 3) s.state = 'OPEN';
    mockCircuitState.set(key, s);
  });
});

describe('provider-registry', () => {
  it('canCall=true when circuit CLOSED', () => {
    const reg = require('../lib/llm/provider-registry');
    expect(reg.canCall('local/qwen2.5-7b')).toBe(true);
  });

  it('recordSuccess 후 stats 기록', () => {
    const reg = require('../lib/llm/provider-registry');
    const key = 'local/test-' + Date.now();
    reg.recordSuccess(key, 150);
    const stats = reg.getProviderStats();
    expect(stats[key]).toBeDefined();
    expect(stats[key].total_calls).toBe(1);
    expect(stats[key].avg_latency_ms).toBe(150);
  });

  it('3회 recordFailure → canCall=false', () => {
    const reg = require('../lib/llm/provider-registry');
    const key = 'local/fail-' + Date.now();
    reg.recordFailure(key, 'timeout', 5000);
    reg.recordFailure(key, 'timeout', 5000);
    reg.recordFailure(key, 'timeout', 5000);
    expect(reg.canCall(key)).toBe(false);
  });

  it('getProviderStats OPEN 상태 반영', () => {
    const reg = require('../lib/llm/provider-registry');
    const key = 'local/open-' + Date.now();
    for (let i = 0; i < 3; i++) reg.recordFailure(key, 'network', 100);
    const stats = reg.getProviderStats();
    expect(stats[key].state).toBe('OPEN');
    expect(stats[key].total_failures).toBe(3);
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

  it('luna/default — isCriticalChain=false', () => {
    const { isCriticalChain } = require('../lib/llm/critical-chain-registry');
    expect(isCriticalChain('luna', 'default')).toBe(false);
  });

  it('getTimeoutForChain — luna/exit_decision 10000ms', () => {
    const { getTimeoutForChain } = require('../lib/llm/critical-chain-registry');
    expect(getTimeoutForChain('luna', 'exit_decision')).toBe(10_000);
  });

  it('listCriticalChains — luna chains 포함', () => {
    const { listCriticalChains } = require('../lib/llm/critical-chain-registry');
    const list = listCriticalChains();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const agents = list.map(c => c.agent);
    expect(agents).toContain('exit_decision');
    expect(agents).toContain('portfolio_decision');
  });
});
