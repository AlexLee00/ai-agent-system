#!/usr/bin/env node
// @ts-nocheck
/**
 * rebuild-pnl-percent.ts — trade_journal pnl_percent 재계산
 *
 * 마이크로 프라이스 코인(LUNC, PUMP 등) 계산 오류로 발생한
 * 수십억% 이상치를 안전한 값으로 재계산한다.
 *
 * 기준:
 *   pnl_percent = (exit_price - entry_price) / entry_price * 100  (LONG/BUY)
 *   pnl_percent = (entry_price - exit_price) / entry_price * 100  (SHORT/SELL)
 *   결과 범위: -100% ~ +1000% 클램핑 (그 이상은 micro-price 오류로 판정)
 *
 * 사용법:
 *   tsx bots/investment/scripts/rebuild-pnl-percent.ts [--dry-run] [--limit=N]
 */

import * as db from '../shared/db.ts';

const PNL_OUTLIER_THRESHOLD = 1000; // % 이상은 이상치

function parseArgs(argv = process.argv.slice(2)) {
  return {
    dryRun: argv.includes('--dry-run'),
    limit: Number(argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '5000'),
    verbose: argv.includes('--verbose'),
  };
}

/**
 * micro-price 안전 pnl_percent 계산.
 * entry_price가 0이거나 너무 작으면 entry_value/exit_value 기반으로 폴백.
 */
function safePnlPercent(
  entryPrice: number | null,
  exitPrice: number | null,
  entryValue: number | null,
  exitValue: number | null,
  direction: string | null,
): number | null {
  const ep = Number(entryPrice);
  const xp = Number(exitPrice);
  const ev = Number(entryValue);
  const xv = Number(exitValue);

  // entry_price 기반 계산 우선
  if (ep > 0 && xp >= 0) {
    const isShort = String(direction || '').toUpperCase() === 'SELL'
      || String(direction || '').toUpperCase() === 'SHORT';
    const raw = isShort
      ? (ep - xp) / ep * 100
      : (xp - ep) / ep * 100;

    // 이상치 클램핑
    if (Math.abs(raw) > PNL_OUTLIER_THRESHOLD) {
      // entry_value/exit_value로 폴백 시도
      if (ev > 0 && xv >= 0) {
        const valBased = (xv - ev) / ev * 100;
        if (Math.abs(valBased) <= PNL_OUTLIER_THRESHOLD) return Number(valBased.toFixed(4));
      }
      // 그래도 이상치면 null (신뢰 불가)
      return null;
    }

    return Number(raw.toFixed(4));
  }

  // entry_value 기반 폴백
  if (ev > 0 && xv >= 0) {
    const raw = (xv - ev) / ev * 100;
    if (Math.abs(raw) <= PNL_OUTLIER_THRESHOLD) return Number(raw.toFixed(4));
    return null;
  }

  return null;
}

async function run() {
  const args = parseArgs();
  console.log(`[rebuild-pnl] 시작: dryRun=${args.dryRun}, limit=${args.limit}`);

  // 이상치가 있는 closed 거래만 조회
  const rows = await db.query(`
    SELECT
      id, symbol, direction,
      entry_price, exit_price,
      entry_value, exit_value,
      pnl_amount, pnl_percent, pnl_net
    FROM investment.trade_journal
    WHERE
      (status = 'closed' OR exit_time IS NOT NULL)
      AND exit_price IS NOT NULL
      AND (
        pnl_percent IS NULL
        OR ABS(pnl_percent) > $1
      )
    ORDER BY id DESC
    LIMIT $2
  `, [PNL_OUTLIER_THRESHOLD, args.limit]);

  if (!rows || rows.length === 0) {
    console.log('[rebuild-pnl] 재계산 대상 없음 (이상치 0건)');
    return;
  }

  console.log(`[rebuild-pnl] 재계산 대상: ${rows.length}건`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    const newPnl = safePnlPercent(
      row.entry_price,
      row.exit_price,
      row.entry_value,
      row.exit_value,
      row.direction,
    );

    const oldPnl = row.pnl_percent != null ? Number(row.pnl_percent).toFixed(2) : 'null';

    if (newPnl === null) {
      // 재계산 불가 — 원인 표기 후 스킵
      if (args.verbose) {
        console.warn(`  SKIP id=${row.id} ${row.symbol}: entry=${row.entry_price} exit=${row.exit_price} → 재계산 불가`);
      }
      skipped++;
      continue;
    }

    if (args.verbose || Math.abs(Number(row.pnl_percent || 0)) > 10000) {
      console.log(`  UPDATE id=${row.id} ${row.symbol}: ${oldPnl}% → ${newPnl}%`);
    }

    if (!args.dryRun) {
      try {
        await db.run(
          `UPDATE investment.trade_journal SET pnl_percent = $1 WHERE id = $2`,
          [newPnl, row.id],
        );
        updated++;
      } catch (err) {
        console.error(`  ERROR id=${row.id}:`, err?.message);
        errors++;
      }
    } else {
      updated++;
    }
  }

  console.log(`\n[rebuild-pnl] 완료: 업데이트=${updated}, 스킵=${skipped}, 에러=${errors}`);
  if (args.dryRun) console.log('  [dry-run] DB 변경 없음');
}

run().catch(err => {
  console.error('[rebuild-pnl] 치명적 오류:', err);
  process.exit(1);
});
