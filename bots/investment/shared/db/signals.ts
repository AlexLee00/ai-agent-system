// @ts-nocheck
import { query, run, get } from './core.ts';
import { getInvestmentTradeMode } from '../secrets.ts';
import { getSignalDedupeWindowMinutes } from '../runtime-config.ts';

export async function insertSignal({
  symbol,
  action,
  amountUsdt,
  confidence,
  reasoning,
  status = 'pending',
  exchange = 'binance',
  analystSignals = null,
  tradeMode = null,
  nemesisVerdict = null,
  approvedAt = null,
  partialExitRatio = null,
  strategyFamily = null,
  strategyQuality = null,
  strategyReadiness = null,
  strategyRoute = null,
  executionOrigin = 'strategy',
  qualityFlag = 'trusted',
  excludeFromLearning = false,
  incidentLink = null,
}) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const rows = await query(
    `INSERT INTO signals (symbol, action, amount_usdt, confidence, reasoning, status, exchange, analyst_signals, trade_mode, nemesis_verdict, approved_at, partial_exit_ratio, strategy_family, strategy_quality, strategy_readiness, strategy_route, execution_origin, quality_flag, exclude_from_learning, incident_link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING id`,
    [
      symbol,
      action,
      amountUsdt ?? null,
      confidence ?? null,
      reasoning ?? null,
      status || 'pending',
      exchange,
      analystSignals ?? null,
      effectiveTradeMode,
      nemesisVerdict ?? null,
      approvedAt ?? null,
      partialExitRatio ?? null,
      strategyFamily ?? null,
      strategyQuality ?? null,
      strategyReadiness ?? null,
      strategyRoute ? JSON.stringify(strategyRoute) : null,
      executionOrigin || 'strategy',
      qualityFlag || 'trusted',
      excludeFromLearning === true,
      incidentLink ?? null,
    ],
  );
  return rows[0]?.id;
}

export async function getRecentSignalDuplicate({
  symbol,
  action,
  exchange = 'binance',
  tradeMode = null,
  minutesBack = 180,
} = {}) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  return get(
    `SELECT *
       FROM signals
      WHERE symbol = $1
        AND action = $2
        AND exchange = $3
        AND COALESCE(trade_mode, 'normal') = $4
        AND created_at > now() - INTERVAL '1 minute' * $5
      ORDER BY created_at DESC
      LIMIT 1`,
    [symbol, action, exchange, effectiveTradeMode, minutesBack],
  );
}

export async function getRecentBlockedSignalByCode({
  symbol,
  action = null,
  exchange = 'binance',
  tradeMode = null,
  blockCode,
  minutesBack = 1440,
} = {}) {
  if (!symbol || !blockCode) return null;
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const conditions = [
    `symbol = $1`,
    `exchange = $2`,
    `COALESCE(trade_mode, 'normal') = $3`,
    `COALESCE(block_code, '') = $4`,
    `created_at > now() - INTERVAL '1 minute' * $5`,
  ];
  const params = [symbol, exchange, effectiveTradeMode, blockCode, minutesBack];

  if (action) {
    params.push(action);
    conditions.push(`action = $${params.length}`);
  }

  return get(
    `SELECT *
       FROM signals
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT 1`,
    params,
  );
}

export async function insertSignalIfFresh({
  symbol,
  action,
  amountUsdt,
  confidence,
  reasoning,
  status = 'pending',
  exchange = 'binance',
  analystSignals = null,
  tradeMode = null,
  dedupeWindowMinutes = null,
  nemesisVerdict = null,
  approvedAt = null,
  strategyFamily = null,
  strategyQuality = null,
  strategyReadiness = null,
  strategyRoute = null,
  executionOrigin = 'strategy',
  qualityFlag = 'trusted',
  excludeFromLearning = false,
  incidentLink = null,
} = {}) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const effectiveWindow = Number.isFinite(Number(dedupeWindowMinutes)) && Number(dedupeWindowMinutes) > 0
    ? Math.round(Number(dedupeWindowMinutes))
    : getSignalDedupeWindowMinutes();
  const duplicate = await getRecentSignalDuplicate({
    symbol,
    action,
    exchange,
    tradeMode: effectiveTradeMode,
    minutesBack: effectiveWindow,
  });

  if (duplicate) {
    return {
      id: duplicate.id,
      duplicate: true,
      existingSignal: duplicate,
      dedupeWindowMinutes: effectiveWindow,
    };
  }

  const id = await insertSignal({
    symbol,
    action,
    amountUsdt,
    confidence,
    reasoning,
    status: status || 'pending',
    exchange,
    analystSignals,
    tradeMode: effectiveTradeMode,
    nemesisVerdict,
    approvedAt,
    strategyFamily,
    strategyQuality,
    strategyReadiness,
    strategyRoute,
    executionOrigin,
    qualityFlag,
    excludeFromLearning,
    incidentLink,
  });

  return {
    id,
    duplicate: false,
    existingSignal: null,
    dedupeWindowMinutes: effectiveWindow,
  };
}

export async function updateSignalStatus(id, status) {
  await run(`UPDATE signals SET status = $1 WHERE id = $2`, [status, id]);
}

export async function updateSignalApproval(id, {
  status = 'approved',
  nemesisVerdict = null,
  approvedAt = null,
} = {}) {
  if (!id) return;
  await run(
    `UPDATE signals
        SET status = $1,
            nemesis_verdict = COALESCE($2, nemesis_verdict),
            approved_at = COALESCE($3, approved_at, now())
      WHERE id = $4`,
    [status, nemesisVerdict, approvedAt, id],
  );
}

export async function updateSignalAmount(id, amountUsdt) {
  await run(`UPDATE signals SET amount_usdt = $1 WHERE id = $2`, [amountUsdt, id]);
}

export async function updateSignalBlock(id, {
  status = null,
  reason = null,
  code = null,
  meta = null,
} = {}) {
  if (!id) return;

  const sets = [];
  const params = [];

  if (status) {
    params.push(status);
    sets.push(`status = $${params.length}`);
  }
  if (reason !== null) {
    params.push(reason);
    sets.push(`block_reason = $${params.length}`);
  }
  if (code !== null) {
    params.push(code);
    sets.push(`block_code = $${params.length}`);
  }
  if (meta !== null) {
    params.push(meta ? JSON.stringify(meta) : null);
    sets.push(`block_meta = $${params.length}`);
  }
  if (sets.length === 0) return;

  params.push(id);
  await run(`UPDATE signals SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

export async function mergeSignalBlockMeta(id, meta = {}) {
  if (!id || !meta || typeof meta !== 'object') return;
  await run(
    `UPDATE signals
        SET block_meta = COALESCE(block_meta, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [JSON.stringify(meta), id],
  );
}

export async function getSignalById(id) {
  return get(`SELECT * FROM signals WHERE id = $1`, [id]);
}

export async function getPendingSignals(exchange, tradeMode = null) {
  const conditions = [`status = 'pending'`];
  const params = [];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (tradeMode) {
    params.push(tradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  return query(
    `SELECT * FROM signals WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
    params,
  );
}

export async function getApprovedSignals(exchange, tradeMode = null) {
  const conditions = [`status = 'approved'`];
  const params = [];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (tradeMode) {
    params.push(tradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  return query(
    `SELECT * FROM signals WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
    params,
  );
}
