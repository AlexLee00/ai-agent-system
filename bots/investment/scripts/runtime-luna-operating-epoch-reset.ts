#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getLunaOperatingEpoch } from '../shared/luna-operating-epoch.ts';

const OUTPUT_PATH = path.resolve('output/ops/luna-operating-epoch-reset.json');
const CONFIRM = 'luna-operating-epoch-reset';

const TABLES = [
  { id: 'signals', table: 'investment.signals', timestamp: 'created_at' },
  { id: 'trades', table: 'investment.trades', timestamp: 'executed_at' },
  { id: 'analysis', table: 'investment.analysis', timestamp: 'created_at' },
];

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
    confirm: argv.find((arg) => arg.startsWith('--confirm='))?.split('=')[1] || '',
  };
}

async function countTable(spec, epoch) {
  if (!epoch.enabled || !epoch.valid) {
    return { ...spec, ok: false, error: 'operating_epoch_disabled_or_invalid' };
  }
  try {
    const rows = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE ${spec.timestamp} < TIMESTAMP '${epoch.startedAt}')::int AS development,
         COUNT(*) FILTER (WHERE ${spec.timestamp} >= TIMESTAMP '${epoch.startedAt}')::int AS operating
       FROM ${spec.table}`,
    );
    const row = rows[0] || {};
    return {
      ...spec,
      ok: true,
      total: Number(row.total || 0),
      development: Number(row.development || 0),
      operating: Number(row.operating || 0),
    };
  } catch (error) {
    return {
      ...spec,
      ok: false,
      error: error?.message || String(error),
    };
  }
}

export async function buildLunaOperatingEpochResetReport(args = parseArgs()) {
  await db.initSchema();
  const epoch = getLunaOperatingEpoch();
  const tables = [];
  for (const spec of TABLES) tables.push(await countTable(spec, epoch));
  const developmentRows = tables.reduce((sum, item) => sum + Number(item.development || 0), 0);
  const operatingRows = tables.reduce((sum, item) => sum + Number(item.operating || 0), 0);
  const result = {
    ok: true,
    status: args.apply ? 'operating_epoch_marker_written' : 'operating_epoch_reset_dry_run',
    dryRun: !args.apply,
    epoch,
    tables,
    summary: {
      developmentRows,
      operatingRows,
      policy: 'development rows are preserved for audit but excluded from policy learning and historical hard gates',
    },
    applyContract: {
      destructiveDbReset: false,
      requiresConfirm: CONFIRM,
      effect: 'writes an ops marker only; live code uses epoch filtering at read time',
    },
  };
  if (args.apply) {
    if (args.confirm !== CONFIRM) {
      return {
        ...result,
        ok: false,
        status: 'confirmation_required',
        requiredConfirm: CONFIRM,
      };
    }
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ ...result, writtenAt: new Date().toISOString() }, null, 2));
    result.output = OUTPUT_PATH;
  }
  return result;
}

async function main() {
  const args = parseArgs();
  const result = await buildLunaOperatingEpochResetReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`runtime-luna-operating-epoch-reset status=${result.status}`);
    console.log(`epoch=${result.epoch.startedAt} developmentRows=${result.summary.developmentRows} operatingRows=${result.summary.operatingRows}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-operating-epoch-reset 실패:' });
}
