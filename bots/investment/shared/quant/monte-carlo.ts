const VALID_EXCHANGES = new Set(['binance', 'kis', 'kis_overseas']);

export const DEFAULT_RISK_SYMBOLS = {
  binance: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
  kis: ['005930', '005380', '000660'],
  kis_overseas: ['AAPL', 'NVDA', 'MSFT', 'SPY'],
};

export const DEFAULT_RISK_LIMITS = {
  dailyLossPct: 0.05,
  weeklyLossPct: 0.15,
  monthlyLossPct: 0.25,
};

export function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function round(value, digits = 6) {
  return Number(Number(value || 0).toFixed(digits));
}

export function parseJsonMaybe(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizeRiskExchange(value) {
  const raw = String(value || 'binance').trim().toLowerCase();
  if (raw === 'crypto') return 'binance';
  if (raw === 'domestic') return 'kis';
  if (raw === 'overseas') return 'kis_overseas';
  return VALID_EXCHANGES.has(raw) ? raw : 'binance';
}

export function marketForRiskExchange(exchange) {
  const normalized = normalizeRiskExchange(exchange);
  if (normalized === 'kis') return 'domestic';
  if (normalized === 'kis_overseas') return 'overseas';
  return 'crypto';
}

export function defaultRiskSymbols(exchange) {
  const normalized = normalizeRiskExchange(exchange);
  return [...(DEFAULT_RISK_SYMBOLS[normalized] || DEFAULT_RISK_SYMBOLS.binance)];
}

export function normalizeBars(value = []) {
  const raw = Array.isArray(value) ? value : [];
  return raw.map((bar) => {
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
  }).filter((bar) => Number.isFinite(bar.close) && bar.close > 0).slice(-720);
}

export function returnsFromBars(bars = []) {
  const normalized = normalizeBars(bars);
  const out = [];
  for (let i = 1; i < normalized.length; i += 1) {
    const prev = finiteNumber(normalized[i - 1]?.close, 0);
    const curr = finiteNumber(normalized[i]?.close, 0);
    if (prev > 0 && curr > 0) out.push((curr - prev) / prev);
  }
  return out;
}

export function mean(values = []) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stdev(values = []) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / Math.max(1, values.length - 1);
  return Math.sqrt(variance);
}

function seededRandom(seed) {
  let state = Math.max(1, Math.floor(finiteNumber(seed, 7))) % 2147483647;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

function normalPair(rand) {
  const u1 = Math.max(1e-9, rand());
  const u2 = Math.max(1e-9, rand());
  const radius = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return [radius * Math.cos(theta), radius * Math.sin(theta)];
}

function percentile(sorted = [], p = 0.05) {
  if (!sorted.length) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function tailAverage(sorted = [], p = 0.05) {
  if (!sorted.length) return 0;
  const count = Math.max(1, Math.ceil(sorted.length * p));
  return mean(sorted.slice(0, count));
}

function estimateRecoveryDays(lossPct, avgReturn) {
  const loss = Math.abs(finiteNumber(lossPct, 0));
  const daily = Math.max(0.0005, Math.abs(finiteNumber(avgReturn, 0.001)));
  return Math.ceil(Math.log(1 / Math.max(0.01, 1 - loss)) / daily);
}

function dataHealthForReturns(count) {
  if (count >= 60) return 'ready';
  if (count >= 20) return 'partial';
  return 'insufficient';
}

function scenarioDriftMultiplier(scenario) {
  if (scenario === 'bull') return 1.5;
  if (scenario === 'bear') return -1.2;
  if (scenario === 'black_swan') return -2.5;
  return 0.15;
}

function scenarioVolMultiplier(scenario) {
  if (scenario === 'black_swan') return 3.0;
  if (scenario === 'bear') return 1.8;
  if (scenario === 'bull') return 1.1;
  return 0.75;
}

export function buildMonteCarloShadow(input = {}, context = {}) {
  const exchange = normalizeRiskExchange(input.exchange || context.exchange);
  const market = input.market || context.market || marketForRiskExchange(exchange);
  const symbols = Array.isArray(input.symbols) && input.symbols.length
    ? input.symbols.map(String)
    : defaultRiskSymbols(exchange);
  const barsBySymbol = input.barsBySymbol || input.priceHistory || {};
  const mergedReturns = symbols.flatMap((symbol) => returnsFromBars(barsBySymbol[symbol] || input.bars || []));
  const returns = Array.isArray(input.returns) && input.returns.length ? input.returns.map(Number).filter(Number.isFinite) : mergedReturns;
  const scenario = String(input.scenario || context.scenario || 'base').toLowerCase();
  const simulations = Math.max(100, Math.min(10000, Math.floor(finiteNumber(input.simulations ?? context.simulations, 1000))));
  const horizonDays = Math.max(1, Math.min(252, Math.floor(finiteNumber(input.horizonDays ?? context.horizonDays, 20))));
  const avg = mean(returns);
  const vol = stdev(returns);
  const drift = avg * scenarioDriftMultiplier(scenario);
  const sigma = Math.max(0.0001, vol * scenarioVolMultiplier(scenario));
  const rand = seededRandom(input.seed ?? context.seed ?? 42);
  const outcomes = [];
  for (let i = 0; i < simulations; i += 1) {
    let cumulative = 1;
    for (let day = 0; day < horizonDays; day += 1) {
      const [z] = normalPair(rand);
      const fatTailShock = scenario === 'black_swan' && rand() < 0.03 ? -Math.abs(z) * sigma * 4 : 0;
      cumulative *= 1 + drift + sigma * z + fatTailShock;
    }
    outcomes.push(cumulative - 1);
  }
  outcomes.sort((a, b) => a - b);
  const p5 = percentile(outcomes, 0.05);
  const p1 = percentile(outcomes, 0.01);
  const cvar5 = tailAverage(outcomes, 0.05);
  const cvar1 = tailAverage(outcomes, 0.01);
  const maxLoss = Math.min(...outcomes);
  const dataHealth = dataHealthForReturns(returns.length);
  return {
    ok: symbols.length > 0,
    analysisType: 'monte_carlo',
    symbols,
    exchange,
    market,
    scenario,
    simulations,
    var95: round(Math.abs(Math.min(0, p5))),
    var99: round(Math.abs(Math.min(0, p1))),
    cvar95: round(Math.abs(Math.min(0, cvar5))),
    cvar99: round(Math.abs(Math.min(0, cvar1))),
    maxLossEstimate: round(Math.abs(Math.min(0, maxLoss))),
    recoveryDaysEstimate: estimateRecoveryDays(maxLoss, avg),
    riskLimits: { ...DEFAULT_RISK_LIMITS, ...(input.riskLimits || {}) },
    scenarioMetrics: {
      horizonDays,
      inputReturns: returns.length,
      meanReturn: round(avg),
      volatility: round(vol),
      drift: round(drift),
      scenarioVolatility: round(sigma),
    },
    dataHealth,
    shadowOnly: true,
    liveMutation: false,
    evidence: {
      source: context.source || 'monte_carlo_shadow',
      distribution: 'seeded_normal_with_fat_tail_shock',
      optionalGarchReady: context.optionalGarchReady === true,
      optionalTDistributionReady: context.optionalTDistributionReady === true,
      insufficientData: dataHealth === 'insufficient',
    },
  };
}

export function normalizeRiskSimulationShadowRow(row = {}) {
  return {
    ok: true,
    analysisType: row.analysis_type || row.analysisType,
    symbols: parseJsonMaybe(row.symbols, row.symbols || []),
    exchange: row.exchange,
    market: row.market || marketForRiskExchange(row.exchange),
    scenario: row.scenario || 'base',
    simulations: finiteNumber(row.simulations, 0),
    var95: finiteNumber(row.var_95 ?? row.var95, 0),
    var99: finiteNumber(row.var_99 ?? row.var99, 0),
    cvar95: finiteNumber(row.cvar_95 ?? row.cvar95, 0),
    cvar99: finiteNumber(row.cvar_99 ?? row.cvar99, 0),
    maxLossEstimate: finiteNumber(row.max_loss_estimate ?? row.maxLossEstimate, 0),
    recoveryDaysEstimate: row.recovery_days_estimate == null ? null : finiteNumber(row.recovery_days_estimate, null),
    riskLimits: parseJsonMaybe(row.risk_limits, row.riskLimits || {}),
    scenarioMetrics: parseJsonMaybe(row.scenario_metrics, row.scenarioMetrics || {}),
    dataHealth: row.data_health || row.dataHealth || 'unknown',
    shadowOnly: row.shadow_only !== false,
    liveMutation: false,
    evidence: {
      source: 'investment.luna_risk_simulation_shadow',
      observedAt: row.observed_at || null,
      ...parseJsonMaybe(row.context_evidence, {}),
    },
  };
}

export default {
  buildMonteCarloShadow,
  defaultRiskSymbols,
  marketForRiskExchange,
  normalizeRiskExchange,
  normalizeRiskSimulationShadowRow,
  returnsFromBars,
};
