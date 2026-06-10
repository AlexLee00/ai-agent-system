import { query as defaultQuery } from '../../shared/db.ts';
import {
  buildMonteCarloShadow,
  marketForRiskExchange,
  normalizeRiskExchange,
  normalizeRiskSimulationShadowRow,
} from '../../shared/quant/monte-carlo.ts';
import { buildStressTestShadow } from '../../shared/quant/stress-test.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
type AnalysisType = 'monte_carlo' | 'stress_test';
type RiskCandidate = {
  symbol?: string;
  symbols?: string[];
  exchange?: string;
  barsBySymbol?: Record<string, unknown[]>;
  bars?: unknown[];
  returns?: number[];
  riskLimits?: Record<string, number>;
};
type RiskSimulationParams = {
  symbol?: string;
  symbols?: string[];
  exchange?: string | null;
  market?: string;
  scenario?: string;
  limit?: number;
  broadcast?: boolean;
  analysisType?: string;
  analysis?: string;
  simulations?: number;
  horizonDays?: number;
  barsBySymbol?: Record<string, unknown[]>;
  bars?: unknown[];
  returns?: number[];
  riskLimits?: Record<string, number>;
  candidate?: RiskCandidate;
};
type RiskSimulationRowsQuery = {
  analysisType?: string | null;
  symbol?: string;
  exchange?: string | null;
  market?: string;
  scenario?: string;
  limit?: number;
};
type RiskSimulationShadow = Omit<ReturnType<typeof buildMonteCarloShadow>, 'evidence'> & {
  evidence: Record<string, unknown>;
};
type RiskSimulationHandlerOptions = {
  queryFn?: QueryFn;
  skillId?: string;
  defaultAnalysisType?: AnalysisType | null;
};
type RiskShadowBuilder = (input: Record<string, unknown>, context: Record<string, unknown>) => RiskSimulationShadow;

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

function normalizeAnalysisType(value: unknown): AnalysisType {
  const raw = String(value || 'monte_carlo').toLowerCase();
  if (raw === 'stress' || raw === 'stress_test') return 'stress_test';
  return 'monte_carlo';
}

function asRiskSimulationParams(params: unknown): RiskSimulationParams {
  return params && typeof params === 'object' ? (params as RiskSimulationParams) : {};
}

async function latestRiskSimulationRows(queryFn: QueryFn, { analysisType, symbol, exchange, market, scenario, limit }: RiskSimulationRowsQuery) {
  const conds: string[] = [];
  const params: unknown[] = [];
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

function outputFromShadow(shadow: RiskSimulationShadow, skillId: string, params: RiskSimulationParams = {}) {
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

function outputFromRows(rows: unknown[] = [], skillId: string, params: RiskSimulationParams = {}) {
  const normalized = rows.map((row) => normalizeRiskSimulationShadowRow(row as Record<string, unknown>));
  const primary = (normalized[0] || {}) as RiskSimulationShadow;
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

function outputFromCandidate(params: RiskSimulationParams = {}, skillId: string, defaultAnalysisType: AnalysisType | null = null) {
  const exchange = normalizeRiskExchange(params.exchange || params.candidate?.exchange);
  const analysisType = normalizeAnalysisType(params.analysisType || params.analysis || defaultAnalysisType);
  const builder = (analysisType === 'stress_test' ? buildStressTestShadow : buildMonteCarloShadow) as RiskShadowBuilder;
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
  queryFn = defaultQuery as QueryFn,
  skillId = 'risk-simulation-shadow',
  defaultAnalysisType = null,
}: RiskSimulationHandlerOptions = {}) {
  return async function riskSimulationShadow(rawParams: unknown = {}): Promise<A2ATaskResult> {
    const params = asRiskSimulationParams(rawParams);
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
      id: '',
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

export function registerRiskSimulationShadowSkills(options: RiskSimulationHandlerOptions = {}) {
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
