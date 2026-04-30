// @ts-nocheck
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function calculateRealizedPnl({ buy = {}, sell = {}, quantity = null } = {}) {
  const qty = num(quantity ?? sell.quantity ?? sell.amount ?? buy.quantity ?? buy.amount, 0);
  const buyPrice = num(buy.price ?? buy.avgPrice ?? buy.average, 0);
  const sellPrice = num(sell.price ?? sell.avgPrice ?? sell.average, 0);
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
      while (remaining > 0 && buys.length) {
        const buy = buys[0];
        const matched = Math.min(remaining, buy.remaining);
        realized.push(calculateRealizedPnl({ buy, sell: trade, quantity: matched }));
        buy.remaining -= matched;
        remaining -= matched;
        if (buy.remaining <= 1e-12) buys.shift();
      }
    }
  }
  return { ok: true, realized, openLots: buys };
}

export default { calculateRealizedPnl, matchFifoRealizedPnl };
