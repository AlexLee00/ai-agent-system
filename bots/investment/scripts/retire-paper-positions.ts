#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { initJournalSchema } from '../shared/trade-journal-db.ts';

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    execute: argv.includes('--execute'),
    confirm: argv.includes('--confirm=retire-paper'),
  };
}

async function collectSummary() {
  const [positionRows, openJournalRows, closedJournalRows] = await Promise.all([
    db.query(`
      SELECT exchange, COALESCE(trade_mode, 'normal') AS trade_mode,
             COUNT(*)::int AS cnt,
             COALESCE(SUM(amount), 0) AS total_amount
      FROM investment.positions
      WHERE paper = true AND amount > 0
      GROUP BY exchange, COALESCE(trade_mode, 'normal')
      ORDER BY exchange, trade_mode
    `),
    db.query(`
      SELECT exchange, COALESCE(trade_mode, 'normal') AS trade_mode,
             COUNT(*)::int AS cnt,
             COALESCE(SUM(entry_value), 0) AS total_entry_value
      FROM investment.trade_journal
      WHERE is_paper = true AND status = 'open'
      GROUP BY exchange, COALESCE(trade_mode, 'normal')
      ORDER BY exchange, trade_mode
    `),
    db.query(`
      SELECT COUNT(*)::int AS cnt
      FROM investment.trade_journal
      WHERE is_paper = true AND status = 'closed'
    `),
  ]);

  const positionCount = positionRows.reduce((sum, row) => sum + Number(row.cnt || 0), 0);
  const openJournalCount = openJournalRows.reduce((sum, row) => sum + Number(row.cnt || 0), 0);

  return {
    positions: positionRows.map((row) => ({
      exchange: row.exchange,
      tradeMode: row.trade_mode,
      count: Number(row.cnt || 0),
      totalAmount: Number(row.total_amount || 0),
    })),
    openJournals: openJournalRows.map((row) => ({
      exchange: row.exchange,
      tradeMode: row.trade_mode,
      count: Number(row.cnt || 0),
      totalEntryValue: Number(row.total_entry_value || 0),
    })),
    closedJournalCount: Number(closedJournalRows?.[0]?.cnt || 0),
    positionCount,
    openJournalCount,
  };
}

async function executeRetirement() {
  const nowMs = Date.now();
  const result = {};

  const closedOpenJournals = await db.run(`
    UPDATE investment.trade_journal
       SET status = 'closed',
           exit_time = COALESCE(exit_time, $1),
           exit_price = COALESCE(exit_price, entry_price),
           exit_value = COALESCE(exit_value, entry_value),
           exit_reason = COALESCE(exit_reason, 'paper_live_cutover_cleanup'),
           pnl_amount = COALESCE(pnl_amount, 0),
           pnl_percent = COALESCE(pnl_percent, 0),
           pnl_net = COALESCE(pnl_net, 0),
           fee_total = COALESCE(fee_total, 0),
           hold_duration = COALESCE(hold_duration, GREATEST($1 - entry_time, 0)),
           execution_origin = 'cleanup',
           quality_flag = 'degraded',
           exclude_from_learning = true,
           incident_link = 'paper_live_cutover_cleanup'
     WHERE is_paper = true
       AND status = 'open'
  `, [nowMs]);
  result.closedOpenJournals = Number(closedOpenJournals?.rowCount || 0);

  const deletedPaperPositions = await db.run(`
    DELETE FROM investment.positions
    WHERE paper = true
      AND amount > 0
  `);
  result.deletedPaperPositions = Number(deletedPaperPositions?.rowCount || 0);

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await db.initSchema();
  await initJournalSchema();

  const before = await collectSummary();

  if (!args.execute) {
    const payload = {
      mode: 'preview',
      canExecute: true,
      requires: '--execute --confirm=retire-paper',
      before,
      note: 'position_strategy_profiles 는 paper/live 분리 컬럼이 없어 이번 정리에서 건드리지 않습니다.',
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log('\n=== Retire Paper Positions (preview) ===\n');
    console.log(`paper positions=${before.positionCount}, open paper journals=${before.openJournalCount}`);
    console.log('실행하려면 --execute --confirm=retire-paper 를 함께 넘기세요.');
    return;
  }

  if (!args.confirm) {
    throw new Error('retire-paper cleanup requires --confirm=retire-paper');
  }

  const executed = await executeRetirement();
  const after = await collectSummary();
  const payload = {
    mode: 'execute',
    executed,
    before,
    after,
    note: 'position_strategy_profiles 는 paper/live 분리 컬럼이 없어 untouched 상태로 유지했습니다.',
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('\n=== Retire Paper Positions (done) ===\n');
  console.log(`closed journals=${executed.closedOpenJournals}, deleted positions=${executed.deletedPaperPositions}`);
  console.log(`remaining paper positions=${after.positionCount}, remaining open paper journals=${after.openJournalCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
