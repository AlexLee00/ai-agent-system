#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { getBinanceBalanceSnapshot, getBinanceOpenOrders } from '../shared/binance-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildCryptoPartialAdjustPreflight,
  loadPartialAdjustCandidates,
} from './partial-adjust-runner.ts';

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

  const plan = await buildProtectiveOrderRebalancePlan(candidate);
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
