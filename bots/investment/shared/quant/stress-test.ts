import {
  DEFAULT_RISK_LIMITS,
  defaultRiskSymbols,
  finiteNumber,
  marketForRiskExchange,
  mean,
  normalizeRiskExchange,
  returnsFromBars,
  round,
  stdev,
} from './monte-carlo.ts';

export const HISTORICAL_STRESS_SCENARIOS = {
  '2008_financial_crisis': {
    label: '2008 금융위기',
    drawdownPct: 0.40,
    months: 6,
    volatilityMultiplier: 2.0,
  },
  '2020_covid_crash': {
    label: '2020 COVID 폭락',
    drawdownPct: 0.30,
    months: 1,
    volatilityMultiplier: 2.4,
  },
  '2022_luna_ftx': {
    label: '2022 LUNA/FTX 붕괴',
    drawdownPct: 0.70,
    months: 3,
    volatilityMultiplier: 3.2,
  },
  '2018_btc_crash': {
    label: '2018 BTC 폭락',
    drawdownPct: 0.80,
    months: 12,
    volatilityMultiplier: 2.8,
  },
};

function dataHealthForReturns(count) {
  if (count >= 60) return 'ready';
  if (count >= 20) return 'partial';
  return 'insufficient';
}

function estimateRecoveryDays(lossPct, avgReturn) {
  const loss = Math.abs(finiteNumber(lossPct, 0));
  const daily = Math.max(0.0005, Math.abs(finiteNumber(avgReturn, 0.001)));
  return Math.ceil(Math.log(1 / Math.max(0.01, 1 - loss)) / daily);
}

function scenarioRiskLevel(lossPct, limits = DEFAULT_RISK_LIMITS) {
  if (lossPct >= finiteNumber(limits.monthlyLossPct, 0.25)) return 'critical';
  if (lossPct >= finiteNumber(limits.weeklyLossPct, 0.15)) return 'high';
  if (lossPct >= finiteNumber(limits.dailyLossPct, 0.05)) return 'medium';
  return 'low';
}

export function buildStressTestShadow(input = {}, context = {}) {
  const exchange = normalizeRiskExchange(input.exchange || context.exchange);
  const market = input.market || context.market || marketForRiskExchange(exchange);
  const symbols = Array.isArray(input.symbols) && input.symbols.length
    ? input.symbols.map(String)
    : defaultRiskSymbols(exchange);
  const scenario = String(input.scenario || context.scenario || '2022_luna_ftx').toLowerCase();
  const scenarioSpec = HISTORICAL_STRESS_SCENARIOS[scenario] || HISTORICAL_STRESS_SCENARIOS['2022_luna_ftx'];
  const barsBySymbol = input.barsBySymbol || input.priceHistory || {};
  const mergedReturns = symbols.flatMap((symbol) => returnsFromBars(barsBySymbol[symbol] || input.bars || []));
  const returns = Array.isArray(input.returns) && input.returns.length ? input.returns.map(Number).filter(Number.isFinite) : mergedReturns;
  const dataHealth = dataHealthForReturns(returns.length);
  const avg = mean(returns);
  const vol = stdev(returns);
  const baseLoss = scenarioSpec.drawdownPct;
  const volatilityAdjustment = Math.min(0.2, vol * scenarioSpec.volatilityMultiplier);
  const maxLossEstimate = Math.min(0.95, baseLoss + volatilityAdjustment);
  const var95 = Math.min(maxLossEstimate, baseLoss * 0.62 + volatilityAdjustment * 0.5);
  const var99 = Math.min(maxLossEstimate, baseLoss * 0.78 + volatilityAdjustment * 0.7);
  const cvar95 = Math.min(maxLossEstimate, var95 * 1.18);
  const cvar99 = Math.min(maxLossEstimate, var99 * 1.12);
  const riskLimits = { ...DEFAULT_RISK_LIMITS, ...(input.riskLimits || {}) };
  const riskLevel = scenarioRiskLevel(maxLossEstimate, riskLimits);
  return {
    ok: symbols.length > 0,
    analysisType: 'stress_test',
    symbols,
    exchange,
    market,
    scenario,
    simulations: 1,
    var95: round(var95),
    var99: round(var99),
    cvar95: round(cvar95),
    cvar99: round(cvar99),
    maxLossEstimate: round(maxLossEstimate),
    recoveryDaysEstimate: estimateRecoveryDays(maxLossEstimate, avg),
    riskLimits,
    scenarioMetrics: {
      label: scenarioSpec.label,
      months: scenarioSpec.months,
      historicalDrawdownPct: scenarioSpec.drawdownPct,
      inputReturns: returns.length,
      meanReturn: round(avg),
      volatility: round(vol),
      riskLevel,
      killSwitchWouldTrigger: maxLossEstimate >= riskLimits.dailyLossPct,
    },
    dataHealth,
    shadowOnly: true,
    liveMutation: false,
    evidence: {
      source: context.source || 'historical_stress_shadow',
      historicalScenario: scenarioSpec.label,
      insufficientData: dataHealth === 'insufficient',
      liveConfigMutationAllowed: false,
    },
  };
}

export default {
  HISTORICAL_STRESS_SCENARIOS,
  buildStressTestShadow,
};
