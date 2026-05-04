#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import {
  getLunaBuyingPowerSnapshot,
} from '../shared/capital-manager.ts';
import {
  formatCapitalModeLog,
  resolveCapitalGateAction,
  shouldRunDiscovery,
} from '../shared/luna-orchestration-policy.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const DEFAULT_EXCHANGES = ['binance', 'kis', 'kis_overseas'];

function hasFlag(name) {
  return process.argv.includes(name);
}

function getArgValue(name, fallback = '') {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function createUnavailableSnapshot(exchange, tradeMode = 'normal', observedAt = new Date().toISOString()) {
  return {
    exchange,
    tradeMode,
    mode: 'BALANCE_UNAVAILABLE',
    reasonCode: 'buying_power_unavailable',
    freeCash: 0,
    availableBalance: 0,
    reservedCash: 0,
    buyableAmount: 0,
    minOrderAmount: exchange === 'kis' ? 5000 : 10,
    feeBufferAmount: 0,
    openPositionCount: 0,
    maxPositionCount: 3,
    remainingSlots: 3,
    totalCapital: 0,
    balanceStatus: 'unavailable',
    source: 'unavailable',
    observedAt,
  };
}

function fixtureSnapshots(generatedAt) {
  return [
    {
      exchange: 'binance',
      tradeMode: 'normal',
      mode: 'ACTIVE_DISCOVERY',
      reasonCode: null,
      freeCash: 500,
      availableBalance: 500,
      reservedCash: 50,
      buyableAmount: 449,
      minOrderAmount: 10,
      feeBufferAmount: 1,
      openPositionCount: 1,
      maxPositionCount: 4,
      remainingSlots: 3,
      totalCapital: 500,
      balanceStatus: 'ok',
      source: 'broker',
      observedAt: generatedAt,
    },
    {
      exchange: 'kis',
      tradeMode: 'normal',
      mode: 'CASH_CONSTRAINED',
      reasonCode: 'cash_constrained_monitor_only',
      freeCash: 900,
      availableBalance: 900,
      reservedCash: 100,
      buyableAmount: 800,
      minOrderAmount: 5000,
      feeBufferAmount: 0,
      openPositionCount: 2,
      maxPositionCount: 4,
      remainingSlots: 2,
      totalCapital: 1000,
      balanceStatus: 'ok',
      source: 'broker',
      observedAt: generatedAt,
    },
    {
      exchange: 'kis_overseas',
      tradeMode: 'normal',
      mode: 'POSITION_MONITOR_ONLY',
      reasonCode: 'position_slots_exhausted',
      freeCash: 200,
      availableBalance: 200,
      reservedCash: 20,
      buyableAmount: 179,
      minOrderAmount: 10,
      feeBufferAmount: 1,
      openPositionCount: 3,
      maxPositionCount: 3,
      remainingSlots: 0,
      totalCapital: 200,
      balanceStatus: 'ok',
      source: 'broker',
      observedAt: generatedAt,
    },
    {
      ...createUnavailableSnapshot('binance', 'normal', generatedAt),
      exchange: 'binance_unavailable',
    },
    {
      exchange: 'kis_reducing',
      tradeMode: 'normal',
      mode: 'REDUCING_ONLY',
      reasonCode: 'reducing_only_mode',
      freeCash: 10000,
      availableBalance: 10000,
      reservedCash: 1000,
      buyableAmount: 8990,
      minOrderAmount: 5000,
      feeBufferAmount: 10,
      openPositionCount: 1,
      maxPositionCount: 3,
      remainingSlots: 2,
      totalCapital: 10000,
      balanceStatus: 'ok',
      source: 'broker',
      observedAt: generatedAt,
    },
  ];
}

function classifyWarning(snapshot, action) {
  if (snapshot.balanceStatus !== 'ok' || snapshot.mode === 'BALANCE_UNAVAILABLE') {
    return `buying_power_unavailable:${snapshot.exchange}`;
  }
  if (snapshot.mode === 'REDUCING_ONLY') return `reducing_only_mode:${snapshot.exchange}`;
  if (snapshot.mode === 'POSITION_MONITOR_ONLY') return `position_slots_exhausted:${snapshot.exchange}`;
  if (snapshot.mode === 'CASH_CONSTRAINED') return `cash_constrained_monitor_only:${snapshot.exchange}`;
  if (action !== 'active_discovery') return `discovery_not_active:${snapshot.exchange}`;
  return null;
}

function buildNextAction(snapshot, action, resumeReady) {
  if (snapshot.mode === 'BALANCE_UNAVAILABLE' || snapshot.balanceStatus !== 'ok') {
    return {
      exchange: snapshot.exchange,
      action: 'verify_balance_source',
      reason: '잔고 조회가 불가하면 신규 발굴/BUY는 fail-closed 상태로 유지한다.',
    };
  }
  if (snapshot.mode === 'REDUCING_ONLY') {
    return {
      exchange: snapshot.exchange,
      action: 'monitor_reducing_only',
      reason: '서킷/감축 모드에서는 신규 BUY 대신 보유 포지션 정리 신호만 처리한다.',
    };
  }
  if (snapshot.mode === 'POSITION_MONITOR_ONLY') {
    return {
      exchange: snapshot.exchange,
      action: 'wait_for_position_slot',
      reason: '포지션 슬롯이 해소될 때까지 신규 종목 발굴을 보류한다.',
    };
  }
  if (snapshot.mode === 'CASH_CONSTRAINED') {
    return {
      exchange: snapshot.exchange,
      action: 'wait_for_cash_or_exit',
      reason: '최소 주문 금액 미만이면 매도/입금으로 가용금이 회복될 때까지 모니터링한다.',
    };
  }
  if (resumeReady) {
    return {
      exchange: snapshot.exchange,
      action: 'discovery_allowed',
      reason: '자본 상태가 ACTIVE_DISCOVERY라 신규 후보 발굴/매수 평가가 가능하다.',
    };
  }
  return {
    exchange: snapshot.exchange,
    action: action === 'exit_only' ? 'exit_only' : 'idle_digest',
    reason: '자본 게이트가 신규 discovery를 허용하지 않는 상태다.',
  };
}

export function buildCapitalStateReportFromSnapshots(snapshots = [], options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const modeOverride = options.modeOverride || '';
  const items = snapshots.map((snapshot) => {
    const openPositionCount = asNumber(snapshot.openPositionCount, 0);
    const gateAction = resolveCapitalGateAction(snapshot, openPositionCount, modeOverride);
    const discoveryAllowed = shouldRunDiscovery(snapshot, modeOverride);
    const resumeReady = discoveryAllowed
      && snapshot.mode === 'ACTIVE_DISCOVERY'
      && snapshot.balanceStatus === 'ok'
      && asNumber(snapshot.buyableAmount, 0) >= asNumber(snapshot.minOrderAmount, 0)
      && asNumber(snapshot.remainingSlots, 0) > 0;
    const warning = classifyWarning(snapshot, gateAction);
    return {
      exchange: snapshot.exchange,
      tradeMode: snapshot.tradeMode || 'normal',
      mode: snapshot.mode,
      reasonCode: snapshot.reasonCode,
      gateAction,
      discoveryAllowed,
      resumeReady,
      buyableAmount: asNumber(snapshot.buyableAmount, 0),
      minOrderAmount: asNumber(snapshot.minOrderAmount, 0),
      freeCash: asNumber(snapshot.freeCash, 0),
      reservedCash: asNumber(snapshot.reservedCash, 0),
      openPositionCount,
      maxPositionCount: asNumber(snapshot.maxPositionCount, 0),
      remainingSlots: asNumber(snapshot.remainingSlots, 0),
      balanceStatus: snapshot.balanceStatus || 'unavailable',
      source: snapshot.source || 'unavailable',
      observedAt: snapshot.observedAt || generatedAt,
      logLine: formatCapitalModeLog(snapshot),
      warning,
      nextAction: buildNextAction(snapshot, gateAction, resumeReady),
    };
  });

  const summary = items.reduce((acc, item) => {
    acc.total += 1;
    acc.byMode[item.mode] = (acc.byMode[item.mode] || 0) + 1;
    acc.byAction[item.gateAction] = (acc.byAction[item.gateAction] || 0) + 1;
    if (item.discoveryAllowed) acc.discoveryAllowed += 1;
    if (item.resumeReady) acc.resumeReady += 1;
    if (item.warning) acc.warningCount += 1;
    return acc;
  }, {
    total: 0,
    discoveryAllowed: 0,
    resumeReady: 0,
    warningCount: 0,
    byMode: {},
    byAction: {},
  });

  const warnings = items.map((item) => item.warning).filter(Boolean);
  const nextActions = items.map((item) => item.nextAction);
  const hasHardAttention = items.some((item) => (
    item.mode === 'BALANCE_UNAVAILABLE'
    || item.mode === 'REDUCING_ONLY'
    || item.balanceStatus !== 'ok'
  ));
  const allReady = items.length > 0 && items.every((item) => item.resumeReady);
  const status = allReady
    ? 'active_discovery_ready'
    : hasHardAttention
      ? 'capital_attention'
      : warnings.length > 0
        ? 'capital_monitor_only'
        : 'capital_state_unknown';

  return {
    ok: true,
    status,
    generatedAt,
    modeOverride: modeOverride || null,
    summary,
    warnings,
    nextActions,
    snapshots: items,
  };
}

function parseExchanges() {
  const raw = getArgValue('--exchange', 'all');
  if (!raw || raw === 'all') return DEFAULT_EXCHANGES;
  const requested = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return requested.length > 0 ? requested : DEFAULT_EXCHANGES;
}

async function collectLiveSnapshots(exchanges, tradeMode) {
  const observedAt = new Date().toISOString();
  const snapshots = [];
  for (const exchange of exchanges) {
    try {
      snapshots.push(await getLunaBuyingPowerSnapshot(exchange, tradeMode || null));
    } catch (error) {
      const snapshot = createUnavailableSnapshot(exchange, tradeMode || 'normal', observedAt);
      snapshot.reasonCode = `buying_power_unavailable:${error?.message || String(error)}`.slice(0, 180);
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

function assertSmokeReport(report) {
  const modes = new Set(report.snapshots.map((item) => item.mode));
  for (const mode of ['ACTIVE_DISCOVERY', 'CASH_CONSTRAINED', 'POSITION_MONITOR_ONLY', 'BALANCE_UNAVAILABLE', 'REDUCING_ONLY']) {
    assert.ok(modes.has(mode), `mode covered: ${mode}`);
  }
  const binance = report.snapshots.find((item) => item.exchange === 'binance');
  assert.equal(binance.gateAction, 'active_discovery');
  assert.equal(binance.resumeReady, true);
  const constrained = report.snapshots.find((item) => item.mode === 'CASH_CONSTRAINED');
  assert.equal(constrained.gateAction, 'exit_only');
  assert.equal(constrained.discoveryAllowed, false);
  const unavailable = report.snapshots.find((item) => item.mode === 'BALANCE_UNAVAILABLE');
  assert.equal(unavailable.gateAction, 'idle_digest');
  assert.ok(report.warnings.some((item) => item.includes('buying_power_unavailable')));
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const generatedAt = new Date().toISOString();
  const modeOverride = getArgValue('--mode-override', '');
  const tradeMode = getArgValue('--trade-mode', '');
  let snapshots;
  if (smoke) {
    snapshots = fixtureSnapshots(generatedAt);
  } else if (json) {
    const originalLog = console.log;
    console.log = (...args) => console.error(...args);
    try {
      snapshots = await collectLiveSnapshots(parseExchanges(), tradeMode);
    } finally {
      console.log = originalLog;
    }
  } else {
    snapshots = await collectLiveSnapshots(parseExchanges(), tradeMode);
  }
  const report = buildCapitalStateReportFromSnapshots(snapshots, { generatedAt, modeOverride });
  if (smoke) assertSmokeReport(report);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Luna capital state: ${report.status}`);
  for (const item of report.snapshots) {
    console.log(`- ${item.exchange}: mode=${item.mode} action=${item.gateAction} buyable=${item.buyableAmount} min=${item.minOrderAmount} positions=${item.openPositionCount}/${item.maxPositionCount}`);
  }
  if (report.warnings.length > 0) console.log(`warnings=${report.warnings.join(',')}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-capital-state-report 실패:' });
}
