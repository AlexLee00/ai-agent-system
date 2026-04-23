// @ts-nocheck

import * as db from './db.ts';
import { createOrUpdatePositionStrategyProfile } from './strategy-profile.ts';

function normalizeSide(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeTradeMode(value = null) {
  return String(value || 'normal').trim() || 'normal';
}

function inferDecisionFromTrade({ trade = null, signal = null } = {}) {
  const side = normalizeSide(trade?.side || signal?.action);
  if (side !== 'buy') return null;
  return {
    action: 'BUY',
    amount_usdt: Number(trade?.total_usdt ?? signal?.amount_usdt ?? 0),
    confidence: Number(signal?.confidence ?? 0.5),
    reasoning: signal?.reasoning || 'execution_attach_backfill',
    trade_mode: normalizeTradeMode(trade?.trade_mode || signal?.trade_mode),
    strategy_route: signal?.strategy_route || null,
    strategyRoute: signal?.strategy_route || null,
  };
}

export async function attachExecutionToPositionStrategy({
  trade = null,
  signal = null,
  dryRun = true,
  forceRefresh = false,
  requireOpenPosition = true,
} = {}) {
  if (!trade?.symbol || !trade?.exchange) {
    return { attached: false, status: 'skipped_missing_trade_scope' };
  }

  const side = normalizeSide(trade.side || signal?.action);
  if (side !== 'buy') {
    return { attached: false, status: 'skipped_non_buy', side };
  }

  const tradeMode = normalizeTradeMode(trade.trade_mode || signal?.trade_mode);
  const position = requireOpenPosition
    ? await db.getLivePosition(trade.symbol, trade.exchange, tradeMode).catch(() => null)
    : null;
  if (requireOpenPosition && !position) {
    return {
      attached: false,
      status: 'skipped_no_open_position',
      symbol: trade.symbol,
      exchange: trade.exchange,
      tradeMode,
    };
  }

  const existing = await db.getPositionStrategyProfile(trade.symbol, {
    exchange: trade.exchange,
    tradeMode,
  }).catch(() => null);
  const existingContext = existing?.strategy_context || {};
  const hasExecutionPlan = Boolean(existingContext?.executionPlan);
  const hasResponsibilityPlan = Boolean(existingContext?.responsibilityPlan);

  if (existing && hasExecutionPlan && hasResponsibilityPlan && !forceRefresh) {
    return {
      attached: false,
      status: 'existing_complete',
      profileId: existing.id,
      symbol: trade.symbol,
      exchange: trade.exchange,
      tradeMode,
    };
  }

  const decision = inferDecisionFromTrade({ trade, signal });
  if (!decision) return { attached: false, status: 'skipped_no_buy_decision' };

  if (dryRun) {
    return {
      attached: false,
      status: existing ? 'would_refresh_profile' : 'would_create_profile',
      profileId: existing?.id || null,
      symbol: trade.symbol,
      exchange: trade.exchange,
      tradeMode,
      signalId: signal?.id || trade.signal_id || null,
    };
  }

  const profile = await createOrUpdatePositionStrategyProfile({
    signalId: existing?.signal_id || signal?.id || trade.signal_id || null,
    symbol: trade.symbol,
    exchange: trade.exchange,
    tradeMode,
    decision,
    seedSignal: signal || null,
  });

  return {
    attached: Boolean(profile),
    status: profile ? (existing ? 'refreshed_profile' : 'created_profile') : 'skipped_profile_not_created',
    profileId: profile?.id || existing?.id || null,
    symbol: trade.symbol,
    exchange: trade.exchange,
    tradeMode,
    signalId: signal?.id || trade.signal_id || null,
  };
}

function buildAttachMeta(result = {}, error = null) {
  return {
    executionAttach: {
      checkedAt: new Date().toISOString(),
      ok: !error,
      status: error ? 'error' : (result?.status || 'unknown'),
      attached: Boolean(result?.attached),
      profileId: result?.profileId || null,
      symbol: result?.symbol || null,
      exchange: result?.exchange || null,
      tradeMode: result?.tradeMode || null,
      error: error ? String(error?.message || error).slice(0, 240) : null,
    },
  };
}

export async function attachExecutionToPositionStrategyTracked({
  trade = null,
  signal = null,
  dryRun = false,
  forceRefresh = false,
  requireOpenPosition = true,
  persistMeta = !dryRun,
} = {}) {
  const signalId = signal?.id || trade?.signal_id || trade?.signalId || null;
  try {
    const result = await attachExecutionToPositionStrategy({
      trade,
      signal,
      dryRun,
      forceRefresh,
      requireOpenPosition,
    });
    if (signalId && persistMeta) {
      await db.mergeSignalBlockMeta(signalId, buildAttachMeta(result)).catch(() => {});
    }
    return result;
  } catch (error) {
    if (signalId && persistMeta) {
      await db.mergeSignalBlockMeta(signalId, buildAttachMeta({}, error)).catch(() => {});
    }
    throw error;
  }
}
