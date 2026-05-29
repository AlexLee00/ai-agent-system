#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/luna-daily-pnl-report.ts — 루나팀 USD 정규화 PnL 일일 보고
 *
 * v_trades_real_usd 기반:
 *   - 거래소별 누적 USD 수익 + 승률
 *   - 오늘(24h) 누적 수익
 *   - KIS ₩ → USD 자동 환산 포함
 *
 * 실행:
 *   node scripts/luna-daily-pnl-report.ts
 *   node scripts/luna-daily-pnl-report.ts --dry-run
 */

import { createRequire } from 'module';
import { maybeSkipForMemory } from '../shared/memory-pressure-guard.ts';
const require = createRequire(import.meta.url);

const path = require('path');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const { query, closeAll }  = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const telegramSender       = require(path.join(PROJECT_ROOT, 'packages/core/lib/telegram-sender'));
const { today }            = require(path.join(PROJECT_ROOT, 'packages/core/lib/kst'));

const DRY_RUN = process.argv.includes('--dry-run');
const DIVIDER = '──────────';

// ─── 집계 함수 ───────────────────────────────────────────────────────

async function fetchExchangeStats() {
  const rows = await query('investment', `
    SELECT
      exchange,
      COUNT(*)                                                       AS trades,
      COUNT(CASE WHEN pnl_usd > 0 THEN 1 END)                       AS wins,
      ROUND(
        100.0 * COUNT(CASE WHEN pnl_usd > 0 THEN 1 END)
        / NULLIF(COUNT(*), 0),
        1
      )                                                              AS win_rate,
      ROUND(SUM(pnl_usd)::numeric, 2)                               AS pnl_usd,
      ROUND(AVG(pnl_usd)::numeric, 4)                               AS avg_pnl,
      currency
    FROM investment.v_trades_real_usd
    WHERE NOT is_paper
    GROUP BY exchange, currency
    ORDER BY exchange
  `);
  return rows;
}

async function fetchTotalStats() {
  const rows = await query('investment', `
    SELECT
      COUNT(*)                          AS total_trades,
      COUNT(CASE WHEN pnl_usd > 0 THEN 1 END) AS total_wins,
      ROUND(SUM(pnl_usd)::numeric, 2)  AS total_usd
    FROM investment.v_trades_real_usd
    WHERE NOT is_paper
  `);
  return rows[0] ?? { total_trades: 0, total_wins: 0, total_usd: 0 };
}

async function fetchTodayStats() {
  const rows = await query('investment', `
    SELECT
      COUNT(*)                          AS trades_today,
      ROUND(SUM(pnl_usd)::numeric, 2)  AS pnl_today
    FROM investment.v_trades_real_usd
    WHERE NOT is_paper
      AND exit_time IS NOT NULL
      AND to_timestamp(exit_time / 1000.0) >= NOW() - INTERVAL '24 hours'
  `);
  return rows[0] ?? { trades_today: 0, pnl_today: 0 };
}

async function fetchCurrentFxRate() {
  try {
    const rows = await query('investment', `
      SELECT inverse_rate
      FROM investment.fx_rates
      WHERE base_currency = 'KRW' AND quote_currency = 'USD'
      ORDER BY effective_date DESC
      LIMIT 1
    `);
    return rows[0]?.inverse_rate ?? 1360;
  } catch {
    return 1360;
  }
}

// ─── 포매터 ──────────────────────────────────────────────────────────

function fmtUsd(val: number, signed = false): string {
  const n = Number(val ?? 0);
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n).toFixed(2);
  const sign = signed ? (n >= 0 ? '+' : '-') : n < 0 ? '-' : '';
  return `${sign}$${abs}`;
}

function fmtPct(val: number): string {
  const n = Number(val ?? 0);
  if (!Number.isFinite(n)) return '-';
  return `${n.toFixed(1)}%`;
}

function buildMessage(
  exchangeRows: any[],
  total: any,
  todayStats: any,
  fxRate: number,
  dateStr: string
): string {
  const lines: string[] = [];

  lines.push(`💰 루나 USD PnL 보고 — ${dateStr}`);
  lines.push(DIVIDER);

  for (const row of exchangeRows) {
    const pnl = Number(row.pnl_usd ?? 0);
    const pnlStr = fmtUsd(pnl, true);
    const wrStr = fmtPct(row.win_rate);
    const emoji = pnl >= 0 ? '✅' : '❌';

    let label = row.exchange;
    if (row.exchange === 'kis') label = 'KIS 국내';
    else if (row.exchange === 'kis_overseas') label = 'KIS 해외';
    else if (row.exchange === 'binance') label = 'Binance';

    const currNote = row.exchange === 'kis' ? ` (₩÷${Number(fxRate).toLocaleString()})` : '';
    lines.push(`${emoji} ${label}${currNote}`);
    lines.push(`   ${row.trades}건 · 승률 ${wrStr} · ${pnlStr}`);
  }

  lines.push(DIVIDER);

  const totalPnl = Number(total.total_usd ?? 0);
  const totalWinRate = total.total_trades > 0
    ? ((Number(total.total_wins) / Number(total.total_trades)) * 100).toFixed(1)
    : '0.0';
  lines.push(`📊 종합 — ${total.total_trades}건 · 승률 ${totalWinRate}%`);
  lines.push(`   누적: ${fmtUsd(totalPnl, true)}`);

  const todayPnl = Number(todayStats.pnl_today ?? 0);
  const todayEmoji = todayPnl >= 0 ? '🟢' : '🔴';
  lines.push(`${todayEmoji} 오늘(24h) ${todayStats.trades_today}건 · ${fmtUsd(todayPnl, true)}`);

  lines.push(DIVIDER);
  lines.push(`📅 환율: 1 USD = ₩${Number(fxRate).toLocaleString()}`);

  return lines.join('\n');
}

// ─── 메인 ────────────────────────────────────────────────────────────

async function main() {
  if (maybeSkipForMemory('luna.daily-pnl-report')) return;
  const dateStr = today();

  const [exchangeRows, total, todayStats, fxRate] = await Promise.all([
    fetchExchangeStats(),
    fetchTotalStats(),
    fetchTodayStats(),
    fetchCurrentFxRate(),
  ]);

  const message = buildMessage(exchangeRows, total, todayStats, fxRate, dateStr);

  console.log('[luna-daily-pnl-report] 메시지:');
  console.log(message);

  if (DRY_RUN) {
    console.log('[luna-daily-pnl-report] --dry-run: 전송 건너뜀');
  } else {
    await telegramSender.send('luna', message);
    console.log('[luna-daily-pnl-report] 텔레그램 전송 완료');
  }

}

main().catch((err) => {
  console.error('[luna-daily-pnl-report] 오류:', err);
  process.exit(1);
}).finally(async () => {
  await closeAll().catch(() => {});
});
