#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBinanceBalanceSnapshot, getBinanceOpenOrders } from '../shared/binance-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildCryptoPartialAdjustPreflight,
  loadPartialAdjustCandidates,
} from './partial-adjust-runner.ts';
import {
  cancelOpenSellOrdersForSymbol,
  placeBinanceProtectiveExit,
} from '../team/hephaestos.ts';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const APPLY_CONFIRM = 'protective-rebalance-partial-adjust';

function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [rawKey, ...rest] = arg.slice(2).split('=');
    values[rawKey] = rest.length > 0 ? rest.join('=') : true;
  }
  return {
    json: Boolean(values.json),
    symbol: values.symbol ? String(values.symbol).toUpperCase() : null,
    exchange: values.exchange ? String(values.exchange) : 'binance',
    tradeMode: values['trade-mode'] ? String(values['trade-mode']) : 'normal',
    minutesBack: values.minutes ? Math.max(10, Number(values.minutes)) : 180,
    apply: Boolean(values.apply),
    confirm: values.confirm ? String(values.confirm) : null,
  };
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function baseAsset(symbol = '') {
  return String(symbol || '').split('/')[0].trim().toUpperCase();
}

function isOpenSellOrder(order = {}) {
  const side = String(order?.side || '').toLowerCase();
  const status = String(order?.status || '').toLowerCase();
  return side === 'sell' && !['closed', 'canceled', 'cancelled', 'expired', 'rejected'].includes(status);
}

function orderGroupKey(order = {}) {
  const listId = order?.orderListId ?? order?.info?.orderListId;
  if (listId != null && String(listId) !== '-1') return `oco:${listId}`;
  const timestamp = order?.timestamp || order?.datetime || order?.createdAt || 'unknown_time';
  return `single:${timestamp}:${order?.id || order?.clientOrderId || 'unknown_order'}`;
}

export function summarizeProtectiveSellOrders(openOrders = []) {
  const orders = (openOrders || []).filter(isOpenSellOrder);
  const grouped = new Map();
  for (const order of orders) {
    const key = orderGroupKey(order);
    const current = grouped.get(key) || {
      groupKey: key,
      orderListId: order?.orderListId ?? order?.info?.orderListId ?? null,
      orderIds: [],
      clientOrderIds: [],
      roles: [],
      totalRemaining: 0,
      orders: [],
    };
    current.orderIds.push(String(order?.id || order?.orderId || 'unknown'));
    if (order?.clientOrderId) current.clientOrderIds.push(String(order.clientOrderId));
    current.roles.push(String(order?.type || order?.info?.type || 'unknown').toLowerCase());
    current.totalRemaining += safeNumber(order?.remaining, safeNumber(order?.amount, 0));
    current.orders.push({
      id: order?.id || order?.orderId || null,
      clientOrderId: order?.clientOrderId || null,
      type: order?.type || order?.info?.type || null,
      status: order?.status || null,
      price: safeNumber(order?.price, null),
      stopPrice: safeNumber(order?.stopPrice ?? order?.info?.stopPrice, null),
      amount: safeNumber(order?.amount, null),
      remaining: safeNumber(order?.remaining, null),
    });
    grouped.set(key, current);
  }
  return [...grouped.values()].map((group) => ({
    ...group,
    orderIds: [...new Set(group.orderIds)],
    clientOrderIds: [...new Set(group.clientOrderIds)],
    roles: [...new Set(group.roles)],
    totalRemaining: Number(group.totalRemaining.toFixed(8)),
  }));
}

function findCandidate(candidates = [], { symbol, exchange, tradeMode } = {}) {
  return (candidates || []).find((candidate) => (
    String(candidate?.symbol || '').toUpperCase() === String(symbol || '').toUpperCase()
    && String(candidate?.exchange || '') === String(exchange || '')
    && String(candidate?.tradeMode || 'normal') === String(tradeMode || 'normal')
  )) || null;
}

function parseTailJson(stdout = '') {
  const text = String(stdout || '').trim();
  const start = text.lastIndexOf('\n{');
  const raw = start >= 0 ? text.slice(start + 1) : text;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractProtectivePrices(groups = []) {
  const orders = (groups || []).flatMap((group) => group.orders || []);
  const takeProfit = orders.find((order) => {
    const type = String(order?.type || '').toLowerCase();
    return type.includes('limit') && !type.includes('stop');
  });
  const stopLoss = orders.find((order) => String(order?.type || '').toLowerCase().includes('stop'));
  return {
    takeProfit: safeNumber(takeProfit?.price, null),
    stopLoss: safeNumber(stopLoss?.stopPrice ?? stopLoss?.price, null),
  };
}

function resolveReferencePrice(candidate = {}, prices = {}) {
  const values = [
    candidate.avgPrice,
    candidate.avg_price,
    candidate?.strategyProfile?.positionRuntimeState?.marketState?.avgPrice,
    candidate?.strategyProfile?.positionRuntimeState?.marketState?.liveIndicator?.timeframes?.[0]?.close,
    prices.takeProfit && prices.stopLoss ? (Number(prices.takeProfit) + Number(prices.stopLoss)) / 2 : null,
  ];
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

async function executePartialAdjustChild(candidate = {}) {
  const args = [
    'scripts/partial-adjust-runner.ts',
    `--symbol=${candidate.symbol}`,
    `--exchange=${candidate.exchange || 'binance'}`,
    `--trade-mode=${candidate.tradeMode || 'normal'}`,
    '--execute',
    '--confirm=partial-adjust',
    '--json',
  ];
  const result = await execFileAsync(process.execPath, args, {
    cwd: INVESTMENT_DIR,
    encoding: 'utf8',
    env: { ...process.env, PAPER_MODE: 'false' },
    maxBuffer: 1024 * 1024 * 8,
  });
  const payload = parseTailJson(result.stdout);
  return {
    ok: payload?.ok === true,
    status: payload?.executionStatus || payload?.status || (payload?.ok === true ? 'executed' : 'unknown'),
    payload,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

export async function buildProtectiveOrderRebalancePlan(candidate = {}, {
  getBalanceSnapshot = getBinanceBalanceSnapshot,
  getOpenOrders = getBinanceOpenOrders,
} = {}) {
  const symbol = String(candidate?.symbol || '').trim().toUpperCase();
  const base = baseAsset(symbol);
  const [preflight, balance, openOrders] = await Promise.all([
    buildCryptoPartialAdjustPreflight(candidate, { getBalanceSnapshot, getOpenOrders }),
    getBalanceSnapshot({ omitZeroBalances: false }),
    getOpenOrders(symbol),
  ]);
  const freeBalance = safeNumber(balance?.free?.[base], 0);
  const totalBalance = safeNumber(balance?.total?.[base], freeBalance);
  const intendedSellAmount = safeNumber(candidate?.estimatedExitAmount, 0);
  const positionAmount = safeNumber(candidate?.positionAmount, totalBalance);
  const residualPositionAmount = Math.max(0, positionAmount - intendedSellAmount);
  const protectiveGroups = summarizeProtectiveSellOrders(openOrders);
  const lockedByOpenSells = preflight?.code === 'partial_adjust_balance_locked_by_open_sell_orders';

  const cancelOrderIds = protectiveGroups.flatMap((group) => group.orderIds);
  const status = lockedByOpenSells
    ? 'protective_rebalance_required'
    : preflight?.ok
      ? 'protective_rebalance_not_required'
      : 'protective_rebalance_unavailable';

  return {
    ok: true,
    mode: 'dry_run',
    status,
    symbol,
    exchange: candidate?.exchange || 'binance',
    tradeMode: candidate?.tradeMode || 'normal',
    executableNow: preflight?.ok === true,
    requiresLiveMutation: lockedByOpenSells,
    mutationExecuted: false,
    reasonCode: preflight?.code || null,
    balances: {
      base,
      free: freeBalance,
      total: totalBalance,
      positionAmount,
      intendedSellAmount,
      residualPositionAmount: Number(residualPositionAmount.toFixed(8)),
    },
    preflight,
    protectiveGroups,
    recommendedPlan: lockedByOpenSells ? {
      policy: 'cancel_recreate_around_partial_adjust',
      approvalRequired: true,
      cancelOrderIds,
      steps: [
        '기존 open SELL 보호주문/OCO를 취소해 가용 수량을 회복합니다.',
        `partial-adjust SELL ${intendedSellAmount.toFixed(8)} ${base}를 실행합니다.`,
        `잔여 수량 약 ${residualPositionAmount.toFixed(8)} ${base} 기준으로 보호주문을 재생성합니다.`,
        '체결/오픈오더/로컬 포지션 정합성을 재조회해 L5 gate를 다시 확인합니다.',
      ],
    } : {
      policy: preflight?.ok ? 'partial_adjust_can_execute_without_rebalance' : 'manual_review_required',
      approvalRequired: false,
      cancelOrderIds: [],
      steps: preflight?.ok
        ? ['현재 가용 수량으로 partial-adjust 실행이 가능합니다.']
        : ['보호주문 재배치만으로 해결할 수 없는 차단 상태입니다. 수량/잔고/포지션 동기화를 먼저 확인합니다.'],
    },
  };
}

export async function applyProtectiveOrderRebalance(candidate = {}, {
  apply = false,
  confirm = null,
  getBalanceSnapshot = getBinanceBalanceSnapshot,
  getOpenOrders = getBinanceOpenOrders,
  cancelOpenSellOrders = cancelOpenSellOrdersForSymbol,
  executePartialAdjust = executePartialAdjustChild,
  placeProtectiveExit = placeBinanceProtectiveExit,
} = {}) {
  const plan = await buildProtectiveOrderRebalancePlan(candidate, { getBalanceSnapshot, getOpenOrders });
  if (apply !== true) return plan;
  if (confirm !== APPLY_CONFIRM) {
    return {
      ...plan,
      ok: false,
      status: 'protective_rebalance_confirmation_required',
      requiredConfirm: APPLY_CONFIRM,
    };
  }
  if (plan.status !== 'protective_rebalance_required') {
    return {
      ...plan,
      mode: 'apply',
      mutationExecuted: false,
      status: 'protective_rebalance_apply_not_required',
    };
  }

  const prices = extractProtectivePrices(plan.protectiveGroups);
  const referencePrice = resolveReferencePrice(candidate, prices);
  const cancelResult = await cancelOpenSellOrders(plan.symbol);
  let partialAdjust = null;
  let protection = null;
  let restoreProtection = null;
  try {
    partialAdjust = await executePartialAdjust(candidate);
    if (partialAdjust?.ok !== true) {
      throw new Error(`partial_adjust_failed:${partialAdjust?.status || 'unknown'}`);
    }
    const afterBalance = await getBalanceSnapshot({ omitZeroBalances: false });
    const residualAmount = Math.max(0, safeNumber(afterBalance?.total?.[plan.balances.base], 0));
    if (residualAmount > 0 && referencePrice && prices.takeProfit && prices.stopLoss) {
      protection = await placeProtectiveExit(plan.symbol, residualAmount, referencePrice, prices.takeProfit, prices.stopLoss);
    }
    return {
      ...plan,
      mode: 'apply',
      ok: partialAdjust?.ok === true && (residualAmount <= 0 || protection?.ok === true),
      status: protection?.ok === true
        ? 'protective_rebalance_applied'
        : residualAmount > 0
          ? 'protective_rebalance_applied_without_recreated_protection'
          : 'protective_rebalance_applied_position_closed',
      mutationExecuted: true,
      cancelResult,
      partialAdjust,
      residualAmount,
      protection,
    };
  } catch (error) {
    const afterFailureBalance = await getBalanceSnapshot({ omitZeroBalances: false }).catch(() => null);
    const restoreAmount = Math.max(0, safeNumber(afterFailureBalance?.total?.[plan.balances.base], 0));
    if (restoreAmount > 0 && referencePrice && prices.takeProfit && prices.stopLoss) {
      restoreProtection = await placeProtectiveExit(plan.symbol, restoreAmount, referencePrice, prices.takeProfit, prices.stopLoss).catch((restoreError) => ({
        ok: false,
        error: String(restoreError?.message || restoreError || 'unknown'),
      }));
    }
    return {
      ...plan,
      mode: 'apply',
      ok: false,
      status: 'protective_rebalance_apply_failed',
      mutationExecuted: true,
      cancelResult,
      partialAdjust,
      restoreProtection,
      error: String(error?.message || error || 'unknown'),
    };
  }
}

async function main() {
  const args = parseArgs();
  if (!args.symbol) {
    throw new Error('--symbol is required for protective order rebalance planning');
  }
  if (args.exchange !== 'binance') {
    throw new Error(`protective rebalance planner currently supports binance only: ${args.exchange}`);
  }

  const candidates = await loadPartialAdjustCandidates({
    tradeMode: args.tradeMode,
    minutesBack: args.minutesBack,
  });
  const candidate = findCandidate(candidates, args);
  if (!candidate) {
    const payload = {
      ok: false,
      mode: 'dry_run',
      status: 'partial_adjust_candidate_not_found',
      symbol: args.symbol,
      exchange: args.exchange,
      tradeMode: args.tradeMode,
      mutationExecuted: false,
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    throw new Error(`partial-adjust 후보를 찾지 못했습니다: ${args.symbol}`);
  }

  const plan = await applyProtectiveOrderRebalance(candidate, {
    apply: args.apply,
    confirm: args.confirm,
  });
  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(`🛡️ protective order rebalance plan: ${plan.symbol}`);
  console.log(`- status: ${plan.status}`);
  console.log(`- executableNow: ${plan.executableNow}`);
  console.log(`- requiresLiveMutation: ${plan.requiresLiveMutation}`);
  for (const step of plan.recommendedPlan.steps || []) console.log(`- ${step}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: () => main(),
    onError: async (error) => {
      console.error(`[protective-order-rebalance-plan] ${error?.stack || error?.message || String(error)}`);
    },
  });
}
