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
import { publishAlert } from '../shared/alert-publisher.ts';
import { initHubSecrets, loadSecrets } from '../shared/secrets.ts';
import { getInvestmentRagRuntimeConfig } from '../shared/runtime-config.ts';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const { createAgentMemory } = _require('../../../packages/core/lib/agent-memory');

const DUST_USDT = 3;
const WATCH_USDT = 10;
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

export async function runSweeper({ telegram = false } = {}) {
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
  const summary = {
    scanned_at: new Date().toISOString(),
    wallet_only_count: walletOnlyRows.length,
    wallet_only_total_usdt: walletOnlyRows.reduce((sum, row) => sum + row.usdt_value, 0),
    significant_wallet_only_count: significantWalletOnly.length,
    mismatch_count: mismatches.length,
    wallet_only: walletOnlyRows,
    mismatches,
  };

  if (telegram && (significantWalletOnly.length > 0 || mismatches.length > 0)) {
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
  try {
    const result = await runSweeper({ telegram });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(`❌ sweeper 오류: ${error.message}`);
    process.exit(1);
  }
}
