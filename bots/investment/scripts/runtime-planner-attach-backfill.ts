#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runRuntimePlannerAttachDryrun } from './runtime-planner-attach-dryrun.ts';

const DEFAULT_MARKETS = ['kis', 'kis_overseas'];

function parseArgs(argv = []) {
  const marketArg = argv.find((arg) => arg.startsWith('--markets='));
  const repeatsArg = argv.find((arg) => arg.startsWith('--repeats='));
  return {
    markets: marketArg?.split('=').slice(1).join('=')
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) || DEFAULT_MARKETS,
    repeats: Math.max(1, Number(repeatsArg?.split('=')[1] || 4)),
    json: argv.includes('--json'),
  };
}

function renderText(payload = {}) {
  return [
    `Runtime planner attach backfill: ${payload.ok ? 'ok' : 'partial'}`,
    `markets: ${payload.markets.join(', ')}`,
    `repeats: ${payload.repeats}`,
    `total: ${payload.total}`,
    `passed: ${payload.passed}`,
    `failed: ${payload.failed}`,
    '',
    ...payload.rows.map((row) =>
      `- ${row.market}#${row.index} | planner=${row.plannerAttached ? 'ok' : 'missing'} | mode=${row.plannerMode || 'none'} | timeMode=${row.plannerTimeMode || 'none'} | bridge=${row.bridgeStatus || 'none'}`
    ),
  ].join('\n');
}

export async function runRuntimePlannerAttachBackfill({ markets = DEFAULT_MARKETS, repeats = 4, json = false } = {}) {
  const rows = [];
  for (const market of markets) {
    for (let index = 1; index <= repeats; index += 1) {
      const result = await runRuntimePlannerAttachDryrun({ market, json: true }).catch((error) => ({
        ok: false,
        market,
        plannerAttached: false,
        plannerMode: null,
        plannerTimeMode: null,
        bridgeStatus: null,
        error: String(error?.message || error),
      }));
      rows.push({
        ...result,
        index,
      });
    }
  }

  const payload = {
    ok: rows.every((row) => row.ok && row.plannerAttached),
    markets,
    repeats,
    total: rows.length,
    passed: rows.filter((row) => row.ok && row.plannerAttached).length,
    failed: rows.filter((row) => !(row.ok && row.plannerAttached)).length,
    rows,
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runRuntimePlannerAttachBackfill(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-planner-attach-backfill 오류:',
  });
}
