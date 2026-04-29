#!/usr/bin/env node
// @ts-nocheck

import * as journalDb from '../shared/trade-journal-db.ts';
import * as db from '../shared/db.ts';
import { fetchBinanceOrder } from '../shared/binance-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const APPLY_CONFIRMATION = 'repair-protective-order-journals';

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeStatus(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isFilledClosedOrder(order = null) {
  if (!order) return false;
  const status = normalizeStatus(order.status);
  const filled = safeNumber(order.filled ?? order.amount, 0);
  return status === 'closed' && filled > 0;
}

function isOpenProtectionOrder(order = null) {
  if (!order) return false;
  return ['open', 'new', 'partially_filled'].includes(normalizeStatus(order.status));
}

function isNonFilledTerminalOrder(order = null) {
  if (!order) return false;
  const status = normalizeStatus(order.status);
  const filled = safeNumber(order.filled, 0);
  return ['canceled', 'cancelled', 'expired', 'rejected'].includes(status) && filled <= 0;
}

function summarizeOrder(order = null, role = '') {
  if (!order) return null;
  return {
    role,
    id: order.id || order.orderId || null,
    clientOrderId: order.clientOrderId || order.clientOrderID || null,
    status: order.status || null,
    side: order.side || null,
    type: order.type || null,
    amount: safeNumber(order.amount, null),
    filled: safeNumber(order.filled, null),
    average: safeNumber(order.average, null),
    price: safeNumber(order.price, null),
    cost: safeNumber(order.cost, null),
    timestamp: safeNumber(order.timestamp, null),
    datetime: order.datetime || null,
  };
}

function entryTolerance(entry = {}) {
  const qty = Math.abs(safeNumber(entry.entry_size, 0));
  return Math.max(0.000001, qty * 0.02);
}

export function classifyProtectiveOrderJournalRepair({
  entry = {},
  tpOrder = null,
  slOrder = null,
  tpError = null,
  slError = null,
} = {}) {
  const orders = [
    { role: 'take_profit', order: tpOrder, error: tpError },
    { role: 'stop_loss', order: slOrder, error: slError },
  ];
  const presentOrders = orders.filter((item) => item.order);
  const fetchErrors = orders.filter((item) => item.error).map((item) => ({
    role: item.role,
    error: String(item.error?.message || item.error).slice(0, 240),
  }));

  if (!presentOrders.length && fetchErrors.length) {
    return {
      action: 'manual_fetch_failed',
      closeSafe: false,
      manualOnly: true,
      reason: 'protective_order_lookup_failed',
      fetchErrors,
      orders: orders.map((item) => summarizeOrder(item.order, item.role)).filter(Boolean),
    };
  }

  const filledClosed = presentOrders.filter((item) => isFilledClosedOrder(item.order));
  if (filledClosed.length > 1) {
    return {
      action: 'manual_ambiguous_multiple_filled_protective_orders',
      closeSafe: false,
      manualOnly: true,
      reason: 'multiple_protective_orders_show_filled',
      fetchErrors,
      orders: orders.map((item) => summarizeOrder(item.order, item.role)).filter(Boolean),
    };
  }

  if (filledClosed.length === 1) {
    const winner = filledClosed[0];
    const filledQty = safeNumber(winner.order.filled, 0);
    const entryQty = safeNumber(entry.entry_size, 0);
    const side = String(winner.order.side || '').toLowerCase();
    if (side && side !== 'sell') {
      return {
        action: 'manual_non_sell_protective_fill',
        closeSafe: false,
        manualOnly: true,
        reason: 'filled_protective_order_side_is_not_sell',
        winningRole: winner.role,
        orders: orders.map((item) => summarizeOrder(item.order, item.role)).filter(Boolean),
      };
    }
    if (entryQty > 0 && Math.abs(filledQty - entryQty) > entryTolerance(entry)) {
      return {
        action: 'manual_partial_protective_fill',
        closeSafe: false,
        manualOnly: true,
        reason: 'filled_quantity_differs_from_journal_entry_size',
        winningRole: winner.role,
        entrySize: entryQty,
        filledQty,
        tolerance: entryTolerance(entry),
        orders: orders.map((item) => summarizeOrder(item.order, item.role)).filter(Boolean),
      };
    }
    return {
      action: 'close_from_protective_order',
      closeSafe: true,
      manualOnly: false,
      reason: 'single_filled_protective_order_found',
      winningRole: winner.role,
      winningOrder: summarizeOrder(winner.order, winner.role),
      orders: orders.map((item) => summarizeOrder(item.order, item.role)).filter(Boolean),
      fetchErrors,
    };
  }

  if (presentOrders.some((item) => isOpenProtectionOrder(item.order))) {
    return {
      action: 'observe_open_protection',
      closeSafe: false,
      manualOnly: false,
      reason: 'protective_order_still_open',
      orders: orders.map((item) => summarizeOrder(item.order, item.role)).filter(Boolean),
      fetchErrors,
    };
  }

  if (presentOrders.length && presentOrders.every((item) => isNonFilledTerminalOrder(item.order))) {
    return {
      action: 'observe_unfilled_terminal_protection',
      closeSafe: false,
      manualOnly: false,
      reason: 'protective_orders_terminal_without_fill',
      orders: orders.map((item) => summarizeOrder(item.order, item.role)).filter(Boolean),
      fetchErrors,
    };
  }

  return {
    action: 'manual_unknown_protective_order_state',
    closeSafe: false,
    manualOnly: true,
    reason: 'protective_order_state_not_classified',
    orders: orders.map((item) => summarizeOrder(item.order, item.role)).filter(Boolean),
    fetchErrors,
  };
}

export function buildProtectiveOrderJournalCloseInput(entry = {}, decision = {}) {
  const order = decision.winningOrder || {};
  const entryValue = safeNumber(entry.entry_value, 0);
  const exitPrice = safeNumber(order.average, 0) || safeNumber(order.price, 0);
  const exitValue = safeNumber(order.cost, 0)
    || (safeNumber(order.filled, 0) * exitPrice);
  const pnlAmount = exitValue - entryValue;
  const pnlPercent = entryValue > 0 ? journalDb.ratioToPercent(pnlAmount / entryValue) : null;
  const exitTime = safeNumber(order.timestamp, 0)
    || (order.datetime ? Date.parse(order.datetime) : 0)
    || Date.now();
  return {
    exitTime,
    exitPrice,
    exitValue,
    exitReason: `protective_order_reconciled:${decision.winningRole || 'unknown'}`,
    pnlAmount,
    pnlPercent,
    pnlNet: pnlAmount,
    execution_origin: 'reconciliation',
    quality_flag: 'trusted',
    exclude_from_learning: false,
    incident_link: `protective_order_reconcile:${order.id || 'unknown'}`,
  };
}

export function buildOpenProtectionJournalRestorePlan({ entry = {}, decision = {}, position = null } = {}) {
  if (decision?.action !== 'observe_open_protection') return null;
  const positionQty = safeNumber(position?.amount, 0);
  if (!(positionQty > 0)) return null;
  const openProtectionQty = Math.max(
    ...((decision.orders || [])
      .filter((order) => isOpenProtectionOrder(order))
      .map((order) => safeNumber(order.amount, 0))),
    0,
  );
  const entryQty = safeNumber(entry.entry_size, 0);
  const qtyTolerance = Math.max(0.000001, positionQty * 0.005);
  const protectionMatchesPosition = Math.abs(openProtectionQty - positionQty) <= qtyTolerance;
  const journalMismatch = Math.abs(entryQty - positionQty) > qtyTolerance;
  if (!protectionMatchesPosition || !journalMismatch) return null;

  const entryPrice = safeNumber(entry.entry_price, 0) || safeNumber(position?.avg_price, 0);
  const restoredValue = positionQty * entryPrice;
  return {
    action: 'restore_open_journal_from_open_protection',
    closeSafe: false,
    restoreSafe: true,
    repairSafe: true,
    manualOnly: false,
    reason: 'open_protective_order_matches_current_position_but_journal_qty_drifted',
    beforeEntrySize: entryQty,
    afterEntrySize: positionQty,
    beforeEntryValue: safeNumber(entry.entry_value, 0),
    afterEntryValue: restoredValue,
    openProtectionQty,
    positionQty,
    qtyTolerance,
  };
}

export function buildFilledProtectionJournalDriftRepairPlan({ entry = {}, decision = {} } = {}) {
  if (decision?.action !== 'manual_partial_protective_fill') return null;
  const entryQty = safeNumber(entry.entry_size, 0);
  const entryPrice = safeNumber(entry.entry_price, 0)
    || (entryQty > 0 ? safeNumber(entry.entry_value, 0) / entryQty : 0);
  const winningOrder = (decision.orders || []).find((order) => order.role === decision.winningRole)
    || (decision.orders || []).find((order) => isFilledClosedOrder(order));
  const filledQty = safeNumber(winningOrder?.filled, 0);
  const side = String(winningOrder?.side || '').toLowerCase();
  if (!(entryQty > 0) || !(entryPrice > 0) || !(filledQty > 0) || (side && side !== 'sell')) return null;

  const dustRatio = entryQty / filledQty;
  if (dustRatio > 0.01) return null;

  const restoredQty = filledQty + entryQty;
  const restoredValue = restoredQty * entryPrice;
  return {
    action: 'restore_and_close_from_filled_protection_after_journal_drift',
    closeSafe: true,
    repairSafe: true,
    restoreBeforeClose: true,
    manualOnly: false,
    reason: 'filled_protective_order_matches_journal_dust_drift',
    winningRole: decision.winningRole || winningOrder?.role || 'unknown',
    winningOrder,
    beforeEntrySize: entryQty,
    afterEntrySize: restoredQty,
    beforeEntryValue: safeNumber(entry.entry_value, 0),
    afterEntryValue: restoredValue,
    filledQty,
    dustRatio,
  };
}

export function buildClosedSiblingResidualPlan({ entry = {}, decision = {}, closedSibling = null } = {}) {
  if (decision?.action !== 'observe_unfilled_terminal_protection') return null;
  if (!closedSibling?.trade_id) return null;
  const entryQty = safeNumber(entry.entry_size, 0);
  const siblingQty = safeNumber(closedSibling.entry_size, 0);
  if (!(entryQty > 0) || !(siblingQty > 0)) return null;
  const residualRatio = entryQty / siblingQty;
  if (residualRatio > 0.01) return null;
  return {
    action: 'close_residual_from_closed_sibling',
    closeSafe: true,
    repairSafe: true,
    manualOnly: false,
    reason: 'small_open_residual_has_matching_closed_sibling',
    closeMode: 'closed_sibling_residual',
    closedSiblingTradeId: closedSibling.trade_id,
    closedSiblingExitReason: closedSibling.exit_reason || null,
    residualRatio,
  };
}

export function summarizeProtectiveOrderJournalRepair(results = []) {
  const byAction = {};
  const candidateTradeIds = [];
  const closedTradeIds = [];
  const restoredTradeIds = [];
  const manualTradeIds = [];
  const errors = [];
  for (const row of results) {
    const action = String(row?.action || 'unknown');
    byAction[action] = (byAction[action] || 0) + 1;
    if (row.closeSafe || row.restoreSafe) candidateTradeIds.push(row.tradeId);
    if (row.closed) closedTradeIds.push(row.tradeId);
    if (row.restored) restoredTradeIds.push(row.tradeId);
    if (row.manualOnly) manualTradeIds.push(row.tradeId);
    if (row.error) errors.push({ tradeId: row.tradeId, error: row.error });
  }
  return {
    total: results.length,
    byAction,
    candidates: candidateTradeIds.length,
    closed: closedTradeIds.length,
    restored: restoredTradeIds.length,
    manual: manualTradeIds.length,
    errors: errors.length,
    candidateTradeIds,
    closedTradeIds,
    restoredTradeIds,
    manualTradeIds,
    errorDetails: errors,
  };
}

export function parseProtectiveOrderJournalArgs(args = []) {
  const symbolsArg = args.find((arg) => arg.startsWith('--symbols='))?.split('=')[1];
  const maxAffectedArg = args.find((arg) => arg.startsWith('--max-affected-trades='))?.split('=')[1];
  const confirmArg = args.find((arg) => arg.startsWith('--confirm='))?.split('=')[1];
  return {
    dryRun: !args.includes('--apply'),
    apply: args.includes('--apply'),
    confirm: String(confirmArg || '').trim(),
    json: args.includes('--json'),
    symbols: symbolsArg ? symbolsArg.split(',').map((value) => value.trim()).filter(Boolean) : [],
    maxAffectedTrades: Number.isFinite(Number(maxAffectedArg)) ? Number(maxAffectedArg) : 10,
  };
}

async function fetchProtectiveOrder(orderId, symbol, role) {
  if (!orderId) return { role, order: null, error: null };
  try {
    const order = await fetchBinanceOrder(
      { orderId: String(orderId), symbol, allowAllOrdersFallback: false },
      symbol,
    );
    return { role, order, error: null };
  } catch (error) {
    return { role, order: null, error };
  }
}

async function closeJournalFromDecision(entry, decision, dryRun) {
  if (decision.closeMode === 'closed_sibling_residual') {
    const entryValue = safeNumber(entry.entry_value, 0);
    const closeInput = {
      exitTime: Date.now(),
      exitPrice: safeNumber(entry.entry_price, 0),
      exitValue: entryValue,
      exitReason: 'protective_order_reconciled:closed_sibling_residual',
      pnlAmount: 0,
      pnlPercent: 0,
      pnlNet: 0,
      execution_origin: 'cleanup',
      quality_flag: 'exclude_from_learning',
      exclude_from_learning: true,
      incident_link: `protective_order_reconcile:closed_sibling=${decision.closedSiblingTradeId || 'unknown'}`,
    };
    if (!dryRun) {
      await journalDb.closeJournalEntry(entry.trade_id, closeInput);
      await journalDb.ensureAutoReview(entry.trade_id).catch(() => {});
    }
    return closeInput;
  }

  let effectiveEntry = entry;
  let restoreInput = null;
  if (decision.restoreBeforeClose) {
    restoreInput = await restoreOpenJournalFromDecision(entry, decision, dryRun);
    effectiveEntry = {
      ...entry,
      entry_size: restoreInput.entrySize,
      entry_value: restoreInput.entryValue,
    };
  }

  const closeInput = buildProtectiveOrderJournalCloseInput(effectiveEntry, decision);
  if (!dryRun) {
    await journalDb.closeJournalEntry(effectiveEntry.trade_id, closeInput);
    await journalDb.ensureAutoReview(entry.trade_id).catch(() => {});
  }
  return restoreInput ? { ...closeInput, restoreInput } : closeInput;
}

async function restoreOpenJournalFromDecision(entry, decision, dryRun) {
  const patch = {
    entrySize: safeNumber(decision.afterEntrySize, 0),
    entryValue: safeNumber(decision.afterEntryValue, 0),
    incidentLink: 'protective_order_reconcile:restore_open_journal',
  };
  if (!dryRun) {
    await db.run(
      `UPDATE investment.trade_journal
          SET entry_size = $1,
              entry_value = $2,
              incident_link = COALESCE(incident_link, $3)
        WHERE trade_id = $4`,
      [patch.entrySize, patch.entryValue, patch.incidentLink, entry.trade_id],
    );
  }
  return patch;
}

async function findClosedSibling(entry = {}) {
  const rows = await db.query(
    `SELECT trade_id, signal_id, entry_size, entry_value, exit_time, exit_price, exit_value, exit_reason, tp_order_id, sl_order_id
      FROM investment.trade_journal
      WHERE status = 'closed'
        AND symbol = $1
        AND (
          (COALESCE(signal_id, '') = COALESCE($2, '') AND COALESCE($2, '') <> '')
          OR (
            COALESCE(tp_order_id, '') = COALESCE($3, '')
            AND COALESCE(sl_order_id, '') = COALESCE($4, '')
            AND COALESCE($3, '') <> ''
            AND COALESCE($4, '') <> ''
          )
        )
      ORDER BY exit_time DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [entry.symbol, entry.signal_id || null, entry.tp_order_id || null, entry.sl_order_id || null],
  ).catch(() => []);
  return rows[0] || null;
}

export async function reconcileProtectiveOrderJournals({
  dryRun = true,
  confirm = '',
  symbols = [],
  maxAffectedTrades = 10,
} = {}) {
  if (dryRun === false && confirm !== APPLY_CONFIRMATION) {
    return {
      ok: false,
      dryRun: false,
      blocked: true,
      reason: 'confirmation_required',
      message: `보호주문 journal 복구 적용은 --apply --confirm=${APPLY_CONFIRMATION} 가 필요합니다.`,
      results: [],
      summary: summarizeProtectiveOrderJournalRepair([]),
    };
  }

  await journalDb.initJournalSchema();
  const symbolFilter = new Set((symbols || []).map((value) => String(value).trim()).filter(Boolean));
  const openEntries = (await journalDb.getOpenJournalEntries('crypto'))
    .filter((entry) => String(entry.exchange || '').toLowerCase() === 'binance')
    .filter((entry) => !entry.is_paper)
    .filter((entry) => String(entry.tp_order_id || entry.sl_order_id || '').trim())
    .filter((entry) => symbolFilter.size === 0 || symbolFilter.has(String(entry.symbol || '').trim()));

  const dryRunResults = [];
  for (const entry of openEntries) {
    const [tp, sl] = await Promise.all([
      fetchProtectiveOrder(entry.tp_order_id, entry.symbol, 'take_profit'),
      fetchProtectiveOrder(entry.sl_order_id, entry.symbol, 'stop_loss'),
    ]);
    const decision = classifyProtectiveOrderJournalRepair({
      entry,
      tpOrder: tp.order,
      slOrder: sl.order,
      tpError: tp.error,
      slError: sl.error,
    });
    const [position, closedSibling] = await Promise.all([
      db.getPosition(entry.symbol, {
        exchange: entry.exchange || 'binance',
        paper: Boolean(entry.is_paper),
        tradeMode: entry.trade_mode || 'normal',
      }).catch(() => null),
      findClosedSibling(entry),
    ]);
    const restorePlan = buildOpenProtectionJournalRestorePlan({ entry, decision, position });
    const filledDriftPlan = buildFilledProtectionJournalDriftRepairPlan({ entry, decision });
    const residualPlan = buildClosedSiblingResidualPlan({ entry, decision, closedSibling });
    const finalDecision = restorePlan
      ? { ...decision, ...restorePlan }
      : filledDriftPlan
        ? { ...decision, ...filledDriftPlan }
      : residualPlan
        ? { ...decision, ...residualPlan }
        : decision;
    dryRunResults.push({
      tradeId: entry.trade_id,
      signalId: entry.signal_id || null,
      symbol: entry.symbol,
      entrySize: safeNumber(entry.entry_size, 0),
      entryValue: safeNumber(entry.entry_value, 0),
      tpOrderId: entry.tp_order_id || null,
      slOrderId: entry.sl_order_id || null,
      ...finalDecision,
    });
  }

  const preflightSummary = summarizeProtectiveOrderJournalRepair(dryRunResults);
  const max = Number(maxAffectedTrades);
  if (dryRun === false && Number.isFinite(max) && max > 0 && preflightSummary.candidates > max) {
    return {
      ok: false,
      dryRun: false,
      blocked: true,
      reason: 'max_affected_trades_exceeded',
      maxAffectedTrades: max,
      results: dryRunResults,
      summary: preflightSummary,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      scanned: openEntries.length,
      maxAffectedTrades: Number.isFinite(max) ? max : null,
      results: dryRunResults,
      summary: preflightSummary,
    };
  }

  const appliedResults = [];
  for (const result of dryRunResults) {
    if (!result.closeSafe && !result.restoreSafe) {
      appliedResults.push(result);
      continue;
    }
    const entry = openEntries.find((row) => row.trade_id === result.tradeId);
    try {
      if (result.restoreSafe) {
        const restoreInput = await restoreOpenJournalFromDecision(entry, result, false);
        appliedResults.push({ ...result, restored: true, restoreInput });
      } else {
        const closeInput = await closeJournalFromDecision(entry, result, false);
        appliedResults.push({ ...result, closed: true, closeInput });
      }
    } catch (error) {
      appliedResults.push({
        ...result,
        closed: false,
        error: String(error?.message || error).slice(0, 240),
      });
    }
  }

  const summary = summarizeProtectiveOrderJournalRepair(appliedResults);
  return {
    ok: summary.errors === 0,
    dryRun: false,
    scanned: openEntries.length,
    maxAffectedTrades: Number.isFinite(max) ? max : null,
    results: appliedResults,
    summary,
  };
}

async function main() {
  const options = parseProtectiveOrderJournalArgs(process.argv.slice(2));
  const result = await reconcileProtectiveOrderJournals(options);
  console.log(JSON.stringify(result, null, 2));
  if (result?.blocked || result?.ok === false) process.exitCode = 2;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ protective order journal reconcile 실패:',
  });
}
