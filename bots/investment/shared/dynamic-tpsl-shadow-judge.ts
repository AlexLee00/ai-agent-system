// @ts-nocheck
import { calculateAtrTpSl } from './tp-sl-auto-setter.ts';
import { computeRegimePolicy } from './regime-strategy-policy.ts';

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max, fallback = min) {
  const n = finiteNumber(value, fallback);
  return Math.max(min, Math.min(max, n));
}

function round(value, digits = 8) {
  return Number(Number(value).toFixed(digits));
}

function normalizePct(value, fallback = 0.02, min = 0.001, max = 0.5) {
  const raw = finiteNumber(value, fallback);
  const ratio = raw > 1 ? raw / 100 : raw;
  return round(clamp(ratio, min, max, fallback), 6);
}

function normalizeExchange(value) {
  const raw = String(value || 'binance').trim().toLowerCase();
  if (raw === 'crypto') return 'binance';
  if (raw === 'domestic') return 'kis';
  if (raw === 'overseas') return 'kis_overseas';
  return ['binance', 'kis', 'kis_overseas'].includes(raw) ? raw : 'binance';
}

function marketForExchange(exchange) {
  if (exchange === 'kis') return 'domestic';
  if (exchange === 'kis_overseas') return 'overseas';
  return 'crypto';
}

function redactSensitiveText(value = '', limit = 240) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer ***')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=:-]{8,}/gi, '$1=***')
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

function redactSensitiveValue(value, depth = 0) {
  if (depth > 6) return '[redacted:depth]';
  if (typeof value === 'string') return redactSensitiveText(value, 1000);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactSensitiveValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, 80).map(([key, item]) => {
        if (/token|secret|password|credential|authorization|api[_-]?key/i.test(key)) return [key, '[redacted]'];
        return [key, redactSensitiveValue(item, depth + 1)];
      }),
    );
  }
  return redactSensitiveText(value, 1000);
}

function priceFromPct(entryPrice, pct, side = 'BUY', direction = 'tp') {
  const entry = finiteNumber(entryPrice, 0);
  const ratio = normalizePct(pct, 0.02);
  if (!(entry > 0)) return null;
  const longSide = String(side || 'BUY').toUpperCase() !== 'SELL';
  const sign = direction === 'tp'
    ? (longSide ? 1 : -1)
    : (longSide ? -1 : 1);
  return round(entry * (1 + sign * ratio));
}

export function buildRuleDynamicTpSl({ candidate = {}, regimeShadow = null, entryShadow = null, context = {} } = {}) {
  const exchange = normalizeExchange(candidate.exchange || entryShadow?.exchange || context.exchange || 'binance');
  const market = candidate.market || entryShadow?.market || marketForExchange(exchange);
  const entryPrice = finiteNumber(
    candidate.entry_price ?? candidate.entryPrice ?? candidate.target_price ?? candidate.targetPrice ?? context.entryPrice,
    0,
  );
  const atr = finiteNumber(
    candidate.atr ?? candidate.atr_value ?? candidate.indicators?.atr ?? candidate.block_meta?.atr ?? context.atr,
    0,
  );
  const side = String(candidate.side || 'BUY').toUpperCase();
  const regime = String(
    regimeShadow?.llm_regime
      || regimeShadow?.llmRegime
      || candidate.regime
      || candidate.market_regime
      || context.regime
      || 'ranging',
  );
  const setupType = candidate.setup_type || candidate.setupType || candidate.strategy_family || entryShadow?.trigger_type || 'unknown';
  const volatility = normalizePct(candidate.volatility ?? candidate.block_meta?.volatility ?? context.volatility, atr > 0 && entryPrice > 0 ? atr / entryPrice : 0.02, 0.001, 0.5);
  const plannedStopLoss = finiteNumber(candidate.stop_loss ?? candidate.stopLoss ?? candidate.sl_price ?? candidate.block_meta?.stop_loss ?? candidate.block_meta?.sl_price, 0);
  const plannedTakeProfit = finiteNumber(candidate.take_profit ?? candidate.takeProfit ?? candidate.tp_price ?? candidate.block_meta?.take_profit ?? candidate.block_meta?.tp_price, 0);
  const policy = computeRegimePolicy({
    market,
    regime,
    setupType,
    sourceQualityScore: context.sourceQualityScore ?? 1,
  });

  if (entryPrice > 0 && plannedStopLoss > 0 && plannedTakeProfit > 0) {
    const slPct = round(Math.abs(entryPrice - plannedStopLoss) / entryPrice, 6);
    const tpPct = round(Math.abs(plannedTakeProfit - entryPrice) / entryPrice, 6);
    const rawRrRatio = tpPct / Math.max(slPct, 0.000001);
    const normalizedRrRatio = Math.abs(rawRrRatio - 2) <= 0.005 ? 2 : rawRrRatio;
    const rrRatio = round(clamp(normalizedRrRatio, 0.5, 6, 2), 4);
    return {
      ok: true,
      source: 'existing_trigger_tpsl',
      market,
      exchange,
      side,
      entryPrice: round(entryPrice),
      atr: atr > 0 ? round(atr) : null,
      regime,
      setupType,
      volatility,
      tpPct,
      slPct,
      takeProfit: round(plannedTakeProfit),
      stopLoss: round(plannedStopLoss),
      rrRatio,
      policy,
      reason: 'rule_dynamic_tpsl_ready',
    };
  }

  const atrPct = entryPrice > 0 && atr > 0 ? atr / entryPrice : 0;
  const baseSlPct = atrPct > 0
    ? clamp(atrPct * (regime === 'volatile' ? 1.25 : regime === 'trending_bear' ? 0.9 : 1.0), 0.006, 0.18, policy.stopLossPct)
    : clamp(policy.stopLossPct || volatility, 0.006, 0.18, 0.04);
  const rrFromPolicy = policy.profitLockPct > 0 && policy.stopLossPct > 0
    ? policy.profitLockPct / policy.stopLossPct
    : 2;
  const rrRatio = round(clamp(Math.max(2, rrFromPolicy), 2, 4, 2), 4);
  const slPct = round(baseSlPct, 6);
  const tpPct = round(clamp(slPct * rrRatio, 0.012, 0.3, slPct * 2), 6);
  const atrCalc = calculateAtrTpSl({
    entryPrice,
    atr: atr > 0 ? atr : entryPrice * slPct,
    side,
    rr: rrRatio,
    atrStopMultiple: atr > 0 ? slPct / Math.max(atrPct, 0.000001) : 1,
  });

  return {
    ok: entryPrice > 0,
    source: atr > 0 ? 'atr_regime_policy' : 'regime_policy_fallback',
    market,
    exchange,
    side,
    entryPrice: round(entryPrice),
    atr: atr > 0 ? round(atr) : null,
    regime,
    setupType,
    volatility,
    tpPct,
    slPct,
    takeProfit: atrCalc.ok ? atrCalc.takeProfit : priceFromPct(entryPrice, tpPct, side, 'tp'),
    stopLoss: atrCalc.ok ? atrCalc.stopLoss : priceFromPct(entryPrice, slPct, side, 'sl'),
    rrRatio,
    policy,
    reason: entryPrice > 0 ? 'rule_dynamic_tpsl_ready' : 'entry_price_missing',
  };
}

export function buildDynamicTpSlJudgeInput({ candidate = {}, regimeShadow = null, entryShadow = null, contextEvidence = {} } = {}) {
  const ruleTpSl = buildRuleDynamicTpSl({ candidate, regimeShadow, entryShadow, context: contextEvidence });
  const debate = entryShadow?.n_agent_debate || entryShadow?.nAgentDebate || {};
  return {
    symbol: candidate.symbol || entryShadow?.symbol || null,
    exchange: ruleTpSl.exchange,
    market: ruleTpSl.market,
    side: ruleTpSl.side,
    entryPrice: ruleTpSl.entryPrice,
    atr: ruleTpSl.atr,
    regime: ruleTpSl.regime,
    setupType: ruleTpSl.setupType,
    volatility: ruleTpSl.volatility,
    ruleTpSl,
    entryShadow: entryShadow ? {
      source: entryShadow.source || 'luna_entry_llm_shadow',
      llmFire: entryShadow.llm_fire ?? entryShadow.llmFire ?? null,
      llmConfidence: finiteNumber(entryShadow.llm_confidence ?? entryShadow.llmConfidence, 0),
      dynamicThreshold: finiteNumber(entryShadow.dynamic_threshold ?? entryShadow.dynamicThreshold, 0),
      deterministicFire: entryShadow.deterministic_fire ?? entryShadow.deterministicFire ?? null,
      deterministicConfidence: finiteNumber(entryShadow.deterministic_confidence ?? entryShadow.deterministicConfidence, 0),
      fixedThreshold: finiteNumber(entryShadow.fixed_threshold ?? entryShadow.fixedThreshold, 0),
      debateFinalFire: debate?.finalVote?.fire ?? null,
      debateConfidence: finiteNumber(debate?.finalVote?.confidence, 0),
      observedAt: entryShadow.observed_at || entryShadow.observedAt || null,
    } : null,
    positionContext: {
      sameSymbolOpen: finiteNumber(contextEvidence.sameSymbolOpen ?? contextEvidence.openPositions?.sameSymbolOpen, 0),
      openPositionCount: finiteNumber(contextEvidence.openPositionCount ?? contextEvidence.openPositions?.openPositionCount, 0),
      exchangeOpenPositionCount: finiteNumber(contextEvidence.exchangeOpenPositionCount ?? contextEvidence.openPositions?.exchangeOpenPositionCount, 0),
    },
  };
}

export function buildDynamicTpSlPrompt(input = {}) {
  const safeInput = redactSensitiveText(JSON.stringify(input, null, 2), 6000);
  return [
    '너는 Luna Phase 3 Dynamic TP/SL Shadow Judge다.',
    '실거래 주문 수정 권한은 없고, 룰 기반 TP/SL과 비교할 shadow TP/SL만 JSON으로 반환한다.',
    'tp_pct와 sl_pct는 0~1 비율 또는 0~100 퍼센트 모두 허용된다.',
    'risk/reward는 가능하면 2:1 이상으로 유지하되, 급변동/약세장 리스크를 설명한다.',
    '응답은 JSON 객체만 반환한다.',
    '{"tp_pct":0.06,"sl_pct":0.03,"rr_ratio":2,"reasoning":"...","risk_assessment":{"risk_level":"medium"}}',
    '',
    safeInput,
  ].join('\n');
}

function extractJson(text = '') {
  if (typeof text === 'object' && text !== null) return text;
  const cleaned = String(text || '').replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('dynamic_tpsl_json_not_found');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function normalizeDynamicTpSlShadowResult(raw, fallback = {}) {
  const parsed = extractJson(raw);
  const entryPrice = finiteNumber(fallback.entryPrice, 0);
  const side = fallback.side || 'BUY';
  const slPct = normalizePct(
    parsed.slPct ?? parsed.sl_pct ?? parsed.stop_loss_pct ?? parsed.stopLossPct,
    fallback.slPct ?? 0.03,
    0.003,
    0.2,
  );
  const tpPct = normalizePct(
    parsed.tpPct ?? parsed.tp_pct ?? parsed.take_profit_pct ?? parsed.takeProfitPct,
    fallback.tpPct ?? Math.max(slPct * 2, 0.02),
    0.006,
    0.35,
  );
  const rrRatio = round(clamp(parsed.rrRatio ?? parsed.rr_ratio ?? (tpPct / Math.max(slPct, 0.000001)), 0.5, 6, 2), 4);
  const riskAssessment = parsed.riskAssessment || parsed.risk_assessment || {};
  return {
    tpPct,
    slPct,
    takeProfit: finiteNumber(parsed.takeProfit ?? parsed.take_profit, 0) > 0
      ? round(parsed.takeProfit ?? parsed.take_profit)
      : priceFromPct(entryPrice, tpPct, side, 'tp'),
    stopLoss: finiteNumber(parsed.stopLoss ?? parsed.stop_loss, 0) > 0
      ? round(parsed.stopLoss ?? parsed.stop_loss)
      : priceFromPct(entryPrice, slPct, side, 'sl'),
    rrRatio,
    reasoning: redactSensitiveText(parsed.reasoning || parsed.rationale || '', 1600),
    riskAssessment: riskAssessment && typeof riskAssessment === 'object' ? redactSensitiveValue(riskAssessment) : {},
    shadowOnly: true,
  };
}

export function compareTpSl(ruleTpSl = {}, llmTpSl = {}) {
  const tpDelta = Math.abs(finiteNumber(ruleTpSl.tpPct, 0) - finiteNumber(llmTpSl.tpPct, 0));
  const slDelta = Math.abs(finiteNumber(ruleTpSl.slPct, 0) - finiteNumber(llmTpSl.slPct, 0));
  return {
    match: tpDelta <= 0.02 && slDelta <= 0.015,
    tpDelta: round(tpDelta, 6),
    slDelta: round(slDelta, 6),
  };
}

export default {
  buildRuleDynamicTpSl,
  buildDynamicTpSlJudgeInput,
  buildDynamicTpSlPrompt,
  normalizeDynamicTpSlShadowResult,
  compareTpSl,
};
