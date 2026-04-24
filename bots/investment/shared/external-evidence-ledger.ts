// @ts-nocheck
/**
 * external-evidence-ledger.ts
 *
 * 커뮤니티, GitHub, 연구/발표, TradingView, backtest를 같은 evidence schema로 저장.
 * evidence는 agent 입력 feature로 쓰되 단독 실행권을 갖지 않는다.
 *
 * source_type:
 *   community    : Reddit/커뮤니티 신호
 *   github       : GitHub 인기 레포 / 전략 코드
 *   research     : 논문/발표
 *   tradingview  : TradingView indicator snapshot
 *   backtest     : vectorbt/Chronos 백테스트 결과
 *   scout        : Argos/Scout 스크리닝 결과
 *
 * source_quality scoring:
 *   community  : max 0.6 (anonymous, unverified)
 *   github     : max 0.75 (recent commit, stars, reproducible = 높음)
 *   research   : max 0.85 (peer-reviewed > preprint)
 *   tradingview: max 0.7 (official indicator > custom)
 *   backtest   : max 0.9 (in-sample은 낮추고 out-of-sample은 높임)
 *   scout      : max 0.8
 */

import * as db from './db.ts';

export interface EvidenceRecord {
  sourceType: 'community' | 'github' | 'research' | 'tradingview' | 'backtest' | 'scout' | string;
  sourceName?: string | null;
  sourceUrl?: string | null;
  symbol?: string | null;
  market?: string | null;
  strategyFamily?: string | null;
  signalDirection?: 'bullish' | 'bearish' | 'neutral' | string | null;
  score?: number;
  sourceQuality?: number;
  freshnessScore?: number;
  evidenceSummary?: string | null;
  rawRef?: Record<string, unknown>;
}

// source_type별 최대 품질 상한
const SOURCE_QUALITY_CAP: Record<string, number> = {
  community:   0.60,
  github:      0.75,
  research:    0.85,
  tradingview: 0.70,
  backtest:    0.90,
  scout:       0.80,
};

export function computeSourceQuality(
  sourceType: string,
  rawScore: number = 0.5,
): number {
  const cap = SOURCE_QUALITY_CAP[sourceType] ?? 0.65;
  return Number(Math.min(Math.max(rawScore, 0), cap).toFixed(4));
}

/**
 * freshness: 최신성 점수 (0~1).
 * ageHours=0이면 1.0, 24h → ~0.8, 72h → ~0.5, 7d → ~0.2
 */
export function computeFreshnessScore(ageHours: number): number {
  if (ageHours <= 0) return 1.0;
  const decay = Math.exp(-ageHours / 48);
  return Number(Math.max(decay, 0.05).toFixed(4));
}

export async function recordEvidence(record: EvidenceRecord): Promise<string | null> {
  const quality = computeSourceQuality(record.sourceType, record.sourceQuality ?? 0.5);
  return db.insertExternalEvidence({
    sourceType: record.sourceType,
    sourceName: record.sourceName || null,
    sourceUrl: record.sourceUrl || null,
    symbol: record.symbol || null,
    market: record.market || null,
    strategyFamily: record.strategyFamily || null,
    signalDirection: record.signalDirection || null,
    score: record.score ?? 0,
    sourceQuality: quality,
    freshnessScore: record.freshnessScore ?? 1.0,
    evidenceSummary: record.evidenceSummary || null,
    rawRef: record.rawRef || {},
  });
}

export async function recordBacktestEvidence({
  symbol,
  market = null,
  strategyFamily = null,
  sharpe,
  winRate,
  totalTrades,
  backwindowDays,
  isOutOfSample = false,
  summary = null,
}: {
  symbol: string;
  market?: string | null;
  strategyFamily?: string | null;
  sharpe: number;
  winRate: number;
  totalTrades: number;
  backwindowDays: number;
  isOutOfSample?: boolean;
  summary?: string | null;
}): Promise<string | null> {
  // in-sample은 quality를 낮춤 (overfitting risk)
  const baseQuality = isOutOfSample ? 0.85 : 0.55;
  // 샘플 수가 많을수록 신뢰도 증가
  const sampleBonus = Math.min(totalTrades / 200, 0.1);
  const quality = computeSourceQuality('backtest', baseQuality + sampleBonus);

  const score = Math.min(
    Number((((sharpe || 0) + (winRate || 0)) / 2).toFixed(4)),
    1.0,
  );

  return recordEvidence({
    sourceType: 'backtest',
    sourceName: `vectorbt_${strategyFamily || 'unknown'}_${backwindowDays}d`,
    symbol,
    market,
    strategyFamily,
    signalDirection: score > 0.6 ? 'bullish' : score < 0.3 ? 'bearish' : 'neutral',
    score,
    sourceQuality: quality,
    freshnessScore: 1.0,
    evidenceSummary: summary || `sharpe=${sharpe}, winRate=${(winRate * 100).toFixed(1)}%, trades=${totalTrades}, window=${backwindowDays}d`,
    rawRef: { sharpe, winRate, totalTrades, backwindowDays, isOutOfSample },
  });
}

export async function recordScoutEvidence({
  symbol,
  market = null,
  strategyFamily = null,
  signalDirection = null,
  score = 0.5,
  summary = null,
  rawRef = {},
}: {
  symbol: string;
  market?: string | null;
  strategyFamily?: string | null;
  signalDirection?: string | null;
  score?: number;
  summary?: string | null;
  rawRef?: Record<string, unknown>;
}): Promise<string | null> {
  return recordEvidence({
    sourceType: 'scout',
    sourceName: 'argos_scout',
    symbol,
    market,
    strategyFamily,
    signalDirection,
    score,
    sourceQuality: 0.75,
    freshnessScore: 1.0,
    evidenceSummary: summary,
    rawRef,
  });
}

/**
 * agent prompt 입력용 evidence summary 빌드.
 * 단독 실행 트리거로 사용하지 않도록 max_evidence_quality가 붙는다.
 */
export async function buildEvidenceSummaryForAgent({
  symbol,
  market = null,
  days = 3,
}: {
  symbol: string;
  market?: string | null;
  days?: number;
}): Promise<{
  evidenceCount: number;
  avgQuality: number;
  avgFreshness: number;
  signals: { bullish: number; bearish: number; neutral: number };
  topEvidences: Array<{
    sourceType: string;
    sourceName: string | null;
    signalDirection: string | null;
    score: number;
    sourceQuality: number;
    freshnessScore: number;
    evidenceSummary: string | null;
  }>;
  warning: string | null;
}> {
  const rows = await db.getRecentExternalEvidence({ days, symbol, limit: 20 });

  if (!rows || rows.length === 0) {
    return {
      evidenceCount: 0,
      avgQuality: 0,
      avgFreshness: 0,
      signals: { bullish: 0, bearish: 0, neutral: 0 },
      topEvidences: [],
      warning: '최근 외부 에비던스 없음. agent는 내부 분석 결과에만 의존해야 합니다.',
    };
  }

  const avgQuality = rows.reduce((s, r) => s + Number(r.source_quality || 0), 0) / rows.length;
  const avgFreshness = rows.reduce((s, r) => s + Number(r.freshness_score || 0), 0) / rows.length;
  const signals = { bullish: 0, bearish: 0, neutral: 0 };
  for (const r of rows) {
    const dir = String(r.signal_direction || '').toLowerCase();
    if (dir === 'bullish') signals.bullish++;
    else if (dir === 'bearish') signals.bearish++;
    else signals.neutral++;
  }

  const topEvidences = rows
    .sort((a, b) => Number(b.source_quality || 0) - Number(a.source_quality || 0))
    .slice(0, 5)
    .map((r) => ({
      sourceType: r.source_type,
      sourceName: r.source_name,
      signalDirection: r.signal_direction,
      score: Number(r.score || 0),
      sourceQuality: Number(r.source_quality || 0),
      freshnessScore: Number(r.freshness_score || 0),
      evidenceSummary: r.evidence_summary,
    }));

  const warning = avgQuality < 0.5
    ? `외부 에비던스 평균 품질 ${avgQuality.toFixed(2)} < 0.5 — 단독 실행 트리거로 사용 금지`
    : null;

  return {
    evidenceCount: rows.length,
    avgQuality: Number(avgQuality.toFixed(4)),
    avgFreshness: Number(avgFreshness.toFixed(4)),
    signals,
    topEvidences,
    warning,
  };
}

export default {
  recordEvidence,
  recordBacktestEvidence,
  recordScoutEvidence,
  buildEvidenceSummaryForAgent,
  computeSourceQuality,
  computeFreshnessScore,
};
