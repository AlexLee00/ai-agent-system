// @ts-nocheck
/**
 * adaptive-cadence-resolver.ts
 *
 * Phase A — Adaptive Cadence
 * 평소 5분 기본 cadence에서 이벤트 발생 시 30초~1분으로 동적 단축.
 * Kill switch: LUNA_POSITION_ADAPTIVE_CADENCE_ENABLED (default: false → shadow mode)
 *
 * 출력: { cadenceMs, reason, triggerType }
 */
import { resolvePositionLifecycleFlags } from './position-lifecycle-flags.ts';

export type CadenceEventType =
  | 'volatility_burst'
  | 'news_event'
  | 'volume_burst'
  | 'community_signal'
  | 'orderbook_imbalance'
  | 'default';

export interface AdaptiveCadenceInput {
  exchange?: string | null;
  symbol?: string | null;
  volatilityBurst?: boolean;       // ATR × 2 spike
  newsEvent?: boolean;             // hub event-lake 뉴스 이벤트
  volumeBurst?: boolean;           // 거래량 × 3 평균 초과
  orderbookImbalance?: boolean;    // 호가창 imbalance 변화 감지
  communitySignal?: boolean;       // 토스/네이버/X 인기 순위 급변
  attentionType?: string | null;   // 기존 position-reevaluator attentionType
  currentCadenceMs?: number | null;
}

export interface AdaptiveCadenceResult {
  cadenceMs: number;
  reason: string;
  triggerType: CadenceEventType;
  adaptiveEnabled: boolean;
  overrideApplied: boolean;
}

function getAdaptiveCadenceEnabled(): boolean {
  return resolvePositionLifecycleFlags().phaseA.enabled === true;
}

function getCadenceDefaults() {
  const flags = resolvePositionLifecycleFlags();
  return {
    defaultMs:  Number(flags.phaseA.defaultCadenceMs ?? 300_000), // 5분
    eventMs:    Number(flags.phaseA.eventCadenceMs ?? 60_000),  // 1분
    burstMs:    Number(flags.phaseA.burstCadenceMs ?? 30_000),  // 30초
  };
}

/**
 * 시장 타입별 기본 cadence 가중치.
 * 암호화폐는 24/7 무휴이므로 burst cadence를 더 짧게 허용한다.
 */
function getMarketCadenceFloor(exchange: string | null | undefined): number {
  const ex = String(exchange || '').toLowerCase();
  if (ex === 'binance' || ex === 'upbit') return 15_000;  // 15초
  return 30_000; // 국내/해외주식 최소 30초
}

/**
 * attentionType 문자열에서 이벤트 종류를 파악한다.
 */
function classifyAttentionType(attentionType: string | null | undefined): CadenceEventType | null {
  const t = String(attentionType || '').toLowerCase();
  if (!t) return null;
  if (t.includes('volatil') || t.includes('atr') || t.includes('spike')) return 'volatility_burst';
  if (t.includes('news') || t.includes('뉴스') || t.includes('event')) return 'news_event';
  if (t.includes('volume') || t.includes('거래량')) return 'volume_burst';
  if (t.includes('community') || t.includes('커뮤니티') || t.includes('toss') || t.includes('토스')) return 'community_signal';
  if (t.includes('orderbook') || t.includes('호가') || t.includes('imbalance')) return 'orderbook_imbalance';
  return null;
}

/**
 * 핵심 공개 함수.
 * Kill switch가 꺼져 있으면 항상 defaultMs를 반환한다 (shadow mode).
 */
export function resolveAdaptiveCadence(input: AdaptiveCadenceInput = {}): AdaptiveCadenceResult {
  const {
    exchange = null,
    volatilityBurst = false,
    newsEvent = false,
    volumeBurst = false,
    orderbookImbalance = false,
    communitySignal = false,
    attentionType = null,
    currentCadenceMs = null,
  } = input;

  const adaptiveEnabled = getAdaptiveCadenceEnabled();
  const defaults = getCadenceDefaults();
  const floor = getMarketCadenceFloor(exchange);

  if (!adaptiveEnabled) {
    return {
      cadenceMs: defaults.defaultMs,
      reason: 'adaptive cadence 비활성화 (shadow mode) — 기본 5분 cadence 유지',
      triggerType: 'default',
      adaptiveEnabled: false,
      overrideApplied: false,
    };
  }

  // 1순위: 변동성 burst — 가장 빠른 cadence
  const attnEventType = classifyAttentionType(attentionType);
  const isVolatilityBurst = volatilityBurst || attnEventType === 'volatility_burst';
  if (isVolatilityBurst) {
    const cadenceMs = Math.max(floor, defaults.burstMs);
    return {
      cadenceMs,
      reason: `변동성 burst 감지 — cadence ${cadenceMs / 1000}초로 단축`,
      triggerType: 'volatility_burst',
      adaptiveEnabled: true,
      overrideApplied: true,
    };
  }

  // 2순위: 거래량 burst
  const isVolumeBurst = volumeBurst || attnEventType === 'volume_burst';
  if (isVolumeBurst) {
    const cadenceMs = Math.max(floor, defaults.burstMs);
    return {
      cadenceMs,
      reason: `거래량 burst 감지 (3배 초과) — cadence ${cadenceMs / 1000}초로 단축`,
      triggerType: 'volume_burst',
      adaptiveEnabled: true,
      overrideApplied: true,
    };
  }

  // 3순위: 뉴스 이벤트
  const isNewsEvent = newsEvent || attnEventType === 'news_event';
  if (isNewsEvent) {
    const cadenceMs = Math.max(floor, defaults.eventMs);
    return {
      cadenceMs,
      reason: `뉴스 이벤트 감지 — cadence ${cadenceMs / 1000}초로 단축`,
      triggerType: 'news_event',
      adaptiveEnabled: true,
      overrideApplied: true,
    };
  }

  // 4순위: 호가창 imbalance
  const isOrderbookImbalance = orderbookImbalance || attnEventType === 'orderbook_imbalance';
  if (isOrderbookImbalance) {
    const cadenceMs = Math.max(floor, defaults.eventMs);
    return {
      cadenceMs,
      reason: `호가창 imbalance 감지 — cadence ${cadenceMs / 1000}초로 단축`,
      triggerType: 'orderbook_imbalance',
      adaptiveEnabled: true,
      overrideApplied: true,
    };
  }

  // 5순위: 커뮤니티 시그널
  const isCommunitySignal = communitySignal || attnEventType === 'community_signal';
  if (isCommunitySignal) {
    const cadenceMs = Math.max(floor, defaults.eventMs);
    return {
      cadenceMs,
      reason: `커뮤니티 시그널 급변 감지 — cadence ${cadenceMs / 1000}초로 단축`,
      triggerType: 'community_signal',
      adaptiveEnabled: true,
      overrideApplied: true,
    };
  }

  // 기본 cadence — 현재 cadence 유지 또는 기본값
  const cadenceMs = Number(currentCadenceMs) > 0 ? Number(currentCadenceMs) : defaults.defaultMs;
  return {
    cadenceMs,
    reason: `이벤트 없음 — 기본 cadence ${cadenceMs / 1000}초 유지`,
    triggerType: 'default',
    adaptiveEnabled: true,
    overrideApplied: false,
  };
}

/**
 * 시나리오별 smoke 검증 입력 셋.
 */
export const ADAPTIVE_CADENCE_SMOKE_SCENARIOS: Array<{
  name: string;
  input: AdaptiveCadenceInput;
  expectedTrigger: CadenceEventType;
  expectOverride: boolean;
}> = [
  {
    name: '기본 — 이벤트 없음',
    input: { exchange: 'binance' },
    expectedTrigger: 'default',
    expectOverride: false,
  },
  {
    name: '변동성 burst (binance)',
    input: { exchange: 'binance', volatilityBurst: true },
    expectedTrigger: 'volatility_burst',
    expectOverride: true,
  },
  {
    name: '뉴스 이벤트 (kis)',
    input: { exchange: 'kis', newsEvent: true },
    expectedTrigger: 'news_event',
    expectOverride: true,
  },
  {
    name: '커뮤니티 시그널 (토스 인기 급변)',
    input: { exchange: 'binance', communitySignal: true },
    expectedTrigger: 'community_signal',
    expectOverride: true,
  },
  {
    name: '거래량 burst — attentionType 경유',
    input: { exchange: 'binance', attentionType: 'volume_burst_3x' },
    expectedTrigger: 'volume_burst',
    expectOverride: true,
  },
];
