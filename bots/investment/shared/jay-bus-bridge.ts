// @ts-nocheck
/**
 * shared/jay-bus-bridge.ts
 * TS/JS → Elixir JayBus 브릿지 (Hub /hub/events/publish 경유)
 *
 * 루나팀 TS WebSocket 서비스들이 JayBus에 이벤트를 발행할 때 사용.
 * Hub가 Elixir Phoenix.PubSub / Jay.Core.JayBus에 전달.
 */

import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';

export interface JayBusEvent {
  source: string;
  topic: string;
  payload: unknown;
  timestamp?: number;
}

export async function publishToJayBus(
  topic: string,
  payload: unknown,
  source = 'luna',
): Promise<void> {
  if (!HUB_TOKEN) return;

  try {
    const res = await fetch(`${HUB_BASE}/hub/events/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HUB_TOKEN}`,
      },
      body: JSON.stringify({
        source,
        topic,
        payload,
        timestamp: Date.now(),
      } satisfies JayBusEvent),
    });

    if (!res.ok) {
      console.warn(`[JayBusBridge] Hub 발행 실패: ${res.status} topic=${topic}`);
    }
  } catch (err: unknown) {
    // Hub 실패는 무시 — 루나팀 TS 레이어는 독립 동작 유지
    console.warn(`[JayBusBridge] fetch 오류: ${(err as Error).message}`);
  }
}

// 루나팀 전용 토픽 상수 (오타 방지)
export const LunaTopic = {
  // 실시간 가격 피드
  tvBar: (symbol: string, tf: string) => `luna.tv.bar.${symbol}.${tf}`,
  binanceTrade: (symbol: string) => `luna.binance.trade.${symbol}`,
  binanceOrderbook: (symbol: string) => `luna.binance.orderbook.${symbol}`,
  binanceKline: (symbol: string, tf: string) => `luna.binance.kline.${symbol}.${tf}`,
  kisTick: (symbol: string) => `luna.kis.tick.${symbol}`,
  kisQuote: (symbol: string) => `luna.kis.quote.${symbol}`,

  // 분석/결정
  analystResult: (agent: string) => `luna.analyst.result.${agent}`,
  decisionCandidate: (symbol: string) => `luna.decision.candidate.${symbol}`,
  policyVerdict: (symbol: string) => `luna.policy.verdict.${symbol}`,

  // 실행
  executionOrder: (symbol: string) => `luna.execution.order.${symbol}`,
  executionFill: (symbol: string) => `luna.execution.fill.${symbol}`,

  // 피드백
  reviewTrade: (id: string) => `luna.review.trade.${id}`,
  circuitBreaker: (event: string) => `luna.circuit.breaker.${event}`,
  killSwitchChanged: 'luna.kill_switch.changed',
  healthStale: (source: string) => `luna.health.stale.${source}`,
} as const;
