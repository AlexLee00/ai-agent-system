// @ts-nocheck

import { getBrokerAdapter } from './brokers/broker-router.ts';
import { normalizePhaseAMarket, normalizePhaseASymbol } from './luna-phase-a-market-data.ts';

function compactError(error: any) {
  return String(error?.message || error || 'unknown_error').slice(0, 280);
}

function normalizeWarningRows(value: any): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.warnings)) return value.warnings;
  return [];
}

function warningTypeOf(row: any) {
  return row?.warningType || row?.warning_type || row?.type || row?.kind || null;
}

export function normalizeSecuritiesWarningSignal(signal: any = {}) {
  const market = normalizePhaseAMarket(signal.market || signal.exchange || 'domestic');
  return {
    market,
    symbol: normalizePhaseASymbol(signal.symbol || '', market),
    family: signal.family || '',
    signalType: signal.signalType || signal.signal_type || null,
  };
}

export function buildSecuritiesWarningGate(status: string, reason: string, details: any = {}) {
  return {
    name: 'G-securities-warning',
    status,
    reason,
    details: {
      source: 'toss',
      shadowOnly: true,
      ...details,
    },
  };
}

export async function evaluateSecuritiesWarningGate(signalInput: any = {}, options: any = {}, deps: any = {}) {
  const signal = normalizeSecuritiesWarningSignal(signalInput);
  if (!['domestic', 'overseas'].includes(signal.market)) {
    return buildSecuritiesWarningGate('skip', 'non_stock_market', { market: signal.market, symbol: signal.symbol || null });
  }
  if (!signal.symbol) {
    return buildSecuritiesWarningGate('skip', 'symbol_required', { market: signal.market });
  }

  try {
    const checkFn = deps.getSecuritiesWarning || options.getSecuritiesWarning;
    const warnings = checkFn
      ? await checkFn(signal.symbol, signal.market, options)
      : await getBrokerAdapter('toss').getSecuritiesWarning(signal.symbol, signal.market, options);
    const rows = normalizeWarningRows(warnings);
    const firstWarning = rows.find((row) => warningTypeOf(row)) || null;
    if (firstWarning) {
      return buildSecuritiesWarningGate('block', 'securities_warning_present', {
        market: signal.market,
        symbol: signal.symbol,
        warningType: warningTypeOf(firstWarning),
        warningCount: rows.length,
      });
    }
    return buildSecuritiesWarningGate('pass', 'no_securities_warning', {
      market: signal.market,
      symbol: signal.symbol,
      warningCount: rows.length,
    });
  } catch (error) {
    return buildSecuritiesWarningGate('skip', 'securities_warning_lookup_failed', {
      market: signal.market,
      symbol: signal.symbol,
      error: compactError(error),
    });
  }
}

export async function evaluateSecuritiesWarningsForSignals(signals = [], options: any = {}, deps: any = {}) {
  const entries = (signals || [])
    .map((signal) => ({ raw: signal, normalized: normalizeSecuritiesWarningSignal(signal) }))
    .filter((item) => item.normalized.signalType === 'entry' && ['domestic', 'overseas'].includes(item.normalized.market) && item.normalized.symbol);
  const symbols = [...new Set(entries.map((item) => item.normalized.symbol))];
  if (symbols.length === 0) return [];

  let rows = [];
  try {
    const universeFn = deps.getSecuritiesWarningsForUniverse || options.getSecuritiesWarningsForUniverse;
    rows = universeFn
      ? await universeFn(symbols, options)
      : await getBrokerAdapter('toss').getSecuritiesWarningsForUniverse(symbols, options);
  } catch (error) {
    rows = symbols.map((symbol) => ({ symbol, warned: false, error: compactError(error) }));
  }
  const bySymbol = new Map((rows || []).map((row) => [String(row.symbol || '').toUpperCase(), row]));
  return entries.map(({ normalized }) => {
    const row = bySymbol.get(normalized.symbol) || { symbol: normalized.symbol, warned: false, error: 'missing_universe_result' };
    if (row.error) {
      return buildSecuritiesWarningGate('skip', 'securities_warning_lookup_failed', {
        market: normalized.market,
        symbol: normalized.symbol,
        error: String(row.error).slice(0, 280),
      });
    }
    if (row.warned || row.warningType) {
      return buildSecuritiesWarningGate('block', 'securities_warning_present', {
        market: normalized.market,
        symbol: normalized.symbol,
        warningType: row.warningType || null,
        warningCount: Array.isArray(row.warnings) ? row.warnings.length : null,
      });
    }
    return buildSecuritiesWarningGate('pass', 'no_securities_warning', {
      market: normalized.market,
      symbol: normalized.symbol,
      warningCount: Array.isArray(row.warnings) ? row.warnings.length : null,
    });
  });
}

export function summarizeSecuritiesWarningGates(gates = []) {
  const rows = (gates || []).filter((gate) => gate?.name === 'G-securities-warning');
  const blocked = rows.filter((gate) => gate.status === 'block').length;
  const skipped = rows.filter((gate) => gate.status === 'skip').length;
  return {
    total: rows.length,
    blocked,
    skipped,
    line: `유의종목 배제 후보 ${blocked}건${skipped ? `·조회스킵 ${skipped}` : ''}`,
  };
}

export default {
  evaluateSecuritiesWarningGate,
  evaluateSecuritiesWarningsForSignals,
  summarizeSecuritiesWarningGates,
};
