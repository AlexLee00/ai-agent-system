// @ts-nocheck
function round(value) {
  return Number(Number(value).toFixed(8));
}

export function calculateAtrTpSl({ entryPrice, atr, side = 'BUY', rr = 2, atrStopMultiple = 1 } = {}) {
  const entry = Number(entryPrice);
  const atrValue = Number(atr);
  if (!(entry > 0) || !(atrValue > 0)) {
    return { ok: false, reasonCode: 'invalid_entry_or_atr', takeProfit: null, stopLoss: null };
  }
  const longSide = String(side).toUpperCase() !== 'SELL';
  const risk = atrValue * Number(atrStopMultiple || 1);
  const reward = risk * Number(rr || 2);
  return {
    ok: true,
    side: longSide ? 'BUY' : 'SELL',
    entryPrice: round(entry),
    atr: round(atrValue),
    stopLoss: round(longSide ? entry - risk : entry + risk),
    takeProfit: round(longSide ? entry + reward : entry - reward),
    riskReward: Number(rr || 2),
    reasonCode: 'atr_tp_sl',
  };
}

export default { calculateAtrTpSl };
