#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/runtime-guard-outcome-tracker.ts — 가드 이벤트 아웃컴 측정
 *
 * 매일 09:00 KST — guard_events.outcome 업데이트
 * launchd: ai.luna.guard-outcome-tracker-daily-0900.plist
 *
 * 로직:
 *   1. outcome IS NULL + 4h 이상 경과 + 30일 이내 guard_events 조회
 *   2. 동일 symbol/exchange로 24h 내 거래 완료 여부 확인 (v_trades_real_usd)
 *   3. 거래 있음 → pnl_usd > 0: 'success' / ≤ 0: 'failure'
 *      거래 없음 → 24h 경과 시 'no_trade'
 *   4. guard_events.outcome + outcome_pnl_usd 업데이트
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const path = require('path');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const { query, run, closeAll } = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));

const MIN_AGE_HOURS = 4;
const OUTCOME_WINDOW_HOURS = 24;
const MAX_AGE_DAYS = 30;
const BATCH_LIMIT = 500;

async function refreshTradesView() {
  try {
    await run(`REFRESH MATERIALIZED VIEW CONCURRENTLY investment.v_trades_real_usd`, []);
    console.log('[GuardOutcome] v_trades_real_usd refresh 완료');
  } catch (err) {
    console.log(`[GuardOutcome] v_trades_real_usd refresh 스킵: ${err?.message}`);
  }
}

async function loadPendingGuardEvents() {
  const rows = await query(
    `SELECT id, guard_name, symbol, exchange, triggered_at
     FROM investment.guard_events
     WHERE outcome IS NULL
       AND symbol IS NOT NULL
       AND triggered_at < NOW() - INTERVAL '1 hour' * $1
       AND triggered_at > NOW() - INTERVAL '1 day' * $2
     ORDER BY triggered_at ASC
     LIMIT $3`,
    [MIN_AGE_HOURS, MAX_AGE_DAYS, BATCH_LIMIT],
  ).catch(() => []);
  return rows || [];
}

async function findTradeAfterGuard(symbol, exchange, triggeredAt) {
  const rows = await query(
    `SELECT pnl_usd
     FROM investment.v_trades_real_usd
     WHERE symbol = $1
       AND exchange = $2
       AND NOT is_paper
       AND exit_time IS NOT NULL
       AND to_timestamp(exit_time / 1000.0)
           BETWEEN $3::timestamptz
               AND $3::timestamptz + INTERVAL '1 hour' * $4
     ORDER BY to_timestamp(exit_time / 1000.0) ASC
     LIMIT 1`,
    [symbol, exchange, triggeredAt, OUTCOME_WINDOW_HOURS],
  ).catch(() => []);
  return rows?.[0] ?? null;
}

async function updateGuardOutcome(id, outcome, pnlUsd) {
  await run(
    `UPDATE investment.guard_events
     SET outcome = $1, outcome_pnl_usd = $2
     WHERE id = $3`,
    [outcome, pnlUsd ?? null, id],
  );
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[GuardOutcome] ${new Date().toISOString()} 아웃컴 측정 시작${dryRun ? ' (dry-run)' : ''}`);

  await refreshTradesView();

  const pending = await loadPendingGuardEvents();
  console.log(`[GuardOutcome] 처리 대상: ${pending.length}건`);

  const stats = { success: 0, failure: 0, no_trade: 0, skipped: 0 };

  for (const ev of pending) {
    const triggeredAt = new Date(ev.triggered_at);
    const ageHours = (Date.now() - triggeredAt.getTime()) / 3_600_000;

    const trade = await findTradeAfterGuard(ev.symbol, ev.exchange, ev.triggered_at);

    let outcome;
    let pnlUsd = null;

    if (trade) {
      const pnl = Number(trade.pnl_usd ?? 0);
      outcome = pnl > 0 ? 'success' : 'failure';
      pnlUsd = pnl;
    } else if (ageHours >= OUTCOME_WINDOW_HOURS) {
      outcome = 'no_trade';
    } else {
      stats.skipped++;
      continue;
    }

    stats[outcome]++;
    if (!dryRun) {
      await updateGuardOutcome(ev.id, outcome, pnlUsd);
    } else {
      console.log(`[GuardOutcome][dry] id=${ev.id} guard=${ev.guard_name} symbol=${ev.symbol} → ${outcome} pnl=${pnlUsd}`);
    }
  }

  console.log(`[GuardOutcome] 완료 — success:${stats.success} failure:${stats.failure} no_trade:${stats.no_trade} skipped:${stats.skipped}`);

  try { await closeAll(); } catch {}
  process.exit(0);
}

main().catch((err) => {
  console.error('[GuardOutcome] 실패:', err);
  process.exit(1);
});
