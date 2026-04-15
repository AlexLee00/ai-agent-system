#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runRuntimePlannerAttachDryrun } from './runtime-planner-attach-dryrun.ts';

const DEFAULT_MARKETS = ['binance', 'kis', 'kis_overseas'];

function parseArgs(argv = []) {
  const marketArg = argv.find((arg) => arg.startsWith('--markets='));
  const markets = marketArg?.split('=').slice(1).join('=')
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean) || DEFAULT_MARKETS;
  return { markets, json: argv.includes('--json') };
}

function renderText(result = {}) {
  const lines = [
    `Runtime planner attach suite: ${result.failed === 0 ? 'ok' : 'failed'}`,
    `total: ${result.total}`,
    `passed: ${result.passed}`,
    `failed: ${result.failed}`,
    '',
    ...result.rows.map((row) =>
      `- ${row.market} | planner=${row.plannerAttached ? 'ok' : 'missing'} | mode=${row.plannerMode || 'none'} | timeMode=${row.plannerTimeMode || 'none'} | bridge=${row.bridgeStatus || 'none'} | trigger=${row.triggerType || 'none'}`
    ),
  ];
  return lines.join('\n');
}

export async function runRuntimePlannerAttachSuite({ markets = DEFAULT_MARKETS, json = false } = {}) {
  const rows = [];
  for (const market of markets) {
    const result = await runRuntimePlannerAttachDryrun({ market, json: true }).catch((error) => ({
      ok: false,
      market,
      plannerAttached: false,
      plannerMode: null,
      plannerTimeMode: null,
      bridgeStatus: null,
      triggerType: 'research',
      error: String(error?.message || error),
    }));
    rows.push(result);
  }

  const payload = {
    ok: rows.every((row) => row.ok && row.plannerAttached),
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
  const result = await runRuntimePlannerAttachSuite(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-planner-attach-suite 오류:',
  });
}
