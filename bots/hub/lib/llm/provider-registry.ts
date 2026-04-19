'use strict';

// Provider-level Circuit Breaker Registry
// Wraps packages/core/lib/local-circuit-breaker; adds Telegram + DB event logging

const { isCircuitOpen, recordSuccess: cbSuccess, recordFailure: cbFailure } = require('../../../../packages/core/lib/local-circuit-breaker');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const sender = require('../../../../packages/core/lib/telegram-sender');

const stats = new Map();

function _getStats(provider) {
  if (!stats.has(provider)) {
    stats.set(provider, { totalCalls: 0, totalFailures: 0, totalLatencyMs: 0, recentLatencies: [] });
  }
  return stats.get(provider);
}

function _p99(latencies) {
  if (!latencies.length) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  return sorted[Math.min(Math.floor(sorted.length * 0.99), sorted.length - 1)];
}

function canCall(provider) {
  return !isCircuitOpen(provider);
}

function recordSuccess(provider, latencyMs) {
  const s = _getStats(provider);
  const wasOpen = isCircuitOpen(provider);
  cbSuccess(provider);
  s.totalCalls += 1;
  s.totalLatencyMs += latencyMs;
  s.recentLatencies.push(latencyMs);
  if (s.recentLatencies.length > 100) s.recentLatencies.shift();

  if (wasOpen) {
    _logEvent(provider, 'closed', null, latencyMs).catch(() => {});
    sender.send('general', `[circuit] ${provider}: OPEN → CLOSED (복구 완료)`).catch(() => {});
  }
}

function recordFailure(provider, reason, latencyMs) {
  const s = _getStats(provider);
  const wasOpen = isCircuitOpen(provider);
  cbFailure(provider);
  s.totalCalls += 1;
  s.totalFailures += 1;
  const nowOpen = isCircuitOpen(provider);

  _logEvent(provider, 'failed', reason || null, latencyMs || 0).catch(() => {});

  if (!wasOpen && nowOpen) {
    _logEvent(provider, 'opened', reason || null, latencyMs || 0).catch(() => {});
    sender.sendCritical('general', `🚨 [circuit] ${provider} OPEN (연속 실패: ${reason})`).catch(() => {});
  }
}

function getProviderStats() {
  const result = {};
  for (const [provider, s] of stats) {
    result[provider] = {
      state: isCircuitOpen(provider) ? 'OPEN' : 'CLOSED',
      total_calls: s.totalCalls,
      total_failures: s.totalFailures,
      failure_rate: s.totalCalls > 0 ? (s.totalFailures / s.totalCalls) : 0,
      avg_latency_ms: s.totalCalls > 0 ? Math.round(s.totalLatencyMs / s.totalCalls) : 0,
      p99_latency_ms: _p99(s.recentLatencies),
    };
  }
  return result;
}

async function _logEvent(provider, eventType, reason, latencyMs) {
  try {
    await pgPool.query(
      'INSERT INTO hub.circuit_events (provider, event_type, reason, latency_ms) VALUES ($1, $2, $3, $4)',
      [provider, eventType, reason, latencyMs]
    );
  } catch {
    // hub.circuit_events 테이블 미생성 시 무시
  }
}

module.exports = { canCall, recordSuccess, recordFailure, getProviderStats };
