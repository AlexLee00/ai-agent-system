// @ts-nocheck
import { query, run } from './db/core.ts';

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ── 순수 계산 (DB 없음) ────────────────────────────────────────────────────────

export function calculateRealizedPnl({ buy = {}, sell = {}, quantity = null } = {}) {
  const qty = num(quantity ?? sell.quantity ?? sell.amount ?? buy.quantity ?? buy.amount, 0);
  const buyPrice = num(buy.price ?? buy.avg_price ?? buy.average, 0);
  const sellPrice = num(sell.price ?? sell.avg_price ?? sell.average, 0);
  const fees = num(buy.fee, 0) + num(sell.fee, 0);
  if (!(qty > 0) || !(buyPrice > 0) || !(sellPrice > 0)) {
    return { ok: false, reasonCode: 'insufficient_trade_data', realizedPnl: 0, realizedPnlPct: 0 };
  }
  const cost = buyPrice * qty;
  const proceeds = sellPrice * qty;
  const realizedPnl = proceeds - cost - fees;
  return {
    ok: true,
    quantity: qty,
    cost,
    proceeds,
    fees,
    realizedPnl,
    realizedPnlPct: cost > 0 ? realizedPnl / cost : 0,
  };
}

export function matchFifoRealizedPnl(trades = []) {
  const buys = [];
  const realized = [];
  for (const trade of trades) {
    const side = String(trade.side || trade.action || '').toUpperCase();
    const qty = num(trade.quantity ?? trade.amount, 0);
    if (side === 'BUY') buys.push({ ...trade, remaining: qty });
    if (side === 'SELL') {
      let remaining = qty;
      const matchedBuyIds = [];
      while (remaining > 0 && buys.length) {
        const buy = buys[0];
        const matched = Math.min(remaining, buy.remaining);
        const pnl = calculateRealizedPnl({ buy, sell: trade, quantity: matched });
        realized.push({ ...pnl, sellTradeId: trade.id, buyTradeId: buy.id });
        if (buy.id) matchedBuyIds.push(buy.id);
        buy.remaining -= matched;
        remaining -= matched;
        if (buy.remaining <= 1e-12) buys.shift();
      }
      if (matchedBuyIds.length) realized[realized.length - 1].primaryBuyId = matchedBuyIds[0];
    }
  }
  return { ok: true, realized, openLots: buys };
}

// ── DB 레이어 ──────────────────────────────────────────────────────────────────

export async function fetchTradesForSymbol(symbol, exchange = null) {
  const params = [String(symbol)];
  const conds = ['symbol = $1', "LOWER(side) IN ('buy','sell')"];
  if (exchange) {
    params.push(String(exchange));
    conds.push(`exchange = $${params.length}`);
  }
  return query(
    `SELECT id, side, amount, price, total_usdt, exchange, executed_at, paper, trade_mode
       FROM trades
      WHERE ${conds.join(' AND ')}
      ORDER BY executed_at ASC`,
    params,
  ).catch(() => []);
}

export async function fetchDistinctSymbolsWithUnmatchedSells() {
  return query(
    `SELECT DISTINCT symbol, exchange
       FROM trades
      WHERE LOWER(side) = 'sell'
        AND realized_pnl_pct IS NULL
      ORDER BY symbol`,
    [],
  ).catch(() => []);
}

export async function persistRealizedPnl(sellTradeId, { realizedPnl, realizedPnlPct, matchedBuyId = null } = {}) {
  if (!sellTradeId) return null;
  return run(
    `UPDATE trades
        SET realized_pnl_usdt = $2,
            realized_pnl_pct  = $3,
            matched_buy_id    = $4
      WHERE id = $1
        AND LOWER(side) = 'sell'`,
    [
      String(sellTradeId),
      Number.isFinite(realizedPnl) ? realizedPnl : null,
      Number.isFinite(realizedPnlPct) ? realizedPnlPct : null,
      matchedBuyId ? String(matchedBuyId) : null,
    ],
  ).catch(() => null);
}

// symbol+exchange 단위로 BUY-SELL FIFO 매칭 후 DB에 저장
export async function computeAndPersistPnlForSymbol(symbol, exchange = null, { dryRun = true } = {}) {
  const trades = await fetchTradesForSymbol(symbol, exchange);
  if (!trades.length) return { ok: true, symbol, exchange, matched: 0, skipped: 0 };

  const { realized } = matchFifoRealizedPnl(trades);
  let matched = 0;
  let skipped = 0;
  for (const r of realized) {
    if (!r.ok || !r.sellTradeId) { skipped++; continue; }
    if (!dryRun) {
      await persistRealizedPnl(r.sellTradeId, {
        realizedPnl: r.realizedPnl,
        realizedPnlPct: r.realizedPnlPct,
        matchedBuyId: r.primaryBuyId ?? null,
      });
    }
    matched++;
  }
  return { ok: true, symbol, exchange, matched, skipped, dryRun, realized };
}

// 전체 미매칭 SELL 거래 일괄 처리
export async function backfillAllRealizedPnl({ dryRun = true, limit = 500 } = {}) {
  const pairs = await fetchDistinctSymbolsWithUnmatchedSells();
  const results = [];
  let totalMatched = 0;
  let totalSkipped = 0;

  for (const { symbol, exchange } of pairs.slice(0, limit)) {
    const r = await computeAndPersistPnlForSymbol(symbol, exchange, { dryRun });
    results.push(r);
    totalMatched += r.matched;
    totalSkipped += r.skipped;
  }

  return {
    ok: true,
    dryRun,
    symbolPairsProcessed: results.length,
    totalMatched,
    totalSkipped,
    results,
  };
}

export default {
  calculateRealizedPnl,
  matchFifoRealizedPnl,
  fetchTradesForSymbol,
  fetchDistinctSymbolsWithUnmatchedSells,
  persistRealizedPnl,
  computeAndPersistPnlForSymbol,
  backfillAllRealizedPnl,
};
