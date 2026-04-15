#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildPositionReevaluationSummary } from './position-reevaluation-summary.ts';
import { buildPositionReevaluationHistory } from './position-reevaluation-history.ts';

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    tradeMode: null,
    paper: false,
    persist: true,
    json: false,
    minutesBack: 180,
    intervalSec: 30,
    iterations: 1,
    filePath: '/tmp/investment-position-reevaluation-history.jsonl',
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--paper') args.paper = true;
    else if (raw === '--no-persist') args.persist = false;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--trade-mode=')) args.tradeMode = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--minutes=')) args.minutesBack = Math.max(10, Number(raw.split('=').slice(1).join('=') || 180));
    else if (raw.startsWith('--interval-sec=')) args.intervalSec = Math.max(5, Number(raw.split('=').slice(1).join('=') || 30));
    else if (raw.startsWith('--iterations=')) args.iterations = Math.max(1, Number(raw.split('=').slice(1).join('=') || 1));
    else if (raw.startsWith('--file=')) args.filePath = raw.split('=').slice(1).join('=') || args.filePath;
  }
  return args;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function renderCycleLine(index, summary) {
  return `#${index} ${summary.decision.status} | HOLD ${summary.decision.metrics.holds} / ADJUST ${summary.decision.metrics.adjusts} / EXIT ${summary.decision.metrics.exits}`;
}

export async function runPositionReevaluationLoop(args = {}) {
  const cycles = [];
  for (let index = 1; index <= args.iterations; index += 1) {
    const summary = await buildPositionReevaluationSummary({
      exchange: args.exchange,
      tradeMode: args.tradeMode,
      paper: args.paper,
      persist: args.persist,
      json: true,
      minutesBack: args.minutesBack,
    });
    const history = await buildPositionReevaluationHistory({
      filePath: args.filePath,
      exchange: args.exchange,
      tradeMode: args.tradeMode,
      paper: args.paper,
      persist: false,
      append: true,
      json: true,
      minutesBack: args.minutesBack,
    });
    cycles.push({
      index,
      status: summary.decision.status,
      headline: summary.decision.headline,
      holds: summary.decision.metrics.holds,
      adjusts: summary.decision.metrics.adjusts,
      exits: summary.decision.metrics.exits,
      historyCount: history.historyCount,
      comparison: history.comparison,
    });
    if (index < args.iterations) {
      await sleep(args.intervalSec * 1000);
    }
  }

  const payload = {
    ok: true,
    iterations: args.iterations,
    intervalSec: args.intervalSec,
    cycles,
  };
  if (args.json) return payload;
  return [
    '🔁 Position Reevaluation Loop',
    `iterations: ${args.iterations}`,
    `intervalSec: ${args.intervalSec}`,
    ...cycles.map((cycle) => renderCycleLine(cycle.index, {
      decision: {
        status: cycle.status,
        metrics: { holds: cycle.holds, adjusts: cycle.adjusts, exits: cycle.exits },
      },
    })),
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionReevaluationLoop(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ position-reevaluation-loop 오류:',
  });
}
