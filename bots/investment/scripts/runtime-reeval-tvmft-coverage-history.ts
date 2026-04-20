#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeReevalTvMtfCoverageReport } from './runtime-reeval-tvmft-coverage-report.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-reeval-tvmft-coverage-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  const exchangeArg = argv.find((arg) => arg.startsWith('--exchange='));
  const tradeModeArg = argv.find((arg) => arg.startsWith('--trade-mode='));
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
    days: Math.max(3, Number(daysArg?.split('=')[1] || 14)),
    limit: Math.max(10, Number(limitArg?.split('=')[1] || 200)),
    exchange: exchangeArg?.split('=')[1] || 'binance',
    tradeMode: tradeModeArg?.split('=')[1] || 'normal',
    paper: argv.includes('--paper'),
    file: fileArg?.split('=').slice(1).join('=') || DEFAULT_FILE,
    json: argv.includes('--json'),
  };
}

function readHistory(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function appendHistory(file, snapshot) {
  fs.appendFileSync(file, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

function renderText(payload) {
  return [
    '📚 Runtime Reevaluation TV-MTF Coverage History',
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `coverage delta: ${payload.delta.coverageRate >= 0 ? '+' : ''}${payload.delta.coverageRate}%`,
    `live delta: ${payload.delta.liveCoverage >= 0 ? '+' : ''}${payload.delta.liveCoverage}`,
    `legacy delta: ${payload.delta.legacyCoverage >= 0 ? '+' : ''}${payload.delta.legacyCoverage}`,
    '',
    `headline: ${payload.current.headline}`,
  ].join('\n');
}

export async function buildRuntimeReevalTvMtfCoverageHistory({
  days = 14,
  limit = 200,
  exchange = 'binance',
  tradeMode = 'normal',
  paper = false,
  file = DEFAULT_FILE,
  json = false,
} = {}) {
  const report = await buildRuntimeReevalTvMtfCoverageReport({
    days,
    limit,
    exchange,
    tradeMode,
    paper,
    json: true,
  });

  const current = {
    recordedAt: new Date().toISOString(),
    status: report.decision.status,
    headline: report.decision.headline,
    exchange,
    tradeMode,
    paper: paper === true,
    totalSymbols: Number(report.decision.metrics?.totalSymbols || 0),
    liveCoverage: Number(report.decision.metrics?.liveCoverage || 0),
    legacyCoverage: Number(report.decision.metrics?.legacyCoverage || 0),
    coverageRate: Number(report.decision.metrics?.coverageRate || 0),
  };

  const history = readHistory(file).filter((row) =>
    row.exchange === exchange &&
    String(row.tradeMode || 'normal') === String(tradeMode || 'normal') &&
    Boolean(row.paper) === Boolean(paper),
  );
  const previous = history[history.length - 1] || null;
  appendHistory(file, current);

  const payload = {
    ok: true,
    file,
    historyCount: history.length + 1,
    current,
    previous,
    delta: {
      totalSymbols: previous ? current.totalSymbols - Number(previous.totalSymbols || 0) : 0,
      liveCoverage: previous ? current.liveCoverage - Number(previous.liveCoverage || 0) : 0,
      legacyCoverage: previous ? current.legacyCoverage - Number(previous.legacyCoverage || 0) : 0,
      coverageRate: previous ? current.coverageRate - Number(previous.coverageRate || 0) : 0,
    },
  };

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeReevalTvMtfCoverageHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-reeval-tvmft-coverage-history 오류:',
  });
}
