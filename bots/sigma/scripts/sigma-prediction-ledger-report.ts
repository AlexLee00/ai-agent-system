#!/usr/bin/env node
// @ts-nocheck

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPredictionLedgerReport,
  fetchPredictionLedgerRows,
} from '../vault/validation-transition.ts';

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function buildRuntimePredictionLedgerReport(options = {}) {
  const rows = options.noDb ? [] : await fetchPredictionLedgerRows({
    limit: options.limit || 500,
    queryReadonly: options.queryReadonly,
  });
  return {
    ...buildPredictionLedgerReport({ rows, now: options.now || new Date() }),
    dryRun: true,
    liveMutation: false,
    rowCount: rows.length,
  };
}

async function main() {
  const args = {
    json: process.argv.includes('--json'),
    noDb: process.argv.includes('--no-db'),
    limit: Math.max(1, Math.min(2000, Number(argValue('--limit', 500)) || 500)),
  };
  const report = await buildRuntimePredictionLedgerReport(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`[sigma-prediction-ledger] forward=${report.counts.forward} due=${report.counts.due} resolved=${report.counts.resolved}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sigma-prediction-ledger] failed: ${error?.message || error}`);
    process.exit(1);
  });
}
