// @ts-nocheck
export function preFilterSignal(signal = {}, opts = {}) {
  const blockers = [];
  const warnings = [];
  const confidence = Number(signal.confidence ?? signal.score ?? 0);
  const minConfidence = Number(opts.minConfidence ?? 0.55);
  const action = String(signal.action || '').toUpperCase();
  if (!['BUY', 'SELL', 'HOLD'].includes(action)) blockers.push('invalid_action');
  if (action === 'BUY' && confidence < minConfidence) blockers.push('low_confidence');
  if (signal.symbol == null) blockers.push('missing_symbol');
  if (signal.marketClosed) blockers.push('market_closed');
  if (signal.capitalMode && signal.capitalMode !== 'ACTIVE_DISCOVERY' && action === 'BUY') warnings.push('capital_backpressure');
  return {
    ok: blockers.length === 0,
    action,
    symbol: signal.symbol ?? null,
    blockers,
    warnings,
    decision: blockers.length ? 'blocked' : warnings.length ? 'watch' : 'pass',
  };
}

export function preFilterSignals(signals = [], opts = {}) {
  const results = signals.map((signal) => preFilterSignal(signal, opts));
  return {
    ok: results.every((result) => result.ok),
    passed: results.filter((result) => result.ok).length,
    blocked: results.filter((result) => !result.ok).length,
    results,
  };
}

export default { preFilterSignal, preFilterSignals };
