// @ts-nocheck
/**
 * Unified Analyst — 기술 + 펀더멘털 + 감성 통합 분석
 *
 * 마스터 철학: "기술분석 + 회사분석 + 하네스 + 스킬 고도화!"
 * 2026 트렌드: ElliottAgents (Technical + Fundamental + RAG + DRL)
 *
 * - 기술: Phase A (HMM + GARCH + WorldQuant) + multi-timeframe
 * - 펀더멘털: corp_fundamentals (PER, PBR, ROE 등)
 * - 감성: FinBERT (한국어 + 영어)
 * - LLM 종합: Hub LLM Gateway
 */

import * as db from './db/core.ts';
import { analyzeMultiTimeframe } from './multi-timeframe-analyzer.ts';
import { runLunaAnalysisPredictionPhaseA } from './luna-analysis-prediction-phase-a.ts';

// ─── 타입 정의 ─────────────────────────────────────────────────

export interface UnifiedAnalysisInput {
  symbol: string;
  market: 'crypto' | 'stocks' | 'overseas';
  exchange: string;
  bars: OHLCVBar[];
  timeframes?: string[];  // 다중 타임프레임
  vix?: number;
  factors?: Record<string, number>;
}

export interface OHLCVBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FundamentalScore {
  per?: number;
  pbr?: number;
  roe?: number;
  roa?: number;
  debtRatio?: number;
  marketCap?: number;
  score: number;        // 0~1 종합 점수
  grade: 'A' | 'B' | 'C' | 'D' | 'N/A';
  factors?: Record<string, number>;
}

export interface UnifiedAnalysisResult {
  symbol: string;
  market: string;
  timestamp: string;

  // 세 축 점수 (0~1)
  technicalScore: number;
  fundamentalScore: number;
  sentimentScore: number;

  // 종합 점수 + 시그널
  compositeScore: number;
  signal: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
  confidence: number;

  // 다중 타임프레임
  timeframeSignal?: { score: number; dominantFrame: string };

  // 세부 데이터
  regime?: string;
  fundamentals?: FundamentalScore;
  phaseAStatus?: string;

  // 메타
  analyzedAt: string;
  sources: string[];
}

// ─── 가중치 설정 ─────────────────────────────────────────────

const WEIGHTS = {
  crypto: { technical: 0.55, fundamental: 0.10, sentiment: 0.35 },
  stocks: { technical: 0.40, fundamental: 0.40, sentiment: 0.20 },
  overseas: { technical: 0.45, fundamental: 0.35, sentiment: 0.20 },
};

// ─── 핵심: 통합 분석 ─────────────────────────────────────────

export async function runUnifiedAnalysis(input: UnifiedAnalysisInput): Promise<UnifiedAnalysisResult> {
  const w = WEIGHTS[input.market] ?? WEIGHTS.crypto;
  const sources: string[] = [];

  // 1. 기술 분석 (Phase A + multi-timeframe)
  let technicalScore = 0.5;
  let regime: string | undefined;
  let phaseAStatus: string | undefined;
  let timeframeSignal: UnifiedAnalysisResult['timeframeSignal'] | undefined;

  try {
    const phaseA = await runLunaAnalysisPredictionPhaseA({
      symbol: input.symbol,
      bars: input.bars,
      vix: input.vix,
      factors: input.factors,
    }, {});
    technicalScore = normalizePhaseAScore(phaseA);
    regime = phaseA?.regime;
    phaseAStatus = phaseA?.status;
    sources.push('phase_a');
  } catch (_err) {
    // Phase A 실패 시 multi-timeframe으로 폴백
  }

  try {
    const mtf = analyzeMultiTimeframe(input.symbol, [], input.exchange, {
      timeframes: input.timeframes,
    });
    if (mtf?.score !== undefined) {
      // mtf.score is -1~1, normalize to 0~1
      timeframeSignal = {
        score: (Number(mtf.score ?? 0) + 1) / 2,
        dominantFrame: mtf.dominantTimeframe ?? '1d',
      };
      // Phase A 실패 시 mtf를 primary로
      if (sources.length === 0) {
        technicalScore = timeframeSignal.score;
        sources.push('multi_timeframe');
      } else {
        // Phase A 있으면 블렌드
        technicalScore = technicalScore * 0.7 + timeframeSignal.score * 0.3;
      }
    }
  } catch (_err) {
    // mtf 실패 시 기존 값 유지
  }

  // 2. 펀더멘털 분석 (DB에서 조회)
  let fundamentalScore = 0.5;
  let fundamentals: FundamentalScore | undefined;

  if (input.market !== 'crypto') {
    try {
      fundamentals = await fetchFundamentalScore(input.symbol);
      fundamentalScore = fundamentals.score;
      sources.push('fundamentals');
    } catch (_err) {
      // 펀더멘털 없으면 중립
    }
  } else {
    // 크립토는 펀더멘털 없으므로 가중치를 기술 쪽으로 재분배
    sources.push('crypto_no_fundamental');
  }

  // 3. 감성 분석 (FinBERT — position_signal_history 최근 감성 참조)
  let sentimentScore = 0.5;
  try {
    const sent = await fetchRecentSentimentScore(input.symbol, input.market);
    if (sent !== null) {
      sentimentScore = sent;
      sources.push('finbert_sentiment');
    }
  } catch (_err) {
    // 감성 없으면 중립
  }

  // 4. 가중 합산
  const effectiveW = input.market === 'crypto'
    ? { technical: w.technical + w.fundamental, fundamental: 0, sentiment: w.sentiment }
    : w;

  const compositeScore =
    technicalScore * effectiveW.technical +
    fundamentalScore * effectiveW.fundamental +
    sentimentScore * effectiveW.sentiment;

  const confidence = calcConfidence(technicalScore, fundamentalScore, sentimentScore, sources.length);
  const signal = scoreToSignal(compositeScore, confidence);

  return {
    symbol: input.symbol,
    market: input.market,
    timestamp: new Date().toISOString(),
    technicalScore: round(technicalScore),
    fundamentalScore: round(fundamentalScore),
    sentimentScore: round(sentimentScore),
    compositeScore: round(compositeScore),
    signal,
    confidence: round(confidence),
    timeframeSignal,
    regime,
    fundamentals,
    phaseAStatus,
    analyzedAt: new Date().toISOString(),
    sources,
  };
}

// ─── 펀더멘털 DB 조회 ────────────────────────────────────────

async function fetchFundamentalScore(symbol: string): Promise<FundamentalScore> {
  const res = await db.query(`
    SELECT per, pbr, roe, roa, debt_ratio, market_cap, factor_scores
    FROM investment.corp_fundamentals
    WHERE stock_code = $1
    ORDER BY updated_at DESC
    LIMIT 1
  `, [symbol]);

  if (res.rows.length === 0) {
    return { score: 0.5, grade: 'N/A' };
  }

  const row = res.rows[0];
  const per = Number(row.per ?? 0);
  const pbr = Number(row.pbr ?? 0);
  const roe = Number(row.roe ?? 0);
  const debtRatio = Number(row.debt_ratio ?? 100);

  // 간단한 펀더멘털 점수화
  let score = 0.5;
  if (per > 0 && per < 15) score += 0.1;
  else if (per > 30) score -= 0.1;
  if (pbr > 0 && pbr < 1.5) score += 0.1;
  if (roe > 15) score += 0.15;
  else if (roe < 5) score -= 0.1;
  if (debtRatio < 50) score += 0.1;
  else if (debtRatio > 150) score -= 0.15;

  score = Math.max(0, Math.min(1, score));
  const grade = score >= 0.75 ? 'A' : score >= 0.55 ? 'B' : score >= 0.40 ? 'C' : 'D';

  return {
    per: per || undefined,
    pbr: pbr || undefined,
    roe: roe || undefined,
    roa: Number(row.roa ?? 0) || undefined,
    debtRatio: debtRatio || undefined,
    marketCap: Number(row.market_cap ?? 0) || undefined,
    score,
    grade,
    factors: row.factor_scores,
  };
}

async function fetchRecentSentimentScore(symbol: string, market: string): Promise<number | null> {
  const res = await db.query(`
    SELECT AVG(sentiment_score) AS avg_sentiment
    FROM investment.position_signal_history
    WHERE symbol = $1 AND market = $2
      AND sentiment_score IS NOT NULL
      AND created_at >= NOW() - INTERVAL '48 hours'
  `, [symbol, market]);

  const raw = res.rows[0]?.avg_sentiment;
  if (raw === null || raw === undefined) return null;
  // DB sentiment: -1~1 → 0~1 정규화
  return Math.max(0, Math.min(1, (Number(raw) + 1) / 2));
}

// ─── 헬퍼 ──────────────────────────────────────────────────

function normalizePhaseAScore(phaseA: any): number {
  if (!phaseA?.signals?.length) return 0.5;
  const bullish = phaseA.signals.filter((s: any) => ['breakout', 'momentum_rotation'].includes(s.type)).length;
  const bearish = phaseA.signals.filter((s: any) => ['defensive_rotation'].includes(s.type)).length;
  const total = phaseA.signals.length;
  return total === 0 ? 0.5 : Math.max(0, Math.min(1, 0.5 + (bullish - bearish) / total * 0.5));
}

function calcConfidence(tech: number, fund: number, sent: number, sourceCount: number): number {
  // 세 축 편차가 적을수록 신뢰도 높음
  const mean = (tech + fund + sent) / 3;
  const variance = ((tech - mean) ** 2 + (fund - mean) ** 2 + (sent - mean) ** 2) / 3;
  const coherence = Math.max(0, 1 - variance * 4);
  // 소스 다양성 보너스
  const diversityBonus = Math.min(0.2, sourceCount * 0.05);
  return Math.min(0.95, coherence * 0.8 + diversityBonus);
}

function scoreToSignal(score: number, confidence: number): UnifiedAnalysisResult['signal'] {
  if (confidence < 0.3) return 'neutral';
  if (score >= 0.72) return 'strong_buy';
  if (score >= 0.58) return 'buy';
  if (score <= 0.28) return 'strong_sell';
  if (score <= 0.42) return 'sell';
  return 'neutral';
}

function round(v: number, digits = 3): number {
  return Number(v.toFixed(digits));
}
