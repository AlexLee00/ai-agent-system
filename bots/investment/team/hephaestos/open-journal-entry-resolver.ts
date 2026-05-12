// @ts-nocheck

function normalizeTradeMode(value) {
  return String(value || 'normal').trim() || 'normal';
}

function amountTolerance(amount) {
  const normalized = Math.abs(Number(amount || 0));
  return Math.max(1e-8, normalized * 0.0001);
}

function summarizeCandidate(entry) {
  return {
    tradeId: entry?.trade_id || null,
    signalId: entry?.signal_id || null,
    symbol: entry?.symbol || null,
    tradeMode: normalizeTradeMode(entry?.trade_mode),
    entrySize: Number(entry?.entry_size || 0),
    entryValue: Number(entry?.entry_value || 0),
  };
}

function selectUniqueAmountMatch(entries, soldAmount) {
  const normalizedSoldAmount = Number(soldAmount || 0);
  if (!(normalizedSoldAmount > 0)) return { status: 'unavailable', matches: [] };

  const tolerance = amountTolerance(normalizedSoldAmount);
  const matches = entries.filter((entry) => (
    Math.abs(Number(entry?.entry_size || 0) - normalizedSoldAmount) <= tolerance
  ));

  if (matches.length === 1) {
    return { status: 'matched', entry: matches[0], matches };
  }
  if (matches.length > 1) {
    return { status: 'ambiguous', matches };
  }
  return { status: 'missing', matches: [] };
}

export function selectOpenJournalEntryForSell(openEntries = [], {
  symbol,
  isPaper = false,
  tradeMode = 'normal',
  soldAmount = null,
  allowCrossModeSingleLive = true,
  allowCrossModeAmountMatch = true,
} = {}) {
  const effectiveTradeMode = normalizeTradeMode(tradeMode);
  const sameScope = (openEntries || []).filter((entry) => (
    entry?.symbol === symbol
      && Boolean(entry?.is_paper) === Boolean(isPaper)
  ));
  const exactMode = sameScope.filter((entry) => normalizeTradeMode(entry?.trade_mode) === effectiveTradeMode);

  const exactAmount = selectUniqueAmountMatch(exactMode, soldAmount);
  if (exactAmount.status === 'matched') {
    return {
      entry: exactAmount.entry,
      ok: true,
      matchType: 'exact_trade_mode_amount',
      reason: null,
      candidates: exactAmount.matches.map(summarizeCandidate),
    };
  }
  if (exactAmount.status === 'ambiguous') {
    return {
      entry: null,
      ok: false,
      matchType: null,
      reason: 'ambiguous_exact_trade_mode_amount',
      candidates: exactAmount.matches.map(summarizeCandidate),
    };
  }

  if (exactMode.length === 1) {
    return {
      entry: exactMode[0],
      ok: true,
      matchType: 'exact_trade_mode_single',
      reason: null,
      candidates: exactMode.map(summarizeCandidate),
    };
  }
  if (exactMode.length > 1) {
    return {
      entry: null,
      ok: false,
      matchType: null,
      reason: 'ambiguous_exact_trade_mode_open_journal',
      candidates: exactMode.map(summarizeCandidate),
    };
  }

  if (!isPaper && allowCrossModeAmountMatch) {
    const crossModeAmount = selectUniqueAmountMatch(sameScope, soldAmount);
    if (crossModeAmount.status === 'matched') {
      return {
        entry: crossModeAmount.entry,
        ok: true,
        matchType: 'cross_trade_mode_amount',
        reason: null,
        candidates: crossModeAmount.matches.map(summarizeCandidate),
      };
    }
    if (crossModeAmount.status === 'ambiguous') {
      return {
        entry: null,
        ok: false,
        matchType: null,
        reason: 'ambiguous_cross_trade_mode_amount',
        candidates: crossModeAmount.matches.map(summarizeCandidate),
      };
    }
  }

  if (!isPaper && allowCrossModeSingleLive && sameScope.length === 1) {
    return {
      entry: sameScope[0],
      ok: true,
      matchType: 'cross_trade_mode_single_live_scope',
      reason: null,
      candidates: sameScope.map(summarizeCandidate),
    };
  }

  return {
    entry: null,
    ok: false,
    matchType: null,
    reason: sameScope.length > 1
      ? 'ambiguous_cross_trade_mode_open_journal'
      : 'missing_open_journal_for_sell',
    candidates: sameScope.map(summarizeCandidate),
  };
}

export default {
  selectOpenJournalEntryForSell,
};
