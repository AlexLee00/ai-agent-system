// Provider-level Circuit Breaker Registry
// Tracks health, latency, and state per LLM provider (name-based, not URL-based)
// Wraps packages/core/lib/local-circuit-breaker for state; adds Telegram + DB logging

const { isCircuitOpen, recordSuccess: cbSuccess, recordFailure: cbFailure } = require('../../../../packages/core/lib/local-circuit-breaker');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const sender = require('../../../../packages/core/lib/telegram-sender');

export type FailureReason = 'timeout' | 'empty_response' | 'network' | 'http_4xx' | 'http_5xx' | 'unknown';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface ProviderStats {
  totalCalls: number;
  totalFailures: number;
  totalLatencyMs: number;
  recentLatencies: number[];  // ring buffer (last 100)
}

const stats = new Map<string, ProviderStats>();

function _getStats(provider: string): ProviderStats {
  if (!stats.has(provider)) {
    stats.set(provider, { totalCalls: 0, totalFailures: 0, totalLatencyMs: 0, recentLatencies: [] });
  }
  return stats.get(provider)!;
}

function _p99(latencies: number[]): number {
  if (!latencies.length) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.99);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export function canCall(provider: string): boolean {
  return !isCircuitOpen(provider);
}

export function recordSuccess(provider: string, latencyMs: number): void {
  const s = _getStats(provider);
  const wasOpen = isCircuitOpen(provider);
  cbSuccess(provider);
  s.totalCalls += 1;
  s.totalLatencyMs += latencyMs;
  s.recentLatencies.push(latencyMs);
  if (s.recentLatencies.length > 100) s.recentLatencies.shift();

  if (wasOpen) {
    _logEvent(provider, 'closed', undefined, latencyMs).catch(() => {});
    sender.send('general', `[circuit] ${provider}: OPEN → CLOSED (복구 완료)`).catch(() => {});
  }
}

export function recordFailure(provider: string, reason: FailureReason, latencyMs = 0): void {
  const s = _getStats(provider);
  const wasOpen = isCircuitOpen(provider);
  cbFailure(provider);
  s.totalCalls += 1;
  s.totalFailures += 1;
  const nowOpen = isCircuitOpen(provider);

  _logEvent(provider, 'failed', reason, latencyMs).catch(() => {});

  if (!wasOpen && nowOpen) {
    _logEvent(provider, 'opened', reason, latencyMs).catch(() => {});
    sender.sendCritical('general', `🚨 [circuit] ${provider} OPEN (연속 실패: ${reason})`).catch(() => {});
  }
}

export function getProviderStats() {
  const result: Record<string, any> = {};
  for (const [provider, s] of stats) {
    const open = isCircuitOpen(provider);
    result[provider] = {
      state: open ? 'OPEN' : 'CLOSED',
      total_calls: s.totalCalls,
      total_failures: s.totalFailures,
      failure_rate: s.totalCalls > 0 ? (s.totalFailures / s.totalCalls) : 0,
      avg_latency_ms: s.totalCalls > 0 ? Math.round(s.totalLatencyMs / s.totalCalls) : 0,
      p99_latency_ms: _p99(s.recentLatencies),
    };
  }
  return result;
}

async function _logEvent(provider: string, eventType: string, reason: string | undefined, latencyMs: number): Promise<void> {
  try {
    await pgPool.query(`
      INSERT INTO hub.circuit_events (provider, event_type, reason, latency_ms)
      VALUES ($1, $2, $3, $4)
    `, [provider, eventType, reason ?? null, latencyMs]);
  } catch {
    // DB 미생성이면 무시 (마이그레이션 전)
  }
}
