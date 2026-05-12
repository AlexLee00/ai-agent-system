import { query as defaultQuery } from '../../shared/db.ts';
import {
  buildMonteCarloShadow,
  marketForRiskExchange,
  normalizeRiskExchange,
  normalizeRiskSimulationShadowRow,
} from '../../shared/quant/monte-carlo.ts';
import { buildStressTestShadow } from '../../shared/quant/stress-test.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

function normalizeAnalysisType(value) {
  const raw = String(value || 'monte_carlo').toLowerCase();
  if (raw === 'stress' || raw === 'stress_test') return 'stress_test';
  return 'monte_carlo';
}

async function latestRiskSimulationRows(queryFn, { analysisType, symbol, exchange, market, scenario, limit }) {
  const conds = [];
  const params = [];
  if (analysisType) {
    params.push(normalizeAnalysisType(analysisType));
    conds.push(`analysis_type = $${params.length}`);
  }
  if (symbol) {
    params.push(JSON.stringify([symbol]));
    conds.push(`symbols @> $${params.length}::jsonb`);
  }
  if (exchange) {
    params.push(exchange);
    conds.push(`exchange = $${params.length}`);
  }
  if (market) {
    params.push(market);
    conds.push(`market = $${params.length}`);
  }
  if (scenario) {
    params.push(String(scenario).toLowerCase());
    conds.push(`scenario = $${params.length}`);
  }
  params.push(Math.max(1, Number(limit || 10)));
  const rows = await Promise.resolve(queryFn(
    `SELECT *
       FROM investment.luna_risk_simulation_shadow
      ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
      ORDER BY observed_at DESC, max_loss_estimate DESC
      LIMIT $${params.length}`,
    params,
  )).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

function outputFromShadow(shadow, skillId, params = {}) {
  return {
    ok: Boolean(shadow.ok),
    skill: skillId,
    market: shadow.market || marketForRiskExchange(params.exchange || shadow.exchange),
    shadowMode: true,
    analysisType: shadow.analysisType,
    symbols: shadow.symbols || [],
    scenario: shadow.scenario,
    simulations: shadow.simulations,
    var95: shadow.var95,
    var99: shadow.var99,
    cvar95: shadow.cvar95,
    cvar99: shadow.cvar99,
    maxLossEstimate: shadow.maxLossEstimate,
    recoveryDaysEstimate: shadow.recoveryDaysEstimate,
    riskLimits: shadow.riskLimits || {},
    scenarioMetrics: shadow.scenarioMetrics || {},
    dataHealth: shadow.dataHealth,
    broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
    evidence: shadow.evidence || {},
  };
}

function outputFromRows(rows = [], skillId, params = {}) {
  const normalized = rows.map(normalizeRiskSimulationShadowRow);
  const primary = normalized[0] || {};
  return {
    ...outputFromShadow(primary, skillId, params),
    rows: normalized.map((row) => ({
      analysisType: row.analysisType,
      symbols: row.symbols,
      exchange: row.exchange,
      scenario: row.scenario,
      var95: row.var95,
      cvar95: row.cvar95,
      maxLossEstimate: row.maxLossEstimate,
      dataHealth: row.dataHealth,
    })),
    evidence: {
      source: 'investment.luna_risk_simulation_shadow',
      observedAt: primary.evidence?.observedAt || null,
    },
  };
}

function outputFromCandidate(params = {}, skillId, defaultAnalysisType = null) {
  const exchange = normalizeRiskExchange(params.exchange || params.candidate?.exchange);
  const analysisType = normalizeAnalysisType(params.analysisType || params.analysis || defaultAnalysisType);
  const builder = analysisType === 'stress_test' ? buildStressTestShadow : buildMonteCarloShadow;
  const symbols = params.symbols || params.candidate?.symbols || [params.symbol || params.candidate?.symbol].filter(Boolean);
  const shadow = builder({
    symbols,
    exchange,
    scenario: params.scenario,
    simulations: params.simulations,
    horizonDays: params.horizonDays,
    barsBySymbol: params.barsBySymbol || params.candidate?.barsBySymbol,
    bars: params.bars || params.candidate?.bars,
    returns: params.returns || params.candidate?.returns,
    riskLimits: params.riskLimits || params.candidate?.riskLimits,
  }, { source: 'candidate_params' });
  return outputFromShadow(shadow, skillId, params);
}

export function createRiskSimulationShadowHandler({
  queryFn = defaultQuery,
  skillId = 'risk-simulation-shadow',
  defaultAnalysisType = null,
} = {}) {
  return async function riskSimulationShadow(params = {}) {
    const exchange = params.exchange ? normalizeRiskExchange(params.exchange) : null;
    const analysisType = params.analysisType || params.analysis || defaultAnalysisType;
    const rows = await latestRiskSimulationRows(queryFn, {
      analysisType,
      symbol: params.symbol,
      exchange,
      market: params.market,
      scenario: params.scenario,
      limit: params.limit || 10,
    });
    const output = rows.length > 0
      ? outputFromRows(rows, skillId, { ...params, exchange })
      : outputFromCandidate({ ...params, exchange: exchange || params?.candidate?.exchange }, skillId, defaultAnalysisType);
    return {
      status: output.ok ? 'completed' : 'failed',
      output,
      metadata: {
        source: rows.length > 0 ? 'luna_risk_simulation_shadow' : 'candidate_params',
        dataHealth: output.dataHealth,
        broadcastEnabled: broadcastEnabled(),
        liveMutation: false,
      },
      error: output.ok ? undefined : { code: -32602, message: 'risk simulation shadow input missing' },
    };
  };
}

export function registerRiskSimulationShadowSkills(options = {}) {
  registerSkillHandler('risk-simulation-shadow', createRiskSimulationShadowHandler(options));
  registerSkillHandler('monte-carlo-shadow', createRiskSimulationShadowHandler({
    ...options,
    skillId: 'monte-carlo-shadow',
    defaultAnalysisType: 'monte_carlo',
  }));
  registerSkillHandler('stress-test-shadow', createRiskSimulationShadowHandler({
    ...options,
    skillId: 'stress-test-shadow',
    defaultAnalysisType: 'stress_test',
  }));
}

export default {
  createRiskSimulationShadowHandler,
  registerRiskSimulationShadowSkills,
};
