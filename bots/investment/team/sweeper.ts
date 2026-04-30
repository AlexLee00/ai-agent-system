// @ts-nocheck
/**
 * team/sweeper.js — 루나팀 Sweeper
 *
 * 역할:
 *   - 실지갑 vs DB 포지션 정합성 점검
 *   - 포지션 없는 지갑 잔고(wallet-only) 분류
 *   - 바이낸스에서 먼저 청산된 포지션 흔적 탐지
 *   - 중요 건 알림
 *
 * 실행:
 *   node team/sweeper.js
 *   node team/sweeper.js --telegram
 */

import ccxt from 'ccxt';
import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { initHubSecrets, loadSecrets } from '../shared/secrets.ts';
import { getInvestmentRagRuntimeConfig } from '../shared/runtime-config.ts';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const { createAgentMemory } = _require('../../../packages/core/lib/agent-memory');

const DUST_USDT = 3;
const WATCH_USDT = 10;
const MANUAL_DUST_SYNC_CONFIRM = 'sync-manual-dust';
const RAG_RUNTIME = getInvestmentRagRuntimeConfig();
const sweeperMemory = createAgentMemory({ agentId: 'investment.sweeper', team: 'investment' });

function getExchange() {
  const secrets = loadSecrets();
  return new ccxt.binance({
    apiKey: secrets.binance_api_key || '',
    secret: secrets.binance_api_secret || '',
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  });
}

function classifyWalletOnly(usdtValue) {
  if (usdtValue >= WATCH_USDT) return 'significant';
  if (usdtValue >= DUST_USDT) return 'watch';
  return 'dust';
}

function symbolForCoin(coin) {
  const base = String(coin || '').trim().toUpperCase();
  return base ? `${base}/USDT` : '';
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

async function fetchWallet(ex) {
  const balance = await ex.fetchBalance();
  return Object.entries(balance?.total || {})
    .filter(([coin, total]) => (total ?? 0) > 0.000001 && !['info', 'free', 'used', 'total', 'debt'].includes(coin))
    .map(([coin, total]) => ({
      coin,
      total: Number(total || 0),
      free: Number(balance?.free?.[coin] || 0),
    }));
}

async function fetchPriceMap(ex, coins = []) {
  const prices = {};
  for (const coin of coins) {
    if (!coin || coin === 'USDT') continue;
    try {
      const ticker = await ex.fetchTicker(`${coin}/USDT`);
      prices[coin] = Number(ticker?.last || 0);
    } catch {
      prices[coin] = 0;
    }
  }
  return prices;
}

async function fetchOpenLiveJournalRows() {
  return db.query(
    `SELECT trade_id,
            symbol,
            exchange,
            COALESCE(trade_mode, 'normal') AS trade_mode,
            entry_time,
            entry_size,
            entry_price,
            entry_value
       FROM trade_journal
      WHERE exchange = 'binance'
        AND status = 'open'
        AND is_paper = false
      ORDER BY symbol, COALESCE(trade_mode, 'normal'), entry_time DESC`,
  ).catch(() => []);
}

export function buildManualDustJournalSyncPlan({
  walletOnlyRows = [],
  positions = [],
  openJournals = [],
  dustThresholdUsdt = DUST_USDT,
  apply = false,
  confirm = '',
  maxAffectedTrades = 10,
} = {}) {
  const positionSymbols = new Set(
    (positions || [])
      .filter((row) => Number(row.amount || 0) > 0)
      .map((row) => normalizeSymbol(row.symbol))
      .filter(Boolean),
  );
  const walletBySymbol = new Map();
  for (const row of walletOnlyRows || []) {
    const symbol = normalizeSymbol(row.symbol || symbolForCoin(row.coin));
    if (!symbol) continue;
    walletBySymbol.set(symbol, {
      ...row,
      symbol,
      usdtValue: Number(row.usdt_value || row.usdtValue || 0),
    });
  }
  const groups = new Map();
  for (const row of openJournals || []) {
    const symbol = normalizeSymbol(row.symbol);
    if (!symbol) continue;
    if (positionSymbols.has(symbol)) continue;
    const tradeMode = row.trade_mode || row.tradeMode || 'normal';
    const key = `${symbol}|${tradeMode}`;
    if (!groups.has(key)) {
      groups.set(key, {
        symbol,
        exchange: row.exchange || 'binance',
        tradeMode,
        openTradeIds: [],
        openRows: [],
        openSize: 0,
        openValue: 0,
      });
    }
    const group = groups.get(key);
    group.openTradeIds.push(row.trade_id);
    group.openRows.push({
      tradeId: row.trade_id,
      entrySize: Number(row.entry_size || 0),
      entryPrice: Number(row.entry_price || 0),
      entryValue: Number(row.entry_value || 0),
    });
    group.openSize += Number(row.entry_size || 0);
    group.openValue += Number(row.entry_value || 0);
  }

  const candidates = [];
  let nonDustOpenJournalCount = 0;
  for (const group of groups.values()) {
    const wallet = walletBySymbol.get(group.symbol) || null;
    const walletValue = Number(wallet?.usdtValue || 0);
    const hasCurrentDust = wallet && walletValue >= 0 && walletValue < Number(dustThresholdUsdt || DUST_USDT);
    const hasDustSizedJournal = Number(group.openValue || 0) >= 0 && Number(group.openValue || 0) < Number(dustThresholdUsdt || DUST_USDT);
    const walletGone = !wallet;
    if (walletGone && !hasDustSizedJournal) {
      nonDustOpenJournalCount += 1;
      continue;
    }
    if (!hasCurrentDust && !walletGone) continue;
    candidates.push({
      ...group,
      walletValueUsdt: walletValue,
      journalValueUsdt: Number(group.openValue || 0),
      journalDustSized: Boolean(hasDustSizedJournal),
      currentWalletDust: Boolean(hasCurrentDust),
      walletPresent: Boolean(wallet),
      syncEligible: Boolean(walletGone && hasDustSizedJournal),
      action: walletGone ? 'sync_manual_dust_cleaned' : 'await_manual_dust_cleanup',
      reason: walletGone
        ? 'wallet_zero_no_position_dust_sized_open_journal'
        : 'wallet_still_has_unconvertible_dust_wait_for_manual_cleanup',
    });
  }

  const confirmationOk = !apply || confirm === MANUAL_DUST_SYNC_CONFIRM;
  const blockers = [];
  if (apply && !confirmationOk) blockers.push('confirmation_required');
  const syncable = candidates.filter((row) => row.syncEligible);
  const affectedTradeCount = syncable.reduce((sum, row) => sum + (row.openTradeIds || []).length, 0);
  if (apply && affectedTradeCount > Number(maxAffectedTrades || 10)) {
    blockers.push(`max_affected_trades_exceeded:${affectedTradeCount}>${Number(maxAffectedTrades || 10)}`);
  }
  return {
    ok: blockers.length === 0,
    apply: apply === true,
    confirmRequired: apply && !confirmationOk,
    confirmValue: MANUAL_DUST_SYNC_CONFIRM,
    dustThresholdUsdt: Number(dustThresholdUsdt || DUST_USDT),
    maxAffectedTrades: Number(maxAffectedTrades || 10),
    candidates: candidates.length,
    syncableCount: syncable.length,
    affectedTradeCount,
    awaitManualCleanupCount: candidates.length - syncable.length,
    nonDustOpenJournalCount,
    blockers,
    rows: candidates,
  };
}

async function applyManualDustJournalSync(plan) {
  const closedTradeIds = [];
  for (const row of plan?.rows || []) {
    if (!row.syncEligible) continue;
    for (const openRow of row.openRows || []) {
      await journalDb.closeJournalEntry(openRow.tradeId, {
        exitTime: Date.now(),
        exitPrice: Number(openRow.entryPrice || 0) || null,
        exitValue: Number(openRow.entryValue || 0) || null,
        exitReason: 'sweeper_manual_dust_wallet_sync',
        pnlAmount: 0,
        pnlPercent: 0,
        pnlNet: 0,
        execution_origin: 'cleanup',
        quality_flag: 'exclude_from_learning',
        exclude_from_learning: true,
        incident_link: 'sweeper_manual_dust_sync',
      });
      await journalDb.ensureAutoReview(openRow.tradeId).catch(() => {});
      closedTradeIds.push(openRow.tradeId);
    }
  }
  return closedTradeIds;
}

async function fetchRecentBrokerExit(ex, symbol, amountHint = 0) {
  try {
    const orders = await ex.fetchOrders(symbol, undefined, 20);
    const sells = (orders || [])
      .filter((o) => o?.side === 'sell' && o?.status === 'closed' && Number(o?.filled || 0) > 0)
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
    if (sells.length === 0) return null;
    if (!(amountHint > 0)) return sells[0];
    return sells.find((o) => {
      const filled = Number(o?.filled || 0);
      return Math.abs(filled - amountHint) <= Math.max(1e-6, amountHint * 0.02);
    }) || sells[0];
  } catch {
    return null;
  }
}

function buildSweeperMemoryQuery(summary = {}) {
  return [
    'investment sweeper wallet integrity',
    summary.mismatch_count > 0 ? 'has-mismatch' : 'no-mismatch',
    summary.significant_wallet_only_count > 0 ? 'has-significant-wallet-only' : 'no-significant-wallet-only',
    `wallet-only-${summary.wallet_only_count || 0}`,
    `mismatch-${summary.mismatch_count || 0}`,
  ].filter(Boolean).join(' ');
}

export async function runSweeper({
  telegram = false,
  syncManualDust = false,
  confirm = '',
  maxAffectedTrades = 10,
} = {}) {
  await db.initSchema();
  await initHubSecrets().catch(() => false);

  const ex = getExchange();
  await ex.loadMarkets();

  const [positions, wallet] = await Promise.all([
    db.getAllPositions('binance', false).catch(() => []),
    fetchWallet(ex),
  ]);

  const trackedBases = new Set(positions.map((row) => String(row.symbol || '').split('/')[0]));
  const walletOnly = wallet.filter((row) => row.coin !== 'USDT' && !trackedBases.has(row.coin));
  const walletOnlyPrices = await fetchPriceMap(ex, walletOnly.map((row) => row.coin));
  const walletOnlyRows = walletOnly
    .map((row) => {
      const usdtValue = row.total * Number(walletOnlyPrices[row.coin] || 0);
      return {
        ...row,
        symbol: symbolForCoin(row.coin),
        usdt_value: usdtValue,
        class: classifyWalletOnly(usdtValue),
      };
    })
    .sort((a, b) => b.usdt_value - a.usdt_value);

  const mismatches = [];
  for (const position of positions) {
    const base = String(position.symbol || '').split('/')[0];
    const walletRow = wallet.find((row) => row.coin === base);
    const walletAmount = Number(walletRow?.total || 0);
    const trackedAmount = Number(position.amount || 0);
    const delta = walletAmount - trackedAmount;
    if (Math.abs(delta) <= Math.max(0.000001, trackedAmount * 0.001)) continue;

    const recentExit = walletAmount <= 0.000001
      ? await fetchRecentBrokerExit(ex, position.symbol, trackedAmount)
      : null;

    mismatches.push({
      symbol: position.symbol,
      trade_mode: position.trade_mode || 'normal',
      tracked_amount: trackedAmount,
      wallet_amount: walletAmount,
      delta,
      likely_external_exit: Boolean(recentExit),
      recent_exit_order_id: recentExit?.id || null,
      recent_exit_type: recentExit?.type || null,
      recent_exit_price: Number(recentExit?.average || recentExit?.price || 0) || null,
    });
  }

  const significantWalletOnly = walletOnlyRows.filter((row) => row.class === 'significant');
  const openLiveJournals = await fetchOpenLiveJournalRows();
  const manualDustSync = buildManualDustJournalSyncPlan({
    walletOnlyRows,
    positions,
    openJournals: openLiveJournals,
    dustThresholdUsdt: DUST_USDT,
    apply: syncManualDust,
    confirm,
    maxAffectedTrades,
  });
  let manualDustSyncApplied = null;
  if (syncManualDust && manualDustSync.ok && manualDustSync.syncableCount > 0) {
    const closedTradeIds = await applyManualDustJournalSync(manualDustSync);
    manualDustSyncApplied = {
      closedTradeCount: closedTradeIds.length,
      closedTradeIds,
    };
  }
  const summary = {
    scanned_at: new Date().toISOString(),
    wallet_only_count: walletOnlyRows.length,
    wallet_only_total_usdt: walletOnlyRows.reduce((sum, row) => sum + row.usdt_value, 0),
    significant_wallet_only_count: significantWalletOnly.length,
    mismatch_count: mismatches.length,
    manual_dust_sync: {
      ...manualDustSync,
      applied: manualDustSyncApplied,
      next_command: manualDustSync.syncableCount > 0 && !syncManualDust
        ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s sweeper:dust-sync -- --confirm=${MANUAL_DUST_SYNC_CONFIRM} --max-affected-trades=${manualDustSync.affectedTradeCount}`
        : null,
    },
    wallet_only: walletOnlyRows,
    mismatches,
  };

  if (telegram && (significantWalletOnly.length > 0 || mismatches.length > 0 || manualDustSync.syncableCount > 0)) {
    const memoryQuery = buildSweeperMemoryQuery(summary);
    const episodicHint = await sweeperMemory.recallCountHint(memoryQuery, {
      type: 'episodic',
      limit: 2,
      threshold: Number(RAG_RUNTIME.sweeperMemory?.episodicThreshold ?? 0.33),
      title: '최근 유사 정합성 점검',
      separator: 'pipe',
      metadataKey: 'kind',
      labels: {
        integrity: '정합성',
      },
      order: ['integrity'],
    }).catch(() => '');
    const semanticHint = await sweeperMemory.recallHint(`${memoryQuery} consolidated integrity pattern`, {
      type: 'semantic',
      limit: 2,
      threshold: Number(RAG_RUNTIME.sweeperMemory?.semanticThreshold ?? 0.28),
      title: '최근 통합 패턴',
      separator: 'newline',
    }).catch(() => '');
    const lines = [
      '🧹 [sweeper] 루나 지갑 정합성 점검',
      `wallet-only: ${walletOnlyRows.length}종 (중요 ${significantWalletOnly.length}종)`,
      `포지션 불일치: ${mismatches.length}건`,
      `수동 dust 동기화 후보: ${manualDustSync.syncableCount}건`,
    ];
    if (significantWalletOnly[0]) {
      lines.push(`주요 미추적 자산: ${significantWalletOnly[0].coin} ≈ $${significantWalletOnly[0].usdt_value.toFixed(2)}`);
    }
    if (mismatches[0]) {
      lines.push(`주요 불일치: ${mismatches[0].symbol} ${mismatches[0].tracked_amount} -> ${mismatches[0].wallet_amount}`);
    }
    const message = `${lines.join('\n')}${episodicHint}${semanticHint}`;
    await publishAlert({
      from_bot: 'sweeper',
      event_type: 'wallet_integrity_report',
      alert_level: mismatches.length > 0 ? 2 : 1,
      message,
      payload: {
        wallet_only_count: walletOnlyRows.length,
        significant_wallet_only_count: significantWalletOnly.length,
        mismatch_count: mismatches.length,
      },
    }).catch(() => {});
    await sweeperMemory.remember(message, 'episodic', {
      importance: mismatches.length > 0 ? 0.76 : 0.68,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: {
        kind: 'integrity',
        walletOnlyCount: walletOnlyRows.length,
        significantWalletOnlyCount: significantWalletOnly.length,
        mismatchCount: mismatches.length,
      },
    }).catch(() => {});
    await sweeperMemory.consolidate({
      olderThanDays: 14,
      limit: 10,
    }).catch(() => {});
  }

  return summary;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const telegram = process.argv.includes('--telegram');
  const syncManualDust = process.argv.includes('--sync-manual-dust');
  const confirmArg = process.argv.find((arg) => arg.startsWith('--confirm='));
  const maxAffectedArg = process.argv.find((arg) => arg.startsWith('--max-affected-trades='));
  const confirm = confirmArg ? confirmArg.split('=').slice(1).join('=') : '';
  const maxAffectedTrades = Number(maxAffectedArg?.split('=').slice(1).join('=') || 10);
  try {
    const result = await runSweeper({ telegram, syncManualDust, confirm, maxAffectedTrades });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.manual_dust_sync?.ok === false ? 1 : 0);
  } catch (error) {
    console.error(`❌ sweeper 오류: ${error.message}`);
    process.exit(1);
  }
}
