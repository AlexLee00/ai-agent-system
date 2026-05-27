#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/balance-sync-15min.ts — 거래소 실제 잔고 15분 sync
 *
 * Binance / KIS / KIS Overseas 잔고를 조회해 account_balances 테이블에 저장.
 * DB pnl vs 실제 잔고 차이가 크면 Telegram 알림.
 *
 * 실행:
 *   node scripts/balance-sync-15min.ts
 *   node scripts/balance-sync-15min.ts --dry-run
 *   node scripts/balance-sync-15min.ts --alert-threshold=500   (USD 기준, 기본 200)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const path = require('path');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const { query, closeAll } = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const telegramSender      = require(path.join(PROJECT_ROOT, 'packages/core/lib/telegram-sender'));

import {
  getMarketExecutionModeInfo,
  getTradingMode,
  initHubSecrets,
} from '../shared/secrets.ts';
import { getBinanceExchange } from '../markets/binance.ts';
import { getDomesticBalance, getOverseasBalance } from '../markets/kis.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const ALERT_THRESHOLD_USD = (() => {
  const arg = process.argv.find((a) => a.startsWith('--alert-threshold='));
  return arg ? Number(arg.split('=')[1]) : 200;
})();

// ─── KRW/USD 환율 ────────────────────────────────────────────────────

async function getFxRate() {
  try {
    const rows = await query('investment', `
      SELECT rate FROM investment.fx_rates
      WHERE base_currency = 'KRW' AND quote_currency = 'USD'
      ORDER BY captured_at DESC LIMIT 1
    `);
    return rows[0] ? Number(rows[0].rate) : (1 / 1360);
  } catch {
    return 1 / 1360;
  }
}

// ─── Binance 잔고 조회 ────────────────────────────────────────────────

async function fetchBinanceBalance(isPaper) {
  if (isPaper) {
    return [{ asset: 'USDT', total: 0, available: 0, usd_value: 0, note: 'paper_skipped' }];
  }
  try {
    const exchange = getBinanceExchange();
    const raw      = await exchange.fetchBalance();
    const results  = [];
    for (const [asset, info] of Object.entries(raw?.total ?? {})) {
      const total = Number(info ?? 0);
      if (total < 0.000001) continue;
      // USDT 기준 USD 환산
      let usd = asset === 'USDT' ? total : null;
      if (asset !== 'USDT' && raw?.prices?.[`${asset}/USDT`]) {
        usd = total * Number(raw.prices[`${asset}/USDT`] ?? 0);
      }
      results.push({
        asset,
        total,
        available: Number(raw?.free?.[asset] ?? total),
        usd_value: usd,
        raw_partial: { total, free: raw?.free?.[asset] },
      });
    }
    return results;
  } catch (err) {
    console.warn('[balance-sync] Binance 잔고 조회 실패:', err.message);
    return [];
  }
}

// ─── KIS 국내 잔고 조회 ────────────────────────────────────────────────

async function fetchKisBalance(isMock, fxRate) {
  try {
    const raw = await getDomesticBalance(isMock);
    if (!raw) return [];
    const krw   = Number(raw.total_balance_krw ?? raw.cash ?? 0);
    const usd   = krw * fxRate;
    return [{
      asset: 'KRW',
      total: krw,
      available: Number(raw.available_balance_krw ?? raw.available_cash ?? krw),
      usd_value: usd,
      raw_partial: { total_krw: krw, is_mock: isMock },
    }];
  } catch (err) {
    console.warn('[balance-sync] KIS 국내 잔고 조회 실패:', err.message);
    return [];
  }
}

// ─── KIS 해외 잔고 조회 ────────────────────────────────────────────────

async function fetchKisOverseasBalance(isMock) {
  try {
    const raw = await getOverseasBalance(isMock);
    if (!raw) return [];
    const usd = Number(raw.total_balance_usd ?? raw.cash ?? 0);
    return [{
      asset: 'USD',
      total: usd,
      available: Number(raw.available_balance_usd ?? raw.available_cash ?? usd),
      usd_value: usd,
      raw_partial: { total_usd: usd, is_mock: isMock },
    }];
  } catch (err) {
    console.warn('[balance-sync] KIS 해외 잔고 조회 실패:', err.message);
    return [];
  }
}

// ─── DB 저장 ─────────────────────────────────────────────────────────

async function saveBalances(exchange, accountType, assets) {
  if (DRY_RUN || assets.length === 0) return;
  for (const item of assets) {
    await query('investment', `
      INSERT INTO investment.account_balances
        (exchange, account_type, asset, total_balance, available_balance, usd_value, raw_json)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      exchange,
      accountType,
      item.asset,
      item.total,
      item.available,
      item.usd_value ?? null,
      item.raw_partial ? JSON.stringify(item.raw_partial) : null,
    ]);
  }
}

// ─── 갭 알림 체크 ────────────────────────────────────────────────────

async function checkGapAlert() {
  try {
    const rows = await query('investment', `
      SELECT exchange, asset, actual_usd, db_pnl_usdt, gap_usd
      FROM investment.v_trades_vs_balance
      WHERE ABS(gap_usd) > $1
      ORDER BY ABS(gap_usd) DESC
    `, [ALERT_THRESHOLD_USD]);

    if (rows.length === 0) return null;

    let msg = `⚠️ [잔고 괴리 경보] 임계값 $${ALERT_THRESHOLD_USD} 초과!\n`;
    for (const r of rows) {
      msg += `  ${r.exchange}/${r.asset}: 실잔고=$${r.actual_usd ?? '?'} | DB PnL=$${r.db_pnl_usdt} | 괴리=$${r.gap_usd}\n`;
    }
    return msg;
  } catch {
    return null;
  }
}

// ─── main ────────────────────────────────────────────────────────────

async function main() {
  console.log('[balance-sync] 시작...');
  await initHubSecrets();

  const cryptoInfo   = getMarketExecutionModeInfo('crypto', '바이낸스');
  const stockInfo    = getMarketExecutionModeInfo('stocks', '국내주식');
  const overseasInfo = getMarketExecutionModeInfo('kis_overseas', '해외주식');

  const isCryptoPaper   = cryptoInfo.paper;
  const isStockMock     = stockInfo.brokerAccountMode === 'mock';
  const isOverseasMock  = overseasInfo.brokerAccountMode === 'mock';

  const fxRate = await getFxRate();
  console.log(`[balance-sync] FX: 1 KRW = ${fxRate.toFixed(6)} USD`);

  // 잔고 조회
  const [binanceAssets, kisAssets, kisOverseasAssets] = await Promise.allSettled([
    fetchBinanceBalance(isCryptoPaper),
    fetchKisBalance(isStockMock, fxRate),
    fetchKisOverseasBalance(isOverseasMock),
  ]);

  const binance   = binanceAssets.status   === 'fulfilled' ? binanceAssets.value   : [];
  const kis       = kisAssets.status       === 'fulfilled' ? kisAssets.value       : [];
  const kisOverseas = kisOverseasAssets.status === 'fulfilled' ? kisOverseasAssets.value : [];

  // DB 저장
  await Promise.allSettled([
    saveBalances('binance',       isCryptoPaper  ? 'paper' : 'main', binance),
    saveBalances('kis',           isStockMock    ? 'paper' : 'main', kis),
    saveBalances('kis_overseas',  isOverseasMock ? 'paper' : 'main', kisOverseas),
  ]);

  if (DRY_RUN) {
    console.log('[balance-sync] --dry-run: DB 저장 생략');
    console.log('binance:', JSON.stringify(binance, null, 2));
    console.log('kis:', JSON.stringify(kis, null, 2));
    console.log('kis_overseas:', JSON.stringify(kisOverseas, null, 2));
  } else {
    console.log(`[balance-sync] 저장 완료: binance=${binance.length}, kis=${kis.length}, overseas=${kisOverseas.length}건`);
  }

  // 갭 알림
  const alert = await checkGapAlert();
  if (alert) {
    console.warn(alert);
    if (!DRY_RUN) {
      await telegramSender.send('luna', alert);
    }
  }

  await closeAll();
}

main().catch((err) => {
  console.error('[balance-sync] 오류:', err);
  closeAll().finally(() => process.exit(1));
});
