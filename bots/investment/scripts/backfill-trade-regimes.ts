#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    limit: Number(
      argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || '1000',
    ),
    batchSize: Number(
      argv.find(arg => arg.startsWith('--batch-size='))?.split('=')[1] || '200',
    ),
  };
}

async function backfillTradeRegimes({ dryRun = false, limit = 1000, batchSize = 200 } = {}) {
  await db.initSchema();
  await journalDb.initJournalSchema();

  let updated = 0;
  let unresolved = 0;
  let scanned = 0;
  const bySource = {
    rationale: 0,
    snapshot: 0,
  };
  const samples = [];

  while (scanned < limit) {
    const remaining = Math.max(0, limit - scanned);
    const rows = await db.query(
      `SELECT trade_id, signal_id, market, entry_time
       FROM investment.trade_journal
       WHERE market_regime IS NULL OR market_regime = ''
       ORDER BY entry_time DESC NULLS LAST
       LIMIT $1`,
      [Math.min(batchSize, remaining)],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const result = await journalDb.syncJournalMarketRegime(
        {
          tradeId: row.trade_id,
          signalId: row.signal_id ?? null,
          market: row.market ?? null,
          entryTime: row.entry_time ?? null,
        },
        { dryRun },
      );

      if (result.updated) {
        updated += 1;
        if (result.source && bySource[result.source] != null) {
          bySource[result.source] += 1;
        }
        if (samples.length < 10) {
          samples.push({
            tradeId: row.trade_id,
            source: result.source,
            regime: result.regime,
            confidence: result.confidence,
          });
        }
      } else {
        unresolved += 1;
      }
    }

    scanned += rows.length;
    if (rows.length < Math.min(batchSize, remaining)) break;
  }

  return {
    scanned,
    updated,
    unresolved,
    bySource,
    dryRun,
    samples,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await backfillTradeRegimes(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`scanned=${result.scanned} updated=${result.updated} unresolved=${result.unresolved}`);
  console.log(`sources=${JSON.stringify(result.bySource)}`);
  if (result.samples.length) {
    console.log(`samples=${JSON.stringify(result.samples, null, 2)}`);
  }
}

main().catch(err => {
  console.error('❌ trade_journal regime backfill 실패:', err?.message || String(err));
  process.exit(1);
});
