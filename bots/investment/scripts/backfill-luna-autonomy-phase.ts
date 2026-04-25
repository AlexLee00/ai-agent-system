#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { initJournalSchema } from '../shared/trade-journal-db.ts';
import { buildLunaAutonomyPhaseContext, resolveLunaAutonomyPhase } from '../shared/autonomy-phase.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
  };
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function collectRows(sql, params = []) {
  return db.query(sql, params).catch(() => []);
}

export async function backfillLunaAutonomyPhase({ dryRun = false } = {}) {
  await db.initSchema();
  await initJournalSchema();

  const cutover = buildLunaAutonomyPhaseContext(Date.now());
  const journalRows = await collectRows(
    `SELECT trade_id, created_at
     FROM investment.trade_journal
     WHERE COALESCE(autonomy_phase, '') = ''`
  );
  const rationaleRows = await collectRows(
    `SELECT id, created_at
     FROM investment.trade_rationale
     WHERE COALESCE(autonomy_phase, '') = ''`
  );
  const closeoutRows = await collectRows(
    `SELECT id, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms
     FROM investment.position_closeout_reviews
     WHERE COALESCE(autonomy_phase, '') = ''`
  );

  const summary = {
    journal: { scanned: journalRows.length, updated: 0 },
    rationale: { scanned: rationaleRows.length, updated: 0 },
    closeout: { scanned: closeoutRows.length, updated: 0 },
  };

  for (const row of journalRows) {
    const phase = resolveLunaAutonomyPhase(row.created_at);
    if (!dryRun) {
      await db.run(
        `UPDATE investment.trade_journal SET autonomy_phase = $1 WHERE trade_id = $2`,
        [phase, row.trade_id],
      ).catch(() => null);
    }
    summary.journal.updated += 1;
  }

  for (const row of rationaleRows) {
    const phase = resolveLunaAutonomyPhase(row.created_at);
    if (!dryRun) {
      await db.run(
        `UPDATE investment.trade_rationale SET autonomy_phase = $1 WHERE id = $2`,
        [phase, row.id],
      ).catch(() => null);
    }
    summary.rationale.updated += 1;
  }

  for (const row of closeoutRows) {
    const phase = resolveLunaAutonomyPhase(row.created_at_ms);
    if (!dryRun) {
      await db.run(
        `UPDATE investment.position_closeout_reviews SET autonomy_phase = $1 WHERE id = $2`,
        [phase, row.id],
      ).catch(() => null);
    }
    summary.closeout.updated += 1;
  }

  return {
    ok: true,
    dryRun,
    cutover,
    summary,
  };
}

async function main() {
  const args = parseArgs();
  const result = await backfillLunaAutonomyPhase(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`autotune cutover: ${result.cutover.autotuneCutoverAt ? new Date(result.cutover.autotuneCutoverAt).toISOString() : 'n/a'}`);
  console.log(`l5 cutover: ${result.cutover.l5CutoverAt ? new Date(result.cutover.l5CutoverAt).toISOString() : 'n/a'}`);
  console.log(`journal ${result.summary.journal.updated}/${result.summary.journal.scanned}`);
  console.log(`rationale ${result.summary.rationale.updated}/${result.summary.rationale.scanned}`);
  console.log(`closeout ${result.summary.closeout.updated}/${result.summary.closeout.scanned}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ backfill-luna-autonomy-phase 오류:',
  });
}
