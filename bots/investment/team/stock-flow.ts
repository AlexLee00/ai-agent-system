// @ts-nocheck
/**
 * team/stock-flow.ts — 주식 flow/event 유지감시 분석가
 *
 * 역할:
 *   - 국내장/국외장 managed 포지션의 경량 유지수집
 *   - quote/volume/랭킹 + 최근 TA/뉴스/센티널 + scout 인텔을 묶어 flow 신호 생성
 *   - maintenance collect에서 장중 변화 체감을 암호화폐 수준으로 끌어올리는 보강 축
 */

import * as db from '../shared/db.ts';
import { ANALYST_TYPES, ACTIONS } from '../shared/signal.ts';
import { getDomesticQuoteSnapshot, getOverseasQuoteSnapshot, getVolumeRank } from '../shared/kis-client.ts';
import { loadLatestScoutIntel, getScoutSignalForSymbol } from '../shared/scout-intel.ts';

const FLOW_THRESHOLDS = {
  buy: 0.55,
  sell: -0.55,
};

function scoreFromSignal(signal, confidence = 0, weight = 1) {
  const dir = signal === ACTIONS.BUY ? 1 : signal === ACTIONS.SELL ? -1 : 0;
  return dir * Number(confidence || 0) * weight;
}

function buildReason(parts = []) {
  return parts.filter(Boolean).join(' | ').slice(0, 240);
}

function toConfidence(score) {
  return Math.max(0.12, Math.min(0.92, Number((Math.abs(score) / 1.8).toFixed(4))));
}

async function loadRecentAnalystMap(symbol, exchange) {
  const rows = await db.getRecentAnalysis(symbol, 12 * 60, exchange).catch(() => []);
  const byAnalyst = new Map();
  for (const row of rows) {
    if (!byAnalyst.has(row.analyst)) byAnalyst.set(row.analyst, row);
  }
  return byAnalyst;
}

async function loadDomesticVolumeRank(symbol) {
  try {
    const rows = await getVolumeRank(false);
    const idx = rows.findIndex((row) => String(row.stockCode || '').trim() === String(symbol || '').trim());
    if (idx < 0) return null;
    const row = rows[idx];
    return {
      rank: idx + 1,
      volume: Number(row.volume || 0),
      changeRate: Number(row.changeRate || 0),
    };
  } catch {
    return null;
  }
}

function deriveFlowDecision({
  exchange,
  quote,
  position,
  taRow,
  newsRow,
  sentinelRow,
  scoutSignal,
  domesticRank,
} = {}) {
  let score = 0;
  const reasons = [];

  if (taRow) {
    const taScore = scoreFromSignal(taRow.signal, taRow.confidence, 0.85);
    score += taScore;
    reasons.push(`TA ${taRow.signal} ${(Number(taRow.confidence || 0) * 100).toFixed(0)}%`);
  }

  if (newsRow) {
    const articleCount = Number(newsRow.metadata?.articleCount || 0);
    const newsWeight = articleCount >= 3 ? 0.55 : 0.35;
    score += scoreFromSignal(newsRow.signal, newsRow.confidence, newsWeight);
    reasons.push(`뉴스 ${newsRow.signal} ${articleCount}건`);
  }

  if (sentinelRow) {
    const sentinelWeight = sentinelRow.metadata?.quality?.status === 'ready' ? 0.45 : 0.28;
    score += scoreFromSignal(sentinelRow.signal, sentinelRow.confidence, sentinelWeight);
    reasons.push(`센티널 ${sentinelRow.signal}`);
  }

  if (scoutSignal) {
    const scoutBoost = Number(scoutSignal.score || 0) >= 0.75 ? 0.2 : Number(scoutSignal.score || 0) >= 0.6 ? 0.1 : 0;
    score += scoutBoost;
    reasons.push(`스카우트 ${scoutSignal.source} ${(Number(scoutSignal.score || 0) * 100).toFixed(0)}%`);
  }

  if (exchange === 'kis' && domesticRank) {
    if (domesticRank.rank <= 10) {
      score += 0.28;
      reasons.push(`거래량 상위 ${domesticRank.rank}위`);
    } else if (domesticRank.rank <= 30) {
      score += 0.14;
      reasons.push(`거래량 상위 ${domesticRank.rank}위`);
    }
  }

  let pnlPct = null;
  if (position && Number(position.avg_price || 0) > 0 && Number(quote?.price || 0) > 0) {
    pnlPct = ((Number(quote.price) - Number(position.avg_price)) / Number(position.avg_price)) * 100;
    if (pnlPct <= -3) {
      score -= 0.25;
      reasons.push(`포지션 손익 ${pnlPct.toFixed(2)}%`);
    } else if (pnlPct >= 4) {
      score += 0.12;
      reasons.push(`포지션 손익 +${pnlPct.toFixed(2)}%`);
    }
  }

  if (exchange === 'kis_overseas' && Number(quote?.changePct || 0) >= 2) {
    score += 0.16;
    reasons.push(`장중 변동 +${Number(quote.changePct).toFixed(2)}%`);
  } else if (exchange === 'kis_overseas' && Number(quote?.changePct || 0) <= -2) {
    score -= 0.16;
    reasons.push(`장중 변동 ${Number(quote.changePct).toFixed(2)}%`);
  }

  const signal =
    score >= FLOW_THRESHOLDS.buy ? ACTIONS.BUY
      : score <= FLOW_THRESHOLDS.sell ? ACTIONS.SELL
        : ACTIONS.HOLD;

  return {
    signal,
    confidence: toConfidence(score),
    reasoning: buildReason(reasons.length > 0 ? reasons : ['flow/event 중립']),
    score: Number(score.toFixed(4)),
    pnlPct: pnlPct == null ? null : Number(pnlPct.toFixed(4)),
  };
}

export async function analyzeStockFlow(symbol, exchange = 'kis') {
  if (exchange !== 'kis' && exchange !== 'kis_overseas') {
    throw new Error(`stock-flow는 주식 시장만 지원합니다: ${exchange}`);
  }

  const [position, byAnalyst, scoutIntel] = await Promise.all([
    db.getLivePosition(symbol, exchange, 'normal').catch(() => null),
    loadRecentAnalystMap(symbol, exchange),
    loadLatestScoutIntel({ minutes: 24 * 60 }).catch(() => null),
  ]);

  const [quote, domesticRank] = await Promise.all([
    exchange === 'kis'
      ? getDomesticQuoteSnapshot(symbol, false)
      : getOverseasQuoteSnapshot(symbol),
    exchange === 'kis'
      ? loadDomesticVolumeRank(symbol)
      : Promise.resolve(null),
  ]);

  const scoutSignal = getScoutSignalForSymbol(scoutIntel, symbol);
  const taRow = byAnalyst.get(ANALYST_TYPES.TA_MTF) || null;
  const newsRow = byAnalyst.get(ANALYST_TYPES.NEWS) || null;
  const sentinelRow = byAnalyst.get(ANALYST_TYPES.SENTINEL) || null;

  const decision = deriveFlowDecision({
    exchange,
    quote,
    position,
    taRow,
    newsRow,
    sentinelRow,
    scoutSignal,
    domesticRank,
  });

  const metadata = {
    exchange,
    quote,
    domesticRank,
    scoutSignal: scoutSignal ? {
      source: scoutSignal.source,
      score: scoutSignal.score,
      label: scoutSignal.label,
    } : null,
    newsSignal: newsRow ? {
      signal: newsRow.signal,
      confidence: Number(newsRow.confidence || 0),
      articleCount: Number(newsRow.metadata?.articleCount || 0),
    } : null,
    taSignal: taRow ? {
      signal: taRow.signal,
      confidence: Number(taRow.confidence || 0),
    } : null,
    sentinelSignal: sentinelRow ? {
      signal: sentinelRow.signal,
      confidence: Number(sentinelRow.confidence || 0),
      quality: sentinelRow.metadata?.quality?.status || null,
    } : null,
    positionPnlPct: decision.pnlPct,
    flowScore: decision.score,
    maintenance: true,
  };

  await db.insertAnalysis({
    symbol,
    analyst: ANALYST_TYPES.MARKET_FLOW,
    signal: decision.signal,
    confidence: decision.confidence,
    reasoning: `[flow] ${decision.reasoning}`,
    metadata,
    exchange,
  });

  return {
    symbol,
    exchange,
    signal: decision.signal,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    metadata,
  };
}
