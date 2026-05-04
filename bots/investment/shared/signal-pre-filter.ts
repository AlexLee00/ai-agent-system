// @ts-nocheck
import { evaluateKisMarketHours, deferSignal } from './kis-market-hours-guard.ts';

function resolveMarketFromExchange(exchange) {
  const ex = String(exchange || '').toLowerCase();
  if (ex.includes('kis_overseas') || ex.includes('overseas')) return 'overseas';
  if (ex.includes('kis') || ex.includes('domestic')) return 'domestic';
  return null; // binance 등 24/7 거래소
}

export function preFilterSignal(signal = {}, opts = {}) {
  const blockers = [];
  const warnings = [];
  const deferred = [];
  const confidence = Number(signal.confidence ?? signal.score ?? 0);
  const minConfidence = Number(opts.minConfidence ?? 0.55);
  const action = String(signal.action || '').toUpperCase();
  const now = opts.now instanceof Date ? opts.now : new Date();

  if (!['BUY', 'SELL', 'HOLD'].includes(action)) blockers.push('invalid_action');
  if (action === 'BUY' && confidence < minConfidence) blockers.push('low_confidence');
  if (signal.symbol == null) blockers.push('missing_symbol');
  if (signal.marketClosed) blockers.push('market_closed');
  if (signal.capitalMode && signal.capitalMode !== 'ACTIVE_DISCOVERY' && action === 'BUY') {
    warnings.push('capital_backpressure');
  }

  // KIS 시장 시간 체크 (BUY 신호 한정, SELL은 통과)
  const market = signal.market ?? resolveMarketFromExchange(signal.exchange);
  if (market && action === 'BUY') {
    const hoursCheck = evaluateKisMarketHours({ market, now });
    if (!hoursCheck.isOpen) {
      blockers.push('market_closed');
      if (opts.deferOnMarketClosed !== false && signal.id) {
        const deferred_ = deferSignal(signal, market, now);
        deferred.push({ market, ...deferred_ });
      }
    }
  }

  const decision = blockers.length ? 'blocked' : warnings.length ? 'watch' : 'pass';

  return {
    ok: blockers.length === 0,
    action,
    symbol: signal.symbol ?? null,
    market: market ?? 'crypto',
    blockers,
    warnings,
    deferred,
    decision,
  };
}

export function preFilterSignals(signals = [], opts = {}) {
  const results = signals.map((signal) => preFilterSignal(signal, opts));
  return {
    ok: results.every((result) => result.ok),
    passed: results.filter((result) => result.ok).length,
    blocked: results.filter((result) => !result.ok).length,
    deferred: results.reduce((sum, r) => sum + r.deferred.length, 0),
    results,
  };
}

export default { preFilterSignal, preFilterSignals };
