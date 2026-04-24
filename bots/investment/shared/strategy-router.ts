// @ts-nocheck

import { ACTIONS, ANALYST_TYPES } from './signal.ts';
import * as journalDb from './trade-journal-db.ts';
import { buildEvidenceSummaryForAgent } from './external-evidence-ledger.ts';

const CRYPTO_FAMILIES = [
  'trend_following',
  'momentum_rotation',
  'breakout',
  'mean_reversion',
  'defensive_rotation',
];

const STOCK_FAMILIES = [
  'equity_swing',
  'breakout',
  'mean_reversion',
  'defensive_rotation',
];

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function add(scores, key, value, reason, reasons) {
  if (scores[key] == null) scores[key] = 0;
  scores[key] += Number(value || 0);
  if (reason) reasons.push(`${key}: ${reason}`);
}

function signalOf(analysis = null) {
  return String(analysis?.signal || ACTIONS.HOLD).toUpperCase();
}

function confidenceOf(analysis = null) {
  return clamp(Number(analysis?.confidence ?? 0.5), 0, 1);
}

function textOf(...parts) {
  return parts.map((part) => String(part || '')).join(' ').toLowerCase();
}

function normalizeSetupType(raw = null, exchange = 'binance') {
  const value = String(raw || '').trim().toLowerCase();
  if (value.includes('breakout') || value.includes('돌파')) return 'breakout';
  if (value.includes('mean') || value.includes('reversion') || value.includes('반등') || value.includes('되돌림')) return 'mean_reversion';
  if (value.includes('trend') || value.includes('추세')) return exchange === 'binance' ? 'trend_following' : 'equity_swing';
  if (value.includes('momentum') || value.includes('rotation')) return exchange === 'binance' ? 'momentum_rotation' : 'equity_swing';
  if (value.includes('defensive') || value.includes('보수') || value.includes('방어')) return 'defensive_rotation';
  return null;
}

function buildRegimeBias(regime = null, exchange = 'binance') {
  const value = String(regime?.regime || regime || '').toLowerCase();
  if (value.includes('bull')) {
    return exchange === 'binance'
      ? { trend_following: 0.24, momentum_rotation: 0.18, breakout: 0.14, mean_reversion: -0.04, defensive_rotation: -0.12 }
      : { equity_swing: 0.22, breakout: 0.12, mean_reversion: -0.02, defensive_rotation: -0.10 };
  }
  if (value.includes('bear')) {
    return exchange === 'binance'
      ? { defensive_rotation: 0.30, mean_reversion: 0.10, trend_following: -0.08, momentum_rotation: -0.12, breakout: -0.14 }
      : { defensive_rotation: 0.30, mean_reversion: 0.08, equity_swing: -0.10, breakout: -0.12 };
  }
  if (value.includes('rang')) {
    return exchange === 'binance'
      ? { mean_reversion: 0.24, defensive_rotation: 0.08, breakout: -0.04, trend_following: -0.06 }
      : { mean_reversion: 0.22, defensive_rotation: 0.08, equity_swing: -0.04 };
  }
  if (value.includes('volatil')) {
    return { defensive_rotation: 0.18, breakout: 0.06, mean_reversion: -0.04 };
  }
  return {};
}

function marketFromExchange(exchange = 'binance') {
  if (exchange === 'binance') return 'crypto';
  if (exchange === 'kis') return 'domestic';
  if (exchange === 'kis_overseas') return 'overseas';
  return 'unknown';
}

function applyExternalEvidenceFeatures({
  exchange = 'binance',
  summary = null,
  scores,
  reasons,
}) {
  if (!summary || Number(summary.evidenceCount || 0) <= 0) return;

  const evidenceCount = Math.max(1, Number(summary.evidenceCount || 0));
  const bullish = Number(summary?.signals?.bullish || 0);
  const bearish = Number(summary?.signals?.bearish || 0);
  const netSignal = bullish - bearish;
  const quality = clamp(Number(summary.avgQuality ?? 0), 0, 1);
  const freshness = clamp(Number(summary.avgFreshness ?? 0), 0, 1);
  const conviction = clamp(Math.abs(netSignal) / evidenceCount, 0, 1);
  const weight = Math.max(0.03, 0.18 * quality * (0.6 + freshness * 0.4) * Math.max(0.4, conviction));

  if (netSignal > 0) {
    add(scores, exchange === 'binance' ? 'trend_following' : 'equity_swing', weight, `external evidence bullish (${bullish}/${bearish})`, reasons);
    add(scores, 'breakout', weight * 0.45, 'external evidence momentum confirmation', reasons);
  } else if (netSignal < 0) {
    add(scores, 'defensive_rotation', weight, `external evidence bearish (${bullish}/${bearish})`, reasons);
    add(scores, 'mean_reversion', weight * 0.4, 'external evidence risk-off bias', reasons);
  } else {
    add(scores, 'mean_reversion', weight * 0.35, 'external evidence mixed/neutral', reasons);
  }

  if (summary.warning) {
    add(scores, 'defensive_rotation', 0.04, 'external evidence quality warning', reasons);
  }
}

function applyAnalystFeatures({ analyses = [], exchange = 'binance', scores, reasons }) {
  const byType = new Map();
  for (const item of analyses || []) {
    if (!byType.has(item.analyst)) byType.set(item.analyst, item);
  }

  const ta = byType.get(ANALYST_TYPES.TA_MTF) || byType.get(ANALYST_TYPES.TA);
  const onchain = byType.get(ANALYST_TYPES.ONCHAIN);
  const marketFlow = byType.get(ANALYST_TYPES.MARKET_FLOW);
  const sentinel = byType.get(ANALYST_TYPES.SENTINEL);
  const news = byType.get(ANALYST_TYPES.NEWS);
  const sentiment = byType.get(ANALYST_TYPES.SENTIMENT);

  const taSignal = signalOf(ta);
  const taConf = confidenceOf(ta);
  const taText = textOf(ta?.reasoning, ta?.metadata?.trend, ta?.metadata?.timeframes);
  if (taSignal === ACTIONS.BUY) {
    add(scores, exchange === 'binance' ? 'trend_following' : 'equity_swing', 0.20 * taConf, 'TA BUY가 기본 추세/스윙 후보를 지지', reasons);
    add(scores, 'breakout', taText.includes('break') || taText.includes('돌파') || taText.includes('volume') ? 0.16 * taConf : 0.06 * taConf, 'TA BUY와 돌파/거래량 단서', reasons);
  } else if (taSignal === ACTIONS.SELL) {
    add(scores, 'defensive_rotation', 0.22 * taConf, 'TA SELL로 방어 전략 우선', reasons);
    add(scores, 'mean_reversion', taText.includes('oversold') || taText.includes('과매도') ? 0.14 * taConf : 0.04 * taConf, 'TA 약세 중 반등 후보 확인', reasons);
  } else {
    add(scores, 'mean_reversion', 0.05 * taConf, 'TA 중립은 평균회귀 관찰 후보', reasons);
  }

  const onchainSignal = signalOf(onchain);
  const onchainConf = confidenceOf(onchain);
  if (exchange === 'binance' && onchain) {
    if (onchainSignal === ACTIONS.BUY) {
      add(scores, 'momentum_rotation', 0.18 * onchainConf, '온체인/파생 flow BUY', reasons);
      add(scores, 'trend_following', 0.08 * onchainConf, '온체인 추세 지지', reasons);
    } else if (onchainSignal === ACTIONS.SELL) {
      add(scores, 'defensive_rotation', 0.18 * onchainConf, '온체인/파생 flow SELL', reasons);
    }
  }

  const flowSignal = signalOf(marketFlow);
  const flowConf = confidenceOf(marketFlow);
  if ((exchange === 'kis' || exchange === 'kis_overseas') && marketFlow) {
    if (flowSignal === ACTIONS.BUY) {
      add(scores, 'equity_swing', 0.16 * flowConf, 'market_flow BUY로 스윙 후보 강화', reasons);
      add(scores, 'breakout', 0.10 * flowConf, 'flow/event 상승 단서', reasons);
    } else if (flowSignal === ACTIONS.SELL) {
      add(scores, 'defensive_rotation', 0.16 * flowConf, 'market_flow 약화', reasons);
    }
  }

  for (const item of [sentinel, news, sentiment].filter(Boolean)) {
    const sig = signalOf(item);
    const conf = confidenceOf(item);
    const quality = String(item?.metadata?.quality?.status || '').toLowerCase();
    const qualityMul = quality === 'insufficient' ? 0.45 : quality === 'degraded' ? 0.75 : 1;
    if (sig === ACTIONS.BUY) {
      add(scores, 'breakout', 0.07 * conf * qualityMul, '뉴스/감성 BUY는 촉매형 전략 보강', reasons);
      add(scores, exchange === 'binance' ? 'momentum_rotation' : 'equity_swing', 0.05 * conf * qualityMul, '뉴스/감성 우호', reasons);
    } else if (sig === ACTIONS.SELL) {
      add(scores, 'defensive_rotation', 0.08 * conf * qualityMul, '뉴스/감성 약화', reasons);
    }
  }
}

async function buildFeedbackBias(symbol, exchange) {
  const notes = [];
  const bias = {};
  try {
    const insight = await journalDb.getTradeReviewInsight(symbol, exchange, 90);
    if (!insight || Number(insight.closedTrades || 0) < 3) {
      return { bias, notes };
    }
    const winRate = Number(insight.winRate);
    const avgPnl = Number(insight.avgPnlPercent);
    if (Number.isFinite(winRate) && winRate >= 0.62) {
      bias[exchange === 'binance' ? 'momentum_rotation' : 'equity_swing'] = 0.08;
      notes.push(`symbol feedback winRate ${(winRate * 100).toFixed(0)}%`);
    } else if (Number.isFinite(winRate) && winRate < 0.38) {
      bias.defensive_rotation = 0.10;
      notes.push(`symbol feedback weak winRate ${(winRate * 100).toFixed(0)}%`);
    }
    if (Number.isFinite(avgPnl) && avgPnl < 0) {
      bias.defensive_rotation = (bias.defensive_rotation || 0) + 0.06;
      notes.push(`symbol feedback avgPnl ${avgPnl.toFixed(2)}%`);
    }
  } catch {
    // feedback is optional.
  }
  return { bias, notes };
}

async function buildStrategyFamilyPerformanceBias(exchange) {
  const notes = [];
  const bias = {};
  try {
    const insight = await journalDb.getStrategyFamilyPerformanceInsight(exchange, 90);
    for (const item of insight?.families || []) {
      const family = String(item.strategyFamily || '').trim();
      if (!family) continue;
      const closed = Number(item.closed || 0);
      if (closed < 5) continue;
      const winRate = Number(item.winRate);
      const avgPnl = Number(item.avgPnlPercent);
      if (Number.isFinite(avgPnl) && avgPnl < -2) {
        bias[family] = (bias[family] || 0) - 0.14;
        notes.push(`${family} weak avgPnl ${avgPnl.toFixed(2)}%`);
      } else if (Number.isFinite(winRate) && winRate < 0.34) {
        bias[family] = (bias[family] || 0) - 0.08;
        notes.push(`${family} weak winRate ${(winRate * 100).toFixed(0)}%`);
      } else if (Number.isFinite(avgPnl) && avgPnl > 1 && Number.isFinite(winRate) && winRate >= 0.42) {
        bias[family] = (bias[family] || 0) + 0.08;
        notes.push(`${family} strong avgPnl ${avgPnl.toFixed(2)}%`);
      }
    }
  } catch {
    // Family-level feedback is optional and should not block route selection.
  }
  return { bias, notes };
}

export async function buildStrategyRoute({
  symbol,
  exchange = 'binance',
  analyses = [],
  fused = null,
  marketRegime = null,
  argosStrategy = null,
  decision = null,
} = {}) {
  const families = exchange === 'binance' ? CRYPTO_FAMILIES : STOCK_FAMILIES;
  const scores = Object.fromEntries(families.map((family) => [family, 0]));
  const reasons = [];

  for (const [family, value] of Object.entries(buildRegimeBias(marketRegime, exchange))) {
    if (scores[family] != null) add(scores, family, value, `regime ${marketRegime?.regime || 'unknown'} bias`, reasons);
  }

  applyAnalystFeatures({ analyses, exchange, scores, reasons });

  const externalEvidenceSummary = await buildEvidenceSummaryForAgent({
    symbol,
    market: marketFromExchange(exchange),
    days: 3,
  }).catch(() => null);
  applyExternalEvidenceFeatures({
    exchange,
    summary: externalEvidenceSummary,
    scores,
    reasons,
  });

  const argosSetup = normalizeSetupType(argosStrategy?.setup_type || argosStrategy?.strategy_name || argosStrategy?.summary, exchange);
  if (argosSetup && scores[argosSetup] != null) {
    add(scores, argosSetup, 0.16 * clamp(argosStrategy?.quality_score ?? 0.6), 'Argos strategy recommendation', reasons);
  }

  const decisionText = textOf(decision?.reasoning);
  const decisionSetup = normalizeSetupType(decisionText, exchange);
  if (decisionSetup && scores[decisionSetup] != null) {
    add(scores, decisionSetup, 0.08 * clamp(decision?.confidence ?? 0.5), 'decision reasoning setup hint', reasons);
  }

  if (fused) {
    if (fused.recommendation === 'LONG') {
      add(scores, exchange === 'binance' ? 'trend_following' : 'equity_swing', 0.08 * clamp(fused.averageConfidence ?? 0.5), 'fused LONG', reasons);
    } else if (fused.recommendation === 'SHORT') {
      add(scores, 'defensive_rotation', 0.10 * clamp(fused.averageConfidence ?? 0.5), 'fused SHORT', reasons);
    }
    if (fused.hasConflict) {
      add(scores, 'defensive_rotation', 0.06, 'analyst conflict', reasons);
      add(scores, 'mean_reversion', 0.04, 'analyst conflict mean-reversion watch', reasons);
    }
  }

  const feedback = await buildFeedbackBias(symbol, exchange);
  for (const [family, value] of Object.entries(feedback.bias)) {
    if (scores[family] != null) add(scores, family, value, 'feedback loop bias', reasons);
  }

  const familyFeedback = await buildStrategyFamilyPerformanceBias(exchange);
  for (const [family, value] of Object.entries(familyFeedback.bias)) {
    if (scores[family] != null) add(scores, family, value, 'strategy family performance bias', reasons);
  }

  const ranked = Object.entries(scores)
    .map(([family, score]) => ({ family, score: Number(score.toFixed(4)) }))
    .sort((a, b) => b.score - a.score);
  const selected = ranked[0] || { family: exchange === 'binance' ? 'momentum_rotation' : 'equity_swing', score: 0 };
  const runnerUp = ranked[1] || null;
  const margin = runnerUp ? selected.score - runnerUp.score : selected.score;
  const readinessScore = clamp(0.45 + selected.score + Math.max(0, margin) * 0.35, 0, 1);
  const quality =
    readinessScore >= 0.72 && margin >= 0.05 ? 'ready'
      : readinessScore >= 0.56 ? 'watch'
        : 'thin';

  return {
    symbol,
    exchange,
    selectedFamily: selected.family,
    setupType: selected.family,
    quality,
    readinessScore: Number(readinessScore.toFixed(4)),
    topScore: selected.score,
    margin: Number(margin.toFixed(4)),
    scores: Object.fromEntries(ranked.map((row) => [row.family, row.score])),
    ranking: ranked,
    regime: marketRegime?.regime || null,
    argosStrategy: argosStrategy ? {
      strategyName: argosStrategy.strategy_name || null,
      setupType: argosStrategy.setup_type || null,
      qualityScore: argosStrategy.quality_score ?? null,
      source: argosStrategy.source || null,
    } : null,
    externalEvidence: externalEvidenceSummary ? {
      evidenceCount: Number(externalEvidenceSummary.evidenceCount || 0),
      avgQuality: Number(externalEvidenceSummary.avgQuality || 0),
      avgFreshness: Number(externalEvidenceSummary.avgFreshness || 0),
      signals: externalEvidenceSummary.signals || { bullish: 0, bearish: 0, neutral: 0 },
      warning: externalEvidenceSummary.warning || null,
    } : null,
    feedbackNotes: [...feedback.notes, ...familyFeedback.notes].slice(0, 6),
    reasons: reasons.slice(0, 8),
  };
}

export function buildStrategyRouteSection(route = null) {
  if (!route) return '';
  const top = (route.ranking || [])
    .slice(0, 3)
    .map((row) => `${row.family}:${row.score}`)
    .join(', ');
  const feedback = Array.isArray(route.feedbackNotes) && route.feedbackNotes.length > 0
    ? `\n- feedback: ${route.feedbackNotes.join(' / ')}`
    : '';
  const reasons = Array.isArray(route.reasons) && route.reasons.length > 0
    ? `\n- reasons: ${route.reasons.slice(0, 4).join(' | ')}`
    : '';
  return `\n\n[전략 라우터]\n- selected=${route.selectedFamily} | quality=${route.quality} | readiness=${route.readinessScore}\n- ranking=${top}${feedback}${reasons}`;
}

export function buildRoutedStrategyFallback({ route = null, exchange = 'binance', decision = null, seedSignal = null } = {}) {
  const setupType = route?.selectedFamily || (exchange === 'binance' ? 'momentum_rotation' : 'equity_swing');
  const reason = route?.reasons?.[0] || decision?.reasoning || seedSignal?.reasoning || 'strategy router fallback';
  return {
    source: 'strategy_router',
    strategy_name: `Routed ${setupType}`,
    quality_score: Math.max(0.35, Number(route?.readinessScore ?? decision?.confidence ?? seedSignal?.confidence ?? 0.45)),
    summary: `strategy router selected ${setupType}`,
    entry_condition: reason,
    exit_condition: 'strategy_break_or_risk_exit',
    risk_management: route?.quality === 'ready' ? 'strategy_router_standard_guard' : 'strategy_router_watchful_guard',
    applicable_timeframe: exchange === 'binance' ? '4h' : '1d',
    setup_type: setupType,
  };
}

export function applyStrategyRouteDecisionBias(decision = null, route = null, exchange = 'binance') {
  if (!decision || !route) return decision;
  const adjusted = { ...decision };
  const action = String(adjusted.action || '').toUpperCase();
  const isEntry = action === ACTIONS.BUY;
  const isExit = action === ACTIONS.SELL;
  const quality = String(route.quality || '').toLowerCase();
  const family = String(route.selectedFamily || '').toLowerCase();

  if (Number.isFinite(Number(adjusted.confidence))) {
    let confidence = Number(adjusted.confidence);
    if (quality === 'ready') confidence += 0.03;
    else if (quality === 'thin') confidence -= 0.06;
    if (isEntry && family === 'defensive_rotation') confidence -= 0.03;
    if (isExit && family === 'defensive_rotation') confidence += 0.03;
    adjusted.confidence = clamp(confidence, 0, 1);
  }

  if (isEntry && Number.isFinite(Number(adjusted.amount_usdt))) {
    let amount = Number(adjusted.amount_usdt);
    if (quality === 'ready') amount *= 1.1;
    else if (quality === 'thin') amount *= 0.72;
    else if (quality === 'watch') amount *= 0.9;
    if (family === 'defensive_rotation') amount *= 0.82;
    if ((exchange === 'kis' || exchange === 'kis_overseas') && amount > 0) {
      amount = Math.round(amount / 1000) * 1000;
    }
    adjusted.amount_usdt = Math.max(0, Number(amount.toFixed(2)));
  }

  const routeNote = `전략품질:${quality || 'unknown'}/${family || 'unknown'}`;
  adjusted.reasoning = String(adjusted.reasoning || routeNote).includes(routeNote)
    ? String(adjusted.reasoning || routeNote).slice(0, 180)
    : `${String(adjusted.reasoning || '').trim()} | ${routeNote}`.slice(0, 180);

  return adjusted;
}
