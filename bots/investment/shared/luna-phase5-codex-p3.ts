// @ts-nocheck

import { query, run } from './db/core.ts';

export const LUNA_PHASE5_MODEL = 'luna_phase5_codex_p3_shadow_v1';

export const LUNA_PHASE5_A2A_SKILLS = Object.freeze([
  {
    skillId: 'market-regime-analysis',
    file: 'a2a/skills/market-regime-analysis.ts',
    phase: 'phase1_regime',
    capability: 'regime_read',
  },
  {
    skillId: 'entry-decision-shadow',
    file: 'a2a/skills/entry-decision-shadow.ts',
    phase: 'phase2_entry',
    capability: 'entry_shadow_read',
  },
  {
    skillId: 'dynamic-tpsl-shadow',
    file: 'a2a/skills/dynamic-tpsl-shadow.ts',
    phase: 'phase3_tpsl',
    capability: 'exit_shadow_read',
  },
  {
    skillId: 'meta-neural-reflexion',
    file: 'a2a/skills/meta-neural-reflexion.ts',
    phase: 'phase4_reflexion',
    capability: 'reflexion_read',
  },
  {
    skillId: 'factor-model-shadow',
    file: 'a2a/skills/factor-model-shadow.ts',
    phase: 'phase5_factor',
    capability: 'factor_shadow_read',
  },
  {
    skillId: 'stat-arb-shadow',
    file: 'a2a/skills/stat-arb-shadow.ts',
    phase: 'phase6_stat_arb',
    capability: 'stat_arb_shadow_read',
  },
  {
    skillId: 'rl-policy-shadow',
    file: 'a2a/skills/rl-policy-shadow.ts',
    phase: 'phase7_rl',
    capability: 'rl_shadow_read',
  },
  {
    skillId: 'risk-simulation-shadow',
    file: 'a2a/skills/risk-simulation-shadow.ts',
    phase: 'phase8_risk',
    capability: 'risk_shadow_read',
  },
  {
    skillId: 'communication-infrastructure-gate',
    file: 'a2a/skills/communication-infrastructure-gate.ts',
    phase: 'phase9_comm',
    capability: 'comm_gate_read',
  },
  {
    skillId: 'hybrid-promotion-gate',
    file: 'a2a/skills/hybrid-promotion-gate.ts',
    phase: 'phase10_gate',
    capability: 'promotion_gate_read',
  },
  {
    skillId: 'hybrid-promotion-review',
    file: 'a2a/skills/hybrid-promotion-review.ts',
    phase: 'phase11_review',
    capability: 'promotion_review_read',
  },
  {
    skillId: 'hybrid-final-closure',
    file: 'a2a/skills/hybrid-final-closure.ts',
    phase: 'phase12_closure',
    capability: 'final_closure_read',
  },
]);

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 1, fallback = 0) {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function round(value, digits = 4) {
  return Number(finiteNumber(value, 0).toFixed(digits));
}

function parseJsonMaybe(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeMarket(value = 'crypto') {
  const raw = String(value || '').toLowerCase();
  if (raw === 'kis' || raw === 'domestic') return 'domestic';
  if (raw === 'kis_overseas' || raw === 'overseas') return 'overseas';
  return 'crypto';
}

export function normalizeMarketFilter(value: any) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'all' || raw === '*' || raw === 'any') return null;
  return normalizeMarket(raw);
}

function exchangeForMarket(market = 'crypto') {
  const normalized = normalizeMarket(market);
  if (normalized === 'domestic') return 'kis';
  if (normalized === 'overseas') return 'kis_overseas';
  return 'binance';
}

function mcpToolName(skillId) {
  return `luna_a2a_${String(skillId || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}`;
}

export function buildPhase5McpBridgeRows({ fixture = false } = {}) {
  return LUNA_PHASE5_A2A_SKILLS.map((skill, index) => ({
    skillId: skill.skillId,
    mcpToolName: mcpToolName(skill.skillId),
    status: 'shadow_read_only_ready',
    directTradeAllowed: false,
    protectedPolicy: 'no_live_trade_no_protected_restart_no_secret_change',
    capability: {
      index: index + 1,
      phase: skill.phase,
      file: skill.file,
      capability: skill.capability,
      inputMode: 'json_rpc_tools_call',
      outputMode: 'json_content',
      writeMode: 'read_only_or_shadow_only',
    },
    evidence: {
      phase: 'luna_phase5_codex_p3',
      task: 'a2a_to_mcp_bridge',
      source: fixture ? 'fixture_manifest' : 'static_skill_inventory',
      hummingbotPattern: 'tool_registry_with_guarded_execution',
      directClaudeTrading: 'blocked_until_explicit_live_trade_approval',
      liveMutation: false,
    },
  }));
}

function fixtureRlRows() {
  return [
    {
      symbol: 'BTC/USDT',
      market: 'crypto',
      exchange: 'binance',
      action_type: 'buy',
      action_size_pct: 0.034,
      confidence: 0.72,
      reward_estimate: 0.19,
      data_health: 'ready',
      state_vector: { values: [0.62, 0.58, 0.22, 0.11, 0.72, 0.2, 0.76, 0.7] },
      context_evidence: {
        fixture: true,
        trendScore: 0.66,
        riskScore: 0.24,
        outcomeLineage: { entryTriggerId: 'fixture-entry-trigger-btc' },
      },
    },
    {
      symbol: 'DOGE/USDT',
      market: 'crypto',
      exchange: 'binance',
      action_type: 'hold',
      action_size_pct: 0,
      confidence: 0.41,
      reward_estimate: -0.08,
      data_health: 'partial',
      state_vector: { values: [0.51, 0.48, 0.74, 0.83, 0.31, 0.1, 0.32, 0.45] },
      context_evidence: { fixture: true, trendScore: 0.41, riskScore: 0.83 },
    },
    {
      symbol: 'NVDA',
      market: 'overseas',
      exchange: 'kis_overseas',
      action_type: 'buy',
      action_size_pct: 0.026,
      confidence: 0.69,
      reward_estimate: 0.15,
      data_health: 'ready',
      state_vector: { values: [0.64, 0.61, 0.24, 0.09, 0.75, 0.08, 0.73, 0.62] },
      context_evidence: { fixture: true, trendScore: 0.7, riskScore: 0.22 },
    },
  ];
}

async function loadLatestRlPolicyRows({ limit = 50, market = null } = {}) {
  const params = [Math.max(1, Number(limit || 50))];
  const marketFilter = normalizeMarketFilter(market);
  const marketWhere = marketFilter ? `AND market = $${params.push(marketFilter)}` : '';
  return query(`
    SELECT DISTINCT ON (symbol, market)
           id, symbol, market, exchange, action_type, action_size_pct, confidence,
           reward_estimate, data_health, state_vector, context_evidence, observed_at
      FROM luna_rl_policy_shadow
     WHERE shadow_only = true
       ${marketWhere}
     ORDER BY symbol, market, observed_at DESC
     LIMIT $1
  `, params).catch(() => []);
}

async function loadLatestPhase4Rows({ limit = 50, market = null } = {}) {
  const params = [Math.max(1, Number(limit || 50))];
  const marketFilter = normalizeMarketFilter(market);
  const marketWhere = marketFilter ? `AND market = $${params.push(marketFilter)}` : '';
  return query(`
    SELECT DISTINCT ON (symbol, market)
           symbol, market, exchange, live_forward_status, ama_score, finsaber_score,
           regime_risk_score, hyperopt_required, max_drawdown_pct, reasons, evidence, observed_at
      FROM luna_phase4_live_forward_shadow
     WHERE shadow_only = true
       ${marketWhere}
     ORDER BY symbol, market, observed_at DESC
     LIMIT $1
  `, params).catch(() => []);
}

function voteFromScore(name, score, buyThreshold = 0.18, sellThreshold = -0.18) {
  const value = clamp(score, -1, 1, 0);
  return {
    algorithm: name,
    action: value >= buyThreshold ? 'buy' : value <= sellThreshold ? 'sell' : 'hold',
    score: round(value, 6),
  };
}

function buildRlEnsembleRow(row = {}, phase4 = {}) {
  const state = parseJsonMaybe(row.state_vector ?? row.stateVector, {});
  const stateValues = Array.isArray(state.values) ? state.values.map((item) => finiteNumber(item, 0)) : [];
  const evidence = parseJsonMaybe(row.context_evidence ?? row.evidence, {});
  const phase4Reasons = parseJsonMaybe(phase4.reasons, []);
  const baseAction = String(row.action_type || row.actionType || 'hold').toLowerCase();
  const baseDirection = baseAction === 'buy' ? 1 : baseAction === 'sell' ? -1 : 0;
  const confidence = clamp(row.confidence, 0, 1, 0);
  const riskScore = clamp(
    finiteNumber(phase4.regime_risk_score, evidence.riskScore ?? stateValues[3] ?? 0.5)
      + Math.max(0, finiteNumber(phase4.max_drawdown_pct, 0) - 12) / 40,
    0,
    1,
    0.5,
  );
  const trendScore = clamp(
    evidence.trendScore
      ?? avg([stateValues[0], stateValues[1], finiteNumber(phase4.ama_score, 0.5), finiteNumber(phase4.finsaber_score, 0.5)]),
    0,
    1,
    0.5,
  );
  const dqnScore = clamp(baseDirection * confidence - riskScore * 0.35, -1, 1, 0);
  const lstmScore = clamp((trendScore - 0.5) * 2 - riskScore * 0.3, -1, 1, 0);
  const transformerScore = clamp(
    (finiteNumber(phase4.ama_score, 0.5) - 0.5) * 1.2
      + (finiteNumber(phase4.finsaber_score, 0.5) - 0.5)
      - phase4Reasons.length * 0.08
      - (phase4.hyperopt_required === true ? 0.12 : 0),
    -1,
    1,
    0,
  );
  const ppoScore = clamp(baseDirection * confidence + finiteNumber(row.reward_estimate, 0) * 0.25, -1, 1, 0);
  const votes = [
    voteFromScore('ppo', ppoScore),
    voteFromScore('dqn', dqnScore),
    voteFromScore('lstm', lstmScore),
    voteFromScore('transformer', transformerScore),
  ];
  const avgScore = avg(votes.map((vote) => vote.score));
  const buyVotes = votes.filter((vote) => vote.action === 'buy').length;
  const sellVotes = votes.filter((vote) => vote.action === 'sell').length;
  const actionType = buyVotes >= 3 && avgScore > 0.18
    ? 'buy'
    : sellVotes >= 3 && avgScore < -0.18
      ? 'sell'
      : 'hold';
  const actionSizePct = actionType === 'hold'
    ? 0
    : round(Math.min(0.10, Math.abs(avgScore) * 0.08), 4);
  const agreement = Math.max(buyVotes, sellVotes, votes.length - buyVotes - sellVotes) / votes.length;
  return {
    symbol: String(row.symbol || phase4.symbol || '').toUpperCase(),
    market: normalizeMarket(row.market || phase4.market),
    exchange: row.exchange || phase4.exchange || exchangeForMarket(row.market || phase4.market),
    ensembleModel: LUNA_PHASE5_MODEL,
    actionType,
    actionSizePct,
    confidence: round(clamp(confidence * 0.45 + agreement * 0.35 + (1 - riskScore) * 0.20, 0, 1, 0), 4),
    rewardEstimate: round(avgScore - riskScore * 0.15, 6),
    algorithmVotes: votes,
    dataHealth: row.data_health || row.dataHealth || 'unknown',
    shadowOnly: true,
    liveMutation: false,
    evidence: {
      phase: 'luna_phase5_codex_p3',
      task: 'rl_diversification_ensemble',
      source: 'ppo_dqn_lstm_transformer_shadow_proxy',
      rlPolicyId: row.id ?? row.rlPolicyId ?? null,
      phase4ObservedAt: phase4.observed_at || null,
      rlObservedAt: row.observed_at || null,
      outcomeLineage: parseJsonMaybe(evidence.outcomeLineage ?? evidence.outcome_lineage, {}),
      riskScore: round(riskScore, 4),
      trendScore: round(trendScore, 4),
      liveMutation: false,
    },
  };
}

function avg(values = []) {
  const nums = values.map((value) => finiteNumber(value, NaN)).filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
}

export async function buildPhase5RlEnsembleRows({ fixture = false, limit = 50, market = null } = {}) {
  const rlRows = fixture ? fixtureRlRows() : await loadLatestRlPolicyRows({ limit, market });
  const phase4Rows = fixture ? [] : await loadLatestPhase4Rows({ limit, market });
  const phase4ByKey = new Map(phase4Rows.map((row) => [`${row.symbol}|${row.market}`, row]));
  return rlRows.map((row) => buildRlEnsembleRow(row, phase4ByKey.get(`${row.symbol}|${row.market}`) || {}));
}

function fixtureGeneticInputs() {
  return [
    {
      symbol: 'BTC/USDT',
      market: 'crypto',
      exchange: 'binance',
      enhancement_status: 'shadow_ready',
      hyperopt_status: 'not_required',
      indicator_score: 0.68,
      max_drawdown_guard: 'observe',
      best_params: { stopLossPct: -2, maxDrawdownPct: 20, paperOnlyDays: 7 },
      reasons: [],
    },
    {
      symbol: 'DOGE/USDT',
      market: 'crypto',
      exchange: 'binance',
      enhancement_status: 'shadow_review',
      hyperopt_status: 'planned',
      indicator_score: 0.16,
      max_drawdown_guard: 'block_live_forward',
      best_params: { stopLossPct: -1.25, maxDrawdownPct: 12, paperOnlyDays: 7 },
      reasons: ['negative_sharpe', 'max_drawdown_gt_20pct'],
    },
  ];
}

async function loadLatestStrategyRows({ limit = 50, market = null } = {}) {
  const params = [Math.max(1, Number(limit || 50))];
  const marketFilter = normalizeMarketFilter(market);
  const marketWhere = marketFilter ? `AND market = $${params.push(marketFilter)}` : '';
  return query(`
    SELECT DISTINCT ON (symbol, market)
           symbol, market, exchange, enhancement_status, hyperopt_status, best_params,
           max_drawdown_guard, indicator_score, reasons, evidence, observed_at
      FROM luna_phase4_strategy_enhancement_shadow
     WHERE shadow_only = true
       ${marketWhere}
     ORDER BY symbol, market, observed_at DESC
     LIMIT $1
  `, params).catch(() => []);
}

async function loadMutationPressure({ limit = 200 } = {}) {
  const rows = await query(`
    SELECT symbol, market, COUNT(*) AS mutation_count, AVG(severity) AS avg_severity
      FROM luna_posttrade_mutation_shadow
     WHERE shadow_only = true
       AND observed_at >= NOW() - INTERVAL '14 days'
     GROUP BY symbol, market
     LIMIT $1
  `, [Math.max(1, Number(limit || 200))]).catch(() => []);
  return new Map(rows.map((row) => [`${row.symbol}|${row.market}`, row]));
}

function buildGeneticRow(row = {}, pressure = {}, generation = 1) {
  const bestParams = parseJsonMaybe(row.best_params ?? row.bestParams, {});
  const reasons = parseJsonMaybe(row.reasons, []);
  const mutationCount = finiteNumber(pressure.mutation_count, 0);
  const mutationSeverity = clamp(pressure.avg_severity, 0, 1, 0);
  const indicatorScore = clamp(row.indicator_score ?? row.indicatorScore, 0, 1, 0);
  const drawdownBlocked = row.max_drawdown_guard === 'block_live_forward';
  const hyperoptPlanned = row.hyperopt_status === 'planned';
  const fitness = clamp(
    indicatorScore * 0.48
      + (row.enhancement_status === 'shadow_ready' ? 0.22 : 0.05)
      + (hyperoptPlanned ? 0.10 : 0.16)
      - (drawdownBlocked ? 0.22 : 0)
      - Math.min(0.18, mutationSeverity * 0.12 + mutationCount * 0.02)
      - Math.min(0.12, reasons.length * 0.02),
    0,
    1,
    0,
  );
  const blockedReasons = [
    drawdownBlocked ? 'max_drawdown_guard_blocks_live_forward' : null,
    reasons.includes('negative_sharpe') ? 'negative_sharpe' : null,
    mutationCount >= 3 ? 'recent_posttrade_mutation_pressure' : null,
    fitness < 0.45 ? 'fitness_below_shadow_threshold' : null,
  ].filter(Boolean);
  return {
    symbol: String(row.symbol || '').toUpperCase(),
    market: normalizeMarket(row.market),
    exchange: row.exchange || exchangeForMarket(row.market),
    generation,
    chromosome: {
      setupFamily: hyperoptPlanned ? 'genetic_hyperopt_candidate' : 'phase4_best_params_refinement',
      stopLossPct: finiteNumber(bestParams.stopLossPct, -2),
      takeProfitPct: finiteNumber(bestParams.takeProfitPct, 6),
      maxDrawdownPct: finiteNumber(bestParams.maxDrawdownPct, drawdownBlocked ? 12 : 20),
      paperOnlyDays: Math.max(7, finiteNumber(bestParams.paperOnlyDays, 7)),
      indicators: {
        macdHistogramMin: finiteNumber(bestParams.macdHistogramMin, 0),
        bollingerPositionMax: finiteNumber(bestParams.bollingerPositionMax, 0.8),
        rsiOversold: finiteNumber(bestParams.rsiOversold, 30),
      },
    },
    fitnessScore: round(fitness, 4),
    promotionStatus: blockedReasons.length === 0 && fitness >= 0.62 ? 'shadow_candidate_ready' : 'shadow_observe',
    blockedReasons,
    shadowOnly: true,
    liveMutation: false,
    evidence: {
      phase: 'luna_phase5_codex_p3',
      task: 'genetic_alpha_shadow',
      source: 'phase4_strategy_enhancement_plus_posttrade_pressure',
      mutationPressure: {
        count: mutationCount,
        avgSeverity: round(mutationSeverity, 4),
      },
      liveMutation: false,
    },
  };
}

export async function buildPhase5GeneticAlphaRows({ fixture = false, limit = 50, market = null, generation = 1 } = {}) {
  const strategyRows = fixture ? fixtureGeneticInputs() : await loadLatestStrategyRows({ limit, market });
  const pressureByKey = fixture ? new Map() : await loadMutationPressure({ limit: 200 });
  return strategyRows.map((row) => buildGeneticRow(row, pressureByKey.get(`${row.symbol}|${row.market}`) || {}, generation));
}

export async function ensureLunaPhase5Schema() {
  await run(`
    CREATE TABLE IF NOT EXISTS luna_phase5_mcp_a2a_bridge_shadow (
      id                    BIGSERIAL PRIMARY KEY,
      skill_id              TEXT NOT NULL,
      mcp_tool_name         TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'shadow_read_only_ready',
      direct_trade_allowed  BOOLEAN DEFAULT FALSE,
      protected_policy      TEXT NOT NULL,
      capability            JSONB DEFAULT '{}'::jsonb,
      evidence              JSONB DEFAULT '{}'::jsonb,
      observed_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase5_mcp_skill ON luna_phase5_mcp_a2a_bridge_shadow(skill_id, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase5_mcp_tool ON luna_phase5_mcp_a2a_bridge_shadow(mcp_tool_name, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase5_mcp_evidence ON luna_phase5_mcp_a2a_bridge_shadow USING GIN (evidence)`);

  await run(`
    CREATE TABLE IF NOT EXISTS luna_phase5_rl_ensemble_shadow (
      id                    BIGSERIAL PRIMARY KEY,
      symbol                TEXT NOT NULL,
      market                TEXT NOT NULL,
      exchange              TEXT NOT NULL,
      ensemble_model        TEXT NOT NULL DEFAULT 'luna_phase5_codex_p3_shadow_v1',
      action_type           TEXT NOT NULL DEFAULT 'hold',
      action_size_pct       DOUBLE PRECISION DEFAULT 0,
      confidence            DOUBLE PRECISION DEFAULT 0,
      reward_estimate       DOUBLE PRECISION DEFAULT 0,
      algorithm_votes       JSONB DEFAULT '[]'::jsonb,
      data_health           TEXT NOT NULL DEFAULT 'unknown',
      live_mutation         BOOLEAN DEFAULT FALSE,
      shadow_only           BOOLEAN DEFAULT TRUE,
      evidence              JSONB DEFAULT '{}'::jsonb,
      observed_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase5_rl_symbol ON luna_phase5_rl_ensemble_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase5_rl_action ON luna_phase5_rl_ensemble_shadow(action_type, confidence DESC, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase5_rl_votes ON luna_phase5_rl_ensemble_shadow USING GIN (algorithm_votes)`);

  await run(`
    CREATE TABLE IF NOT EXISTS luna_phase5_genetic_alpha_shadow (
      id                    BIGSERIAL PRIMARY KEY,
      symbol                TEXT NOT NULL,
      market                TEXT NOT NULL,
      exchange              TEXT NOT NULL,
      generation            INTEGER NOT NULL DEFAULT 1,
      chromosome            JSONB DEFAULT '{}'::jsonb,
      fitness_score         DOUBLE PRECISION DEFAULT 0,
      promotion_status      TEXT NOT NULL DEFAULT 'shadow_observe',
      blocked_reasons       JSONB DEFAULT '[]'::jsonb,
      live_mutation         BOOLEAN DEFAULT FALSE,
      shadow_only           BOOLEAN DEFAULT TRUE,
      evidence              JSONB DEFAULT '{}'::jsonb,
      observed_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase5_genetic_symbol ON luna_phase5_genetic_alpha_shadow(symbol, market, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase5_genetic_status ON luna_phase5_genetic_alpha_shadow(promotion_status, fitness_score DESC, observed_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_luna_phase5_genetic_chromosome ON luna_phase5_genetic_alpha_shadow USING GIN (chromosome)`);
}

export async function insertPhase5McpBridgeRow(row) {
  await run(`
    INSERT INTO luna_phase5_mcp_a2a_bridge_shadow
      (skill_id, mcp_tool_name, status, direct_trade_allowed, protected_policy, capability, evidence)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
  `, [
    row.skillId,
    row.mcpToolName,
    row.status,
    row.directTradeAllowed === true,
    row.protectedPolicy,
    JSON.stringify(row.capability || {}),
    JSON.stringify(row.evidence || {}),
  ]);
}

export async function insertPhase5RlEnsembleRow(row) {
  await run(`
    INSERT INTO luna_phase5_rl_ensemble_shadow
      (symbol, market, exchange, ensemble_model, action_type, action_size_pct, confidence,
       reward_estimate, algorithm_votes, data_health, live_mutation, shadow_only, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb)
  `, [
    row.symbol,
    row.market,
    row.exchange,
    row.ensembleModel,
    row.actionType,
    row.actionSizePct,
    row.confidence,
    row.rewardEstimate,
    JSON.stringify(row.algorithmVotes || []),
    row.dataHealth,
    false,
    true,
    JSON.stringify(row.evidence || {}),
  ]);
}

export async function insertPhase5GeneticAlphaRow(row) {
  await run(`
    INSERT INTO luna_phase5_genetic_alpha_shadow
      (symbol, market, exchange, generation, chromosome, fitness_score, promotion_status,
       blocked_reasons, live_mutation, shadow_only, evidence)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11::jsonb)
  `, [
    row.symbol,
    row.market,
    row.exchange,
    row.generation,
    JSON.stringify(row.chromosome || {}),
    row.fitnessScore,
    row.promotionStatus,
    JSON.stringify(row.blockedReasons || []),
    false,
    true,
    JSON.stringify(row.evidence || {}),
  ]);
}

export default {
  LUNA_PHASE5_A2A_SKILLS,
  LUNA_PHASE5_MODEL,
  buildPhase5GeneticAlphaRows,
  buildPhase5McpBridgeRows,
  buildPhase5RlEnsembleRows,
  ensureLunaPhase5Schema,
  insertPhase5GeneticAlphaRow,
  insertPhase5McpBridgeRow,
  insertPhase5RlEnsembleRow,
};
