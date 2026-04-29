// @ts-nocheck

import * as db from './db.ts';
import { ACTIONS, ANALYST_TYPES } from './signal.ts';
import { getPositionReevaluationRuntimeConfig } from './runtime-config.ts';

function getExchangeLabel(exchange) {
  return exchange === 'kis_overseas' ? '미국주식' : exchange === 'kis' ? '국내주식' : '암호화폐';
}

export function buildCompactExitAnalystSummary(analysesList) {
  if (!Array.isArray(analysesList) || analysesList.length === 0) return '분석 데이터 없음';
  return analysesList.slice(0, 3).map((item) => {
    const label = item.analyst === ANALYST_TYPES.TA_MTF    ? 'TA'
                : item.analyst === ANALYST_TYPES.ONCHAIN   ? '온체인'
                : item.analyst === ANALYST_TYPES.SENTINEL  ? 'sentinel'
                : item.analyst === ANALYST_TYPES.NEWS      ? '뉴스'
                : item.analyst === ANALYST_TYPES.SENTIMENT ? '감성'
                : '기타';
    const signal = String(item.signal || 'HOLD').toUpperCase();
    const conf = `${((item.confidence || 0) * 100).toFixed(0)}%`;
    const reason = String(item.reasoning || '').replace(/\s+/g, ' ').slice(0, 48);
    return `[${label}] ${signal} ${conf} ${reason}`.trim();
  }).join(' / ');
}

export function buildExitPrompt(openPositions, exchange = 'binance') {
  const label = getExchangeLabel(exchange);
  const lines = openPositions.map((pos) => {
    const pnl = Number(pos.unrealized_pnl || 0);
    const avgPrice = Number(pos.avg_price || 0);
    const currentPrice = Number(pos.current_price || avgPrice || 0);
    const pnlPct = avgPrice > 0
      ? (((currentPrice - avgPrice) / avgPrice) * 100).toFixed(2)
      : '0.00';
    const heldHours = Number(pos.held_hours || 0).toFixed(1);
    const analysesList = Array.isArray(pos.analyses) ? pos.analyses : [];
    const sellLikeCount = analysesList.filter(item => String(item.signal || '').toUpperCase() === 'SELL').length;
    const holdCount = analysesList.filter(item => String(item.signal || '').toUpperCase() === 'HOLD').length;
    const buyCount = analysesList.filter(item => String(item.signal || '').toUpperCase() === 'BUY').length;
    const compactAnalyses = buildCompactExitAnalystSummary(analysesList);
    return [
      `- ${pos.symbol}`,
      `  수량: ${pos.amount}`,
      `  평균단가: ${avgPrice}`,
      `  현재가: ${currentPrice}`,
      `  미실현손익: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPct}%)`,
      `  보유시간: ${heldHours}h`,
      `  trade_mode: ${pos.trade_mode || 'normal'}`,
      `  분석가 집계: BUY ${buyCount} / HOLD ${holdCount} / SELL ${sellLikeCount}`,
      `  요약: ${compactAnalyses}`,
    ].join('\n');
  }).join('\n\n');

  return [
    `시장: ${label} (${exchange})`,
    '',
    '당신은 포지션 청산 전문가입니다.',
    '현재 보유 중인 포지션을 분석하고, 청산이 필요한 포지션을 판단하세요.',
    '',
    '판단 기준:',
    '1. 수익 실현 (TP): 목표 수익률 도달 시',
    '2. 손절 (SL): 손실 한도 초과 시',
    '3. 추세 전환: 분석가 신호가 SELL/HOLD로 전환 시',
    '4. 보유 기간: 장기 보유(72시간+) 시 재평가',
    '5. 시장 레짐: 시장 전반 하락 국면 시',
    '',
    'SELL 우선 규칙:',
    '- 미실현손익이 음수이고 분석가 다수가 SELL/HOLD면 SELL을 우선 검토',
    '- 미실현손익 -5% 이하 손실은 특별한 반전 근거가 없으면 SELL',
    '- 72시간 이상 장기 보유는 명확한 상승 근거가 없으면 SELL',
    '- 단, 작은 손실(-1% 이내)이고 보유 시간이 짧으면 즉시 SELL보다 HOLD를 우선 검토',
    '',
    '각 포지션에 대해 SELL 또는 HOLD를 반드시 지정하세요.',
    '',
    '[보유 포지션]',
    lines,
  ].join('\n');
}

export function normalizeExitDecision(rawDecision, fallbackPosition) {
  const action = String(rawDecision?.action || 'HOLD').toUpperCase();
  return {
    symbol: rawDecision?.symbol || fallbackPosition?.symbol,
    action: action === ACTIONS.SELL ? ACTIONS.SELL : ACTIONS.HOLD,
    confidence: Math.max(0, Math.min(1, Number(rawDecision?.confidence ?? 0.5))),
    reasoning: String(rawDecision?.reasoning || '').trim().slice(0, 180) || 'EXIT 판단 근거 없음',
    exit_type: 'normal_exit',
  };
}

export function getExitGuardConfig() {
  const guards = getPositionReevaluationRuntimeConfig()?.exitGuards || {};
  return {
    mildLossHoldThresholdPct: Number.isFinite(Number(guards?.mildLossHoldThresholdPct))
      ? Number(guards.mildLossHoldThresholdPct)
      : -1.0,
    shortHoldHours: Number.isFinite(Number(guards?.shortHoldHours))
      ? Number(guards.shortHoldHours)
      : 6,
    overwhelmingSellVotes: Math.max(
      1,
      Number.isFinite(Number(guards?.overwhelmingSellVotes))
        ? Math.round(Number(guards.overwhelmingSellVotes))
        : 3,
    ),
  };
}

export function getPositionPnlPct(position) {
  const avgPrice = Number(position?.avg_price || 0);
  const currentPrice = Number(position?.current_price || avgPrice || 0);
  if (!(avgPrice > 0)) return 0;
  return ((currentPrice - avgPrice) / avgPrice) * 100;
}

export function countExitVotes(position) {
  const analyses = Array.isArray(position?.analyses) ? position.analyses : [];
  let buy = 0;
  let sellLike = 0;
  for (const item of analyses) {
    const signal = String(item?.signal || '').toUpperCase();
    if (signal === 'BUY') buy += 1;
    if (signal === 'SELL' || signal === 'HOLD') sellLike += 1;
  }
  return { buy, sellLike };
}

export function shouldDowngradeEarlyExit(position, decision) {
  if (String(decision?.action || '').toUpperCase() !== ACTIONS.SELL) return false;
  const guards = getExitGuardConfig();
  const heldHours = Number(position?.held_hours || 0);
  const pnlPct = getPositionPnlPct(position);
  if (!(pnlPct < 0 && pnlPct > guards.mildLossHoldThresholdPct && heldHours < guards.shortHoldHours)) {
    return false;
  }
  const { buy, sellLike } = countExitVotes(position);
  const overwhelmingSell = sellLike >= Math.max(guards.overwhelmingSellVotes, buy + 2);
  return !overwhelmingSell;
}

export function applyExitGuard(position, decision) {
  if (!position || !decision) return decision;
  if (!shouldDowngradeEarlyExit(position, decision)) return decision;
  const heldHours = Number(position?.held_hours || 0);
  const pnlPct = getPositionPnlPct(position);
  return {
    ...decision,
    action: ACTIONS.HOLD,
    confidence: Math.min(Number(decision?.confidence ?? 0.5), 0.58),
    reasoning: `EXIT 가드 — 작은 손실 ${pnlPct.toFixed(2)}% / 짧은 보유 ${heldHours.toFixed(1)}h 구간이라 관찰 유지`,
  };
}

export function buildExitFallback(openPositions) {
  const decisions = openPositions.map((pos) => {
    const avgPrice = Number(pos.avg_price || 0);
    const currentPrice = Number(pos.current_price || avgPrice || 0);
    const heldHours = Number(pos.held_hours || 0);
    const pnlPct = avgPrice > 0
      ? ((currentPrice - avgPrice) / avgPrice) * 100
      : 0;
    const analyses = Array.isArray(pos.analyses) ? pos.analyses : [];
    const sellLikeCount = analyses.filter(item => {
      const signal = String(item.signal || '').toUpperCase();
      return signal === 'SELL' || signal === 'HOLD';
    }).length;

    if (heldHours >= 72) {
      return {
        symbol: pos.symbol,
        action: ACTIONS.SELL,
        confidence: 0.58,
        reasoning: 'EXIT fallback — 72시간 이상 장기 보유 재평가',
        exit_type: 'normal_exit',
      };
    }
    if (pnlPct <= -5) {
      return {
        symbol: pos.symbol,
        action: ACTIONS.SELL,
        confidence: 0.64,
        reasoning: 'EXIT fallback — 손실 -5% 이하 손절',
        exit_type: 'normal_exit',
      };
    }
    if (pnlPct < 0 && heldHours >= 24 && sellLikeCount >= 2) {
      return {
        symbol: pos.symbol,
        action: ACTIONS.SELL,
        confidence: 0.6,
        reasoning: 'EXIT fallback — 음수 손익 + 약세 분석 우세',
        exit_type: 'normal_exit',
      };
    }
    return {
      symbol: pos.symbol,
      action: ACTIONS.HOLD,
      confidence: 0.5,
      reasoning: 'EXIT fallback — 보수적으로 HOLD 유지',
      exit_type: 'normal_exit',
    };
  });

  return {
    decisions,
    exit_view: 'EXIT fallback — 장기보유/손절 규칙 기반 판단',
  };
}

export async function enrichExitPositions(openPositions, exchange = 'binance') {
  const enrichedPositions = [];
  for (const position of openPositions) {
    const analyses = await db.getRecentAnalysis(position.symbol, 180, exchange).catch(() => []);
    const entryTime = position.entry_time || position.updated_at || null;
    const heldHours = entryTime
      ? Math.max(0, (Date.now() - new Date(entryTime).getTime()) / 3600000)
      : 0;
    const avgPrice = Number(position.avg_price || 0);
    const amount = Number(position.amount || 0);
    const unrealizedPnl = Number(position.unrealized_pnl || 0);
    const derivedCurrentPrice = avgPrice > 0 && amount > 0
      ? avgPrice + (unrealizedPnl / amount)
      : avgPrice;
    enrichedPositions.push({
      ...position,
      analyses,
      held_hours: heldHours,
      current_price: position.current_price || derivedCurrentPrice || avgPrice || 0,
    });
  }
  return enrichedPositions;
}

export function normalizeExitDecisionResult(parsed, enrichedPositions) {
  if (!parsed || !Array.isArray(parsed.decisions)) {
    return buildExitFallback(enrichedPositions);
  }

  const bySymbol = new Map(enrichedPositions.map(pos => [pos.symbol, pos]));
  const decisions = parsed.decisions
    .map(item => {
      const position = bySymbol.get(item?.symbol);
      return applyExitGuard(position, normalizeExitDecision(item, position));
    })
    .filter(item => item.symbol && bySymbol.has(item.symbol));

  for (const position of enrichedPositions) {
    if (!decisions.some(dec => dec.symbol === position.symbol)) {
      decisions.push({
        symbol: position.symbol,
        action: ACTIONS.HOLD,
        confidence: 0.5,
        reasoning: 'LLM 응답 누락 — 기본 HOLD',
        exit_type: 'normal_exit',
      });
    }
  }

  return {
    decisions,
    exit_view: parsed.exit_view || 'EXIT 판단 요약 없음',
  };
}

export default {
  buildCompactExitAnalystSummary,
  buildExitPrompt,
  normalizeExitDecision,
  getExitGuardConfig,
  getPositionPnlPct,
  countExitVotes,
  shouldDowngradeEarlyExit,
  applyExitGuard,
  buildExitFallback,
  enrichExitPositions,
  normalizeExitDecisionResult,
};
