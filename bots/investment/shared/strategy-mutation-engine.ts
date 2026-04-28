// @ts-nocheck
/**
 * strategy-mutation-engine.ts
 *
 * Phase C — Strategy Mutation Engine
 * PIVOT 신호 발생 시 현재 전략에서 더 적합한 전략으로 변환 후보를 산출.
 * predictive-validation(predictiveScore ≥ 0.55) 통과 시에만 적용.
 *
 * Kill switch: LUNA_STRATEGY_MUTATION_ENABLED (default: false → shadow mode)
 *
 * 입력: position, currentStrategyProfile, validityScore, regime
 * 출력: StrategyMutationResult { mutationApplied, candidate, reason, lifecycleEvent }
 */

import * as db from './db.ts';
import { buildPositionScopeKey } from './lifecycle-contract.ts';
import type { StrategyValidityResult } from './strategy-validity-evaluator.ts';

// ─── 타입 ───────────────────────────────────────────────────────────────────

export type SetupType =
  | 'trend_following'
  | 'momentum_rotation'
  | 'breakout'
  | 'mean_reversion'
  | 'defensive_rotation'
  | 'equity_swing';

export interface StrategyMutationCandidate {
  newSetupType: SetupType;
  newSlPct: number;
  newTpPct: number;
  newPartialExitRatios: number[];
  newReevaluationWindowMinutes: number;
  newCadenceMs: number;
  predictiveScore: number;           // 0~1 — 신규 전략 예측 품질
  confidence: number;                // 0~1 — mutation 확신도
  mutationReason: string;
}

export interface StrategyMutationLifecycleEvent {
  eventType: 'strategy_mutated' | 'strategy_mutation_rejected' | 'strategy_mutation_shadow';
  lifecyclePhase: 'phase5_monitor';
  positionScopeKey: string;
  exchange: string;
  symbol: string;
  tradeMode: string;
  oldSetupType: string | null;
  newSetupType: string | null;
  validityScore: number;
  predictiveScore: number | null;
  reason: string;
  createdAt: string;
}

export interface StrategyMutationResult {
  mutationApplied: boolean;
  shadowMode: boolean;
  mutationEnabled: boolean;
  candidate: StrategyMutationCandidate | null;
  rejectionReason: string | null;
  lifecycleEvent: StrategyMutationLifecycleEvent;
}

export interface MutationEngineInput {
  position: {
    symbol: string;
    exchange: string;
    trade_mode?: string;
    unrealized_pnl?: number | null;
    avg_price?: number | null;
    amount?: number | null;
    entry_time?: string | null;
  };
  currentStrategyProfile: {
    id?: number | null;
    setup_type?: string | null;
    quality_score?: number | null;
    backtest_plan?: Record<string, unknown> | null;
    strategy_context?: Record<string, unknown> | null;
  } | null;
  validityResult: StrategyValidityResult;
  regimeSnapshot?: {
    regime?: string | null;
    market?: string | null;
  } | null;
  latestBacktest?: {
    sharpe_ratio?: number | null;
    win_rate?: number | null;
    total_return_pct?: number | null;
    total_trades?: number | null;
  } | null;
  pnlPct?: number | null;
  heldHours?: number | null;
  dailyMutationCount?: number;   // 일일 mutation 횟수 (외부 전달)
}

// ─── Kill switch & 설정 ──────────────────────────────────────────────────────

function getMutationEnabled(): boolean {
  const v = process.env.LUNA_STRATEGY_MUTATION_ENABLED;
  if (!v) return false;
  return v === 'true' || v === '1';
}

function getMutationConfig() {
  return {
    predictiveThreshold: Number(process.env.LUNA_STRATEGY_MUTATION_PREDICTIVE_THRESHOLD ?? 0.55),
    dailyLimit: Number(process.env.LUNA_STRATEGY_MUTATION_DAILY_LIMIT ?? 5),
  };
}

// ─── 전략 전환 규칙 매트릭스 ─────────────────────────────────────────────────

/**
 * 현재 전략 × 현재 regime → 신규 전략 후보.
 * 각 후보는 { to, score } 형태이며 score가 높을수록 우선순위.
 */
type MutationRule = { to: SetupType; score: number; reason: string };

const MUTATION_RULES: Record<string, Record<string, MutationRule[]>> = {
  trend_following: {
    ranging:       [{ to: 'mean_reversion', score: 0.85, reason: 'range 형성으로 mean_reversion 적합' }],
    trending_bear: [{ to: 'defensive_rotation', score: 0.80, reason: '약세장 전환으로 defensive 적합' }, { to: 'mean_reversion', score: 0.60, reason: '추세 역전 mean_reversion 검토' }],
    volatile:      [{ to: 'breakout', score: 0.65, reason: '변동성 burst 시 breakout 검토' }, { to: 'defensive_rotation', score: 0.60, reason: '변동성 구간 defensive 검토' }],
    trending_bull: [],  // 이미 적합 — mutation 불필요
  },
  momentum_rotation: {
    ranging:       [{ to: 'mean_reversion', score: 0.80, reason: 'range 형성 — mean_reversion 전환' }],
    trending_bear: [{ to: 'defensive_rotation', score: 0.85, reason: '약세 모멘텀 역전' }],
    volatile:      [{ to: 'breakout', score: 0.70, reason: '변동성 구간 breakout 검토' }],
    trending_bull: [],
  },
  breakout: {
    ranging:       [{ to: 'mean_reversion', score: 0.75, reason: '돌파 실패 — range 복귀' }],
    trending_bull: [{ to: 'trend_following', score: 0.80, reason: '돌파 성공 후 추세 추종으로 전환' }],
    trending_bear: [{ to: 'defensive_rotation', score: 0.82, reason: '약세 돌파 — defensive 전환' }],
    volatile:      [{ to: 'defensive_rotation', score: 0.65, reason: '변동성 exhaustion 후 defensive' }],
  },
  mean_reversion: {
    trending_bull: [{ to: 'trend_following', score: 0.82, reason: 'range 돌파 — 추세 추종으로 전환' }, { to: 'equity_swing', score: 0.70, reason: '상승 breakout equity_swing 검토' }],
    trending_bear: [{ to: 'defensive_rotation', score: 0.80, reason: '약세 전환 — defensive 필요' }],
    volatile:      [{ to: 'defensive_rotation', score: 0.70, reason: '변동성 급증 — defensive 전환' }],
    ranging:       [],  // 이미 적합
  },
  defensive_rotation: {
    trending_bull: [{ to: 'trend_following', score: 0.75, reason: '강세 전환 — trend_following 검토' }, { to: 'equity_swing', score: 0.70, reason: '강세 전환 equity_swing 검토' }],
    ranging:       [{ to: 'mean_reversion', score: 0.72, reason: '안정적 range — mean_reversion 검토' }],
    trending_bear: [],
    volatile:      [],
  },
  equity_swing: {
    ranging:       [{ to: 'mean_reversion', score: 0.78, reason: 'range 형성 — mean_reversion 전환' }],
    trending_bear: [{ to: 'defensive_rotation', score: 0.82, reason: '약세 전환 — defensive 필요' }],
    volatile:      [{ to: 'defensive_rotation', score: 0.68, reason: '변동성 급증 defensive 검토' }],
    trending_bull: [],
  },
};

// ─── 신규 전략 파라미터 생성 ──────────────────────────────────────────────────

function buildNewStrategyParams(
  newSetupType: SetupType,
  exchange: string,
  regime: string | null,
): Pick<StrategyMutationCandidate, 'newSlPct' | 'newTpPct' | 'newPartialExitRatios' | 'newReevaluationWindowMinutes' | 'newCadenceMs'> {
  const isCrypto = exchange === 'binance' || exchange === 'upbit';

  const defaults: Record<SetupType, { sl: number; tp: number; partials: number[]; evalMin: number; cadenceMs: number }> = {
    trend_following:   { sl: 0.05, tp: 0.15, partials: [0.25, 0.25], evalMin: isCrypto ? 45 : 120, cadenceMs: 300_000 },
    momentum_rotation: { sl: 0.04, tp: 0.12, partials: [0.33, 0.33], evalMin: isCrypto ? 30 : 90,  cadenceMs: 300_000 },
    breakout:          { sl: 0.04, tp: 0.14, partials: [0.30],        evalMin: isCrypto ? 30 : 90,  cadenceMs: 180_000 },
    mean_reversion:    { sl: 0.03, tp: 0.08, partials: [0.50],        evalMin: isCrypto ? 30 : 60,  cadenceMs: 180_000 },
    defensive_rotation:{ sl: 0.03, tp: 0.06, partials: [0.50, 0.25], evalMin: isCrypto ? 60 : 120, cadenceMs: 300_000 },
    equity_swing:      { sl: 0.04, tp: 0.12, partials: [0.33],        evalMin: 120,                 cadenceMs: 300_000 },
  };

  const p = defaults[newSetupType] ?? defaults.mean_reversion;

  // volatile regime에서 SL 축소 (더 빠른 손절)
  const slMultiplier = regime === 'volatile' ? 0.75 : 1.0;
  // trending regime에서 TP 확대 (추세 추종 최대화)
  const tpMultiplier = regime === 'trending_bull' ? 1.2 : 1.0;

  return {
    newSlPct: Math.round(p.sl * slMultiplier * 1000) / 1000,
    newTpPct: Math.round(p.tp * tpMultiplier * 1000) / 1000,
    newPartialExitRatios: p.partials,
    newReevaluationWindowMinutes: p.evalMin,
    newCadenceMs: p.cadenceMs,
  };
}

// ─── predictive score 추정 ───────────────────────────────────────────────────

/**
 * 신규 전략의 예측 품질 추정.
 * 실제 vectorbt backtest가 없으므로 regime alignment + 신호 품질로 추정.
 */
function estimatePredictiveScore(
  newSetupType: SetupType,
  regime: string | null,
  ruleScore: number,
  analysisBuyVotes: number,
  analysisSellVotes: number,
  qualityScore: number | null,
): number {
  // 규칙 기반 점수 (mutation rule score)
  let base = ruleScore * 0.6;

  // 분석가 신호 방향이 새 전략과 일치하는지
  if (newSetupType === 'defensive_rotation' || newSetupType === 'mean_reversion') {
    // sell > buy → 방어 전략 지지
    if (analysisSellVotes > analysisBuyVotes) base += 0.15;
  } else if (newSetupType === 'trend_following' || newSetupType === 'momentum_rotation') {
    // buy > sell → 추세 전략 지지
    if (analysisBuyVotes > analysisSellVotes) base += 0.15;
  }

  // 이전 전략 quality_score 연속성
  if (qualityScore != null && qualityScore >= 0.7) base += 0.10;

  return Math.min(1.0, Math.max(0.0, Math.round(base * 100) / 100));
}

// ─── 라이프사이클 이벤트 기록 ────────────────────────────────────────────────

async function recordMutationLifecycleEvent(event: StrategyMutationLifecycleEvent): Promise<void> {
  try {
    await db.run(`
      INSERT INTO investment.strategy_mutation_events (
        event_type, lifecycle_phase, position_scope_key,
        exchange, symbol, trade_mode,
        old_setup_type, new_setup_type,
        validity_score, predictive_score,
        reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      event.eventType,
      event.lifecyclePhase,
      event.positionScopeKey,
      event.exchange,
      event.symbol,
      event.tradeMode,
      event.oldSetupType,
      event.newSetupType,
      event.validityScore,
      event.predictiveScore,
      event.reason,
      event.createdAt,
    ]);
  } catch {
    // 테이블이 없으면 생성 후 재시도
    try {
      await db.run(`
        CREATE TABLE IF NOT EXISTS investment.strategy_mutation_events (
          id SERIAL PRIMARY KEY,
          event_type TEXT NOT NULL,
          lifecycle_phase TEXT NOT NULL DEFAULT 'phase5_monitor',
          position_scope_key TEXT NOT NULL,
          exchange TEXT NOT NULL,
          symbol TEXT NOT NULL,
          trade_mode TEXT NOT NULL DEFAULT 'normal',
          old_setup_type TEXT,
          new_setup_type TEXT,
          validity_score DOUBLE PRECISION,
          predictive_score DOUBLE PRECISION,
          reason TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await db.run(`
        INSERT INTO investment.strategy_mutation_events (
          event_type, lifecycle_phase, position_scope_key,
          exchange, symbol, trade_mode,
          old_setup_type, new_setup_type,
          validity_score, predictive_score,
          reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        event.eventType,
        event.lifecyclePhase,
        event.positionScopeKey,
        event.exchange,
        event.symbol,
        event.tradeMode,
        event.oldSetupType,
        event.newSetupType,
        event.validityScore,
        event.predictiveScore,
        event.reason,
        event.createdAt,
      ]);
    } catch {
      // DB 오류는 조용히 무시 (mutation 자체가 실패하지 않도록)
    }
  }
}

// ─── 핵심 공개 함수 ──────────────────────────────────────────────────────────

export async function evaluateStrategyMutation(input: MutationEngineInput): Promise<StrategyMutationResult> {
  const mutationEnabled = getMutationEnabled();
  const config = getMutationConfig();
  const shadowMode = !mutationEnabled;

  const exchange = String(input.position.exchange || 'binance');
  const symbol = String(input.position.symbol || '');
  const tradeMode = String(input.position.trade_mode || 'normal');
  const positionScopeKey = buildPositionScopeKey(symbol, exchange, tradeMode);
  const createdAt = new Date().toISOString();

  const oldSetupType = String(input.currentStrategyProfile?.setup_type || '').trim().toLowerCase() || null;
  const regime = String(input.regimeSnapshot?.regime || '').trim().toLowerCase() || null;
  const validityScore = Number(input.validityResult?.score ?? 0);

  // PIVOT/EXIT 이외의 경우 mutation 불필요
  const action = input.validityResult?.recommendedAction;
  if (!shadowMode && action !== 'PIVOT' && action !== 'EXIT') {
    const event: StrategyMutationLifecycleEvent = {
      eventType: 'strategy_mutation_rejected',
      lifecyclePhase: 'phase5_monitor',
      positionScopeKey,
      exchange, symbol, tradeMode,
      oldSetupType,
      newSetupType: null,
      validityScore,
      predictiveScore: null,
      reason: `action ${action} — mutation 불필요`,
      createdAt,
    };
    return { mutationApplied: false, shadowMode, mutationEnabled, candidate: null, rejectionReason: `action ${action} — mutation 불필요`, lifecycleEvent: event };
  }

  // 일일 mutation 제한 확인
  if (!shadowMode && (input.dailyMutationCount ?? 0) >= config.dailyLimit) {
    const event: StrategyMutationLifecycleEvent = {
      eventType: 'strategy_mutation_rejected',
      lifecyclePhase: 'phase5_monitor',
      positionScopeKey,
      exchange, symbol, tradeMode,
      oldSetupType,
      newSetupType: null,
      validityScore,
      predictiveScore: null,
      reason: `일일 mutation 한도 ${config.dailyLimit}회 도달`,
      createdAt,
    };
    return { mutationApplied: false, shadowMode, mutationEnabled, candidate: null, rejectionReason: '일일 mutation 한도 도달', lifecycleEvent: event };
  }

  // mutation 규칙 조회
  const rules = (MUTATION_RULES[oldSetupType ?? ''] ?? {})[regime ?? ''] ?? [];
  if (rules.length === 0) {
    const event: StrategyMutationLifecycleEvent = {
      eventType: 'strategy_mutation_rejected',
      lifecyclePhase: 'phase5_monitor',
      positionScopeKey,
      exchange, symbol, tradeMode,
      oldSetupType,
      newSetupType: null,
      validityScore,
      predictiveScore: null,
      reason: `${oldSetupType} × ${regime} — 적용 가능한 mutation 규칙 없음`,
      createdAt,
    };
    return { mutationApplied: false, shadowMode, mutationEnabled, candidate: null, rejectionReason: '적용 가능한 mutation 규칙 없음', lifecycleEvent: event };
  }

  // 최고 점수 규칙 선택
  const bestRule = [...rules].sort((a, b) => b.score - a.score)[0];
  const newSetupType = bestRule.to;

  // 분석가 신호 집계
  const buyVotes = Number(input.validityResult?.dimensions?.find((d) => d.name === 'source_quality') ? 0 : 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const analysisSummary = (input as any).analysisSummary;
  const analysisBuy = Number(analysisSummary?.buy ?? 0);
  const analysisSell = Number(analysisSummary?.sell ?? 0);

  // predictive score 추정
  const predictiveScore = estimatePredictiveScore(
    newSetupType,
    regime,
    bestRule.score,
    analysisBuy,
    analysisSell,
    Number(input.currentStrategyProfile?.quality_score ?? null),
  );

  // shadow mode: 계산만, DB 저장/실제 적용 없음
  if (shadowMode) {
    const params = buildNewStrategyParams(newSetupType, exchange, regime);
    const candidate: StrategyMutationCandidate = {
      newSetupType,
      ...params,
      predictiveScore,
      confidence: bestRule.score,
      mutationReason: `[shadow] ${bestRule.reason} (validity: ${validityScore.toFixed(3)})`,
    };
    const event: StrategyMutationLifecycleEvent = {
      eventType: 'strategy_mutation_shadow',
      lifecyclePhase: 'phase5_monitor',
      positionScopeKey,
      exchange, symbol, tradeMode,
      oldSetupType,
      newSetupType,
      validityScore,
      predictiveScore,
      reason: `shadow mode — ${bestRule.reason}`,
      createdAt,
    };
    return { mutationApplied: false, shadowMode: true, mutationEnabled: false, candidate, rejectionReason: 'shadow mode', lifecycleEvent: event };
  }

  // predictive score 임계 검증
  if (predictiveScore < config.predictiveThreshold) {
    const event: StrategyMutationLifecycleEvent = {
      eventType: 'strategy_mutation_rejected',
      lifecyclePhase: 'phase5_monitor',
      positionScopeKey,
      exchange, symbol, tradeMode,
      oldSetupType,
      newSetupType,
      validityScore,
      predictiveScore,
      reason: `predictiveScore ${predictiveScore.toFixed(3)} < threshold ${config.predictiveThreshold} — mutation 거부`,
      createdAt,
    };
    await recordMutationLifecycleEvent(event);
    return { mutationApplied: false, shadowMode, mutationEnabled, candidate: null, rejectionReason: `predictive score 불충분 (${predictiveScore.toFixed(3)})`, lifecycleEvent: event };
  }

  // mutation 승인 → 신규 전략 파라미터 구성
  const params = buildNewStrategyParams(newSetupType, exchange, regime);
  const candidate: StrategyMutationCandidate = {
    newSetupType,
    ...params,
    predictiveScore,
    confidence: bestRule.score,
    mutationReason: `${bestRule.reason} (validity: ${validityScore.toFixed(3)}, predictive: ${predictiveScore.toFixed(3)})`,
  };

  const event: StrategyMutationLifecycleEvent = {
    eventType: 'strategy_mutated',
    lifecyclePhase: 'phase5_monitor',
    positionScopeKey,
    exchange, symbol, tradeMode,
    oldSetupType,
    newSetupType,
    validityScore,
    predictiveScore,
    reason: candidate.mutationReason,
    createdAt,
  };

  await recordMutationLifecycleEvent(event);

  return { mutationApplied: true, shadowMode, mutationEnabled, candidate, rejectionReason: null, lifecycleEvent: event };
}

// ─── 시나리오 데이터 (smoke test용) ─────────────────────────────────────────

export const MUTATION_SMOKE_SCENARIOS: Array<{
  name: string;
  input: Partial<MutationEngineInput>;
  expectMutationType?: string;
  expectRejection?: boolean;
}> = [
  {
    name: 'trend_following → mean_reversion (ranging regime, PIVOT)',
    input: {
      position: { symbol: 'BTCUSDT', exchange: 'binance', trade_mode: 'normal' },
      currentStrategyProfile: { setup_type: 'trend_following', quality_score: 0.72 },
      validityResult: { score: 0.42, recommendedAction: 'PIVOT', evaluatorEnabled: true, shadowMode: false } as StrategyValidityResult,
      regimeSnapshot: { regime: 'ranging' },
    },
    expectMutationType: 'mean_reversion',
  },
  {
    name: 'mean_reversion → trend_following (trending_bull, PIVOT)',
    input: {
      position: { symbol: 'AAPL', exchange: 'kis_overseas', trade_mode: 'normal' },
      currentStrategyProfile: { setup_type: 'mean_reversion', quality_score: 0.65 },
      validityResult: { score: 0.38, recommendedAction: 'PIVOT', evaluatorEnabled: true, shadowMode: false } as StrategyValidityResult,
      regimeSnapshot: { regime: 'trending_bull' },
    },
    expectMutationType: 'trend_following',
  },
  {
    name: 'breakout → defensive_rotation (trending_bear, EXIT)',
    input: {
      position: { symbol: '005930', exchange: 'kis', trade_mode: 'normal' },
      currentStrategyProfile: { setup_type: 'breakout', quality_score: 0.55 },
      validityResult: { score: 0.22, recommendedAction: 'EXIT', evaluatorEnabled: true, shadowMode: false } as StrategyValidityResult,
      regimeSnapshot: { regime: 'trending_bear' },
    },
    expectMutationType: 'defensive_rotation',
  },
  {
    name: 'shadow mode — mutation 계산만 수행',
    input: {
      position: { symbol: 'ETHUSDT', exchange: 'binance', trade_mode: 'normal' },
      currentStrategyProfile: { setup_type: 'trend_following', quality_score: 0.70 },
      validityResult: { score: 0.35, recommendedAction: 'PIVOT', evaluatorEnabled: false, shadowMode: true } as StrategyValidityResult,
      regimeSnapshot: { regime: 'volatile' },
    },
    expectRejection: true,  // shadow mode이므로 적용 안 됨
  },
  {
    name: 'predictive score 미달 — mutation 거부',
    input: {
      position: { symbol: 'BTCUSDT', exchange: 'binance', trade_mode: 'normal' },
      currentStrategyProfile: { setup_type: 'momentum_rotation', quality_score: 0.40 },
      validityResult: { score: 0.28, recommendedAction: 'PIVOT', evaluatorEnabled: true, shadowMode: false } as StrategyValidityResult,
      regimeSnapshot: { regime: 'ranging' },
      // 분석가 신호가 약해 predictive score가 임계 미달
    },
    expectRejection: true,
  },
];
