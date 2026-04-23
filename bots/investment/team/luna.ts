// @ts-nocheck
/**
 * team/luna.js — 루나 (오케스트레이터·최종 판단)
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
 * 실행: node team/luna.js --symbols=BTC/USDT,ETH/USDT
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
import { getAvailableBalance, getAvailableUSDT, getOpenPositions, getCapitalConfigWithOverrides } from '../shared/capital-manager.ts';
import { getDomesticBalance } from '../shared/kis-client.ts';
import { getInvestmentRagRuntimeConfig, getLunaRuntimeConfig, getLunaStockStrategyProfile, getPositionReevaluationRuntimeConfig } from '../shared/runtime-config.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { buildAccuracyReport, getEffectiveAnalystWeightProfiles, normalizeWeights } from '../shared/analyst-accuracy.ts';
import { getMarketRegime, formatMarketRegime } from '../shared/market-regime.ts';
import { runBullResearcher } from './zeus.ts';
import { runBearResearcher } from './athena.ts';
import { evaluateSignal } from './nemesis.ts';
import { recommendStrategy } from './argos.ts';

const LUNA_RUNTIME = getLunaRuntimeConfig();
const LUNA_STOCK_PROFILE = getLunaStockStrategyProfile();
const RAG_RUNTIME = getInvestmentRagRuntimeConfig();
const MIN_CONFIDENCE = LUNA_RUNTIME.minConfidence.live;
const PAPER_MIN_CONFIDENCE = LUNA_RUNTIME.minConfidence.paper;
const MAX_POS_COUNT = LUNA_RUNTIME.maxPosCount;
const MAX_DEBATE_SYMBOLS = LUNA_RUNTIME.maxDebateSymbols;
const STOCK_ORDER_DEFAULTS = LUNA_RUNTIME.stockOrderDefaults;
const ANALYST_WEIGHT_CONFIG = LUNA_RUNTIME.analystWeights || {};

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

function getStockOrderSpec(exchange) {
  return STOCK_ORDER_DEFAULTS[exchange] || null;
}

function formatStockAmountRule(exchange) {
  const spec = getStockOrderSpec(exchange);
  if (!spec) return 'amount_usdt 범위 정보 없음';
  const unit = exchange === 'kis' ? 'KRW 주문금액' : 'USD 주문금액';
  return `amount_usdt는 ${unit}이며 ${spec.min}~${spec.max} 범위`;
}

function normalizeDecisionAmount(exchange, action, amount) {
  const spec = getStockOrderSpec(exchange);
  if (!spec) return amount;
  const fallback = action === ACTIONS.SELL ? spec.sellDefault : spec.buyDefault;
  const numeric = Number.isFinite(Number(amount)) ? Number(amount) : fallback;
  return Math.max(spec.min, Math.min(spec.max, Math.round(numeric)));
}

function buildAnalystWeights(exchange = 'binance') {
  const runtimeAnalystWeightConfig = getEffectiveAnalystWeightProfiles();
  const isStock = exchange === 'kis' || exchange === 'kis_overseas';
  const profile = isStock
    ? (isPaperMode() ? runtimeAnalystWeightConfig.stocksPaper : runtimeAnalystWeightConfig.stocksLive)
    : runtimeAnalystWeightConfig.crypto;
  const fallback = runtimeAnalystWeightConfig.default || {};
  const sentinelBase = profile?.sentinel
    ?? ((profile?.sentiment ?? fallback.sentiment ?? ANALYST_WEIGHTS[ANALYST_TYPES.SENTIMENT])
      + (profile?.news ?? fallback.news ?? ANALYST_WEIGHTS[ANALYST_TYPES.NEWS])) / 2;

  return normalizeWeights({
    [ANALYST_TYPES.TA_MTF]: profile?.taMtf ?? fallback.taMtf ?? ANALYST_WEIGHTS[ANALYST_TYPES.TA_MTF],
    [ANALYST_TYPES.ONCHAIN]: profile?.onchain ?? fallback.onchain ?? ANALYST_WEIGHTS[ANALYST_TYPES.ONCHAIN],
    [ANALYST_TYPES.MARKET_FLOW]:
      (isStock ? (profile?.marketFlow ?? fallback.marketFlow ?? ANALYST_WEIGHTS[ANALYST_TYPES.MARKET_FLOW]) : 0),
    [ANALYST_TYPES.SENTINEL]: sentinelBase,
    [ANALYST_TYPES.SENTIMENT]: profile?.sentiment ?? fallback.sentiment ?? ANALYST_WEIGHTS[ANALYST_TYPES.SENTIMENT],
    [ANALYST_TYPES.NEWS]: profile?.news ?? fallback.news ?? ANALYST_WEIGHTS[ANALYST_TYPES.NEWS],
  });
}

export function getMinConfidence(exchange) {
  if (exchange === 'kis' || exchange === 'kis_overseas') {
    return isPaperMode()
      ? LUNA_STOCK_PROFILE.minConfidence.paper
      : LUNA_STOCK_PROFILE.minConfidence.live;
  }
  if (isPaperMode()) return PAPER_MIN_CONFIDENCE[exchange] ?? MIN_CONFIDENCE[exchange] ?? 0.60;
  return MIN_CONFIDENCE[exchange] ?? 0.60;
}

export function getDebateLimit(exchange, symbolCount = 0) {
  if (!isPaperMode()) {
    if (exchange === 'binance') {
      const count = Math.max(0, Number(symbolCount || 0));
      const rules = Array.isArray(LUNA_RUNTIME.dynamicDebateLimits?.cryptoLive)
        ? [...LUNA_RUNTIME.dynamicDebateLimits.cryptoLive]
            .map((rule) => ({
              minSymbols: Math.max(0, Number(rule?.minSymbols || 0)),
              limit: Math.max(1, Number(rule?.limit || MAX_DEBATE_SYMBOLS)),
            }))
            .sort((a, b) => a.minSymbols - b.minSymbols)
        : [];
      let limit = MAX_DEBATE_SYMBOLS;
      for (const rule of rules) {
        if (count >= rule.minSymbols) {
          limit = Math.max(limit, rule.limit);
        }
      }
      return limit;
    }
    return MAX_DEBATE_SYMBOLS;
  }
  if (exchange === 'kis' || exchange === 'kis_overseas') return 1;
  return MAX_DEBATE_SYMBOLS;
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
  const fused = fuseSignals(analyses, analystWeights);
  if (fused.hasConflict) return true;
  if (exchange === 'kis' || exchange === 'kis_overseas') {
    const threshold = isPaperMode()
      ? LUNA_STOCK_PROFILE.debateThresholds.paper
      : LUNA_STOCK_PROFILE.debateThresholds.live;
    return fused.averageConfidence < threshold.minAverageConfidence || Math.abs(fused.fusedScore) < threshold.minAbsScore;
  }
  return fused.averageConfidence < LUNA_RUNTIME.debateThresholds.crypto.minAverageConfidence
    || Math.abs(fused.fusedScore) < LUNA_RUNTIME.debateThresholds.crypto.minAbsScore;
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

// ─── 시스템 프롬프트 ────────────────────────────────────────────────

const LUNA_SYSTEM_CRYPTO = `당신은 루나(Luna), 루나팀의 수석 오케스트레이터다.
멀티타임프레임 TA·온체인·뉴스·감성·강세/약세 2라운드 토론 결과를 종합해 최종 매매 신호를 결정한다.

핵심 원칙:
- 기본은 진입 검토 — HOLD는 명확한 충돌 신호나 기대값 부족이 분명할 때만
- 장기(4h)와 단기(1h)가 같은 방향이거나, 단기 추세(15m/1h)가 강하고 4h가 중립이면 진입 검토
- 2라운드 토론 후에도 우세 신호가 매우 약할 때만 HOLD
- confidence 0.38 미만이면 HOLD 우선, 0.38~0.52 구간은 소액 분할 진입을 우선 검토
- 동일 방향의 유망 심볼이 여러 개면 1개만 고집하지 말고 분산 진입 기회를 검토
- 단기 급등 추격보다 재진입 가능한 추세 지속 종목을 선호
- 2개 이상 분석가가 같은 방향이고 명확한 반대 근거가 약하면 HOLD 대신 소규모 진입을 우선 검토

응답 형식 (JSON만, 다른 텍스트 없이):
{"action":"HOLD","amount_usdt":100,"confidence":0.6,"reasoning":"근거 60자 이내"}

amount_usdt 범위: 80~400 USDT`.trim();

function buildLunaStockSystem() {
  return `당신은 루나(Luna), 루나팀의 수석 오케스트레이터다. (국내/해외 주식 — ${LUNA_STOCK_PROFILE.promptTag})
멀티타임프레임 TA·뉴스·감성·강세/약세 2라운드 토론 결과를 종합해 최종 매매 신호를 결정한다.

핵심 원칙 (${LUNA_STOCK_PROFILE.promptTag}):
- 기본 전략은 진입 — HOLD는 명확한 반대 신호가 있을 때만
- 단기(1h) 방향이 긍정적이면 BUY 검토, 명확한 하락 추세일 때만 SELL/HOLD
- 2라운드 토론 후 강세가 약세보다 설득력 있으면 BUY
- confidence ${getMinConfidence('kis').toFixed(2)} 이상이면 진입 검토 (${getMinConfidence('kis').toFixed(2)} 미만만 HOLD)
- 소규모 분할 진입으로 리스크 분산

응답 형식 (JSON만, 다른 텍스트 없이):
{"action":"BUY","amount_usdt":300000,"confidence":0.5,"reasoning":"근거 60자 이내"}

중요:
- exchange='kis'면 amount_usdt는 KRW 주문금액으로 해석한다
- exchange='kis_overseas'면 amount_usdt는 USD 주문금액으로 해석한다
- 국내주식(kis) amount_usdt 범위: ${getStockOrderSpec('kis')?.min}~${getStockOrderSpec('kis')?.max}
- 해외주식(kis_overseas) amount_usdt 범위: ${getStockOrderSpec('kis_overseas')?.min}~${getStockOrderSpec('kis_overseas')?.max}`.trim();
}

function getLunaSystem(exchange) {
  if (exchange === 'kis' || exchange === 'kis_overseas') return buildLunaStockSystem();
  return LUNA_SYSTEM_CRYPTO;
}

const LUNA_EXIT_SYSTEM = `당신은 루나(Luna), 루나팀의 포지션 청산 전문가다.
현재 보유 포지션을 분석해 SELL 또는 HOLD를 판단한다.

핵심 원칙:
- 각 포지션에 대해 반드시 SELL 또는 HOLD를 결정한다
- SELL은 수익 실현, 손절, 추세 약화, 시장 레짐 악화, 장기 보유 재평가 중 하나 이상 근거가 있어야 한다
- HOLD는 아직 청산보다 보유 기대값이 높을 때만 선택한다
- 손실 포지션은 HOLD보다 SELL을 우선 검토한다
- 72시간 이상 보유했거나 손실폭이 -5% 이하이면 SELL 쪽으로 강하게 기울어야 한다
- 분석가 다수가 SELL/HOLD이고 미실현손익이 음수면 HOLD를 남발하지 않는다
- reasoning은 한국어 80자 이내로 간결하게 작성한다
- confidence는 0~1 범위의 숫자다

응답 형식 (JSON만, 다른 텍스트 없이):
{"decisions":[{"symbol":"BTC/USDT","action":"SELL","confidence":0.72,"reasoning":"추세 약화 및 목표 수익 달성"}],"exit_view":"전체 포지션 판단 요약"}`.trim();

// PORTFOLIO_PROMPT는 함수로 생성 — 실제 심볼 목록을 예시에 반영해 LLM 환각 방지
function buildPortfolioPrompt(symbols, exchange = 'binance', exitSummary = null) {
  const exampleSymbol = symbols[0] || 'SYMBOL';
  const isStock       = exchange === 'kis' || exchange === 'kis_overseas';
  const minConf       = getMinConfidence(exchange);
  const maxPosPct     = isStock ? `${Math.round((LUNA_STOCK_PROFILE.portfolioMaxPositionPct || 0.30) * 100)}%` : '20%';
  const dailyLoss     = isStock ? `${Math.round((LUNA_STOCK_PROFILE.portfolioDailyLossPct || 0.10) * 100)}%` : '5%';
  const stockSpec     = getStockOrderSpec(exchange);
  const exampleAmount = isStock ? (stockSpec?.buyDefault ?? 500) : 100;
  const amountRule    = isStock
    ? formatStockAmountRule(exchange)
    : 'amount_usdt는 USDT 주문금액';
  const diversificationRule = isStock
    ? ''
    : '\n- 암호화폐는 동일 시간대에 기대값이 있는 심볼을 1개만 고집하지 말고 2~4개 분산 진입 후보를 유지\n- HOLD 남발 금지: 명확한 반대 근거가 없으면 BUY/SELL/HOLD 중 기대값이 가장 높은 쪽을 선택\n- 2개 이상 후보의 기대값이 비슷하면 하나만 선택하지 말고 소규모 분산 진입 결정을 우선\n- BUY/SELL 후보가 있는데 전부 HOLD로 돌리지 말고, 가장 우세한 방향의 심볼부터 우선 배치';
  const exitRule = exitSummary?.closedCount
    ? '\n- 방금 EXIT Phase에서 청산된 포지션과 회수된 현금을 반영해 가용 자산을 재배치하되, 방금 청산한 동일 심볼 재진입은 더 보수적으로 판단'
    : '';
  return `당신은 루나팀 수석 펀드매니저입니다. 개별 심볼 신호를 포트폴리오 맥락에서 검토합니다.${isStock ? ` (주식 — ${LUNA_STOCK_PROFILE.promptTag})` : ''}

분석 대상 심볼: ${symbols.join(', ')}
⚠️ 반드시 위 심볼 중에서만 결정을 내려야 합니다. 다른 심볼은 절대 포함하지 마세요.

응답: JSON만 (코드블록 없음):
{"decisions":[{"symbol":"${exampleSymbol}","action":"BUY","amount_usdt":${exampleAmount},"confidence":0.7,"reasoning":"판단 근거 (한국어 60자)"}],"portfolio_view":"전체 시황 평가 (80자)","risk_level":"LOW"|"MEDIUM"|"HIGH"}

제약:
- 단일 포지션: 총자산 ${maxPosPct} 이하
- 동시 포지션: 최대 ${MAX_POS_COUNT}개
- 일손실 한도: ${dailyLoss}
- confidence ${minConf} 미만: HOLD
- ${amountRule}${exitRule}
- 가용 현금 범위를 초과하는 매수 금지${diversificationRule}`;
}

// ─── 시그널 융합 ─────────────────────────────────────────────────────

const ANALYST_WEIGHTS = {
  [ANALYST_TYPES.TA_MTF]:    0.35,
  [ANALYST_TYPES.ONCHAIN]:   0.25,
  [ANALYST_TYPES.MARKET_FLOW]: 0.18,
  [ANALYST_TYPES.SENTINEL]:  0.35,
  [ANALYST_TYPES.SENTIMENT]: 0.20,
  [ANALYST_TYPES.NEWS]:      0.15,
};
const DIRECTION_MAP = { BUY: 1, SELL: -1, HOLD: 0 };

function getSentinelFusionProfile(analysis = {}) {
  const metadata = analysis?.metadata && typeof analysis.metadata === 'object' ? analysis.metadata : {};
  const quality = metadata?.quality && typeof metadata.quality === 'object' ? metadata.quality : {};
  const sourceBreakdown = metadata?.sourceBreakdown && typeof metadata.sourceBreakdown === 'object'
    ? metadata.sourceBreakdown
    : {};
  const tierWeights = metadata?.sourceTierWeights && typeof metadata.sourceTierWeights === 'object'
    ? metadata.sourceTierWeights
    : { tier2: 0.65, tier3: 0.35 };

  const newsConfidence = Number(sourceBreakdown?.news?.confidence || metadata?.news?.confidence || 0);
  const communityConfidence = Number(sourceBreakdown?.community?.confidence || metadata?.community?.confidence || 0);
  const newsSignal = String(sourceBreakdown?.news?.signal || metadata?.news?.signal || '').trim().toUpperCase();
  const communitySignal = String(sourceBreakdown?.community?.signal || metadata?.community?.signal || '').trim().toUpperCase();
  const weightedConfidenceBase =
    (newsConfidence * Number(tierWeights?.tier2 || 0.65))
    + (communityConfidence * Number(tierWeights?.tier3 || 0.35));

  let confidenceMultiplier = 1;
  let weightMultiplier = 1;

  if (quality?.status === 'degraded') {
    confidenceMultiplier *= 0.82;
    weightMultiplier *= 0.9;
  } else if (quality?.status === 'insufficient') {
    confidenceMultiplier *= 0.6;
    weightMultiplier *= 0.7;
  }

  if (
    newsSignal
    && communitySignal
    && newsSignal !== ACTIONS.HOLD
    && communitySignal !== ACTIONS.HOLD
    && newsSignal !== communitySignal
  ) {
    confidenceMultiplier *= 0.88;
    weightMultiplier *= 0.92;
  }

  const effectiveConfidence = Math.max(
    0,
    Math.min(
      1,
      Number(((weightedConfidenceBase || Number(analysis?.confidence || 0.5)) * confidenceMultiplier).toFixed(4)),
    ),
  );

  return {
    effectiveConfidence,
    weightMultiplier: Number(weightMultiplier.toFixed(4)),
    qualityStatus: quality?.status || 'unknown',
  };
}

function getFusionInput(type, analysis, weights) {
  const baseWeight = Number(weights[type] ?? 0.05);
  const direction = DIRECTION_MAP[analysis.signal] ?? 0;
  let confidence = Math.max(0, Math.min(1, analysis.confidence || 0.5));
  let weight = baseWeight;

  if (type === ANALYST_TYPES.SENTINEL) {
    const sentinelProfile = getSentinelFusionProfile(analysis);
    confidence = sentinelProfile.effectiveConfidence;
    weight = Number((baseWeight * sentinelProfile.weightMultiplier).toFixed(4));
  }

  return { weight, direction, confidence };
}

/**
 * 분석가별 신호를 가중 평균으로 융합
 * @param {Array} analyses  DB에서 읽은 분석 결과 배열
 * @returns {{ fusedScore, averageConfidence, hasConflict, recommendation }}
 */
export function fuseSignals(analyses, weights = ANALYST_WEIGHTS) {
  // 같은 타입이 여러 개면 첫 번째(최신)만 사용
  const byType = new Map();
  for (const a of analyses) {
    if (!byType.has(a.analyst)) byType.set(a.analyst, a);
  }

  let weightedScore = 0, totalWeight = 0;
  const directions = [];
  for (const [type, analysis] of byType) {
    const { weight, direction, confidence: conf } = getFusionInput(type, analysis, weights);
    weightedScore  += direction * conf * weight;
    totalWeight    += weight;
    if (direction !== 0) directions.push(direction);
  }

  const fusedScore        = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const averageConfidence = byType.size > 0
    ? [...byType.entries()].reduce((s, [type, analysis]) => s + getFusionInput(type, analysis, weights).confidence, 0) / byType.size
    : 0.5;
  const hasConflict    = directions.some(d => d > 0) && directions.some(d => d < 0);
  const recommendation =
    hasConflict && Math.abs(fusedScore) < 0.3 ? 'HOLD' :
    fusedScore  >  0.2                        ? 'LONG' :
    fusedScore  < -0.2                        ? 'SHORT' : 'HOLD';

  return { fusedScore, averageConfidence, hasConflict, recommendation };
}

function buildCryptoPortfolioFallback(symbolDecisions, portfolio) {
  const candidates = symbolDecisions
    .filter(dec => dec.action !== ACTIONS.HOLD && (dec.confidence || 0) >= 0.38)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  if (candidates.length === 0) return null;

  const slotsAvailable = Math.max(1, Math.min(3, MAX_POS_COUNT - (portfolio?.positionCount || 0)));
  const portfolioCap = Math.max(80, Math.floor((portfolio?.totalAsset || 0) * 0.12));
  const budgetCap = Math.max(80, Math.floor(((portfolio?.usdtFree || 0) / Math.max(1, slotsAvailable)) * 0.8));
  const baseAmount = Math.max(80, Math.min(180, Math.min(portfolioCap, budgetCap)));
  const decisions = candidates.slice(0, slotsAvailable).map((dec, idx) => ({
    symbol: dec.symbol,
    action: dec.action,
    amount_usdt: Math.max(80, Math.min(220, baseAmount + (idx === 0 ? 20 : 0))),
    confidence: Math.max(0.40, Math.min(0.72, dec.confidence || 0.4)),
    reasoning: `crypto fallback 분산진입 | ${dec.reasoning || '우세 신호 보존'}`.slice(0, 120),
  }));

  return {
    decisions,
    portfolio_view: 'LLM 포트폴리오 판단 공백 보정 — crypto 분산진입 fallback',
    risk_level: 'MEDIUM',
    source: 'crypto_portfolio_fallback',
  };
}

function buildStockValidationPortfolioFallback(symbolDecisions, exchange, reason = 'llm_emergency_stop') {
  if (!isValidationTradeMode()) return null;
  const candidates = symbolDecisions
    .filter(dec => dec.action !== ACTIONS.HOLD && (dec.confidence || 0) >= 0.18)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  if (candidates.length === 0) return null;
  const spec = getStockOrderSpec(exchange);
  const starterAmount = normalizeDecisionAmount(exchange, ACTIONS.BUY, spec?.min ?? spec?.buyDefault);
  return {
    decisions: candidates.slice(0, 2).map((dec) => ({
      symbol: dec.symbol,
      action: dec.action,
      amount_usdt: starterAmount,
      confidence: Math.max(0.22, Math.min(0.55, dec.confidence || 0.22)),
      reasoning: `주식 validation 긴급 차단 starter fallback | ${dec.reasoning || '우세 신호 유지'}`.slice(0, 120),
    })),
    portfolio_view: `LLM 긴급 차단 fallback — 주식 validation starter 유지 (${reason})`,
    risk_level: 'MEDIUM',
    source: 'stock_validation_emergency_fallback',
    block_reason: reason,
  };
}

function buildEmergencyPortfolioFallback(symbolDecisions, portfolio, exchange, reason = 'llm_emergency_stop') {
  if (exchange === 'binance') {
    const cryptoFallback = buildCryptoPortfolioFallback(symbolDecisions, portfolio);
    if (cryptoFallback) {
      return {
        ...cryptoFallback,
        portfolio_view: `LLM 긴급 차단 fallback — crypto 분산진입 유지 (${reason})`,
        source: 'llm_emergency_stop_crypto_fallback',
        block_reason: reason,
      };
    }
  }
  if ((exchange === 'kis' || exchange === 'kis_overseas') && isValidationTradeMode()) {
    const stockFallback = buildStockValidationPortfolioFallback(symbolDecisions, exchange, reason);
    if (stockFallback) return stockFallback;
  }

  return {
    decisions: symbolDecisions.map((dec) => ({
      ...dec,
      action: ACTIONS.HOLD,
      amount_usdt: 0,
      reasoning: `LLM 긴급 차단 보수 fallback | ${dec.reasoning || '신규 진입 보류'}`.slice(0, 120),
    })),
    portfolio_view: `LLM 긴급 차단 fallback — 신규 포지션 보류 (${reason})`,
    risk_level: 'HIGH',
    source: 'llm_emergency_stop_hold_fallback',
    block_reason: reason,
  };
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

async function loadAdaptiveAnalystWeights(exchange = 'binance') {
  const baseWeights = buildAnalystWeights(exchange);
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

async function buildStrategySection(symbol, exchange) {
  try {
    const strat = await recommendStrategy(symbol, exchange);
    if (!strat) return '';
    return `\n\n[참고 전략 — 아르고스]\n${strat.strategy_name}: ${strat.entry_condition || '진입 조건 없음'} (품질점수 ${strat.quality_score?.toFixed(2)})`;
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
  const [strategySection, ragContext, regimeSection] = await Promise.all([
    buildStrategySection(symbol, exchange),
    buildRagContext(symbol, summary),
    buildRegimeSection(exchange),
  ]);
  const userMsg = `심볼: ${symbol} (${label})\n\n분석 결과:\n${summary}${buildFusedSection(fused)}${buildReviewSection(reviewHint)}${buildDebateSection(debate)}${strategySection}${ragContext}${regimeSection}\n\n최종 매매 신호:`;

  return {
    summary,
    label,
    fused,
    reviewHint,
    userMsg,
  };
}

async function buildPortfolioDecisionPromptParts(symbolDecisions, portfolio, exchange = 'binance', exitSummary = null) {
  const symbols = [...new Set(symbolDecisions.map(s => s.symbol))];
  const signalLines = symbolDecisions
    .map(s => `${s.symbol}: ${s.action} | 확신도 ${((s.confidence || 0) * 100).toFixed(0)}% | ${s.reasoning}`)
    .join('\n');

  let regimeSection = '';
  try {
    const regime = await getMarketRegime(exchange);
    regimeSection = formatMarketRegime(regime);
  } catch {}

  const exitSection = exitSummary?.closedCount
    ? [
        `=== EXIT Phase 결과 ===`,
        `방금 ${exitSummary.closedCount}개 포지션을 청산했습니다.`,
        ...(Array.isArray(exitSummary.closedPositions) ? exitSummary.closedPositions.map(item => {
          const reclaimed = Number(item.reclaimedUsdt || 0);
          const reclaimedText = reclaimed > 0 ? ` | 회수 $${reclaimed.toFixed(2)}` : '';
          return `- ${item.symbol}: ${item.reason || '청산'}${reclaimedText}`;
        }) : []),
        `회수된 USDT: $${Number(exitSummary.reclaimedUsdt || 0).toFixed(2)}`,
        ``,
      ].join('\n')
    : '';

  const userMsg = [
    `=== 포트폴리오 현황 ===`,
    `USDT 가용: $${portfolio.usdtFree.toFixed(2)} | 총자산: $${portfolio.totalAsset.toFixed(2)}`,
    `현재 포지션: ${portfolio.positionCount}/${MAX_POS_COUNT}개`,
    `오늘 P&L: ${(portfolio.todayPnl?.pnl || 0) >= 0 ? '+' : ''}$${(portfolio.todayPnl?.pnl || 0).toFixed(2)}`,
    ``,
    regimeSection,
    regimeSection ? `` : '',
    exitSection,
    `=== 분석가 신호 (${symbols.join(', ')}) ===`,
    signalLines,
    ``,
    `최종 포트폴리오 투자 결정:`,
  ].join('\n');

  return {
    symbols,
    userMsg,
    systemPrompt: buildPortfolioPrompt(symbols, exchange, exitSummary),
  };
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
    parsed.decisions = parsed.decisions.filter(d => allowed.has(d.symbol));
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

function buildCompactExitAnalystSummary(analysesList) {
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

function buildExitPrompt(openPositions, exchange = 'binance') {
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

function normalizeExitDecision(rawDecision, fallbackPosition) {
  const action = String(rawDecision?.action || 'HOLD').toUpperCase();
  return {
    symbol: rawDecision?.symbol || fallbackPosition?.symbol,
    action: action === ACTIONS.SELL ? ACTIONS.SELL : ACTIONS.HOLD,
    confidence: Math.max(0, Math.min(1, Number(rawDecision?.confidence ?? 0.5))),
    reasoning: String(rawDecision?.reasoning || '').trim().slice(0, 180) || 'EXIT 판단 근거 없음',
    exit_type: 'normal_exit',
  };
}

function getExitGuardConfig() {
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

function getPositionPnlPct(position) {
  const avgPrice = Number(position?.avg_price || 0);
  const currentPrice = Number(position?.current_price || avgPrice || 0);
  if (!(avgPrice > 0)) return 0;
  return ((currentPrice - avgPrice) / avgPrice) * 100;
}

function countExitVotes(position) {
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

function shouldDowngradeEarlyExit(position, decision) {
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

function applyExitGuard(position, decision) {
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

function buildExitFallback(openPositions) {
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

async function enrichExitPositions(openPositions, exchange = 'binance') {
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

function normalizeExitDecisionResult(parsed, enrichedPositions) {
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

function buildVoteFallbackDecision(analyses, exchange = 'binance', reason = '분석가 투표 기반 fallback') {
  const votes   = analyses.filter(a => a.signal !== 'HOLD').map(a => a.signal === 'BUY' ? 1 : -1);
  const avgConf = analyses.reduce((s, a) => s + (a.confidence || 0), 0) / (analyses.length || 1);
  const vote    = votes.reduce((a, b) => a + b, 0);
  const isStock = exchange === 'kis' || exchange === 'kis_overseas';
  const stockBuyThreshold = isValidationTradeMode() ? 0.18 : 0.3;
  const action  = isStock
    ? (vote >= 0 && avgConf >= stockBuyThreshold ? ACTIONS.BUY : vote < -1 ? ACTIONS.SELL : ACTIONS.HOLD)
    : (vote > 0 ? ACTIONS.BUY : vote < 0 ? ACTIONS.SELL : ACTIONS.HOLD);
  const fallbackAmt = isStock
    ? normalizeDecisionAmount(exchange, action, getStockOrderSpec(exchange)?.buyDefault)
    : 100;
  return { action, amount_usdt: fallbackAmt, confidence: avgConf, reasoning: reason };
}

function buildEmergencySymbolFallbackDecision(analyses, exchange, fused) {
  if (exchange === 'binance' && !fused.hasConflict) {
    if (fused.recommendation === 'LONG' && fused.averageConfidence >= 0.24 && fused.fusedScore >= 0.12) {
      return {
        action: ACTIONS.BUY,
        amount_usdt: 80,
        confidence: Math.max(0.40, Math.min(0.62, fused.averageConfidence)),
        reasoning: '분석가 합의 기반 긴급 차단 starter BUY',
      };
    }
    if (fused.recommendation === 'SHORT' && fused.averageConfidence >= 0.24 && Math.abs(fused.fusedScore) >= 0.12) {
      return {
        action: ACTIONS.SELL,
        amount_usdt: 80,
        confidence: Math.max(0.38, Math.min(0.58, fused.averageConfidence)),
        reasoning: '분석가 합의 기반 긴급 차단 starter SELL',
      };
    }
  }
  if ((exchange === 'kis' || exchange === 'kis_overseas') && isValidationTradeMode() && !fused.hasConflict) {
    const spec = getStockOrderSpec(exchange);
    const starterAmount = normalizeDecisionAmount(exchange, ACTIONS.BUY, spec?.min ?? spec?.buyDefault);
    if (fused.recommendation === 'LONG' && fused.averageConfidence >= 0.16 && fused.fusedScore >= 0.06) {
      return {
        action: ACTIONS.BUY,
        amount_usdt: starterAmount,
        confidence: Math.max(0.22, Math.min(0.52, fused.averageConfidence)),
        reasoning: '주식 validation 긴급 차단 starter BUY',
      };
    }
  }
  return buildVoteFallbackDecision(analyses, exchange, '분석가 투표 기반 (긴급 차단 fallback)');
}

// ─── 개별 심볼 LLM 판단 ────────────────────────────────────────────

export async function getSymbolDecision(symbol, analyses, exchange = 'binance', debate = null, analystWeights = ANALYST_WEIGHTS) {
  const { fused, reviewHint, userMsg } = await buildSymbolDecisionPromptParts({
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
    };
  }

  const fastPath = buildFastPathDecision(fused, exchange);
  if (fastPath) {
    const boostedConfidence = Math.max(0, Math.min(1, (fastPath.confidence || fused.averageConfidence) + reviewHint.delta));
    return {
      ...fastPath,
      confidence: boostedConfidence,
      reasoning: reviewHint.notes.length > 0
        ? `${fastPath.reasoning} | 리뷰:${reviewHint.notes.join(', ')}`.slice(0, 180)
        : fastPath.reasoning,
    };
  }

  // Shadow Mode 래핑 (mode: 'shadow' 고정 — TEAM_MODE.luna='off' 무시)
  let shadowResult;
  try {
    shadowResult = await shadow.evaluate({
      team:      'luna',
      context:   'symbol_decision',
      input:     userMsg,
      ruleEngine: async () => {
        const raw    = await callLLMWithHub('luna', getLunaSystem(exchange), userMsg, cachedCallLLM, 256, { symbol });
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
  return adjusted;  // ruleResult (기존 Groq 판단) 반환, shadow는 shadow_log에만 기록
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
    raw = await callLLMWithHub('luna', systemPrompt, userMsg, callLLM, 768);
  } catch (err) {
    if (String(err?.message || '').includes('LLM 긴급 차단 중')) {
      console.warn(`[luna] portfolio decision LLM 긴급 차단 fallback 적용 (${exchange}): ${err.message}`);
      return buildEmergencyPortfolioFallback(symbolDecisions, portfolio, exchange, err.message);
    }
    throw err;
  }

  return normalizePortfolioDecisionResult(parseJSON(raw), symbols, exchange, symbolDecisions, portfolio);
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
  const todayPnl   = await db.getTodayPnl();
  const posValue   = positions.reduce((s, p) => s + (p.amount * p.avg_price), 0);
  const usdtFree   = exchange === 'binance'
    ? await getAvailableUSDT().catch(() => 0)
    : exchange === 'kis'
      ? await getDomesticBalance().then(b => Number(b?.dnca_tot_amt || 0)).catch(() => 0)
      : 0;
  const availableBalance = exchange === 'binance'
    ? await getAvailableBalance().catch(() => usdtFree)
    : usdtFree;
  const totalAsset = exchange === 'binance'
    ? availableBalance + posValue
    : usdtFree + posValue;
  // 사이클별 자산 스냅샷 기록 (드로우다운 추적용)
  if (exchange === 'binance') {
    try { await db.insertAssetSnapshot(totalAsset, usdtFree); } catch {}
  }
  return { usdtFree, totalAsset, positionCount: positions.length, todayPnl, positions };
}

export async function inspectPortfolioContext(exchange = 'binance') {
  return buildPortfolioContext(exchange);
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
export async function orchestrate(symbols, exchange = 'binance', params = null) {
  const label           = exchange === 'kis_overseas' ? '미국주식' : exchange === 'kis' ? '국내주식' : '암호화폐';
  const results         = [];
  let debateCount          = 0;
  const portfolio          = await buildPortfolioContext(exchange);
  const { weights: analystWeights, report: accuracyReport } = await loadAdaptiveAnalystWeights(exchange);
  const symbolDecisions    = [];
  const symbolAnalysesMap  = new Map(); // symbol → analyses (상관관계 기록용)

  console.log(`\n🌙 [루나] ${label} 오케스트레이션 시작 — ${symbols.join(', ')}`);
  console.log(`  ⚖️ [루나] 분석가 가중치: TA ${analystWeights[ANALYST_TYPES.TA_MTF].toFixed(2)} | 온체인 ${analystWeights[ANALYST_TYPES.ONCHAIN].toFixed(2)} | sentinel ${analystWeights[ANALYST_TYPES.SENTINEL].toFixed(2)} | 감성 ${analystWeights[ANALYST_TYPES.SENTIMENT].toFixed(2)} | 뉴스 ${analystWeights[ANALYST_TYPES.NEWS].toFixed(2)}`);

  for (const symbol of symbols) {
    try {
      const analyses = await db.getRecentAnalysis(symbol, 70, exchange);
      if (analyses.length === 0) {
        console.log(`  ⚠️ [루나] ${symbol}: 분석 결과 없음 → 스킵`);
        continue;
      }

      symbolAnalysesMap.set(symbol, analyses);
      console.log(`  📋 [루나] ${symbol}: ${analyses.length}개 분석 결과`);

      let debate = null;
      const debateLimit = getDebateLimit(exchange, symbols.length);
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

      console.log(`\n  🤖 [루나] ${symbol} 신호 판단 중...`);
      const decision = await getSymbolDecision(symbol, analyses, exchange, debate, analystWeights);
      console.log(`  → ${decision.action} (${((decision.confidence || 0) * 100).toFixed(0)}%) | ${decision.reasoning}`);

      symbolDecisions.push({ symbol, exchange, ...decision });
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
  const portfolio_decision = await getPortfolioDecision(symbolDecisions, portfolio, exchange);
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
      return `${emoji} ${d.action} ${d.symbol} $${d.amount_usdt} (${((d.confidence || 0) * 100).toFixed(0)}%)\n  ${d.reasoning?.slice(0, 80)}`;
    }),
  ].join('\n');
  publishAlert({ from_bot: 'luna', event_type: 'report', alert_level: 1, message: summaryMsg });

  for (const dec of (portfolio_decision.decisions || [])) {
    if (dec.action === ACTIONS.HOLD) continue;
    const runtimeMinConf = getMinConfidence(exchange);
    const minConf = exchange === 'binance'
      ? Math.min(params?.minSignalScore ?? runtimeMinConf, runtimeMinConf)
      : (params?.minSignalScore ?? runtimeMinConf);
    if ((dec.confidence || 0) < minConf) {
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

    let signalData = {
      symbol:          dec.symbol,
      action:          dec.action,
      amountUsdt:      dec.amount_usdt || (exchange === 'kis' || exchange === 'kis_overseas'
        ? getStockOrderSpec(exchange)?.buyDefault
        : 100),
      confidence:      dec.confidence,
      reasoning:       `[루나] ${dec.reasoning}`,
      exchange:        dec.exchange || exchange,
      analystSignals,
    };
    if (exchange === 'kis' || exchange === 'kis_overseas') {
      signalData.amountUsdt = normalizeDecisionAmount(exchange, dec.action, signalData.amountUsdt);
    }

    let existingStrategyProfile = null;
    if (signalData.action === ACTIONS.BUY) {
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
        signalData.amountUsdt = normalizeDecisionAmount(exchange, dec.action, signalData.amountUsdt);
      }
    }

    const { valid, errors } = validateSignal(signalData);
    if (!valid) {
      console.warn(`  ⚠️ [루나] ${dec.symbol} 신호 검증 실패: ${errors.join(', ')}`);
      continue;
    }

    const signalInsert = await db.insertSignalIfFresh(signalData);
    const signalId = signalInsert.id;
    if (signalInsert.duplicate) {
      console.log(`  ⏭️ [루나] 최근 중복 신호 스킵: ${dec.symbol} ${dec.action} (${signalInsert.dedupeWindowMinutes}분 내 기존 signal=${signalId})`);
      continue;
    }

    console.log(`  ✅ [루나] 신호 저장: ${signalId} (${dec.symbol} ${dec.action})`);
    await notifySignal({ ...signalData, paper: paperMode, exchange, tradeMode: signalData.tradeMode || null });

    // RAG 저장: 투자 신호 이력을 rag_trades에 학습 데이터로 기록
    try {
      const content = [
        `${dec.symbol} ${dec.action} 신호`,
        `신뢰도: ${dec.confidence || '?'}`,
        `판단: ${(dec.reasoning || '').slice(0, 100)}`,
      ].join(' | ');
      await storeRag('trades', content, {
        symbol:     dec.symbol,
        action:     dec.action,
        confidence: dec.confidence,
        exchange,
        paper_mode: paperMode,
      }, 'luna');
    } catch (e) {
      console.warn('[luna] RAG 저장 실패 (무시):', e.message);
    }

    try {
      // 최근 TA 분석에서 atrRatio 추출 (아리아가 저장한 메타데이터)
      const taAnalysis = _symAnalyses.find(a => a.metadata?.atrRatio != null);
      const atrRatio   = taAnalysis?.metadata?.atrRatio ?? null;
      const currentPrice = taAnalysis?.metadata?.currentPrice ?? null;

      const riskResult = await evaluateSignal(
        { id: signalId, ...signalData },
        { totalUsdt: portfolio.totalAsset, atrRatio, currentPrice }
      );
      if (riskResult.approved) {
        console.log(`  ✅ [네메시스] 승인: $${riskResult.adjustedAmount}${riskResult.tpPrice ? ` TP=${riskResult.tpPrice?.toFixed(2)} SL=${riskResult.slPrice?.toFixed(2)}` : ''}`);
        await db.updateSignalStatus(signalId, 'approved');
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
        console.log(`  🚫 [네메시스] 거부: ${riskResult.reason}`);
        await db.updateSignalStatus(signalId, 'rejected');
        rejectedCount++;
      }
    } catch (e) {
      console.warn(`  ⚠️ [네메시스] 리스크 평가 실패 → failed 처리: ${e.message}`);
      await db.updateSignalBlock(signalId, {
        status: SIGNAL_STATUS.FAILED,
        reason: `nemesis_error:${String(e.message || 'unknown').slice(0, 180)}`,
        code: 'nemesis_error',
        meta: {
          exchange,
          symbol: dec.symbol,
          action: dec.action,
          amount: dec.amount_usdt,
          confidence: dec.confidence,
        },
      }).catch(() => {});
      failedCount++;
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
