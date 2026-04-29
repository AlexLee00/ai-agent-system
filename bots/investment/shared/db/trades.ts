// @ts-nocheck
import { query, run, get } from './core.ts';
import { getInvestmentTradeMode } from '../secrets.ts';

export async function insertTrade({ signalId, symbol, side, amount, price, totalUsdt, paper, exchange = 'binance', tpPrice = null, slPrice = null, tpOrderId = null, slOrderId = null, tpSlSet = false, tradeMode = null, executionOrigin = 'strategy', qualityFlag = 'trusted', excludeFromLearning = false, incidentLink = null }) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  await run(
    `INSERT INTO trades (signal_id, symbol, side, amount, price, total_usdt, paper, exchange, tp_price, sl_price, tp_order_id, sl_order_id, tp_sl_set, trade_mode, execution_origin, quality_flag, exclude_from_learning, incident_link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [signalId ?? null, symbol, side, amount, price, totalUsdt ?? null, paper !== false, exchange,
     tpPrice, slPrice, tpOrderId, slOrderId, tpSlSet ?? false, effectiveTradeMode,
     executionOrigin || 'strategy', qualityFlag || 'trusted', excludeFromLearning === true, incidentLink ?? null],
  );
}

export async function getTradeHistory(symbol, limit = 50) {
  if (symbol) {
    return query(`SELECT * FROM trades WHERE symbol = $1 ORDER BY executed_at DESC LIMIT $2`, [symbol, limit]);
  }
  return query(`SELECT * FROM trades ORDER BY executed_at DESC LIMIT $1`, [limit]);
}

export async function getLatestTradeBySignalId(signalId) {
  return get(`SELECT * FROM trades WHERE signal_id = $1 ORDER BY executed_at DESC LIMIT 1`, [signalId]);
}

export async function getSameDayTrade({
  symbol,
  side,
  exchange = null,
  tradeMode = null,
} = {}) {
  const conditions = [`symbol = $1`, `side = $2`, `executed_at::date = CURRENT_DATE`];
  const params = [symbol, side];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (tradeMode) {
    params.push(tradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  return get(
    `SELECT * FROM trades WHERE ${conditions.join(' AND ')} ORDER BY executed_at DESC LIMIT 1`,
    params,
  );
}
