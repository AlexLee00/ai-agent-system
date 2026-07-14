const VALID_EXCHANGES = new Set(['binance', 'kis', 'kis_overseas']);
type AnyRecord = Record<string, any>;
type RlExchange = 'binance' | 'kis' | 'kis_overseas';
type PriceBar = {
  close: number;
  high: number;
  low: number;
  volume: number;
};

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: unknown, min = 0, max = 1, fallback = 0): number {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function round(value: unknown, digits = 4): number {
  return Number(Number(value || 0).toFixed(digits));
}

function parseJsonMaybe(value: unknown, fallback: unknown = {}): unknown {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizeRlExchange(value: unknown): RlExchange {
  const raw = String(value || 'binance').trim().toLowerCase();
  if (raw === 'crypto') return 'binance';
  if (raw === 'domestic') return 'kis';
  if (raw === 'overseas') return 'kis_overseas';
  return VALID_EXCHANGES.has(raw) ? raw as RlExchange : 'binance';
}

export function marketForRlExchange(exchange: unknown): string {
  const normalized = normalizeRlExchange(exchange);
  if (normalized === 'kis') return 'domestic';
  if (normalized === 'kis_overseas') return 'overseas';
  return 'crypto';
}

function normalizeBars(value: unknown = []): PriceBar[] {
  const raw = Array.isArray(value) ? value : [];
  return raw.map((bar: any) => {
    if (Array.isArray(bar)) {
      return {
        close: finiteNumber(bar[4] ?? bar[1], NaN),
        high: finiteNumber(bar[2] ?? bar[4] ?? bar[1], NaN),
        low: finiteNumber(bar[3] ?? bar[4] ?? bar[1], NaN),
        volume: finiteNumber(bar[5], 0),
      };
    }
    return {
      close: finiteNumber(bar.close ?? bar.c ?? bar.price, NaN),
      high: finiteNumber(bar.high ?? bar.h ?? bar.close ?? bar.price, NaN),
      low: finiteNumber(bar.low ?? bar.l ?? bar.close ?? bar.price, NaN),
      volume: finiteNumber(bar.volume ?? bar.v ?? bar.quoteVolume ?? bar.qv, 0),
    };
  }).filter((bar: PriceBar) => Number.isFinite(bar.close) && bar.close > 0).slice(-240);
}

function returnsFromBars(bars: PriceBar[] = []): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = finiteNumber(bars[i - 1]?.close, 0);
    const curr = finiteNumber(bars[i]?.close, 0);
    if (prev > 0 && curr > 0) out.push((curr - prev) / prev);
  }
  return out;
}

function mean(values: number[] = []): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdev(values: number[] = []): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / Math.max(1, values.length - 1);
  return Math.sqrt(variance);
}

function maxDrawdown(bars: PriceBar[] = []): number {
  if (!bars.length) return 0;
  let peak = finiteNumber(bars[0].high ?? bars[0].close, bars[0].close);
  let mdd = 0;
  for (const bar of bars) {
    peak = Math.max(peak, finiteNumber(bar.high ?? bar.close, peak));
    const close = finiteNumber(bar.close, peak);
    if (peak > 0) mdd = Math.max(mdd, (peak - close) / peak);
  }
  return mdd;
}

function returnOverWindow(bars: PriceBar[] = [], window = 20): number {
  const tail = bars.slice(-window);
  if (tail.length < 2) return 0;
  const first = finiteNumber(tail[0].close, 0);
  const last = finiteNumber(tail[tail.length - 1].close, 0);
  return first > 0 ? (last - first) / first : 0;
}

function inferDataHealth({ bars, factorEvidence, statArbEvidence, entryEvidence, regimeEvidence }: {
  bars: PriceBar[];
  factorEvidence: AnyRecord;
  statArbEvidence: AnyRecord;
  entryEvidence: AnyRecord;
  regimeEvidence: AnyRecord;
}): string {
  const available = [
    bars.length >= 20,
    Boolean(factorEvidence?.compositeScore ?? factorEvidence?.composite_score),
    Boolean(statArbEvidence?.confidence),
    Boolean(entryEvidence?.confidence),
    Boolean(regimeEvidence?.confidence),
  ].filter(Boolean).length;
  if (bars.length >= 20 && available >= 3) return 'ready';
  if (bars.length >= 8 || available >= 2) return 'partial';
  return 'insufficient';
}

function actionLabel(value: number): string {
  if (value >= 0.1) return 'buy';
  if (value <= -0.1) return 'sell';
  return 'hold';
}

function modelStatus(context: AnyRecord = {}): string {
  if (context.modelLoaded === true) return 'trained_model_available_shadow';
  if (context.optionalDepsReady === true) return 'ppo_runtime_ready_untrained';
  return 'missing_optional_deps_or_model';
}

export function buildRlStateVector(input: AnyRecord = {}, context: AnyRecord = {}) {
  const exchange = normalizeRlExchange(input.exchange || context.exchange);
  const market = input.market || context.market || marketForRlExchange(exchange);
  const bars = normalizeBars(input.bars || input.ohlcv || input.candles || []);
  const returns = returnsFromBars(bars).slice(-20);
  const factorEvidence = input.factorEvidence || input.factor || context.factorEvidence || {};
  const statArbEvidence = input.statArbEvidence || input.statArb || context.statArbEvidence || {};
  const entryEvidence = input.entryEvidence || input.entry || context.entryEvidence || {};
  const regimeEvidence = input.regimeEvidence || input.regime || context.regimeEvidence || {};
  const portfolio = input.portfolio || context.portfolio || {};

  const factorComposite = finiteNumber(factorEvidence.compositeScore ?? factorEvidence.composite_score, 0.5);
  const statArbConfidence = finiteNumber(statArbEvidence.confidence, 0);
  const entryConfidence = finiteNumber(entryEvidence.confidence, 0);
  const regimeConfidence = finiteNumber(regimeEvidence.confidence, 0);
  const cashPct = clamp(portfolio.cashPct ?? portfolio.cash_pct ?? 1, 0, 1, 1);
  const positionPct = clamp(portfolio.positionPct ?? portfolio.position_pct ?? 0, 0, 1, 0);
  const unrealizedPnlPct = clamp(portfolio.unrealizedPnlPct ?? portfolio.unrealized_pnl_pct ?? 0, -1, 1, 0);
  const riskBudgetPct = clamp(portfolio.riskBudgetPct ?? portfolio.risk_budget_pct ?? 0.02, 0, 0.25, 0.02);

  const features: Record<string, number> = {
    momentum5: clamp(0.5 + returnOverWindow(bars, 5) * 6, 0, 1, 0.5),
    momentum20: clamp(0.5 + returnOverWindow(bars, 20) * 4, 0, 1, 0.5),
    volatility20: clamp(stdev(returns) / 0.08, 0, 1, 0),
    drawdown20: clamp(maxDrawdown(bars.slice(-20)) / 0.3, 0, 1, 0),
    factorComposite: clamp(factorComposite, 0, 1, 0.5),
    statArbConfidence: clamp(statArbConfidence, 0, 1, 0),
    entryConfidence: clamp(entryConfidence, 0, 1, 0),
    regimeConfidence: clamp(regimeConfidence, 0, 1, 0),
    cashPct,
    positionPct,
    unrealizedPnlPct,
    riskBudgetPct,
  };
  const names = Object.keys(features);
  return {
    exchange,
    market,
    featureNames: names,
    values: names.map((name) => round(features[name], 6)),
    features,
    dataHealth: inferDataHealth({ bars, factorEvidence, statArbEvidence, entryEvidence, regimeEvidence }),
    evidence: {
      bars: bars.length,
      factorSource: factorEvidence.evidence?.source || factorEvidence.source || null,
      statArbSource: statArbEvidence.evidence?.source || statArbEvidence.source || null,
      entrySource: entryEvidence.evidence?.source || entryEvidence.source || null,
      regimeSource: regimeEvidence.evidence?.source || regimeEvidence.source || null,
    },
  };
}

export function buildRlPolicyShadow(input: AnyRecord = {}, context: AnyRecord = {}) {
  const exchange = normalizeRlExchange(input.exchange || context.exchange);
  const market = input.market || context.market || marketForRlExchange(exchange);
  const symbol = String(input.symbol || input.symbols?.[0] || '').trim();
  const entryEvidence = input.entryEvidence || input.entry || context.entryEvidence || {};
  const entryTriggerId = String(
    entryEvidence?.evidence?.triggerId ?? entryEvidence?.triggerId ?? '',
  ).trim();
  const state = buildRlStateVector({ ...input, exchange, market }, context);
  const f = state.features;
  const opportunity =
    (f.momentum5 - 0.5) * 0.22 +
    (f.momentum20 - 0.5) * 0.28 +
    (f.factorComposite - 0.5) * 0.22 +
    (f.entryConfidence - 0.5) * 0.16 +
    (f.regimeConfidence - 0.5) * 0.12 +
    f.statArbConfidence * 0.08;
  const riskPenalty = f.volatility20 * 0.2 + f.drawdown20 * 0.22 + f.positionPct * 0.08;
  const liquidityCap = Math.max(0.15, f.cashPct);
  const rawAction = clamp((opportunity - riskPenalty) * 3, -1, 1, 0);
  const sellSuppressedNoPosition = rawAction < 0 && f.positionPct <= 0.001;
  const cappedAction = sellSuppressedNoPosition ? 0 : rawAction > 0 ? Math.min(rawAction, liquidityCap) : rawAction;
  const action = round(cappedAction, 6);
  const actionType = actionLabel(action);
  const maxSize = market === 'crypto' ? 0.12 : 0.1;
  const actionSizePct = actionType === 'hold' ? 0 : round(Math.min(Math.abs(action) * maxSize, maxSize), 4);
  const confidenceBase = state.dataHealth === 'ready' ? 0.35 : state.dataHealth === 'partial' ? 0.18 : 0.05;
  const confidence = clamp(confidenceBase + Math.abs(action) * 0.55 + f.factorComposite * 0.1, 0, 1, 0.1);
  const rewardEstimate = round(
    opportunity * 0.7 - riskPenalty * 0.8 + f.unrealizedPnlPct * 0.1 - actionSizePct * 0.03,
    6,
  );
  return {
    ok: Boolean(symbol),
    symbol,
    exchange,
    market,
    stateVector: {
      featureNames: state.featureNames,
      values: state.values,
    },
    action,
    actionType,
    actionSizePct,
    confidence: round(confidence, 4),
    rewardEstimate,
    modelStatus: modelStatus(context),
    dataHealth: state.dataHealth,
    shadowOnly: true,
    liveMutation: false,
    evidence: {
      source: context.source || 'rl_policy_shadow',
      ...state.evidence,
      policy: 'deterministic_ppo_shadow_proxy',
      trainedModelUsed: context.modelLoaded === true,
      sellSuppressedNoPosition,
      outcomeLineage: entryTriggerId ? { entryTriggerId } : {},
    },
  };
}

export function normalizeRlPolicyShadowRow(row: AnyRecord = {}) {
  return {
    ok: true,
    symbol: row.symbol,
    exchange: row.exchange,
    market: row.market || marketForRlExchange(row.exchange),
    stateVector: parseJsonMaybe(row.state_vector, row.stateVector || {}),
    action: finiteNumber(row.action, 0),
    actionType: row.action_type || row.actionType || actionLabel(row.action),
    actionSizePct: finiteNumber(row.action_size_pct ?? row.actionSizePct, 0),
    confidence: finiteNumber(row.confidence, 0),
    rewardEstimate: finiteNumber(row.reward_estimate ?? row.rewardEstimate, 0),
    modelStatus: row.model_status || row.modelStatus || 'unknown',
    dataHealth: row.data_health || row.dataHealth || 'unknown',
    shadowOnly: row.shadow_only !== false,
    liveMutation: false,
    evidence: {
      source: 'investment.luna_rl_policy_shadow',
      observedAt: row.observed_at || null,
      ...parseJsonMaybe(row.context_evidence, {}) as AnyRecord,
    },
  };
}

export default {
  buildRlPolicyShadow,
  buildRlStateVector,
  marketForRlExchange,
  normalizeRlExchange,
  normalizeRlPolicyShadowRow,
};
