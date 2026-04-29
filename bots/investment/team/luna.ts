// @ts-nocheck
/**
 * team/luna.ts — 루나 (오케스트레이터·최종 판단)
 *
 * 역할: 모든 분석가 결과 수집 → 강세/약세 토론 → 최종 투자 판단
 * LLM: Claude Haiku (LIVE) / Groq Scout (PAPER) — PAPER_MODE 분기
 *
 * 흐름:
 *   1. 분석가 결과 조회 (aria + oracle + hermes + sophia)
 *   2. 제우스(강세) + 아테나(약세) 리서처 병렬 토론
 *   3. 최종 판단 (포트폴리오 맥락)
 *   4. 네메시스 리스크 평가
 *   5. 신호 DB 저장 + 텔레그램
 *
 * 실행: node team/luna.ts --symbols=BTC/USDT,ETH/USDT
 */

import { createRequire }  from 'module';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const _require = createRequire(import.meta.url);
const shadow   = _require('../../../packages/core/lib/shadow-mode.js');
import { callLLM, cachedCallLLM, parseJSON } from '../shared/llm-client.ts';
import { callLLMWithHub } from '../shared/hub-llm-client.ts';
import { search as searchRag, store as storeRag } from '../shared/rag-client.ts';
import { ACTIONS, ANALYST_TYPES, SIGNAL_STATUS, validateSignal } from '../shared/signal.ts';
import { notifySignal, notifyError } from '../shared/report.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { isPaperMode, isValidationTradeMode } from '../shared/secrets.ts';
import { getAvailableBalance, getAvailableUSDT, getOpenPositions, getCapitalConfigWithOverrides, getLunaBuyingPowerSnapshot, adjustLunaBuyCandidate } from '../shared/capital-manager.ts';
import type { LunaBuyingPowerSnapshot } from '../shared/capital-manager.ts';
import { getDomesticBalance } from '../shared/kis-client.ts';
import { getInvestmentRagRuntimeConfig, getLunaDiscoveryThrottleConfig, getLunaRuntimeConfig, getLunaStockStrategyProfile } from '../shared/runtime-config.ts';
import { getOHLCV } from '../shared/ohlcv-fetcher.ts';
import { getLunaIntelligentDiscoveryFlags } from '../shared/luna-intelligent-discovery-config.ts';
import { ensureLunaDiscoveryEntryTables } from '../shared/luna-discovery-entry-store.ts';
import { scoreCommunitySentiment } from '../shared/community-sentiment.ts';
import { detectWyckoffPhase } from '../shared/wyckoff-phase-detector.ts';
import { classifyVsaBar } from '../shared/vsa-bar-classifier.ts';
import { analyzeMultiTimeframe } from '../shared/multi-timeframe-analyzer.ts';
import { fuseDiscoveryScore } from '../shared/discovery-score-fusion.ts';
import { evaluateEntryTriggers } from '../shared/entry-trigger-engine.ts';
import { applyPredictiveValidationGate } from '../shared/predictive-validation-gate.ts';
import { recordDiscoveryAttribution, buildDiscoveryReflectionSummary, shouldPublishDiscoveryReflectionReport } from '../shared/discovery-reflection.ts';
import { buildDiscoveryUniverse, toDiscoveryMarket } from './discovery/discovery-universe.ts';
import { runNewsToSymbolMapping } from './discovery/news-to-symbol-mapper.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { buildAccuracyReport, normalizeWeights } from '../shared/analyst-accuracy.ts';
import { getMarketRegime, formatMarketRegime } from '../shared/market-regime.ts';
import {
  ANALYST_WEIGHTS as POLICY_ANALYST_WEIGHTS,
  buildAnalystWeights as buildAnalystWeightsPolicy,
  getMinConfidence as getMinConfidencePolicy,
  getDebateLimit as getDebateLimitPolicy,
  shouldDebateForSymbol as shouldDebateForSymbolPolicy,
  fuseSignals as fuseSignalsPolicy,
} from '../shared/luna-decision-policy.ts';
import { runBullResearcher } from './zeus.ts';
import { runBearResearcher } from './athena.ts';
import { evaluateSignal } from './nemesis.ts';
import { recommendStrategy } from './argos.ts';
import { applyStrategyRouteDecisionBias, buildStrategyRoute, buildStrategyRouteSection } from '../shared/strategy-router.ts';
import { buildSignalApprovalUpdate } from '../shared/signal-approval.ts';
import { publishAgentHint } from '../shared/agent-hint-bridge.ts';
import { checkReflexionBeforeEntry } from '../shared/reflexion-guard.ts';
import {
  getStockOrderSpec,
  formatStockAmountRule,
  normalizeDecisionAmount,
  formatLunaDecisionAmount,
  mapCapitalCheckResultToReasonCode,
  enrichCapitalCheck,
  buildCryptoPortfolioFallback,
  buildEmergencyPortfolioFallback,
  buildVoteFallbackDecision,
  buildEmergencySymbolFallbackDecision,
} from '../shared/luna-fallback-policy.ts';
import {
  LUNA_EXIT_SYSTEM,
  getLunaSystem as getLunaSystemPrompt,
  buildPortfolioPrompt as buildLunaPortfolioPrompt,
} from '../shared/luna-prompt-policy.ts';
import { buildPortfolioDecisionPromptParts as buildPortfolioDecisionPromptPartsBase } from '../shared/luna-portfolio-prompt-parts.ts';
import {
  buildExitFallback,
  buildExitPrompt,
  enrichExitPositions,
  normalizeExitDecisionResult,
} from '../shared/luna-exit-policy.ts';

const LUNA_RUNTIME = getLunaRuntimeConfig();
const LUNA_STOCK_PROFILE = getLunaStockStrategyProfile();
const RAG_RUNTIME = getInvestmentRagRuntimeConfig();
const MAX_POS_COUNT = LUNA_RUNTIME.maxPosCount;
const MAX_DEBATE_SYMBOLS = LUNA_RUNTIME.maxDebateSymbols;

function normalizeResponsibilityPlan(strategyProfile = null) {
  return strategyProfile?.strategy_context?.responsibilityPlan
    || strategyProfile?.strategyContext?.responsibilityPlan
    || strategyProfile?.responsibilityPlan
    || null;
}

function normalizeExecutionPlan(strategyProfile = null) {
  return strategyProfile?.strategy_context?.executionPlan
    || strategyProfile?.strategyContext?.executionPlan
    || strategyProfile?.executionPlan
    || null;
}

function applyExistingPositionStrategyBias(signalData, existingStrategyProfile = null) {
  if (!existingStrategyProfile || signalData?.action !== ACTIONS.BUY) {
    return {
      signalData,
      applied: false,
      note: null,
      existingStrategyProfile,
    };
  }

  const responsibilityPlan = normalizeResponsibilityPlan(existingStrategyProfile) || {};
  const executionPlan = normalizeExecutionPlan(existingStrategyProfile) || {};
  const ownerMode = String(responsibilityPlan?.ownerMode || '').trim().toLowerCase();
  const setupType = String(existingStrategyProfile?.setup_type || '').trim() || 'unknown';
  const lifecycleStatus = String(existingStrategyProfile?.strategy_state?.lifecycleStatus || '').trim() || 'holding';
  const originalAmount = Number(signalData.amountUsdt || 0);
  const originalConfidence = Number(signalData.confidence || 0);
  let adjustedAmount = originalAmount;
  let adjustedConfidence = originalConfidence;
  let note = null;

  if (ownerMode === 'capital_preservation') {
    adjustedAmount = Math.max(0, Math.floor(originalAmount * 0.88));
    adjustedConfidence = Math.max(0, Math.min(1, originalConfidence * 0.97));
    note = `기존 전략 ${setupType}/${lifecycleStatus}가 capital_preservation이라 추가진입 크기를 더 보수적으로 조절`;
  } else if (ownerMode === 'balanced_rotation') {
    adjustedAmount = Math.max(0, Math.floor(originalAmount * 0.95));
    adjustedConfidence = Math.max(0, Math.min(1, originalConfidence * 0.99));
    note = `기존 전략 ${setupType}/${lifecycleStatus}가 balanced_rotation이라 추가진입을 소폭 완화`;
  } else if (ownerMode === 'equity_rotation') {
    adjustedAmount = Math.max(0, Math.floor(originalAmount * 0.96));
    note = `기존 전략 ${setupType}/${lifecycleStatus}가 equity_rotation이라 추가진입 크기를 소폭 완화`;
  } else if (ownerMode === 'opportunity_capture' && originalConfidence >= 0.74) {
    adjustedAmount = Math.max(0, Math.floor(originalAmount * 1.08));
    adjustedConfidence = Math.max(0, Math.min(1, originalConfidence * 1.01));
    note = `기존 전략 ${setupType}/${lifecycleStatus}가 opportunity_capture라 강한 추가진입 후보로 간주`;
  }

  const nextSignalData = {
    ...signalData,
    amountUsdt: adjustedAmount || signalData.amountUsdt,
    confidence: adjustedConfidence || signalData.confidence,
    existingStrategyProfileId: existingStrategyProfile?.id || null,
    existingStrategyState: existingStrategyProfile?.strategy_state || null,
    existingResponsibilityPlan: responsibilityPlan,
    existingExecutionPlan: executionPlan,
  };
  if (note) {
    nextSignalData.reasoning = `${signalData.reasoning} | ${note}`.slice(0, 500);
  }

  return {
    signalData: nextSignalData,
    applied: adjustedAmount !== originalAmount || adjustedConfidence !== originalConfidence,
    note,
    existingStrategyProfile,
  };
}

export function buildLunaRiskEvaluationSignal(signalData = {}) {
  return {
    ...signalData,
    amount_usdt: signalData.amount_usdt ?? signalData.amountUsdt ?? null,
    trade_mode: signalData.trade_mode ?? signalData.tradeMode ?? null,
  };
}

export function buildLunaSignalPersistencePlan(signalData = {}, riskResult = null, riskError = null, context = {}) {
  const symbol = context.symbol || signalData.symbol || null;
  const action = context.action || signalData.action || null;
  const exchange = context.exchange || signalData.exchange || null;
  const decision = context.decision || {};

  if (riskError) {
    return {
      status: SIGNAL_STATUS.FAILED,
      signalData: { ...signalData },
      approvalUpdate: null,
      blockUpdate: {
        status: SIGNAL_STATUS.FAILED,
        reason: `nemesis_error:${String(riskError.message || 'unknown').slice(0, 180)}`,
        code: 'nemesis_error',
        meta: {
          exchange,
          symbol,
          action,
          amount: decision.amount_usdt ?? signalData.amountUsdt ?? null,
          confidence: decision.confidence ?? signalData.confidence ?? null,
        },
      },
      outcome: 'failed',
    };
  }

  if (riskResult?.approved) {
    const approvalUpdate = buildSignalApprovalUpdate({
      ...riskResult,
      status: SIGNAL_STATUS.APPROVED,
    });
    return {
      status: SIGNAL_STATUS.APPROVED,
      signalData: {
        ...signalData,
        amountUsdt: riskResult.adjustedAmount ?? signalData.amountUsdt,
        nemesisVerdict: approvalUpdate.nemesisVerdict,
        approvedAt: approvalUpdate.approvedAt,
      },
      approvalUpdate,
      blockUpdate: null,
      outcome: 'approved',
    };
  }

  return {
    status: SIGNAL_STATUS.REJECTED,
    signalData: { ...signalData },
    approvalUpdate: null,
    blockUpdate: {
      status: SIGNAL_STATUS.REJECTED,
      reason: riskResult?.reason || 'risk_rejected',
      code: 'risk_rejected',
      meta: {
        exchange,
        symbol,
        action,
        amount: decision.amount_usdt ?? signalData.amountUsdt ?? null,
        adjustedAmount: riskResult?.adjustedAmount ?? null,
      },
    },
    outcome: 'rejected',
  };
}

/**
 * @typedef {Object} TradeSignal
 * @property {string} symbol
 * @property {string} action
 * @property {number} amount_usdt
 * @property {number} confidence
 * @property {string} reasoning
 * @property {number} [adjustedAmount]
 * @property {number|null} [tpPrice]
 * @property {number|null} [slPrice]
 * @property {string|null} [tpslSource]
 * @property {number|string} [signalId]
 */

export function buildAnalystWeights(exchange = 'binance', options = {}) {
  return buildAnalystWeightsPolicy(exchange, options);
}

export function getMinConfidence(exchange) {
  return getMinConfidencePolicy(exchange);
}

export function getDebateLimit(exchange, symbolCount = 0) {
  return getDebateLimitPolicy(exchange, symbolCount);
}

async function applyCryptoRepresentativePass(portfolioDecision, exchange) {
  if (exchange !== 'binance') {
    return { decision: portfolioDecision, reduction: null };
  }
  if (isPaperMode() || isValidationTradeMode()) {
    return { decision: portfolioDecision, reduction: null };
  }

  const decisions = Array.isArray(portfolioDecision?.decisions) ? [...portfolioDecision.decisions] : [];
  const buyDecisions = decisions.filter((item) => item?.action === ACTIONS.BUY);
  if (buyDecisions.length <= 1) {
    return { decision: portfolioDecision, reduction: null };
  }

  const [openPositions, capitalPolicy] = await Promise.all([
    getOpenPositions(exchange, false, 'normal').catch(() => []),
    getCapitalConfigWithOverrides(exchange, 'normal').catch(() => ({})),
  ]);

  const maxSameDirection = Number(capitalPolicy?.max_same_direction_positions || 3);
  const currentLongCount = Array.isArray(openPositions) ? openPositions.length : 0;
  const remainingLongSlots = Math.max(0, maxSameDirection - currentLongCount);

  if (buyDecisions.length <= remainingLongSlots) {
    return { decision: portfolioDecision, reduction: null };
  }

  const sortedBuys = [...buyDecisions].sort((a, b) => {
    const confidenceGap = Number(b?.confidence || 0) - Number(a?.confidence || 0);
    if (confidenceGap !== 0) return confidenceGap;
    const amountGap = Number(b?.amount_usdt || 0) - Number(a?.amount_usdt || 0);
    if (amountGap !== 0) return amountGap;
    return String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
  });

  const keepBuySet = new Set(sortedBuys.slice(0, remainingLongSlots).map((item) => item.symbol));
  const kept = [];
  const dropped = [];
  const nextDecisions = decisions.filter((item) => {
    if (item?.action !== ACTIONS.BUY) return true;
    if (keepBuySet.has(item.symbol)) {
      kept.push(item.symbol);
      keepBuySet.delete(item.symbol);
      return true;
    }
    dropped.push(item.symbol);
    return false;
  });

  return {
    decision: {
      ...portfolioDecision,
      decisions: nextDecisions,
    },
    reduction: {
      currentLongCount,
      maxSameDirection,
      remainingLongSlots,
      requestedBuyCount: buyDecisions.length,
      kept,
      dropped,
    },
  };
}

export function shouldDebateForSymbol(analyses, exchange, analystWeights = ANALYST_WEIGHTS) {
  return shouldDebateForSymbolPolicy(analyses, exchange, analystWeights);
}

function buildFastPathDecision(fused, exchange) {
  const isStock = exchange === 'kis' || exchange === 'kis_overseas';
  const isCrypto = exchange === 'binance';
  if (fused.hasConflict) return null;
  if (isStock && !isPaperMode()) return null;
  if (!isStock && !isCrypto) return null;
  if (
    fused.averageConfidence < LUNA_RUNTIME.fastPathThresholds.minAverageConfidence ||
    Math.abs(fused.fusedScore) < LUNA_RUNTIME.fastPathThresholds.minAbsScore
  ) return null;
  const spec = getStockOrderSpec(exchange);

  if (fused.recommendation === 'LONG') {
    return {
      action: ACTIONS.BUY,
      amount_usdt: spec
        ? (fused.averageConfidence >= 0.68 ? spec.max : spec.buyDefault)
        : (fused.averageConfidence >= 0.62 ? 180 : 120),
      confidence: Math.max(
        isStock ? LUNA_STOCK_PROFILE.fastPathMinConfidence : LUNA_RUNTIME.fastPathThresholds.minCryptoConfidence,
        Math.min(isStock ? 0.80 : 0.74, fused.averageConfidence),
      ),
      reasoning: '분석가 합의 기반 fast-path 진입',
    };
  }
  if (fused.recommendation === 'SHORT') {
    return {
      action: ACTIONS.SELL,
      amount_usdt: spec?.sellDefault ?? 100,
      confidence: Math.max(
        isStock ? LUNA_STOCK_PROFILE.fastPathMinConfidence : LUNA_RUNTIME.fastPathThresholds.minCryptoConfidence,
        Math.min(isStock ? 0.75 : 0.70, fused.averageConfidence),
      ),
      reasoning: '분석가 합의 기반 fast-path 청산',
    };
  }
  return null;
}

function getLunaSystem(exchange) {
  return getLunaSystemPrompt(exchange, {
    stockProfile: LUNA_STOCK_PROFILE,
    getMinConfidence,
    getStockOrderSpec,
  });
}

function buildPortfolioPrompt(symbols, exchange = 'binance', exitSummary = null) {
  return buildLunaPortfolioPrompt(symbols, exchange, exitSummary, {
    stockProfile: LUNA_STOCK_PROFILE,
    getMinConfidence,
    getStockOrderSpec,
    formatStockAmountRule,
    maxPosCount: MAX_POS_COUNT,
  });
}

// ─── 시그널 융합 ─────────────────────────────────────────────────────

const ANALYST_WEIGHTS = POLICY_ANALYST_WEIGHTS;

/**
 * 분석가별 신호를 가중 평균으로 융합
 * @param {Array} analyses  DB에서 읽은 분석 결과 배열
 * @returns {{ fusedScore, averageConfidence, hasConflict, recommendation }}
 */
export function fuseSignals(analyses, weights = ANALYST_WEIGHTS) {
  return fuseSignalsPolicy(analyses, weights);
}

function mapSuggestedWeightsToAnalystTypes(suggestedWeights = {}, fallbackWeights = ANALYST_WEIGHTS) {
  const sentinelWeight = suggestedWeights.sentinel
    ?? (((suggestedWeights.sophia ?? fallbackWeights[ANALYST_TYPES.SENTIMENT]) + (suggestedWeights.hermes ?? fallbackWeights[ANALYST_TYPES.NEWS])) / 2);
  return normalizeWeights({
    [ANALYST_TYPES.TA_MTF]: suggestedWeights.aria ?? fallbackWeights[ANALYST_TYPES.TA_MTF],
    [ANALYST_TYPES.ONCHAIN]: suggestedWeights.oracle ?? fallbackWeights[ANALYST_TYPES.ONCHAIN],
    [ANALYST_TYPES.SENTINEL]: sentinelWeight,
    [ANALYST_TYPES.SENTIMENT]: suggestedWeights.sophia ?? fallbackWeights[ANALYST_TYPES.SENTIMENT],
    [ANALYST_TYPES.NEWS]: suggestedWeights.hermes ?? fallbackWeights[ANALYST_TYPES.NEWS],
  });
}

async function loadAdaptiveAnalystWeights(exchange = 'binance', marketRegime = null) {
  const baseWeights = buildAnalystWeights(exchange, { marketRegime });
  try {
    const report = await buildAccuracyReport({
      aria: baseWeights[ANALYST_TYPES.TA_MTF],
      sentinel: baseWeights[ANALYST_TYPES.SENTINEL],
      sophia: baseWeights[ANALYST_TYPES.SENTIMENT],
      oracle: baseWeights[ANALYST_TYPES.ONCHAIN],
      hermes: baseWeights[ANALYST_TYPES.NEWS],
    });
    return {
      weights: mapSuggestedWeightsToAnalystTypes(report.suggestedWeights, baseWeights),
      report,
    };
  } catch (err) {
    console.warn('[luna] adaptive analyst weights 실패 (기본값 사용):', err.message);
    return { weights: { ...baseWeights }, report: null };
  }
}

async function loadReviewConfidenceHint(symbol, exchange) {
  try {
    const insight = await journalDb.getTradeReviewInsight(symbol, exchange, 60);
    if (!insight || insight.closedTrades < 3) return { insight, delta: 0, notes: [] };

    let delta = 0;
    const notes = [];
    if (insight.winRate != null && insight.winRate >= 0.65) {
      delta += 0.05;
      notes.push(`최근 승률 ${(insight.winRate * 100).toFixed(0)}%`);
    } else if (insight.winRate != null && insight.winRate < 0.4) {
      delta -= 0.08;
      notes.push(`최근 승률 ${(insight.winRate * 100).toFixed(0)}%`);
    }
    if (insight.avgPnlPercent != null && insight.avgPnlPercent < 0) {
      delta -= 0.05;
      notes.push(`평균 실현손익 ${insight.avgPnlPercent.toFixed(2)}%`);
    }
    return { insight, delta, notes };
  } catch (err) {
    console.warn('[luna] review confidence hint 실패 (무시):', err.message);
    return { insight: null, delta: 0, notes: [] };
  }
}

// ─── 분석 요약 빌더 ─────────────────────────────────────────────────

export function buildAnalysisSummary(analyses) {
  if (!analyses || analyses.length === 0) return '분석 데이터 없음';
  return analyses.map(a => {
    const label = a.analyst === ANALYST_TYPES.TA_MTF    ? 'TA(MTF)'
                : a.analyst === ANALYST_TYPES.ONCHAIN   ? '온체인'
                : a.analyst === ANALYST_TYPES.SENTINEL  ? 'sentinel'
                : a.analyst === ANALYST_TYPES.NEWS      ? '뉴스'
                : a.analyst === ANALYST_TYPES.SENTIMENT ? '감성'
                : a.analyst === ANALYST_TYPES.X_SEARCH  ? 'X감성'
                : 'TA';
    return `[${label}] ${a.signal} | ${((a.confidence || 0) * 100).toFixed(0)}% | ${a.reasoning || ''}`;
  }).join('\n');
}

function getExchangeLabel(exchange) {
  return exchange === 'kis_overseas' ? '미국주식' : exchange === 'kis' ? '국내주식' : '암호화폐';
}

function buildFusedSection(fused) {
  return `\n\n[시그널 융합] 방향=${fused.recommendation} | 점수=${fused.fusedScore.toFixed(3)} | 평균확신도=${(fused.averageConfidence * 100).toFixed(0)}%${fused.hasConflict ? ' | ⚠️ 신호 충돌' : ''}`;
}

function buildReviewSection(reviewHint) {
  return reviewHint.notes.length > 0
    ? `\n[리뷰 힌트] ${reviewHint.notes.join(' / ')}`
    : '';
}

function buildDebateSection(debate) {
  if (!debate) return '';
  const bullText = debate.bull
    ? `목표가 ${debate.bull.targetPrice} | 상승 ${debate.bull.upsidePct}% | ${debate.bull.reasoning}`
    : '데이터 없음';
  const bearText = debate.bear
    ? `목표가 ${debate.bear.targetPrice} | 하락 ${debate.bear.downsidePct}% | ${debate.bear.reasoning}`
    : '데이터 없음';
  return `\n\n[강세 리서처] ${bullText}\n[약세 리서처] ${bearText}`;
}

async function buildStrategySection(strategy) {
  try {
    if (!strategy) return '';
    return `\n\n[참고 전략 — 아르고스]\n${strategy.strategy_name}: ${strategy.entry_condition || '진입 조건 없음'} (품질점수 ${strategy.quality_score?.toFixed(2)})`;
  } catch {
    return '';
  }
}

async function buildRagContext(symbol, summary) {
  try {
    const hits = await searchRag(
      'trades',
      `${symbol} ${summary.slice(0, 100)}`,
      {
        limit: Number(RAG_RUNTIME.lunaTradeContext?.limit ?? 3),
        threshold: Number(RAG_RUNTIME.lunaTradeContext?.threshold ?? 0.7),
      },
      { sourceBot: 'luna' },
    );
    if (hits.length === 0) return '';
    return '\n\n[과거 유사 신호]\n' + hits.map(h => {
      const m = h.metadata || {};
      return `  ${m.symbol || '?'} ${m.action || '?'} (신뢰도 ${m.confidence || '?'}): ${h.content.slice(0, 80)}`;
    }).join('\n');
  } catch {
    return '';
  }
}

async function buildRegimeSection(exchange) {
  try {
    const regime = await getMarketRegime(exchange);
    return `\n\n${formatMarketRegime(regime)}`;
  } catch {
    return '';
  }
}

async function buildSymbolDecisionPromptParts({ symbol, analyses, exchange, debate, analystWeights }) {
  const summary = buildAnalysisSummary(analyses);
  const label = getExchangeLabel(exchange);
  const fused = fuseSignals(analyses, analystWeights);
  const reviewHint = await loadReviewConfidenceHint(symbol, exchange);
  const [argosStrategy, ragContext, marketRegime] = await Promise.all([
    recommendStrategy(symbol, exchange).catch(() => null),
    buildRagContext(symbol, summary),
    getMarketRegime(exchange).catch(() => null),
  ]);
  const strategyRoute = await buildStrategyRoute({
    symbol,
    exchange,
    analyses,
    fused,
    marketRegime,
    argosStrategy,
  });
  const strategySection = await buildStrategySection(argosStrategy);
  const regimeSection = marketRegime ? `\n\n${formatMarketRegime(marketRegime)}` : '';
  const userMsg = `심볼: ${symbol} (${label})\n\n분석 결과:\n${summary}${buildFusedSection(fused)}${buildReviewSection(reviewHint)}${buildDebateSection(debate)}${strategySection}${buildStrategyRouteSection(strategyRoute)}${ragContext}${regimeSection}\n\n최종 매매 신호:`;

  return {
    summary,
    label,
    fused,
    reviewHint,
    strategyRoute,
    userMsg,
  };
}

async function buildPortfolioDecisionPromptParts(symbolDecisions, portfolio, exchange = 'binance', exitSummary = null) {
  return buildPortfolioDecisionPromptPartsBase(symbolDecisions, portfolio, exchange, exitSummary, {
    maxPosCount: MAX_POS_COUNT,
    buildPortfolioPrompt,
  });
}

function normalizePortfolioDecisionResult(parsed, symbols, exchange, symbolDecisions, portfolio) {
  if (!parsed) {
    if (exchange === 'binance') {
      const fallback = buildCryptoPortfolioFallback(symbolDecisions, portfolio);
      if (fallback) return fallback;
    }
    return {
      decisions: symbolDecisions.map(s => ({ ...s })),
      portfolio_view: 'LLM 판단 실패',
      risk_level: 'MEDIUM',
    };
  }

  if (parsed.decisions) {
    const allowed = new Set(symbols);
    const routeBySymbol = new Map(symbolDecisions.map((item) => [
      item.symbol,
      item.strategy_route || item.strategyRoute || null,
    ]));
    const setupTypeBySymbol = new Map(symbolDecisions.map((item) => [
      item.symbol,
      item.setup_type || item.setupType || item.strategy_route?.setupType || item.strategyRoute?.setupType || null,
    ]));
    parsed.decisions = parsed.decisions.filter(d => allowed.has(d.symbol));
    parsed.decisions = parsed.decisions.map(d => ({
      ...d,
      strategy_route: d.strategy_route || d.strategyRoute || routeBySymbol.get(d.symbol) || null,
      setup_type: d.setup_type || setupTypeBySymbol.get(d.symbol) || null,
    })).map((d) => applyStrategyRouteDecisionBias(d, d.strategy_route || d.strategyRoute || null, exchange));
    if (exchange === 'kis' || exchange === 'kis_overseas') {
      parsed.decisions = parsed.decisions.map(d => ({
        ...d,
        amount_usdt: normalizeDecisionAmount(exchange, d.action, d.amount_usdt),
      }));
    }
  }

  const hasExecutableDecision = (parsed.decisions || []).some(d => d.action && d.action !== ACTIONS.HOLD);
  if (!hasExecutableDecision && exchange === 'binance') {
    const fallback = buildCryptoPortfolioFallback(symbolDecisions, portfolio);
    if (fallback) return fallback;
  }
  return parsed;
}

// ─── 개별 심볼 LLM 판단 ────────────────────────────────────────────

export async function getSymbolDecision(symbol, analyses, exchange = 'binance', debate = null, analystWeights = ANALYST_WEIGHTS) {
  const { fused, reviewHint, strategyRoute, userMsg } = await buildSymbolDecisionPromptParts({
    symbol,
    analyses,
    exchange,
    debate,
    analystWeights,
  });

  const weakSignalGate = exchange === 'binance'
    ? { minAverageConfidence: 0.22, minAbsScore: 0.03 }
    : { minAverageConfidence: 0.32, minAbsScore: 0.08 };

  if (!fused.hasConflict && fused.averageConfidence < weakSignalGate.minAverageConfidence && Math.abs(fused.fusedScore) < weakSignalGate.minAbsScore) {
    return {
      action: ACTIONS.HOLD,
      amount_usdt: exchange === 'kis' || exchange === 'kis_overseas' ? 500 : 100,
      confidence: Math.max(0.2, fused.averageConfidence),
      reasoning: '약한 신호 구간 — 저비용 HOLD',
      strategy_route: strategyRoute,
    };
  }

  const fastPath = buildFastPathDecision(fused, exchange);
  if (fastPath) {
    const boostedConfidence = Math.max(0, Math.min(1, (fastPath.confidence || fused.averageConfidence) + reviewHint.delta));
    return applyStrategyRouteDecisionBias({
      ...fastPath,
      confidence: boostedConfidence,
      reasoning: reviewHint.notes.length > 0
        ? `${fastPath.reasoning} | 리뷰:${reviewHint.notes.join(', ')}`.slice(0, 180)
        : fastPath.reasoning,
      strategy_route: strategyRoute,
      setup_type: strategyRoute?.setupType || null,
    }, strategyRoute, exchange);
  }

  // Shadow Mode 래핑 (mode: 'shadow' 고정 — TEAM_MODE.luna='off' 무시)
  let shadowResult;
  try {
    shadowResult = await shadow.evaluate({
      team:      'luna',
      context:   'symbol_decision',
      input:     userMsg,
      ruleEngine: async () => {
        const raw    = await callLLMWithHub('luna', getLunaSystem(exchange), userMsg, cachedCallLLM, 256, {
          symbol,
          market: exchange,
          taskType: 'final_decision',
          incidentKey: `luna:symbol:${exchange}:${symbol}`,
        });
        const parsed = parseJSON(raw);
        if (!parsed?.action) {
          return buildVoteFallbackDecision(analyses, exchange, '분석가 투표 기반 (LLM fallback)');
        }
        if (exchange === 'kis' || exchange === 'kis_overseas') {
          parsed.amount_usdt = normalizeDecisionAmount(exchange, parsed.action, parsed.amount_usdt);
        }
        return parsed;
      },
      llmPrompt: getLunaSystem(exchange),
      mode:      'shadow',
    });
  } catch (err) {
    if (String(err?.message || '').includes('LLM 긴급 차단 중')) {
      console.warn(`[luna] symbol decision LLM 긴급 차단 fallback 적용 (${symbol}/${exchange}): ${err.message}`);
      shadowResult = {
        action: buildEmergencySymbolFallbackDecision(analyses, exchange, fused),
      };
    } else {
      throw err;
    }
  }
  const adjusted = { ...shadowResult.action };
  const baseConfidence = Math.max(0, Math.min(1, adjusted.confidence ?? fused.averageConfidence ?? 0.5));
  adjusted.confidence = Math.max(0, Math.min(1, baseConfidence + reviewHint.delta));
  if (reviewHint.notes.length > 0) {
    adjusted.reasoning = `${adjusted.reasoning || ''} | 리뷰:${reviewHint.notes.join(', ')}`.slice(0, 180);
  }
  adjusted.strategy_route = strategyRoute;
  adjusted.setup_type = strategyRoute?.setupType || adjusted.setup_type || null;
  if (strategyRoute?.selectedFamily && adjusted.reasoning) {
    adjusted.reasoning = `${adjusted.reasoning} | 전략:${strategyRoute.selectedFamily}`.slice(0, 180);
  }
  return applyStrategyRouteDecisionBias(adjusted, strategyRoute, exchange);  // ruleResult (기존 Groq 판단) 반환, shadow는 shadow_log에만 기록
}

// ─── 포트폴리오 판단 ───────────────────────────────────────────────

export async function getPortfolioDecision(symbolDecisions, portfolio, exchange = 'binance', exitSummary = null) {
  if (symbolDecisions.length === 0) return null;

  const { symbols, userMsg, systemPrompt } = await buildPortfolioDecisionPromptParts(
    symbolDecisions,
    portfolio,
    exchange,
    exitSummary,
  );

  let raw;
  try {
    raw = await callLLMWithHub('luna', systemPrompt, userMsg, callLLM, 768, {
      market: exchange,
      taskType: 'final_decision',
      incidentKey: `luna:portfolio:${exchange}:${Date.now().toString(36)}`,
    });
  } catch (err) {
    if (String(err?.message || '').includes('LLM 긴급 차단 중')) {
      console.warn(`[luna] portfolio decision LLM 긴급 차단 fallback 적용 (${exchange}): ${err.message}`);
      return buildEmergencyPortfolioFallback(symbolDecisions, portfolio, exchange, err.message);
    }
    throw err;
  }

  const normalized = normalizePortfolioDecisionResult(parseJSON(raw), symbols, exchange, symbolDecisions, portfolio);
  const reflexionApplied = await applyReflexionEntryGateToDecisions(normalized, exchange);
  return applyBudgetCheckerToDecisions(reflexionApplied, portfolio, exchange);
}

async function applyReflexionEntryGateToDecisions(portfolioDecision, exchange) {
  const decisions = Array.isArray(portfolioDecision?.decisions) ? portfolioDecision.decisions : [];
  if (decisions.length === 0) return portfolioDecision;

  const adjusted = [];
  for (const decision of decisions) {
    if (decision?.action !== ACTIONS.BUY) {
      adjusted.push(decision);
      continue;
    }

    const reflexion = await checkReflexionBeforeEntry(
      decision.symbol,
      exchange,
      'LONG',
      { pattern: decision?.setup_type || decision?.strategy_route?.setupType || null },
    ).catch(() => ({
      confidenceDelta: 0,
      blockedByReflexion: false,
      relevantFailures: [],
      warningMessage: null,
    }));

    if (reflexion?.blockedByReflexion) {
      const nextDecision = {
        ...decision,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        confidence: Math.max(0, Number(decision?.confidence || 0) + Number(reflexion?.confidenceDelta || 0)),
        reasoning: `reflexion_entry_blocked: ${(reflexion?.warningMessage || '유사 실패 패턴').slice(0, 160)}`,
        block_meta: {
          ...(decision?.block_meta || {}),
          reflexion: {
            blocked: true,
            confidenceDelta: Number(reflexion?.confidenceDelta || 0),
            failures: Number(reflexion?.relevantFailures?.length || 0),
          },
        },
      };
      adjusted.push(nextDecision);
      await db.run(
        `INSERT INTO investment.mapek_knowledge(event_type, payload) VALUES ($1, $2::jsonb)`,
        ['reflexion_entry_blocked', JSON.stringify({
          symbol: decision.symbol,
          exchange,
          confidence_delta: Number(reflexion?.confidenceDelta || 0),
          failures: Number(reflexion?.relevantFailures?.length || 0),
          at: new Date().toISOString(),
        })],
      ).catch(() => {});
      continue;
    }

    const delta = Number(reflexion?.confidenceDelta || 0);
    if (delta >= 0) {
      adjusted.push(decision);
      continue;
    }
    const nextConfidence = Math.max(0, Math.min(1, Number(decision?.confidence || 0) + delta));
    adjusted.push({
      ...decision,
      confidence: nextConfidence,
      reasoning: `${decision?.reasoning || ''} | reflexion_confidence_adjusted(${delta.toFixed(2)})`.slice(0, 200),
      block_meta: {
        ...(decision?.block_meta || {}),
        reflexion: {
          blocked: false,
          confidenceDelta: delta,
          failures: Number(reflexion?.relevantFailures?.length || 0),
        },
      },
    });
    await db.run(
      `INSERT INTO investment.mapek_knowledge(event_type, payload) VALUES ($1, $2::jsonb)`,
      ['reflexion_confidence_adjusted', JSON.stringify({
        symbol: decision.symbol,
        exchange,
        confidence_delta: delta,
        adjusted_confidence: nextConfidence,
        failures: Number(reflexion?.relevantFailures?.length || 0),
        at: new Date().toISOString(),
      })],
    ).catch(() => {});
  }
  return { ...portfolioDecision, decisions: adjusted };
}

/**
 * 포트폴리오 결정의 BUY 후보 전체에 budget checker를 적용한다 (Phase 3).
 * SELL/HOLD는 영향 없음. 자본 상태가 없거나 binance가 아니면 그대로 반환.
 */
function applyBudgetCheckerToDecisions(portfolioDecision, portfolio, exchange) {
  const capitalSnapshot: LunaBuyingPowerSnapshot | null = portfolio?.capitalSnapshot ?? null;
  if (!capitalSnapshot) return portfolioDecision;

  const decisions = Array.isArray(portfolioDecision?.decisions) ? portfolioDecision.decisions : [];
  const adjusted: any[] = [];
  let anyAdjusted = false;

  for (const d of decisions) {
    if (d.action !== ACTIONS.BUY) {
      adjusted.push(d);
      continue;
    }
    const desired = Number(d.amount_usdt || 0);
    const check = adjustLunaBuyCandidate(desired, capitalSnapshot);
    const enrichedCheck = enrichCapitalCheck(check, capitalSnapshot);

    if (check.result === 'accepted') {
      adjusted.push(d);
      continue;
    }

    anyAdjusted = true;

    if (check.result === 'reduced') {
      console.log(`  💱 [루나 budget] ${d.symbol} BUY ${desired} → ${check.adjustedAmount} (${check.reason})`);
      adjusted.push({
        ...d,
        amount_usdt: check.adjustedAmount,
        block_meta: { capitalCheck: enrichedCheck },
      });
      continue;
    }

    // blocked_cash / blocked_slots / blocked_balance_unavailable / reduce_only → HOLD로 전환
    console.log(`  🔒 [루나 budget] ${d.symbol} BUY → HOLD (${check.result}): ${check.reason}`);
    adjusted.push({
      ...d,
      action: ACTIONS.HOLD,
      amount_usdt: 0,
      reasoning: `capital_backpressure: ${check.reason} | ${d.reasoning || ''}`.slice(0, 200),
      block_meta: { capitalCheck: enrichedCheck },
    });
  }

  if (!anyAdjusted) return portfolioDecision;
  return { ...portfolioDecision, decisions: adjusted };
}

export async function getExitDecisions(openPositions, exchange = 'binance') {
  if (!Array.isArray(openPositions) || openPositions.length === 0) {
    return { decisions: [], exit_view: 'no_positions' };
  }

  const enrichedPositions = await enrichExitPositions(openPositions, exchange);

  const userPrompt = buildExitPrompt(enrichedPositions, exchange);

  let raw;
  try {
    raw = await callLLMWithHub('luna', LUNA_EXIT_SYSTEM, userPrompt, callLLM, 512, {
      purpose: 'exit_phase',
      market: exchange,
      taskType: 'final_decision',
      incidentKey: `luna:exit:${exchange}:${Date.now().toString(36)}`,
    });
  } catch (err) {
    if (String(err?.message || '').includes('LLM 긴급 차단 중')) {
      console.warn(`[luna] exit decision LLM 긴급 차단 fallback 적용 (${exchange}): ${err.message}`);
      return buildExitFallback(enrichedPositions);
    }
    throw err;
  }

  return normalizeExitDecisionResult(parseJSON(raw), enrichedPositions);
}

// ─── 포트폴리오 컨텍스트 ───────────────────────────────────────────

async function buildPortfolioContext(exchange = 'binance') {
  const positions  = await db.getAllPositions(exchange, false);
  const todayPnl   = await db.getTodayPnl(exchange);
  const posValue   = positions.reduce((s, p) => s + (p.amount * p.avg_price), 0);

  // 자본 상태 스냅샷 (balanceStatus로 잔고 조회 실패와 0 잔고를 구분)
  const capitalSnapshot: LunaBuyingPowerSnapshot = await getLunaBuyingPowerSnapshot(
    exchange as 'binance' | 'kis' | 'kis_overseas',
  ).catch(() => null);

  const usdtFree = capitalSnapshot?.balanceStatus === 'ok'
    ? capitalSnapshot.freeCash
    : capitalSnapshot?.balanceStatus === 'unavailable'
      ? 0
      : (exchange === 'binance'
          ? await getAvailableUSDT().catch(() => 0)
          : exchange === 'kis'
            ? await getDomesticBalance().then(b => Number(b?.dnca_tot_amt || 0)).catch(() => 0)
            : 0);

  const availableBalance = exchange === 'binance'
    ? await getAvailableBalance().catch(() => usdtFree)
    : usdtFree;
  const totalAsset = exchange === 'binance'
    ? availableBalance + posValue
    : usdtFree + posValue;

  if (exchange === 'binance') {
    try { await db.insertAssetSnapshot(totalAsset, usdtFree); } catch {}
  }

  return {
    usdtFree,
    totalAsset,
    positionCount: positions.length,
    todayPnl,
    positions,
    capitalSnapshot,
    capitalMode: capitalSnapshot?.mode || null,
    reasonCode: capitalSnapshot?.reasonCode || null,
    buyableAmount: Number(capitalSnapshot?.buyableAmount || 0),
    balanceStatus: capitalSnapshot?.balanceStatus || 'unavailable',
  };
}

export async function inspectPortfolioContext(exchange = 'binance') {
  const context = await buildPortfolioContext(exchange);
  return {
    ...context,
    capitalMode: context?.capitalMode ?? context?.capitalSnapshot?.mode ?? null,
    reasonCode: context?.reasonCode ?? context?.capitalSnapshot?.reasonCode ?? null,
    buyableAmount: context?.buyableAmount ?? Number(context?.capitalSnapshot?.buyableAmount || 0),
    balanceStatus: context?.balanceStatus ?? context?.capitalSnapshot?.balanceStatus ?? 'unavailable',
  };
}

// ─── 2라운드 토론 ───────────────────────────────────────────────────

/**
 * 리서처 토론 1라운드 or 2라운드 실행
 * @param {string} symbol
 * @param {string} summary    분석 요약 텍스트
 * @param {string} exchange
 * @param {object|null} prevDebate  1라운드 결과 (null이면 1라운드)
 * @returns {Promise<{ bull: any, bear: any, round: number }>}
 */
async function runDebateRound(symbol, summary, exchange, prevDebate = null) {
  if (!prevDebate) {
    // 1라운드: 병렬 실행
    const [bull, bear] = await Promise.all([
      runBullResearcher(symbol, summary, null, exchange),
      runBearResearcher(symbol, summary, null, exchange),
    ]);
    return { bull, bear, round: 1 };
  }

  // 2라운드: 상대방 주장 포함 재반박
  const bullCtx = prevDebate.bear
    ? `${summary}\n\n[약세 주장 반박 요청]\n${prevDebate.bear.reasoning}`
    : summary;
  const bearCtx = prevDebate.bull
    ? `${summary}\n\n[강세 주장 반박 요청]\n${prevDebate.bull.reasoning}`
    : summary;

  const [bull2, bear2] = await Promise.all([
    runBullResearcher(symbol, bullCtx, null, exchange),
    runBearResearcher(symbol, bearCtx, null, exchange),
  ]);
  return { bull: bull2, bear: bear2, round: 2 };
}

// ─── 메인 오케스트레이터 ────────────────────────────────────────────

/**
 * 심볼 배열에 대해 분석 결과 취합 → 최종 신호 결정 → DB 저장
 * @param {string[]} symbols
 * @param {string}   exchange
 * @returns {Promise<Array>}
 */
/**
 * @param {string[]} symbols
 * @param {string} [exchange]
 * @param {any} [params]
 * @returns {Promise<TradeSignal[]>}
 */
export function shouldRunDiscovery(capitalSnapshot: LunaBuyingPowerSnapshot | null, modeOverride = ''): boolean {
  if (String(modeOverride || '').trim().toLowerCase() === 'monitor_only') return false;
  if (!capitalSnapshot) return true; // 스냅샷 없으면 허용 (안전 폴백)
  return capitalSnapshot.mode === 'ACTIVE_DISCOVERY';
}

export function resolveCapitalGateAction(capitalSnapshot: LunaBuyingPowerSnapshot | null, openPositionCount = 0, modeOverride = '') {
  if (shouldRunDiscovery(capitalSnapshot, modeOverride)) return 'active_discovery';
  if (Number(openPositionCount || 0) > 0) return 'exit_only';
  return 'idle_digest';
}

function formatCapitalModeLog(snapshot: LunaBuyingPowerSnapshot | null): string {
  if (!snapshot) return '';
  const { mode, reasonCode, buyableAmount, minOrderAmount, balanceStatus, openPositionCount, maxPositionCount } = snapshot;
  return `[자본상태] mode=${mode} | reason=${reasonCode || 'none'} | 매수가능=${buyableAmount.toFixed(2)} 최소=${minOrderAmount} | 잔고=${balanceStatus} | 포지션=${openPositionCount}/${maxPositionCount}`;
}

function applyDiscoveryThrottleToSymbols(symbols = [], throttle = null) {
  if (!Array.isArray(symbols)) return [];
  if (!throttle?.enabled) return symbols;
  const maxSymbols = Number(throttle?.maxSymbols || 0);
  if (!(maxSymbols > 0) || symbols.length <= maxSymbols) return symbols;
  return symbols.slice(0, maxSymbols);
}

function applyDiscoveryHardCap(symbols = [], maxSymbols = 60) {
  if (!Array.isArray(symbols)) return [];
  const cap = Math.max(1, Number(maxSymbols || 60));
  return symbols.length > cap ? symbols.slice(0, cap) : symbols;
}

function applyDiscoveryThrottleToDecision(decision = null, throttle = null) {
  if (!decision || !Array.isArray(decision.decisions)) {
    return { decision, reducedCount: 0 };
  }
  if (!throttle?.enabled) return { decision, reducedCount: 0 };
  const maxBuyCandidates = Number(throttle?.maxBuyCandidates || 0);
  if (!(maxBuyCandidates > 0)) return { decision, reducedCount: 0 };

  const buys = decision.decisions
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item?.action === ACTIONS.BUY)
    .sort((a, b) => Number(b.item?.confidence || 0) - Number(a.item?.confidence || 0));
  if (buys.length <= maxBuyCandidates) return { decision, reducedCount: 0 };

  const keep = new Set(buys.slice(0, maxBuyCandidates).map((entry) => entry.idx));
  let reducedCount = 0;
  const nextDecisions = decision.decisions.map((item, idx) => {
    if (item?.action !== ACTIONS.BUY || keep.has(idx)) return item;
    reducedCount += 1;
    return {
      ...item,
      action: ACTIONS.HOLD,
      amount_usdt: 0,
      reasoning: `discovery_throttle: maxBuyCandidates=${maxBuyCandidates} 상한으로 후보 보류 | ${item.reasoning || ''}`.slice(0, 220),
      block_meta: {
        ...(item.block_meta || {}),
        discoveryThrottle: {
          modeOverride: throttle.modeOverride || null,
          maxBuyCandidates,
          reducedByThrottle: true,
        },
      },
    };
  });

  return {
    decision: { ...decision, decisions: nextDecisions },
    reducedCount,
  };
}

function mergeUniqueSymbols(primary = [], fallback = []) {
  const out = [];
  const seen = new Set();
  for (const item of [...primary, ...fallback]) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeRegimeLabel(marketRegime = null) {
  const raw = String(marketRegime?.regime || marketRegime?.label || marketRegime || '').trim();
  return raw || 'ranging';
}

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export async function orchestrate(symbols, exchange = 'binance', params = null) {
  const label           = exchange === 'kis_overseas' ? '미국주식' : exchange === 'kis' ? '국내주식' : '암호화폐';
  const results         = [];
  let debateCount          = 0;
  const portfolio          = await buildPortfolioContext(exchange);
  const capitalSnapshot    = portfolio.capitalSnapshot ?? null;
  const discoveryThrottle  = getLunaDiscoveryThrottleConfig(exchange);
  const intelligentFlags   = getLunaIntelligentDiscoveryFlags();
  const discoveryMarket    = toDiscoveryMarket(exchange);
  const marketRegime       = await getMarketRegime(exchange).catch(() => null);
  const { weights: analystWeights, report: accuracyReport } = await loadAdaptiveAnalystWeights(exchange, marketRegime);
  const symbolDecisions    = [];
  const symbolAnalysesMap  = new Map(); // symbol → analyses (상관관계 기록용)
  const intelligentBySymbol = new Map();

  let baseSymbols = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
  let universeCandidates = [];

  if (Object.values(intelligentFlags.phases || {}).some(Boolean)) {
    await ensureLunaDiscoveryEntryTables().catch(() => {});
  }

  if (intelligentFlags.phases.discoveryOrchestratorEnabled) {
    const universe = await buildDiscoveryUniverse(discoveryMarket, new Date(), {
      refresh: true,
      fallbackSymbols: baseSymbols,
      limit: Math.max(60, baseSymbols.length * 4),
      ttlHours: 24,
    }).catch(() => null);
    if (universe?.symbols?.length) {
      baseSymbols = mergeUniqueSymbols(universe.symbols, baseSymbols);
    }
    if (Array.isArray(universe?.candidates)) {
      universeCandidates = universe.candidates;
    }
  }

  if (intelligentFlags.phases.newsSymbolMappingEnabled) {
    await runNewsToSymbolMapping({
      exchange,
      market: discoveryMarket,
      ttlHours: 24,
    }).catch((error) => {
      console.warn(`  ⚠️ [루나] news→symbol 매핑 실패: ${error?.message || error}`);
    });
    const refreshed = await buildDiscoveryUniverse(discoveryMarket, new Date(), {
      refresh: false,
      fallbackSymbols: baseSymbols,
      limit: Math.max(60, baseSymbols.length * 4),
    }).catch(() => null);
    if (refreshed?.symbols?.length) {
      baseSymbols = mergeUniqueSymbols(refreshed.symbols, baseSymbols);
    }
    if (Array.isArray(refreshed?.candidates) && refreshed.candidates.length > 0) {
      universeCandidates = refreshed.candidates;
    }
  }

  const discoveryCandidateBySymbol = new Map(
    (universeCandidates || []).map((row) => [String(row.symbol || ''), row]),
  );

  baseSymbols = applyDiscoveryHardCap(baseSymbols, intelligentFlags.discovery?.maxSymbols || 60);
  const discoverySymbols = applyDiscoveryThrottleToSymbols(baseSymbols, discoveryThrottle);
  console.log(`\n🌙 [루나] ${label} 오케스트레이션 시작 — ${discoverySymbols.join(', ')}`);
  if (baseSymbols.length !== symbols.length) {
    console.log(`  🌐 [루나] discovery universe 확장: ${symbols.length} → ${baseSymbols.length}`);
  }
  if (discoveryThrottle?.enabled && discoveryThrottle?.maxSymbols > 0 && discoverySymbols.length < baseSymbols.length) {
    console.log(`  🎚️ [루나] discoveryThrottle maxSymbols=${discoveryThrottle.maxSymbols} 적용: ${baseSymbols.length} → ${discoverySymbols.length}`);
  }

  const communitySentimentBySymbol = new Map();
  if (intelligentFlags.phases.communitySentimentEnabled && discoverySymbols.length > 0) {
    const sentimentRows = await scoreCommunitySentiment(discoverySymbols, { exchange, minutes: 720 }).catch(() => []);
    for (const row of sentimentRows || []) {
      communitySentimentBySymbol.set(String(row.symbol || ''), row);
    }
  }

  // 자본 상태 게이트: ACTIVE_DISCOVERY가 아니면 신규 발굴 생략 (전시장 공통)
  const capitalGateAction = resolveCapitalGateAction(
    capitalSnapshot,
    Number(portfolio?.positions?.length || 0),
    discoveryThrottle?.modeOverride,
  );
  if (capitalGateAction !== 'active_discovery') {
    console.log(`  🔒 [루나] ${formatCapitalModeLog(capitalSnapshot)}`);
    if (String(discoveryThrottle?.modeOverride || '').trim().toLowerCase() === 'monitor_only') {
      console.log(`  🔒 [루나] discoveryThrottle modeOverride=monitor_only 적용`);
    }
    console.log(`  🔒 [루나] 신규 발굴 생략 → 보유 포지션 EXIT 판단만 수행`);

    const openPositions = portfolio.positions || [];
    if (capitalGateAction === 'exit_only' && openPositions.length > 0) {
      const exitSignals = await getExitDecisions(openPositions, exchange).catch(() => []);
      if (exitSignals.length > 0) {
        console.log(`  🚪 [루나] EXIT 신호 ${exitSignals.length}개 반환`);
      }
      return exitSignals;
    }
    const modeLabel = capitalSnapshot?.mode || 'MONITOR_ONLY';
    const reasonLabel = capitalSnapshot?.reasonCode || 'discovery_throttle';
    publishAlert({
      from_bot: 'luna',
      event_type: 'capital_state_report',
      alert_level: 1,
      message: `ℹ️ [루나 자본상태] ${exchange} ${modeLabel} (${reasonLabel})\n매수가능 ${Number(capitalSnapshot?.buyableAmount || 0).toFixed(2)} / 최소 ${Number(capitalSnapshot?.minOrderAmount || 0).toFixed(2)}\n보유포지션 ${Number(capitalSnapshot?.openPositionCount || 0)}/${Number(capitalSnapshot?.maxPositionCount || 0)}\n신규 발굴/매수는 보류하고 다음 사이클에서 회복 여부를 재평가합니다.`,
    });
    console.log(`  ℹ️ [루나] 보유 포지션 없음 + 매수 불가 → 빈 배열 반환 (${capitalSnapshot?.mode || 'monitor_only'})`);
    return [];
  }
  console.log(`  ⚖️ [루나] 분석가 가중치: TA ${analystWeights[ANALYST_TYPES.TA_MTF].toFixed(2)} | 온체인 ${analystWeights[ANALYST_TYPES.ONCHAIN].toFixed(2)} | sentinel ${analystWeights[ANALYST_TYPES.SENTINEL].toFixed(2)} | 감성 ${analystWeights[ANALYST_TYPES.SENTIMENT].toFixed(2)} | 뉴스 ${analystWeights[ANALYST_TYPES.NEWS].toFixed(2)}`);

  for (const symbol of discoverySymbols) {
    try {
      const analyses = await db.getRecentAnalysis(symbol, 70, exchange);
      if (analyses.length === 0) {
        console.log(`  ⚠️ [루나] ${symbol}: 분석 결과 없음 → 스킵`);
        continue;
      }

      symbolAnalysesMap.set(symbol, analyses);
      console.log(`  📋 [루나] ${symbol}: ${analyses.length}개 분석 결과`);

      let debate = null;
      const baseDebateLimit = getDebateLimit(exchange, discoverySymbols.length);
      const debateLimit = discoveryThrottle?.enabled && Number(discoveryThrottle?.maxDebateSymbols || 0) > 0
        ? Math.min(baseDebateLimit, Number(discoveryThrottle.maxDebateSymbols))
        : baseDebateLimit;
      if (debateCount < debateLimit && shouldDebateForSymbol(analyses, exchange, analystWeights)) {
        try {
          const summary = buildAnalysisSummary(analyses);

          // 1라운드
          const r1 = await runDebateRound(symbol, summary, exchange, null);
          if (r1.bull) console.log(`  🐂 [제우스 R1] 목표가 ${r1.bull.targetPrice} | ${r1.bull.reasoning?.slice(0, 50)}`);
          if (r1.bear) console.log(`  🐻 [아테나 R1] 목표가 ${r1.bear.targetPrice} | ${r1.bear.reasoning?.slice(0, 50)}`);

          // 2라운드 (상대방 주장 보고 재반박)
          const r2 = await runDebateRound(symbol, summary, exchange, r1);
          if (r2.bull) console.log(`  🐂 [제우스 R2] ${r2.bull.reasoning?.slice(0, 60)}`);
          if (r2.bear) console.log(`  🐻 [아테나 R2] ${r2.bear.reasoning?.slice(0, 60)}`);

          debate = { bull: r2.bull, bear: r2.bear, r1 };
          debateCount++;
        } catch (e) {
          console.warn(`  ⚠️ [루나] ${symbol} 리서처 실패: ${e.message}`);
        }
      } else {
        console.log(`  ⏭️ [루나] ${symbol}: debate 생략 (명확 신호 또는 한도 도달)`);
      }

      const mtf = intelligentFlags.phases.mtfAnalyzerEnabled
        ? analyzeMultiTimeframe(symbol, analyses, exchange, intelligentFlags.mtf)
        : null;
      const sentiment = communitySentimentBySymbol.get(symbol) || null;

      let wyckoff = null;
      let vsa = null;
      if ((intelligentFlags.phases.wyckoffDetectionEnabled || intelligentFlags.phases.vsaClassificationEnabled) && exchange === 'binance') {
        const fromDate = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const candles = await getOHLCV(symbol, '1h', fromDate, null, 'binance').catch(() => []);
        if (intelligentFlags.phases.wyckoffDetectionEnabled) {
          wyckoff = detectWyckoffPhase(candles);
        }
        if (intelligentFlags.phases.vsaClassificationEnabled && candles.length > 10) {
          vsa = classifyVsaBar(candles[candles.length - 1], candles.slice(-30, -1));
        }
      }

      const taAnalysis = analyses.find((a) => a.analyst === ANALYST_TYPES.TA_MTF || a.analyst === ANALYST_TYPES.TA);
      const discoverySeed = discoveryCandidateBySymbol.get(symbol) || null;
      const fused = intelligentFlags.phases.scoreFusionEnabled
        ? fuseDiscoveryScore({
            regime: normalizeRegimeLabel(marketRegime),
            discoverySignals: discoverySeed ? [discoverySeed] : [],
            sentiment,
            technical: { confidence: Number(taAnalysis?.confidence || 0.5) },
            mtf,
            wyckoff,
            vsa,
          })
        : null;

      console.log(`\n  🤖 [루나] ${symbol} 신호 판단 중...`);
      const decision = await getSymbolDecision(symbol, analyses, exchange, debate, analystWeights);
      const discoveryScore = clamp01(fused?.discoveryScore ?? decision?.confidence ?? 0.5, 0.5);
      const shouldMutateDecision = intelligentFlags.shouldApplyDecisionMutation();
      const shouldApplyScoreFusion = intelligentFlags.shouldApplyScoreFusion();
      const blendedConfidence = shouldApplyScoreFusion
        ? clamp01((Number(decision?.confidence || 0) * 0.7) + (discoveryScore * 0.3), Number(decision?.confidence || 0))
        : Number(decision?.confidence || 0);
      const predictiveScore = clamp01(
        (discoveryScore * 0.55) + (clamp01(((Number(mtf?.alignmentScore || 0) + 1) / 2), 0.5) * 0.45),
        discoveryScore,
      );

      const enrichedDecision = {
        ...decision,
        confidence: Number(blendedConfidence.toFixed(4)),
        setup_type: shouldMutateDecision ? (decision?.setup_type || fused?.setupType || null) : (decision?.setup_type || null),
        entry_strategy: shouldMutateDecision ? (decision?.entry_strategy || fused?.entryStrategy || null) : (decision?.entry_strategy || null),
        predictiveScore: Number(predictiveScore.toFixed(4)),
        triggerHints: {
          mtfAgreement: Number(mtf?.mtfAgreement || 0),
          discoveryScore: Number(discoveryScore || 0),
          volumeBurst: Number(vsa?.metrics?.volRatio || 0),
          breakoutRetest: String(wyckoff?.phase || '') === 'accumulation' && String(mtf?.dominantSignal || '') === ACTIONS.BUY,
          newsMomentum: Math.max(0, Number(sentiment?.sentimentScore || 0)),
        },
        block_meta: {
          ...(decision?.block_meta || {}),
          discoveryContext: {
            source: discoverySeed?.source || null,
            market: discoveryMarket,
            score: discoverySeed?.score ?? null,
            confidence: discoverySeed?.confidence ?? null,
            reasonCode: discoverySeed?.reasonCode ?? null,
            evidenceRef: discoverySeed?.evidenceRef ?? null,
          },
          mtf,
          sentiment,
          wyckoff,
          vsa,
          scoreFusion: fused,
        },
      };
      intelligentBySymbol.set(symbol, {
        discoverySeed,
        sentiment,
        mtf,
        wyckoff,
        vsa,
        fused,
        predictiveScore,
      });
      console.log(`  → ${enrichedDecision.action} (${((enrichedDecision.confidence || 0) * 100).toFixed(0)}%) | ${enrichedDecision.reasoning}`);

      symbolDecisions.push({ symbol, exchange, ...enrichedDecision });
    } catch (e) {
      console.error(`  ❌ [루나] ${symbol} 오류: ${e.message}`);
      await notifyError(`루나 오케스트레이터 - ${symbol}`, e);
    }
  }

  if (symbolDecisions.length === 0) {
    console.log('  ℹ️ [루나] 처리할 심볼 없음');
    return [];
  }

  console.log(`\n🏦 [루나] 포트폴리오 최종 판단...`);
  let portfolio_decision = await getPortfolioDecision(symbolDecisions, portfolio, exchange);
  let approvedCount = 0;
  let rejectedCount = 0;
  let failedCount   = 0;

  if (!portfolio_decision) {
    console.log('  ⚠️ [루나] 포트폴리오 판단 실패');
    return [];
  }

  const representativePass = await applyCryptoRepresentativePass(portfolio_decision, exchange);
  portfolio_decision = representativePass.decision;
  if (representativePass.reduction) {
    const info = representativePass.reduction;
    console.log(`  🧭 [루나] 대표 후보 패스 적용: BUY ${info.requestedBuyCount} → ${info.kept.length} (현재 long ${info.currentLongCount}/${info.maxSameDirection})`);
    if (info.dropped.length > 0) {
      console.log(`    - 제외: ${info.dropped.join(', ')}`);
    }
  }
  const discoveryThrottleApplied = applyDiscoveryThrottleToDecision(portfolio_decision, discoveryThrottle);
  portfolio_decision = discoveryThrottleApplied.decision;
  if (discoveryThrottleApplied.reducedCount > 0) {
    console.log(`  🎚️ [루나] discoveryThrottle maxBuyCandidates=${discoveryThrottle.maxBuyCandidates} 적용: BUY 후보 ${discoveryThrottleApplied.reducedCount}개 보류`);
  }

  if (intelligentFlags.phases.predictiveValidationEnabled) {
    const predictiveGate = applyPredictiveValidationGate(
      portfolio_decision.decisions || [],
      intelligentFlags.predictive,
    );
    portfolio_decision = {
      ...portfolio_decision,
      decisions: predictiveGate.decisions,
      predictiveValidation: {
        mode: intelligentFlags.predictive.mode,
        threshold: intelligentFlags.predictive.threshold,
        blocked: predictiveGate.blocked,
        advisory: predictiveGate.advisory,
      },
    };
    if (predictiveGate.blocked > 0 || predictiveGate.advisory > 0) {
      console.log(`  🧠 [루나] predictive validation: mode=${intelligentFlags.predictive.mode} blocked=${predictiveGate.blocked} advisory=${predictiveGate.advisory}`);
    }
  }

  if (intelligentFlags.phases.entryTriggerEnabled) {
    const triggerResult = await evaluateEntryTriggers(portfolio_decision.decisions || [], {
      exchange,
      regime: normalizeRegimeLabel(marketRegime),
    }).catch((error) => {
      console.warn(`  ⚠️ [루나] entry trigger 평가 실패: ${error?.message || error}`);
      return null;
    });
    if (triggerResult?.decisions) {
      portfolio_decision = {
        ...portfolio_decision,
        decisions: triggerResult.decisions,
        entryTriggerStats: triggerResult.stats || null,
      };
      console.log(`  🎯 [루나] entry trigger: armed=${Number(triggerResult?.stats?.armed || 0)} fired=${Number(triggerResult?.stats?.fired || 0)} blocked=${Number(triggerResult?.stats?.blocked || 0)} mode=${triggerResult?.stats?.mode || intelligentFlags.mode}`);
    }
  }

  console.log(`  📌 시황: ${portfolio_decision.portfolio_view}`);
  console.log(`  📌 리스크: ${portfolio_decision.risk_level}`);

  const paperMode  = isPaperMode();
  const summaryMsg = [
    `${paperMode ? '[PAPER] ' : ''}🌙 루나 판단 (${label})`,
    `시황: ${portfolio_decision.portfolio_view}`,
    `리스크: ${portfolio_decision.risk_level}`,
    representativePass.reduction
      ? `대표 후보 패스: BUY ${representativePass.reduction.requestedBuyCount} → ${representativePass.reduction.kept.length} (long ${representativePass.reduction.currentLongCount}/${representativePass.reduction.maxSameDirection})`
      : '',
    accuracyReport?.totalWeight ? `가중치합: ${accuracyReport.totalWeight}` : '',
    '',
    ...(portfolio_decision.decisions || []).map(d => {
      const emoji = d.action === 'BUY' ? '🟢' : d.action === 'SELL' ? '🔴' : '⚪';
      const amountLabel = formatLunaDecisionAmount(exchange, d.amount_usdt);
      return `${emoji} ${d.action} ${d.symbol} ${amountLabel} (${((d.confidence || 0) * 100).toFixed(0)}%)\n  ${d.reasoning?.slice(0, 80)}`;
    }),
  ].join('\n');
  publishAlert({ from_bot: 'luna', event_type: 'report', alert_level: 1, message: summaryMsg });

  for (const dec of (portfolio_decision.decisions || [])) {
    const capitalCheck = dec?.block_meta?.capitalCheck || null;
    const isCapitalBlockedBuy = dec.action === ACTIONS.HOLD
      && capitalCheck
      && ['blocked_cash', 'blocked_slots', 'blocked_balance_unavailable', 'reduce_only'].includes(String(capitalCheck.result || ''));
    if (dec.action === ACTIONS.HOLD && !isCapitalBlockedBuy) continue;
    const runtimeMinConf = getMinConfidence(exchange);
    const minConf = exchange === 'binance'
      ? Math.min(params?.minSignalScore ?? runtimeMinConf, runtimeMinConf)
      : (params?.minSignalScore ?? runtimeMinConf);
    if (!isCapitalBlockedBuy && (dec.confidence || 0) < minConf) {
      console.log(`  ⏸️ [루나] ${dec.symbol}: 확신도 미달 (${((dec.confidence || 0) * 100).toFixed(0)}% < ${(minConf * 100).toFixed(0)}%) → HOLD`);
      continue;
    }

    // 분석 봇 신호 패턴 추출 (상관관계 분석용)
    const _getChar = s => !s ? 'N' : s.toUpperCase() === 'BUY' ? 'B' : s.toUpperCase() === 'SELL' ? 'S' : 'N';
    const _symAnalyses = symbolAnalysesMap.get(dec.symbol) || [];
    const _sentinelSignal = _symAnalyses.find(a => a.analyst === ANALYST_TYPES.SENTINEL)?.signal;
    const analystSignals = [
      `A:${_getChar(_symAnalyses.find(a => a.analyst === ANALYST_TYPES.TA_MTF)?.signal)}`,
      `O:${_getChar(_symAnalyses.find(a => a.analyst === ANALYST_TYPES.ONCHAIN)?.signal)}`,
      `H:${_getChar(_symAnalyses.find(a => a.analyst === ANALYST_TYPES.NEWS)?.signal || _sentinelSignal)}`,
      `S:${_getChar(_symAnalyses.find(a => a.analyst === ANALYST_TYPES.SENTIMENT)?.signal || _sentinelSignal)}`,
    ].join('|');

    // 펀딩레이트 극단값 경고 (오라클 메타데이터 참조)
    const _oracleMeta = _symAnalyses.find(a => a.analyst === ANALYST_TYPES.ONCHAIN)?.metadata;
    if (_oracleMeta?.fundingRate != null) {
      const fPct = _oracleMeta.fundingRate * 100;
      if (fPct > 0.05)      console.log(`  ⚠️ [루나] 펀딩레이트 롱 과열 (+${fPct.toFixed(4)}%) — 반전 주의`);
      else if (fPct < -0.01) console.log(`  ⚠️ [루나] 펀딩레이트 음수 (${fPct.toFixed(4)}%) — 숏 스퀴즈 주의`);
    }

    const desiredBlockedBuyAmount = Number(
      capitalCheck?.desiredAmount
      ?? capitalCheck?.adjustedAmount
      ?? dec?.desired_amount_usdt
      ?? dec?.amount_usdt
      ?? 0,
    );
    let signalData = {
      symbol:          dec.symbol,
      action:          isCapitalBlockedBuy ? ACTIONS.BUY : dec.action,
      amountUsdt:      isCapitalBlockedBuy
        ? desiredBlockedBuyAmount
        : (dec.amount_usdt || (exchange === 'kis' || exchange === 'kis_overseas'
        ? getStockOrderSpec(exchange)?.buyDefault
        : 100)),
      confidence:      dec.confidence,
      reasoning:       `[루나] ${dec.reasoning}`,
      exchange:        dec.exchange || exchange,
      analystSignals,
      strategyFamily:  dec.strategy_route?.selectedFamily || dec.strategyRoute?.selectedFamily || null,
      strategyQuality: dec.strategy_route?.quality || dec.strategyRoute?.quality || null,
      strategyReadiness: dec.strategy_route?.readinessScore || dec.strategyRoute?.readinessScore || null,
      strategyRoute:   dec.strategy_route || dec.strategyRoute || null,
    };
    if (exchange === 'kis' || exchange === 'kis_overseas') {
      signalData.amountUsdt = normalizeDecisionAmount(exchange, signalData.action, signalData.amountUsdt);
    }

    let existingStrategyProfile = null;
    if (signalData.action === ACTIONS.BUY && !isCapitalBlockedBuy) {
      existingStrategyProfile = await db.getPositionStrategyProfile(dec.symbol, {
        exchange: signalData.exchange,
        status: 'active',
      }).catch(() => null);
      const strategyBias = applyExistingPositionStrategyBias(signalData, existingStrategyProfile);
      signalData = strategyBias.signalData;
      if (strategyBias.applied && strategyBias.note) {
        console.log(`  🧩 [루나] ${dec.symbol}: 기존 전략 객체 반영 → ${strategyBias.note}`);
      }
      if (exchange === 'kis' || exchange === 'kis_overseas') {
        signalData.amountUsdt = normalizeDecisionAmount(exchange, signalData.action, signalData.amountUsdt);
      }
    }

    const { valid, errors } = validateSignal(signalData);
    if (!valid) {
      console.warn(`  ⚠️ [루나] ${dec.symbol} 신호 검증 실패: ${errors.join(', ')}`);
      continue;
    }

    if (isCapitalBlockedBuy) {
      const reasonCode = mapCapitalCheckResultToReasonCode(capitalCheck?.result);
      const blockMeta = {
        exchange,
        symbol: dec.symbol,
        action: ACTIONS.BUY,
        reasonCode,
        desiredAmount: Number(capitalCheck?.desiredAmount || signalData.amountUsdt || 0),
        adjustedAmount: Number(capitalCheck?.adjustedAmount || 0),
        minOrderAmount: Number(capitalCheck?.minOrderAmount || capitalSnapshot?.minOrderAmount || 0),
        remainingSlots: Number(capitalCheck?.remainingSlots ?? capitalSnapshot?.remainingSlots ?? 0),
        capitalCheck,
      };
      const signalInsert = await db.insertSignalIfFresh({
        ...signalData,
        status: SIGNAL_STATUS.FAILED,
      });
      const signalId = signalInsert.id;
      if (signalInsert.duplicate) {
        console.log(`  ⏭️ [루나] 최근 중복 신호 스킵: ${dec.symbol} BUY (capital_backpressure, signal=${signalId})`);
        continue;
      }
      await db.updateSignalBlock(signalId, {
        status: SIGNAL_STATUS.FAILED,
        reason: `${reasonCode}: ${String(capitalCheck?.reason || 'capital_backpressure')}`.slice(0, 200),
        code: 'capital_backpressure',
        meta: blockMeta,
      }).catch((error) => {
        console.warn(`  ⚠️ [루나] ${dec.symbol}: capital backpressure block 저장 실패 (${error.message})`);
      });
      if (intelligentFlags.phases.reflectionEnabled) {
        const intel = intelligentBySymbol.get(dec.symbol) || {};
        await recordDiscoveryAttribution({
          signalId,
          source: intel?.discoverySeed?.source || 'capital_backpressure',
          setupType: dec?.setup_type || dec?.strategy_route?.setupType || null,
          triggerType: dec?.block_meta?.entryTrigger?.triggerType || null,
          discoveryScore: Number(intel?.fused?.discoveryScore ?? dec?.predictiveScore ?? dec?.confidence ?? 0),
          predictiveScore: Number(dec?.predictiveScore ?? intel?.predictiveScore ?? 0),
          note: 'capital_backpressure',
        }).catch(() => null);
      }
      console.log(`  💰 [루나] 신호 저장: ${signalId} (${dec.symbol} BUY, status=failed, capital_backpressure)`);
      await notifySignal({ ...signalData, paper: paperMode, exchange, tradeMode: signalData.tradeMode || null, status: SIGNAL_STATUS.FAILED });
      try {
        const content = [
          `${dec.symbol} BUY 신호`,
          `상태: failed/capital_backpressure`,
          `reasonCode: ${reasonCode}`,
          `desired: ${Number(blockMeta.desiredAmount || 0).toFixed(2)} adjusted: ${Number(blockMeta.adjustedAmount || 0).toFixed(2)}`,
        ].join(' | ');
        await storeRag('trades', content, {
          symbol: dec.symbol,
          action: ACTIONS.BUY,
          confidence: dec.confidence,
          exchange,
          paper_mode: paperMode,
          status: SIGNAL_STATUS.FAILED,
          block_code: 'capital_backpressure',
          reason_code: reasonCode,
        }, 'luna');
      } catch (e) {
        console.warn('[luna] RAG 저장 실패 (무시):', e.message);
      }
      failedCount++;
      continue;
    }

    const taAnalysis = _symAnalyses.find(a => a.metadata?.atrRatio != null);
    const atrRatio   = taAnalysis?.metadata?.atrRatio ?? null;
    const currentPrice = taAnalysis?.metadata?.currentPrice ?? null;
    const incidentKey = signalData.traceId || signalData.incidentLink || `luna:${exchange}:${dec.symbol}:${Date.now().toString(36)}`;
    publishAgentHint('luna', ['nemesis', 'oracle'], {
      type: 'entry_context',
      symbol: dec.symbol,
      exchange,
      action: dec.action,
      confidence: dec.confidence,
      strategy_family: dec?.strategy_route?.selectedFamily || null,
      generated_at: new Date().toISOString(),
    }, {
      incidentKey,
      messageType: 'query',
    }).catch(() => {
      console.warn(`  ⚠️ [루나] 교차 힌트 전송 실패 (nemesis/oracle): ${dec.symbol}`);
    });
    let riskResult = null;
    let riskError = null;
    try {
      riskResult = await evaluateSignal(
        {
          ...buildLunaRiskEvaluationSignal(signalData),
          traceId: incidentKey,
          incidentLink: incidentKey,
        },
        { totalUsdt: portfolio.totalAsset, atrRatio, currentPrice, persist: false }
      );
    } catch (e) {
      riskError = e;
    }

    const persistencePlan = buildLunaSignalPersistencePlan(signalData, riskResult, riskError, {
      exchange,
      symbol: dec.symbol,
      action: dec.action,
      decision: dec,
    });
    const persistedSignal = persistencePlan.signalData;
    const signalInsert = await db.insertSignalIfFresh({
      ...persistedSignal,
      status: persistencePlan.status,
      nemesisVerdict: persistencePlan.approvalUpdate?.nemesisVerdict ?? persistedSignal.nemesisVerdict ?? null,
      approvedAt: persistencePlan.approvalUpdate?.approvedAt ?? persistedSignal.approvedAt ?? null,
    });
    const signalId = signalInsert.id;
    if (signalInsert.duplicate) {
      console.log(`  ⏭️ [루나] 최근 중복 신호 스킵: ${dec.symbol} ${dec.action} (${signalInsert.dedupeWindowMinutes}분 내 기존 signal=${signalId})`);
      continue;
    }

    if (persistencePlan.blockUpdate) {
      await db.updateSignalBlock(signalId, persistencePlan.blockUpdate).catch((error) => {
        console.warn(`  ⚠️ [루나] ${dec.symbol}: block meta 저장 실패 (${error.message})`);
      });
    }
    if (intelligentFlags.phases.reflectionEnabled) {
      const intel = intelligentBySymbol.get(dec.symbol) || {};
      await recordDiscoveryAttribution({
        signalId,
        source: intel?.discoverySeed?.source || dec?.block_meta?.discoveryContext?.source || null,
        setupType: dec?.setup_type || dec?.strategy_route?.setupType || dec?.strategyRoute?.setupType || null,
        triggerType: dec?.block_meta?.entryTrigger?.triggerType || null,
        discoveryScore: Number(intel?.fused?.discoveryScore ?? dec?.predictiveScore ?? dec?.confidence ?? 0),
        predictiveScore: Number(dec?.predictiveScore ?? intel?.predictiveScore ?? 0),
        note: persistencePlan.status,
      }).catch(() => null);
    }

    console.log(`  ✅ [루나] 신호 저장: ${signalId} (${dec.symbol} ${dec.action}, status=${persistencePlan.status})`);
    await notifySignal({ ...persistedSignal, paper: paperMode, exchange, tradeMode: persistedSignal.tradeMode || null, status: persistencePlan.status });

    // RAG 저장: 투자 신호 이력을 rag_trades에 학습 데이터로 기록
    try {
      const content = [
        `${dec.symbol} ${dec.action} 신호`,
        `상태: ${persistencePlan.status}`,
        `신뢰도: ${dec.confidence || '?'}`,
        `판단: ${(dec.reasoning || '').slice(0, 100)}`,
      ].join(' | ');
      await storeRag('trades', content, {
        symbol:     dec.symbol,
        action:     dec.action,
        confidence: dec.confidence,
        exchange,
        paper_mode: paperMode,
        status: persistencePlan.status,
      }, 'luna');
    } catch (e) {
      console.warn('[luna] RAG 저장 실패 (무시):', e.message);
    }

    if (riskError) {
      console.warn(`  ⚠️ [네메시스] 리스크 평가 실패 → failed 저장: ${riskError.message}`);
      failedCount++;
      continue;
    }

    if (riskResult?.approved) {
      console.log(`  ✅ [네메시스] 승인: $${riskResult.adjustedAmount}${riskResult.tpPrice ? ` TP=${riskResult.tpPrice?.toFixed(2)} SL=${riskResult.slPrice?.toFixed(2)}` : ''}`);
      approvedCount++;
      results.push({
        symbol: dec.symbol, signalId, ...dec,
        adjustedAmount: riskResult.adjustedAmount,
        // 동적 TP/SL (applied=true일 때만 전달)
        tpPrice: riskResult.tpPrice ?? null,
        slPrice: riskResult.slPrice ?? null,
        tpslSource: riskResult.tpslSource ?? null,
      });
    } else {
      console.log(`  🚫 [네메시스] 거부: ${riskResult?.reason || 'risk_rejected'}`);
      rejectedCount++;
    }
  }

  if (intelligentFlags.phases.reflectionEnabled) {
    const reflection = await buildDiscoveryReflectionSummary({ days: 14, exchange }).catch(() => null);
    const top = reflection?.bySource?.[0] || null;
    if (top) {
      const reportGate = await shouldPublishDiscoveryReflectionReport({
        exchange,
        reportMeta: top,
      }).catch(() => ({ publish: false, reason: 'reflection_state_unavailable' }));
      if (reportGate?.publish) {
        publishAlert({
          from_bot: 'luna',
          event_type: 'report',
          alert_level: 1,
          message: `🪞 [루나 Reflection] ${exchange} 최근14일 source=${top.source} closed=${top.closed} winRate=${(Number(top.avgWinRate || 0) * 100).toFixed(1)}% avgPnL=${Number(top.avgPnlPct || 0).toFixed(2)}%`,
        });
      }
    }
  }

  console.log(`\n✅ [루나] 완료 — 승인 ${approvedCount}개 / 거부 ${rejectedCount}개 / 실패 ${failedCount}개`);
  return results;
}

// CLI 실행
if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: async () => {
      const args     = process.argv.slice(2);
      const symArg   = args.find(a => a.startsWith('--symbols='));
      const symbols  = symArg ? symArg.split('=')[1].split(',').map(s => s.trim()) : ['BTC/USDT'];
      const exchange = args.find(a => a.startsWith('--exchange='))?.split('=')[1] || 'binance';
      const inspectContext = args.includes('--inspect-context');
      if (inspectContext) {
        const ctx = await inspectPortfolioContext(exchange);
        console.log(`\n컨텍스트: ${JSON.stringify(ctx, null, 2)}`);
        return [];
      }
      return orchestrate(symbols, exchange);
    },
    onSuccess: async (results) => {
      if (Array.isArray(results)) {
        console.log(`\n결과: ${results.length}개 신호`);
      }
    },
    errorPrefix: '❌ 루나 오류:',
  });
}
