#!/usr/bin/env node
// @ts-nocheck

import * as journalDb from '../shared/trade-journal-db.ts';
import * as db from '../shared/db.ts';
import { validateTradeReview } from './validate-trade-review.ts';

async function backfillTradeReview({ dryRun = false } = {}) {
  await db.initSchema();
  await journalDb.initJournalSchema();

  const closedTrades = await db.query(`
    SELECT trade_id
    FROM investment.trade_journal
    WHERE status = 'closed'
    ORDER BY exit_time DESC NULLS LAST, created_at DESC
  `);

  let inserted = 0;
  let skipped = 0;

  for (const row of closedTrades) {
    const existing = await journalDb.getReviewByTradeId(row.trade_id);
    if (existing) {
      skipped++;
      continue;
    }
    if (!dryRun) {
      await journalDb.ensureAutoReview(row.trade_id);
    }
    inserted++;
  }

  return {
    closedTrades: closedTrades.length,
    inserted,
    skipped,
    dryRun,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const result = await backfillTradeReview({ dryRun });
  const validation = await validateTradeReview({ days: 3650, fix: !dryRun });
  console.log(JSON.stringify({
    ...result,
    validation,
  }, null, 2));
}

main().catch(err => {
  console.error('❌ trade_review 백필 실패:', err?.message || String(err));
  process.exit(1);
});
