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
import { getYahooStockEventIntel } from '../shared/stock-event-intel.ts';
import { getRecentHubMarketPulse } from '../shared/hub-market-pulse.ts';

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

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function compactText(value, max = 80) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
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

function deriveDomesticScoutContext(symbol, scoutIntel, scoutSignal) {
  const sections = scoutIntel?.sections && typeof scoutIntel.sections === 'object'
    ? scoutIntel.sections
    : {};
  const sectorLines = Array.isArray(sections.sectors) ? sections.sectors : [];
  const communityLines = Array.isArray(sections.community) ? sections.community : [];
  const topLines = Array.isArray(sections.top10) ? sections.top10 : [];
  const calendarLines = Array.isArray(sections.calendar) ? sections.calendar : [];

  const source = String(scoutSignal?.source || '').trim();
  const score = Number(scoutSignal?.score || 0);
  let boost = 0;
  const reasons = [];

  if (source === 'sectors') {
    boost += score >= 0.75 ? 0.24 : 0.16;
    reasons.push(`토스 섹터 모멘텀 ${(score * 100).toFixed(0)}%`);
  } else if (source === 'top10') {
    boost += score >= 0.75 ? 0.2 : 0.12;
    reasons.push(`토스 거래대금/인기 ${(score * 100).toFixed(0)}%`);
  } else if (source === 'community') {
    boost += score >= 0.75 ? 0.1 : 0.05;
    reasons.push(`토스 커뮤니티 관심 ${(score * 100).toFixed(0)}%`);
  } else if (source === 'calendar') {
    boost += score >= 0.75 ? 0.08 : 0.04;
    reasons.push(`토스 일정 포착 ${(score * 100).toFixed(0)}%`);
  } else if (source === 'aiSignals' || source === 'strategies') {
    boost += score >= 0.75 ? 0.16 : 0.1;
    reasons.push(`토스 전략 신호 ${(score * 100).toFixed(0)}%`);
  }

  if (scoutIntel?.focusSymbols?.includes(symbol)) {
    boost += 0.05;
    reasons.push('토스 focus 심볼');
  }

  if (scoutIntel?.overlapSymbols?.includes(symbol)) {
    boost += 0.04;
    reasons.push('아르고스/토스 overlap');
  }

  const highlights = [
    ...sectorLines.slice(0, 2),
    ...topLines.slice(0, 1),
    ...calendarLines.slice(0, 1),
    ...communityLines.slice(0, 1),
  ]
    .map((line) => compactText(line, 64))
    .filter(Boolean)
    .slice(0, 4);

  return {
    boost: Number(boost.toFixed(4)),
    reasons,
    highlights,
    source: source || null,
    score: score > 0 ? Number(score.toFixed(4)) : 0,
  };
}

function deriveFlowDecision({
  exchange,
  quote,
  position,
  taRow,
  newsRow,
  sentinelRow,
  scoutSignal,
  domesticScoutContext,
  domesticRank,
  overseasEvent,
  hubPulse,
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

  if (exchange === 'kis' && domesticScoutContext?.boost) {
    score += Number(domesticScoutContext.boost || 0);
    reasons.push(...(Array.isArray(domesticScoutContext.reasons) ? domesticScoutContext.reasons : []));
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

  if (exchange === 'kis_overseas' && overseasEvent && !overseasEvent.error) {
    if (Number.isFinite(Number(overseasEvent.earningsDays)) && overseasEvent.earningsDays >= 0 && overseasEvent.earningsDays <= 7) {
      score -= 0.08;
      reasons.push(`실적발표 임박 D-${overseasEvent.earningsDays}`);
    }

    if (Number.isFinite(Number(overseasEvent.recommendationMean))) {
      if (overseasEvent.recommendationMean <= 2.2) {
        score += 0.18;
        reasons.push(`애널리스트 우호 ${Number(overseasEvent.recommendationMean).toFixed(2)}`);
      } else if (overseasEvent.recommendationMean >= 3.4) {
        score -= 0.18;
        reasons.push(`애널리스트 보수 ${Number(overseasEvent.recommendationMean).toFixed(2)}`);
      }
    }

    if (Number(overseasEvent.recentUpgrades || 0) > Number(overseasEvent.recentDowngrades || 0)) {
      score += 0.12;
      reasons.push(`최근 상향 ${overseasEvent.recentUpgrades}건`);
    } else if (Number(overseasEvent.recentDowngrades || 0) > Number(overseasEvent.recentUpgrades || 0)) {
      score -= 0.12;
      reasons.push(`최근 하향 ${overseasEvent.recentDowngrades}건`);
    }

    const secFilings = overseasEvent.secFilings;
    if (secFilings && !secFilings.error) {
      if (Number(secFilings.recent30Count || 0) >= 4) {
        score -= 0.06;
        reasons.push(`SEC 공시 증가 ${secFilings.recent30Count}건/30일`);
      }
      const latestMaterial = secFilings.latestMaterialForm;
      if (latestMaterial?.form) {
        reasons.push(`최근 SEC ${latestMaterial.form}`);
        if (/^(8-K|6-K)$/i.test(String(latestMaterial.form || ''))) {
          score -= 0.04;
        }
      }
    }
  }

  if ((exchange === 'kis' || exchange === 'kis_overseas') && hubPulse) {
    if (hubPulse.status === 'ready' || hubPulse.status === 'degraded') {
      if (hubPulse.hasRecentPulse && Number(hubPulse.tickCount || 0) >= 3) {
        if (Number(hubPulse.tickDeltaPct || 0) >= 0.18) {
          score += 0.16;
          reasons.push(`장중 펄스 +${Number(hubPulse.tickDeltaPct).toFixed(2)}%`);
        } else if (Number(hubPulse.tickDeltaPct || 0) <= -0.18) {
          score -= 0.16;
          reasons.push(`장중 펄스 ${Number(hubPulse.tickDeltaPct).toFixed(2)}%`);
        }
      }

      if (hubPulse.hasRecentPulse && Number(hubPulse.quoteCount || 0) > 0 && Number.isFinite(Number(hubPulse.spreadPct))) {
        if (Number(hubPulse.spreadPct || 0) <= 0.12) {
          score += 0.05;
          reasons.push(`호가 스프레드 ${Number(hubPulse.spreadPct).toFixed(2)}%`);
        } else if (Number(hubPulse.spreadPct || 0) >= 0.6) {
          score -= 0.08;
          reasons.push(`호가 스프레드 확대 ${Number(hubPulse.spreadPct).toFixed(2)}%`);
        }
      }

      if (!hubPulse.hasRecentPulse && Number.isFinite(Number(hubPulse.freshnessSeconds)) && Number(hubPulse.freshnessSeconds) >= 600) {
        score -= 0.04;
        reasons.push(`장중 펄스 stale ${hubPulse.freshnessSeconds}s`);
      }
    }
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

  const [quote, domesticRank, overseasEvent, hubPulse] = await Promise.all([
    exchange === 'kis'
      ? getDomesticQuoteSnapshot(symbol, false).catch((error) => ({
          error: error?.message || 'domestic_quote_failed',
        }))
      : getOverseasQuoteSnapshot(symbol).catch((error) => ({
          error: error?.message || 'overseas_quote_failed',
        })),
    exchange === 'kis'
      ? loadDomesticVolumeRank(symbol)
      : Promise.resolve(null),
    exchange === 'kis_overseas'
      ? getYahooStockEventIntel(symbol).catch(() => null)
      : Promise.resolve(null),
    getRecentHubMarketPulse(symbol, exchange, { minutes: 120, limit: 24 }).catch(() => null),
  ]);

  const scoutSignal = getScoutSignalForSymbol(scoutIntel, symbol);
  const domesticScoutContext = exchange === 'kis'
    ? deriveDomesticScoutContext(symbol, scoutIntel, scoutSignal)
    : null;
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
    domesticScoutContext,
    domesticRank,
    overseasEvent,
    hubPulse,
  });

  const metadata = {
    exchange,
    quote: quote && !quote.error ? quote : null,
    quoteError: quote?.error || null,
    domesticRank,
    overseasEvent: overseasEvent && !overseasEvent.error ? overseasEvent : null,
    hubPulse,
    scoutSignal: scoutSignal ? {
      source: scoutSignal.source,
      score: scoutSignal.score,
      label: scoutSignal.label,
    } : null,
    domesticScoutContext,
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
