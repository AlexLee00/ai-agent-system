// @ts-nocheck
import { query, run, get } from './core.ts';
import { getInvestmentTradeMode, getExecutionMode, getBrokerAccountMode } from '../secrets.ts';

export function isUnifiedLiveSymbolScope(exchange = null, paper = null) {
  return String(exchange || '').trim().toLowerCase() === 'binance' && paper !== true;
}

export function canonicalizePositionTradeMode(exchange = null, paper = null, tradeMode = null) {
  if (isUnifiedLiveSymbolScope(exchange, paper)) return 'normal';
  return tradeMode || getInvestmentTradeMode();
}

export async function upsertPosition({ symbol, amount, avgPrice, unrealizedPnl, exchange = 'binance', paper = false, tradeMode = null }) {
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, paper, tradeMode);
  const normalizedExchange = String(exchange || 'binance').trim().toLowerCase();
  const marketType = normalizedExchange === 'kis' || normalizedExchange === 'kis_overseas' ? 'stocks' : 'crypto';
  const executionMode = paper === true ? 'paper' : getExecutionMode();
  const brokerAccountMode = getBrokerAccountMode(marketType);
  await run(
    `INSERT INTO positions (symbol, amount, avg_price, unrealized_pnl, paper, execution_mode, broker_account_mode, exchange, trade_mode, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (symbol, exchange, paper, trade_mode) DO UPDATE SET
       amount         = EXCLUDED.amount,
       avg_price      = EXCLUDED.avg_price,
       unrealized_pnl = EXCLUDED.unrealized_pnl,
       paper          = EXCLUDED.paper,
       execution_mode = EXCLUDED.execution_mode,
       broker_account_mode = EXCLUDED.broker_account_mode,
       exchange       = EXCLUDED.exchange,
       trade_mode     = EXCLUDED.trade_mode,
       updated_at     = EXCLUDED.updated_at`,
    [symbol, amount, avgPrice, unrealizedPnl ?? 0, paper === true, executionMode, brokerAccountMode, exchange, effectiveTradeMode],
  );
}

export async function deletePositionsForExchangeScope(exchange, { paper = false, symbol = null } = {}) {
  const conditions = [`exchange = $1`, `paper = $2`];
  const params = [exchange, paper === true];

  if (symbol) {
    params.push(symbol);
    conditions.push(`symbol = $${params.length}`);
  }

  return run(`DELETE FROM positions WHERE ${conditions.join(' AND ')}`, params);
}

export async function getPosition(symbol, { exchange = null, paper = null, tradeMode = null } = {}) {
  const conditions = [`symbol = $1`];
  const params = [symbol];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (paper !== null) {
    params.push(paper === true);
    conditions.push(`paper = $${params.length}`);
  }
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, paper, tradeMode);
  if (effectiveTradeMode && !isUnifiedLiveSymbolScope(exchange, paper)) {
    params.push(effectiveTradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  const orderBy = paper === null
    ? `ORDER BY paper ASC, updated_at DESC`
    : `ORDER BY updated_at DESC`;

  return get(`SELECT * FROM positions WHERE ${conditions.join(' AND ')} ${orderBy} LIMIT 1`, params);
}

export async function getLivePosition(symbol, exchange = null, tradeMode = null) {
  return getPosition(symbol, { exchange, paper: false, tradeMode });
}

export async function getPaperPosition(symbol, exchange = null, tradeMode = null) {
  return getPosition(symbol, { exchange, paper: true, tradeMode });
}

export async function getAllPositions(exchange = null, paper = null, tradeMode = null) {
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, paper, tradeMode);
  if (exchange && paper === true && tradeMode) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND exchange = $1 AND paper = true AND COALESCE(trade_mode, 'normal') = $2 ORDER BY symbol`,
      [exchange, effectiveTradeMode],
    );
  }
  if (paper === true && tradeMode) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND paper = true AND COALESCE(trade_mode, 'normal') = $1 ORDER BY symbol`,
      [effectiveTradeMode],
    );
  }
  if (exchange && paper === false && tradeMode && isUnifiedLiveSymbolScope(exchange, paper)) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND exchange = $1 AND paper = false ORDER BY symbol`,
      [exchange],
    );
  }
  if (exchange && paper !== null) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND exchange = $1 AND paper = $2 ORDER BY symbol`,
      [exchange, paper === true],
    );
  }
  if (exchange) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND exchange = $1 ORDER BY symbol`, [exchange]);
  }
  if (paper !== null) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND paper = $1 ORDER BY symbol`, [paper === true]);
  }
  return query(`SELECT * FROM positions WHERE amount > 0 ORDER BY symbol`);
}

export async function getPaperPositions(exchange = null, tradeMode = null) {
  if (exchange && tradeMode) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND paper = true AND exchange = $1 AND COALESCE(trade_mode, 'normal') = $2 ORDER BY updated_at ASC`,
      [exchange, tradeMode],
    );
  }
  if (exchange) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND paper = true AND exchange = $1 ORDER BY updated_at ASC`, [exchange]);
  }
  if (tradeMode) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND paper = true AND COALESCE(trade_mode, 'normal') = $1 ORDER BY updated_at ASC`, [tradeMode]);
  }
  return query(`SELECT * FROM positions WHERE amount > 0 AND paper = true ORDER BY updated_at ASC`);
}

export async function getOpenPositions(exchange = null, paper = false, tradeMode = null) {
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, paper, tradeMode);
  if (exchange && tradeMode && !isUnifiedLiveSymbolScope(exchange, paper)) {
    return query(
      `SELECT p.symbol, p.amount, p.avg_price, p.unrealized_pnl, p.exchange, p.paper,
              COALESCE(p.trade_mode, 'normal') AS trade_mode,
              COALESCE(
                (
                  SELECT MIN(tj.entry_time)
                  FROM trade_journal tj
                  WHERE tj.symbol = p.symbol
                    AND tj.exchange = p.exchange
                    AND tj.is_paper = p.paper
                    AND COALESCE(tj.trade_mode, 'normal') = COALESCE(p.trade_mode, 'normal')
                    AND tj.status = 'open'
                ),
                (EXTRACT(EPOCH FROM p.updated_at) * 1000)::bigint
              ) AS entry_time,
              p.updated_at
       FROM positions p
       WHERE p.amount > 0 AND p.exchange = $1 AND p.paper = $2 AND COALESCE(p.trade_mode, 'normal') = $3
       ORDER BY entry_time ASC`,
      [exchange, paper === true, effectiveTradeMode],
    );
  }
  if (exchange) {
    return query(
      `SELECT p.symbol, p.amount, p.avg_price, p.unrealized_pnl, p.exchange, p.paper,
              COALESCE(p.trade_mode, 'normal') AS trade_mode,
              COALESCE(
                (
                  SELECT MIN(tj.entry_time)
                  FROM trade_journal tj
                  WHERE tj.symbol = p.symbol
                    AND tj.exchange = p.exchange
                    AND tj.is_paper = p.paper
                    AND COALESCE(tj.trade_mode, 'normal') = COALESCE(p.trade_mode, 'normal')
                    AND tj.status = 'open'
                ),
                (EXTRACT(EPOCH FROM p.updated_at) * 1000)::bigint
              ) AS entry_time,
              p.updated_at
       FROM positions p
       WHERE p.amount > 0 AND p.exchange = $1 AND p.paper = $2
       ORDER BY entry_time ASC`,
      [exchange, paper === true],
    );
  }
  return query(
    `SELECT p.symbol, p.amount, p.avg_price, p.unrealized_pnl, p.exchange, p.paper,
            COALESCE(p.trade_mode, 'normal') AS trade_mode,
            COALESCE(
              (
                SELECT MIN(tj.entry_time)
                FROM trade_journal tj
                WHERE tj.symbol = p.symbol
                  AND tj.exchange = p.exchange
                  AND tj.is_paper = p.paper
                  AND COALESCE(tj.trade_mode, 'normal') = COALESCE(p.trade_mode, 'normal')
                  AND tj.status = 'open'
              ),
              (EXTRACT(EPOCH FROM p.updated_at) * 1000)::bigint
            ) AS entry_time,
            p.updated_at
     FROM positions p
     WHERE p.amount > 0 AND p.paper = $1
     ORDER BY entry_time ASC`,
    [paper === true],
  );
}

export async function deletePosition(symbol, { exchange = null, paper = null, tradeMode = null } = {}) {
  const conditions = [`symbol = $1`];
  const params = [symbol];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (paper !== null) {
    params.push(paper === true);
    conditions.push(`paper = $${params.length}`);
  }
  if ((tradeMode || paper !== null) && !isUnifiedLiveSymbolScope(exchange, paper)) {
    const effectiveMode = canonicalizePositionTradeMode(exchange, paper, tradeMode);
    params.push(effectiveMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  await run(`DELETE FROM positions WHERE ${conditions.join(' AND ')}`, params);
  // deferred import to avoid circular dep with position-profile
  const { closePositionStrategyProfile } = await import('./position-profile.ts');
  await closePositionStrategyProfile(symbol, { exchange, tradeMode }).catch(() => {});
}

export async function getTodayPnl(exchange = null) {
  const conditions = [
    `status = 'closed'`,
    `exit_time IS NOT NULL`,
    `to_timestamp(exit_time / 1000.0)::date = current_date`,
  ];
  const params = [];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }

  const rows = await query(`
    SELECT
      COALESCE(SUM(pnl_net), 0) AS pnl,
      COUNT(*) AS trade_count
    FROM trade_journal
    WHERE ${conditions.join(' AND ')}
  `, params);
  return rows[0] || { pnl: 0, trade_count: 0 };
}
