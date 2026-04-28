// @ts-nocheck
/**
 * strategy-validity-evaluator.ts
 *
 * Phase B — Strategy Validity Score
 * 포지션 보유 중 전략이 여전히 유효한지 0~1 점수로 산출.
 * Bayesian posterior 업데이트 + 7차원 평가 + 4-tier action 결정.
 *
 * Kill switch: LUNA_STRATEGY_VALIDITY_EVALUATOR_ENABLED (default: false → shadow mode)
 *
 * 입력: position, runtimeState, recentAnalyses, backtest, regime, evidence
 * 출력: StrategyValidityResult { score, driftReasons, recommendedAction, dimensions }
 */
import { resolvePositionLifecycleFlags } from './position-lifecycle-flags.ts';

// ─── 타입 ───────────────────────────────────────────────────────────────────

export type ValidityAction = 'HOLD' | 'CAUTION' | 'PIVOT' | 'EXIT';

export interface ValidityDimension {
  name: string;
  score: number;        // 0~1 (높을수록 전략 유효)
  weight: number;       // 각 차원 가중치 (합산 = 1.0)
  reason: string;
}

export interface StrategyValidityResult {
  score: number;                    // 0~1 Bayesian posterior (운영 표시용)
  actionScore: number;              // 0~1 이번 사이클 weighted score (action 기준)
  weightedScore: number;            // actionScore alias — 리포트 명확성
  baseAction: ValidityAction;        // escalation 전 action
  recommendedAction: ValidityAction;
  driftReasons: string[];
  dimensions: ValidityDimension[];
  bayesianPosterior: number;        // Bayesian 업데이트 후 전략 유효 사후확률
  priorScore: number;               // 이전 사이클 score (없으면 0.75 prior)
  evaluatorEnabled: boolean;
  shadowMode: boolean;              // kill switch 꺼진 경우 true
}

export interface ValidityEvaluatorInput {
  position: {
    symbol: string;
    exchange: string;
    trade_mode?: string;
    unrealized_pnl?: number | null;
    avg_price?: number | null;
    amount?: number | null;
    entry_time?: string | null;
  };
  strategyProfile?: {
    setup_type?: string | null;
    quality_score?: number | null;
    backtest_plan?: {
      latestBaseline?: {
        sharpeRatio?: number | null;
        totalReturn?: number | null;
        totalTrades?: number | null;
      } | null;
    } | null;
    strategy_state?: {
      positionRuntimeState?: {
        validationState?: {
          severity?: string;
          confidenceDecay?: number;
        };
        strategyValidityScore?: number | null;
      } | null;
    } | null;
  } | null;
  analysisSummary?: {
    buy?: number;
    hold?: number;
    sell?: number;
    avgConfidence?: number;
    liveIndicator?: {
      compositeSignal?: string;
    } | null;
  } | null;
  latestBacktest?: {
    sharpe_ratio?: number | null;
    total_return_pct?: number | null;
    total_trades?: number | null;
    win_rate?: number | null;
  } | null;
  regimeSnapshot?: {
    regime?: string | null;
    market?: string | null;
  } | null;
  externalEvidenceSummary?: {
    evidenceCount?: number;
    sentiment?: string | null;
    warning?: string | null;
    qualityScore?: number | null;
  } | null;
  driftContext?: {
    sharpeDrop?: number | null;
    returnDropPct?: number | null;
    totalTrades?: number | null;
    ignored?: string | null;
  } | null;
  pnlPct?: number | null;
  heldHours?: number | null;
  expectedHoldHours?: number | null;   // entry 시 예상 보유 시간
  entryVolatility?: number | null;     // entry 시 ATR 수준
  currentVolatility?: number | null;   // 현재 ATR 수준
  portfolioCorrelation?: number | null; // 다른 포지션과의 최대 상관계수
  previousScore?: number | null;       // 직전 사이클 score (Bayesian prior)
}

// ─── Kill switch & 임계값 ────────────────────────────────────────────────────

function getEvaluatorEnabled(): boolean {
  return resolvePositionLifecycleFlags().phaseB.enabled === true;
}

function getThresholds() {
  const flags = resolvePositionLifecycleFlags();
  return {
    hold: Number(flags.phaseB.holdThreshold ?? 0.7),
    caution: Number(flags.phaseB.cautionThreshold ?? 0.5),
    pivot: Number(flags.phaseB.pivotThreshold ?? 0.3),
    exit: Number(flags.phaseB.exitThreshold ?? 0.3),
  };
}

// ─── 차원별 평가 함수 ────────────────────────────────────────────────────────

function evalPnlDrift(pnlPct: number | null | undefined, setupType: string | null): ValidityDimension {
  const pnl = Number(pnlPct ?? 0);
  let score = 0.75;
  let reason = `PnL ${pnl.toFixed(2)}% — 정상 범위`;

  if (pnl >= 5) { score = 0.95; reason = `PnL ${pnl.toFixed(2)}% — 예상 수익 달성 중`; }
  else if (pnl >= 0) { score = 0.80; reason = `PnL ${pnl.toFixed(2)}% — 소폭 수익 유지`; }
  else if (pnl >= -2) { score = 0.65; reason = `PnL ${pnl.toFixed(2)}% — 소폭 손실 관찰 필요`; }
  else if (pnl >= -5) { score = 0.45; reason = `PnL ${pnl.toFixed(2)}% — 손실 확대 중, 전략 재검토`; }
  else { score = 0.15; reason = `PnL ${pnl.toFixed(2)}% — 손절 임계 근접, 전략 무효 가능성`; }

  // breakout 전략은 초기 -2% 손실 허용 (false breakout 제외)
  if (setupType === 'breakout' && pnl >= -2 && score < 0.70) {
    score = 0.70;
    reason = `${reason} (breakout 전략 초기 손실 허용)`;
  }

  return { name: 'pnl_drift', score, weight: 0.20, reason };
}

function evalTimeDrift(
  heldHours: number | null | undefined,
  expectedHoldHours: number | null | undefined,
): ValidityDimension {
  const held = Number(heldHours ?? 0);
  const expected = Number(expectedHoldHours ?? 0);
  let score = 0.75;
  let reason = `보유 ${held.toFixed(1)}h`;

  if (expected <= 0) {
    return { name: 'time_drift', score: 0.75, weight: 0.10, reason: '예상 보유 시간 미설정 — 중립' };
  }

  const ratio = held / expected;
  if (ratio <= 0.5) { score = 0.90; reason = `보유 ${held.toFixed(1)}h / 예상 ${expected.toFixed(1)}h (${(ratio*100).toFixed(0)}%) — 조기 구간`; }
  else if (ratio <= 1.0) { score = 0.80; reason = `보유 ${held.toFixed(1)}h / 예상 ${expected.toFixed(1)}h — 정상 구간`; }
  else if (ratio <= 1.5) { score = 0.55; reason = `보유 ${held.toFixed(1)}h / 예상 ${expected.toFixed(1)}h (${(ratio*100).toFixed(0)}%) — 초과 보유`; }
  else { score = 0.30; reason = `보유 ${held.toFixed(1)}h / 예상 ${expected.toFixed(1)}h (${(ratio*100).toFixed(0)}%) — 대폭 초과, 전략 재검토`; }

  return { name: 'time_drift', score, weight: 0.10, reason };
}

function evalVolatilityDrift(
  currentVol: number | null | undefined,
  entryVol: number | null | undefined,
): ValidityDimension {
  if (!currentVol || !entryVol || entryVol <= 0) {
    return { name: 'volatility_drift', score: 0.75, weight: 0.12, reason: '변동성 데이터 없음 — 중립' };
  }
  const ratio = currentVol / entryVol;
  let score = 0.75;
  let reason = `현재 변동성 / 진입 변동성 = ${ratio.toFixed(2)}x`;

  if (ratio <= 0.8) { score = 0.85; reason = `${reason} — 변동성 감소, 전략 안정`; }
  else if (ratio <= 1.3) { score = 0.78; reason = `${reason} — 변동성 정상 범위`; }
  else if (ratio <= 2.0) { score = 0.55; reason = `${reason} — 변동성 상승, 포지션 사이즈 재검토`; }
  else { score = 0.25; reason = `${reason} — 변동성 2배 초과, 전략 환경 크게 변화`; }

  return { name: 'volatility_drift', score, weight: 0.12, reason };
}

function evalCorrelationDrift(portfolioCorrelation: number | null | undefined): ValidityDimension {
  if (portfolioCorrelation == null) {
    return { name: 'correlation_drift', score: 0.80, weight: 0.08, reason: '상관관계 데이터 없음 — 중립' };
  }
  const corr = Math.abs(Number(portfolioCorrelation));
  let score = 0.80;
  let reason = `포트폴리오 최대 상관계수: ${corr.toFixed(2)}`;

  if (corr < 0.5) { score = 0.90; reason = `${reason} — 충분한 분산`; }
  else if (corr < 0.7) { score = 0.72; reason = `${reason} — 중간 상관, 관찰 필요`; }
  else if (corr < 0.85) { score = 0.50; reason = `${reason} — 높은 상관, 분산 위험`; }
  else { score = 0.25; reason = `${reason} — 매우 높은 상관, 포트폴리오 리스크 집중`; }

  return { name: 'correlation_drift', score, weight: 0.08, reason };
}

function evalRegimeAlignment(
  setupType: string | null,
  regime: string | null,
): ValidityDimension {
  const st = String(setupType || '').toLowerCase();
  const r = String(regime || '').toLowerCase();

  if (!st || !r) {
    return { name: 'regime_alignment', score: 0.70, weight: 0.15, reason: '전략/regime 정보 없음 — 중립' };
  }

  // 전략-regime 적합도 매트릭스
  const alignMatrix: Record<string, Record<string, number>> = {
    trend_following:     { trending_bull: 0.95, trending_bear: 0.30, ranging: 0.45, volatile: 0.50 },
    momentum_rotation:   { trending_bull: 0.90, trending_bear: 0.35, ranging: 0.50, volatile: 0.55 },
    breakout:            { trending_bull: 0.85, trending_bear: 0.40, ranging: 0.60, volatile: 0.65 },
    mean_reversion:      { trending_bull: 0.50, trending_bear: 0.65, ranging: 0.92, volatile: 0.55 },
    defensive_rotation:  { trending_bull: 0.45, trending_bear: 0.90, ranging: 0.70, volatile: 0.75 },
    equity_swing:        { trending_bull: 0.88, trending_bear: 0.35, ranging: 0.55, volatile: 0.50 },
  };

  const familyScores = alignMatrix[st];
  if (!familyScores) {
    return { name: 'regime_alignment', score: 0.65, weight: 0.15, reason: `알 수 없는 setupType: ${st}` };
  }

  const score = familyScores[r] ?? 0.60;
  let reason = `${st} 전략 × ${r} regime 적합도: ${score.toFixed(2)}`;
  if (score >= 0.80) reason += ' — 매우 적합';
  else if (score >= 0.65) reason += ' — 적합';
  else if (score >= 0.50) reason += ' — 보통';
  else reason += ' — 부적합, 전략 변경 검토';

  return { name: 'regime_alignment', score, weight: 0.15, reason };
}

function evalBacktestDivergence(driftContext: ValidityEvaluatorInput['driftContext']): ValidityDimension {
  if (!driftContext || driftContext.ignored) {
    return { name: 'backtest_divergence', score: 0.75, weight: 0.20, reason: '백테스트 drift 데이터 없음 — 중립' };
  }

  const sharpeDrop = Number(driftContext.sharpeDrop ?? 0);
  const returnDrop = Number(driftContext.returnDropPct ?? 0);
  let score = 0.80;
  const parts: string[] = [];

  if (sharpeDrop >= 1.5 || returnDrop >= 10) {
    score = 0.15;
    parts.push(`sharpeΔ ${sharpeDrop.toFixed(2)}, returnΔ ${returnDrop.toFixed(2)}% — 심각한 drift`);
  } else if (sharpeDrop >= 0.75 || returnDrop >= 5) {
    score = 0.40;
    parts.push(`sharpeΔ ${sharpeDrop.toFixed(2)}, returnΔ ${returnDrop.toFixed(2)}% — 중간 drift`);
  } else if (sharpeDrop >= 0.3 || returnDrop >= 2) {
    score = 0.65;
    parts.push(`sharpeΔ ${sharpeDrop.toFixed(2)}, returnΔ ${returnDrop.toFixed(2)}% — 경미한 drift`);
  } else {
    parts.push(`sharpeΔ ${sharpeDrop.toFixed(2)}, returnΔ ${returnDrop.toFixed(2)}% — 정상 범위`);
  }

  return { name: 'backtest_divergence', score, weight: 0.20, reason: parts.join('; ') };
}

function evalSourceQuality(
  evidenceSummary: ValidityEvaluatorInput['externalEvidenceSummary'],
  analysisSummary: ValidityEvaluatorInput['analysisSummary'],
): ValidityDimension {
  const evidenceQuality = Number(evidenceSummary?.qualityScore ?? 0.5);
  const evidenceCount = Number(evidenceSummary?.evidenceCount ?? 0);
  const totalAnalysis = Number((analysisSummary?.buy ?? 0)) + Number((analysisSummary?.hold ?? 0)) + Number((analysisSummary?.sell ?? 0));
  const avgConf = Number(analysisSummary?.avgConfidence ?? 0.5);

  let score = 0.70;
  const parts: string[] = [];

  // 외부 evidence 품질
  if (evidenceQuality >= 0.7 && evidenceCount >= 3) {
    score = Math.min(1.0, score + 0.15);
    parts.push(`외부 evidence 양호 (count: ${evidenceCount}, quality: ${evidenceQuality.toFixed(2)})`);
  } else if (evidenceQuality < 0.4 || evidenceCount < 1) {
    score = Math.max(0.0, score - 0.20);
    parts.push(`외부 evidence 부족 (count: ${evidenceCount}, quality: ${evidenceQuality.toFixed(2)})`);
  }

  // 분석가 신호 품질
  if (totalAnalysis >= 3 && avgConf >= 0.6) {
    score = Math.min(1.0, score + 0.10);
    parts.push(`분석가 신호 충분 (${totalAnalysis}개, 평균 확신도 ${avgConf.toFixed(2)})`);
  } else if (totalAnalysis < 2 || avgConf < 0.3) {
    score = Math.max(0.0, score - 0.15);
    parts.push(`분석가 신호 부족 (${totalAnalysis}개, 평균 확신도 ${avgConf.toFixed(2)})`);
  }

  return {
    name: 'source_quality',
    score: Math.min(1.0, Math.max(0.0, score)),
    weight: 0.15,
    reason: parts.join('; ') || '소스 품질 보통',
  };
}

// ─── Bayesian update ─────────────────────────────────────────────────────────

/**
 * 간소화된 Bayesian posterior 업데이트.
 *  posterior = (likelihood × prior) / normalizer
 *  likelihood = weighted score (현재 사이클 evidence)
 *  prior = 이전 score (없으면 0.75 기본값)
 */
function bayesianUpdate(currentScore: number, priorScore: number): number {
  const likelihood = currentScore;
  const prior = Math.min(1.0, Math.max(0.01, priorScore));
  const numerator = likelihood * prior;
  const normalizer = numerator + (1 - likelihood) * (1 - prior);
  if (normalizer <= 0) return currentScore;
  return Math.min(1.0, Math.max(0.0, numerator / normalizer));
}

// ─── 4-tier action 결정 ──────────────────────────────────────────────────────

function resolveAction(score: number, thresholds: ReturnType<typeof getThresholds>): ValidityAction {
  if (score >= thresholds.hold) return 'HOLD';
  if (score >= thresholds.caution) return 'CAUTION';
  if (score > thresholds.pivot) return 'PIVOT';
  return 'EXIT';
}

function findDimensionScore(dimensions: ValidityDimension[], name: string): number {
  const hit = dimensions.find((d) => d.name === name);
  return Number(hit?.score ?? 1);
}

function escalateAction(baseAction: ValidityAction, dimensions: ValidityDimension[]): ValidityAction {
  const sev = {
    pnl: findDimensionScore(dimensions, 'pnl_drift'),
    time: findDimensionScore(dimensions, 'time_drift'),
    volatility: findDimensionScore(dimensions, 'volatility_drift'),
    regime: findDimensionScore(dimensions, 'regime_alignment'),
    backtest: findDimensionScore(dimensions, 'backtest_divergence'),
    source: findDimensionScore(dimensions, 'source_quality'),
  };

  if (sev.pnl <= 0.2 && sev.backtest <= 0.25) return 'EXIT';

  const criticalCount = Object.values(sev).filter((v) => Number(v) <= 0.45).length;
  if (criticalCount >= 2 && (sev.time <= 0.35 || sev.backtest <= 0.45)) {
    return baseAction === 'EXIT' ? 'EXIT' : 'PIVOT';
  }

  if (sev.volatility <= 0.3 && sev.regime <= 0.55) {
    if (baseAction === 'EXIT') return 'EXIT';
    if (baseAction === 'PIVOT') return 'PIVOT';
    return 'CAUTION';
  }

  if (sev.regime <= 0.5 || sev.source <= 0.5) {
    if (baseAction === 'HOLD') return 'CAUTION';
  }

  return baseAction;
}

// ─── 핵심 공개 함수 ──────────────────────────────────────────────────────────

export function evaluateStrategyValidity(input: ValidityEvaluatorInput): StrategyValidityResult {
  const evaluatorEnabled = getEvaluatorEnabled();
  const thresholds = getThresholds();

  const setupType = String(input.strategyProfile?.setup_type || '').trim().toLowerCase() || null;
  const regime = String(input.regimeSnapshot?.regime || '').trim().toLowerCase() || null;
  const previousScore = Number(
    input.previousScore
    ?? input.strategyProfile?.strategy_state?.positionRuntimeState?.strategyValidityScore
    ?? 0.75,
  );

  // shadow mode — 항상 HOLD 반환, 점수만 산출
  const shadowMode = !evaluatorEnabled;

  const dimensions: ValidityDimension[] = [
    evalPnlDrift(input.pnlPct, setupType),
    evalTimeDrift(input.heldHours, input.expectedHoldHours),
    evalVolatilityDrift(input.currentVolatility, input.entryVolatility),
    evalCorrelationDrift(input.portfolioCorrelation),
    evalRegimeAlignment(setupType, regime),
    evalBacktestDivergence(input.driftContext),
    evalSourceQuality(input.externalEvidenceSummary, input.analysisSummary),
  ];

  // 가중 합산
  const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0);
  const weightedScore = dimensions.reduce((s, d) => s + d.score * d.weight, 0) / (totalWeight || 1);

  // Bayesian posterior
  const bayesianPosterior = bayesianUpdate(weightedScore, previousScore);

  const actionScore = Math.round(weightedScore * 1000) / 1000;
  const score = Math.round(bayesianPosterior * 1000) / 1000;

  // drift 이유 수집
  const driftReasons = dimensions
    .filter((d) => d.score < 0.55)
    .map((d) => `[${d.name}] ${d.reason}`);

  // shadow mode에서는 action을 계산하되 실행에 영향 안 줌
  const baseAction = resolveAction(actionScore, thresholds);
  const recommendedAction = shadowMode ? 'HOLD' : escalateAction(baseAction, dimensions);

  return {
    score,
    actionScore,
    weightedScore: actionScore,
    baseAction,
    recommendedAction,
    driftReasons,
    dimensions,
    bayesianPosterior,
    priorScore: previousScore,
    evaluatorEnabled,
    shadowMode,
  };
}

// ─── 시나리오 데이터 (smoke test용) ─────────────────────────────────────────

export const VALIDITY_SMOKE_SCENARIOS: Array<{
  name: string;
  input: Partial<ValidityEvaluatorInput>;
  expectedActionRange: ValidityAction[];
}> = [
  {
    name: '전략 완전 유효 — 강세장 trend_following 수익 중',
    input: {
      pnlPct: 8,
      heldHours: 12,
      expectedHoldHours: 24,
      strategyProfile: { setup_type: 'trend_following', quality_score: 0.82 },
      regimeSnapshot: { regime: 'trending_bull' },
      driftContext: { sharpeDrop: 0.1, returnDropPct: 0.5 },
      analysisSummary: { buy: 4, hold: 1, sell: 0, avgConfidence: 0.72 },
    },
    expectedActionRange: ['HOLD'],
  },
  {
    name: '주의 구간 — regime 변경으로 trend_following 적합도 하락',
    input: {
      pnlPct: 1,
      heldHours: 20,
      expectedHoldHours: 24,
      strategyProfile: { setup_type: 'trend_following', quality_score: 0.65 },
      regimeSnapshot: { regime: 'ranging' },
      driftContext: { sharpeDrop: 0.4, returnDropPct: 2 },
      analysisSummary: { buy: 2, hold: 2, sell: 1, avgConfidence: 0.55 },
    },
    expectedActionRange: ['CAUTION', 'PIVOT'],
  },
  {
    name: 'PIVOT 후보 — 백테스트 drift + 시간 초과',
    input: {
      pnlPct: -2.5,
      heldHours: 40,
      expectedHoldHours: 24,
      strategyProfile: { setup_type: 'mean_reversion', quality_score: 0.55 },
      regimeSnapshot: { regime: 'trending_bull' },
      driftContext: { sharpeDrop: 0.9, returnDropPct: 6 },
      analysisSummary: { buy: 1, hold: 3, sell: 2, avgConfidence: 0.40 },
    },
    expectedActionRange: ['PIVOT', 'EXIT'],
  },
  {
    name: 'EXIT 필요 — 심각한 손실 + 심각한 drift',
    input: {
      pnlPct: -6,
      heldHours: 48,
      expectedHoldHours: 24,
      strategyProfile: { setup_type: 'breakout', quality_score: 0.45 },
      regimeSnapshot: { regime: 'trending_bear' },
      driftContext: { sharpeDrop: 2.0, returnDropPct: 15 },
      analysisSummary: { buy: 0, hold: 1, sell: 4, avgConfidence: 0.30 },
    },
    expectedActionRange: ['EXIT'],
  },
  {
    name: 'mean_reversion — ranging regime 최적 적합',
    input: {
      pnlPct: 3,
      heldHours: 8,
      expectedHoldHours: 12,
      strategyProfile: { setup_type: 'mean_reversion', quality_score: 0.78 },
      regimeSnapshot: { regime: 'ranging' },
      driftContext: { sharpeDrop: 0.05, returnDropPct: 0.3 },
      analysisSummary: { buy: 3, hold: 2, sell: 0, avgConfidence: 0.68 },
    },
    expectedActionRange: ['HOLD'],
  },
  {
    name: '변동성 급증 — 진입 시 대비 2.5배',
    input: {
      pnlPct: 0.5,
      entryVolatility: 100,
      currentVolatility: 250,
      strategyProfile: { setup_type: 'trend_following' },
      regimeSnapshot: { regime: 'volatile' },
      driftContext: null,
    },
    expectedActionRange: ['CAUTION', 'PIVOT'],
  },
  {
    name: 'shadow mode — evaluator 비활성화 시 HOLD 반환',
    input: {
      pnlPct: -7,
      strategyProfile: { setup_type: 'trend_following' },
      regimeSnapshot: { regime: 'trending_bear' },
      driftContext: { sharpeDrop: 3.0, returnDropPct: 20 },
    },
    expectedActionRange: ['HOLD'],  // shadow mode 강제 HOLD
  },
];
