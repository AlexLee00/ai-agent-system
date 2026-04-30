// @ts-nocheck
export function buildPosttradeAutoTrigger(trade = {}, opts = {}) {
  const side = String(trade.side || trade.action || '').toUpperCase();
  const closesPosition = side === 'SELL' || trade.closed === true || trade.closeout === true;
  const dryRun = opts.dryRun !== false;
  return {
    ok: true,
    dryRun,
    tradeId: trade.id ?? trade.tradeId ?? null,
    symbol: trade.symbol ?? null,
    closesPosition,
    shouldTrigger: closesPosition,
    pipeline: closesPosition
      ? ['trade_quality_evaluator', 'stage_attribution', 'reflexion_or_skill_extraction', 'agent_memory_write']
      : [],
    reasonCode: closesPosition ? 'closed_trade_detected' : 'not_a_close_trade',
  };
}

export function summarizePosttradeTriggers(trades = [], opts = {}) {
  const triggers = trades.map((trade) => buildPosttradeAutoTrigger(trade, opts));
  return {
    ok: true,
    total: triggers.length,
    triggerable: triggers.filter((item) => item.shouldTrigger).length,
    triggers,
  };
}

export default { buildPosttradeAutoTrigger, summarizePosttradeTriggers };
