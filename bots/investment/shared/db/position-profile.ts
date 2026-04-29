// @ts-nocheck
import { query, run, get } from './core.ts';
import { canonicalizePositionTradeMode } from './positions.ts';

export async function getPositionStrategyProfile(symbol, {
  exchange = null,
  tradeMode = null,
  status = 'active',
} = {}) {
  if (!symbol) return null;
  const conditions = [`symbol = $1`];
  const params = [symbol];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, false, tradeMode);
  if (effectiveTradeMode) {
    params.push(effectiveTradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  return get(
    `SELECT *
     FROM position_strategy_profiles
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    params,
  );
}

export async function getActivePositionStrategyProfiles({
  exchange = null,
  symbol = null,
  status = 'active',
  limit = 500,
} = {}) {
  const conditions = [];
  const params = [];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (symbol) {
    params.push(symbol);
    conditions.push(`symbol = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(Math.max(1, Number(limit || 500)));

  return query(
    `SELECT *
     FROM position_strategy_profiles
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $${params.length}`,
    params,
  );
}

export async function upsertPositionStrategyProfile({
  symbol,
  exchange,
  signalId = null,
  tradeMode = null,
  strategyName = null,
  strategyQualityScore = null,
  setupType = null,
  thesis = null,
  monitoringPlan = {},
  exitPlan = {},
  backtestPlan = {},
  marketContext = {},
  strategyContext = {},
} = {}) {
  if (!symbol || !exchange) return null;
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, false, tradeMode);
  const updated = await get(
    `UPDATE position_strategy_profiles
     SET signal_id = $1,
         strategy_name = $2,
         strategy_quality_score = $3,
         setup_type = $4,
         thesis = $5,
         monitoring_plan = $6,
         exit_plan = $7,
         backtest_plan = $8,
         market_context = $9,
         strategy_context = $10,
         updated_at = now()
     WHERE symbol = $11
       AND exchange = $12
       AND COALESCE(trade_mode, 'normal') = $13
       AND status = 'active'
     RETURNING *`,
    [
      signalId,
      strategyName,
      strategyQualityScore,
      setupType,
      thesis,
      JSON.stringify(monitoringPlan || {}),
      JSON.stringify(exitPlan || {}),
      JSON.stringify(backtestPlan || {}),
      JSON.stringify(marketContext || {}),
      JSON.stringify(strategyContext || {}),
      symbol,
      exchange,
      effectiveTradeMode,
    ],
  );
  if (updated) return updated;

  return get(
    `INSERT INTO position_strategy_profiles (
       symbol, exchange, signal_id, trade_mode, status,
       strategy_name, strategy_quality_score, setup_type, thesis,
       monitoring_plan, exit_plan, backtest_plan, market_context, strategy_context
     ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      symbol,
      exchange,
      signalId,
      effectiveTradeMode,
      strategyName,
      strategyQualityScore,
      setupType,
      thesis,
      JSON.stringify(monitoringPlan || {}),
      JSON.stringify(exitPlan || {}),
      JSON.stringify(backtestPlan || {}),
      JSON.stringify(marketContext || {}),
      JSON.stringify(strategyContext || {}),
    ],
  );
}

export async function updatePositionStrategyProfileState(symbol, {
  exchange = null,
  tradeMode = null,
  strategyState = {},
  lastEvaluationAt = null,
  lastAttentionAt = null,
} = {}) {
  if (!symbol || !exchange) return null;
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, false, tradeMode);
  return get(
    `UPDATE position_strategy_profiles
     SET strategy_state = COALESCE(strategy_state, '{}'::jsonb) || $1::jsonb,
         last_evaluation_at = COALESCE($2::timestamptz, now()),
         last_attention_at = CASE WHEN $3::timestamptz IS NULL THEN last_attention_at ELSE $3::timestamptz END,
         updated_at = now()
     WHERE symbol = $4
       AND exchange = $5
       AND COALESCE(trade_mode, 'normal') = $6
       AND status = 'active'
     RETURNING *`,
    [
      JSON.stringify(strategyState || {}),
      lastEvaluationAt,
      lastAttentionAt,
      symbol,
      exchange,
      effectiveTradeMode,
    ],
  );
}

export async function closePositionStrategyProfile(symbol, {
  exchange = null,
  tradeMode = null,
  signalId = null,
} = {}) {
  if (!symbol) return null;
  const conditions = [`symbol = $1`];
  const params = [symbol];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, false, tradeMode);
  if (effectiveTradeMode) {
    params.push(effectiveTradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }
  if (signalId) {
    params.push(signalId);
    conditions.push(`signal_id = $${params.length}`);
  }

  params.push('active');
  conditions.push(`status = $${params.length}`);

  const row = await get(
    `SELECT * FROM position_strategy_profiles
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT 1`,
    params,
  );
  if (!row?.id) return null;
  const closedState = {
    lifecycleStatus: 'closed',
    latestRecommendation: 'CLOSED',
    latestReasonCode: 'position_closed',
    latestReason: 'position scope closed',
    closedAt: new Date().toISOString(),
    updatedBy: 'close_position_strategy_profile',
  };
  return get(
    `UPDATE position_strategy_profiles
     SET status = 'closed',
         strategy_state = COALESCE(strategy_state, '{}'::jsonb) || $2::jsonb,
         closed_at = now(),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [row.id, JSON.stringify(closedState)],
  );
}
