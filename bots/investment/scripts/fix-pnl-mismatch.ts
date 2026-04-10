#!/usr/bin/env node
// @ts-nocheck
/**
 * PnL 보정 스크립트 — 기존 MISMATCH 데이터 수정
 * 10차 재검증에서 확인된 9건의 PnL 오류를 보정
 * 
 * 사용법:
 *   node fix-pnl-mismatch.js          # dry-run (기본)
 *   node fix-pnl-mismatch.js --execute # 실제 수정
 */
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ database: 'jay', user: process.env.USER || 'alexlee' });
const EXECUTE = process.argv.includes('--execute');

async function main() {
  console.log(`\n=== PnL 보정 스크립트 (${EXECUTE ? '🔴 EXECUTE' : '🟢 DRY-RUN'}) ===\n`);

  // 모든 closed journal에서 MISMATCH 탐색
  const { rows } = await pool.query(`
    SELECT trade_id, symbol, exchange, entry_price, exit_price, entry_size, entry_value,
      pnl_net, pnl_percent,
      CASE WHEN exit_price IS NOT NULL AND entry_price > 0 THEN
        ROUND(((exit_price - entry_price) / entry_price * 100)::numeric, 4)
      ELSE NULL END as expected_pnl_pct,
      CASE WHEN exit_price IS NOT NULL AND entry_price > 0 THEN
        ROUND(((exit_price - entry_price) * entry_size)::numeric, 4)
      ELSE NULL END as expected_pnl_net
    FROM investment.trade_journal 
    WHERE status = 'closed' AND exit_price IS NOT NULL AND entry_price > 0
    ORDER BY exit_time
  `);

  let mismatchCount = 0;
  let fixedCount = 0;

  for (const row of rows) {
    const diff = Math.abs((row.pnl_percent || 0) - (row.expected_pnl_pct || 0));
    if (diff > 5) {
      mismatchCount++;
      console.log(`❌ MISMATCH: ${row.trade_id} ${row.symbol}`);
      console.log(`   현재: pnl=${row.pnl_percent}%, net=${row.pnl_net}`);
      console.log(`   정확: pnl=${row.expected_pnl_pct}%, net=${row.expected_pnl_net}`);

      if (EXECUTE) {
        await pool.query(`
          UPDATE investment.trade_journal 
          SET pnl_percent = $1, pnl_net = $2
          WHERE trade_id = $3
        `, [row.expected_pnl_pct, row.expected_pnl_net, row.trade_id]);
        console.log(`   ✅ 수정 완료`);
        fixedCount++;
      } else {
        console.log(`   ⏸️ dry-run — --execute로 실제 수정`);
      }
      console.log();
    }
  }

  console.log(`\n총 ${rows.length}건 검사, ${mismatchCount}건 MISMATCH${EXECUTE ? `, ${fixedCount}건 수정 완료` : ''}`);
  if (!EXECUTE && mismatchCount > 0) {
    console.log('→ node fix-pnl-mismatch.js --execute 로 실제 수정');
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
