#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { buildPositionReevaluationSummary } from './position-reevaluation-summary.ts';

const DEFAULT_STATE_FILE = '/tmp/investment-position-watch-state.json';

function parseArgs(argv = []) {
  const args = {
    json: false,
    notify: true,
    paper: false,
    persist: true,
    minutesBack: 180,
    stateFile: DEFAULT_STATE_FILE,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--paper') args.paper = true;
    else if (raw === '--no-notify') args.notify = false;
    else if (raw === '--no-persist') args.persist = false;
    else if (raw.startsWith('--minutes=')) args.minutesBack = Math.max(10, Number(raw.split('=').slice(1).join('=') || 180));
    else if (raw.startsWith('--state-file=')) args.stateFile = raw.split('=').slice(1).join('=') || DEFAULT_STATE_FILE;
  }
  return args;
}

function loadState(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(filePath, state) {
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function buildFocusRows(rows = [], recommendation) {
  return rows
    .filter((row) => row.recommendation === recommendation)
    .slice(0, 5)
    .map((row) => ({
      exchange: row.exchange,
      symbol: row.symbol,
      tradeMode: row.tradeMode || 'normal',
      pnlPct: Number(row.pnlPct || 0),
      reasonCode: row.reasonCode || 'unknown',
    }));
}

function buildSnapshot(summaryPayload) {
  const decision = summaryPayload?.decision || {};
  const report = summaryPayload?.report || {};
  const rows = report.rows || [];
  return {
    status: decision.status || 'unknown',
    headline: decision.headline || null,
    count: Number(report.count || 0),
    holds: Number(decision?.metrics?.holds || 0),
    adjusts: Number(decision?.metrics?.adjusts || 0),
    exits: Number(decision?.metrics?.exits || 0),
    topExit: decision?.metrics?.topExit || null,
    topAdjust: decision?.metrics?.topAdjust || null,
    exitRows: buildFocusRows(rows, 'EXIT'),
    adjustRows: buildFocusRows(rows, 'ADJUST'),
  };
}

function buildSignature(snapshot) {
  return JSON.stringify({
    status: snapshot.status,
    count: snapshot.count,
    adjusts: snapshot.adjusts,
    exits: snapshot.exits,
    topExit: snapshot.topExit?.code || null,
    topAdjust: snapshot.topAdjust?.code || null,
    exitSymbols: snapshot.exitRows.map((row) => `${row.exchange}:${row.symbol}:${row.tradeMode}:${row.reasonCode}`),
    adjustSymbols: snapshot.adjustRows.map((row) => `${row.exchange}:${row.symbol}:${row.tradeMode}:${row.reasonCode}`),
  });
}

function renderMessage(snapshot) {
  const lines = [
    '👀 포지션 watch',
    `status: ${snapshot.status}`,
    `positions: ${snapshot.count} | HOLD ${snapshot.holds} / ADJUST ${snapshot.adjusts} / EXIT ${snapshot.exits}`,
  ];

  if (snapshot.topExit?.code) {
    lines.push(`topExit: ${snapshot.topExit.code} (${snapshot.topExit.count})`);
  }
  if (snapshot.topAdjust?.code) {
    lines.push(`topAdjust: ${snapshot.topAdjust.code} (${snapshot.topAdjust.count})`);
  }

  if (snapshot.exitRows.length > 0) {
    lines.push('');
    lines.push('EXIT focus:');
    for (const row of snapshot.exitRows) {
      lines.push(`- ${row.exchange} ${row.symbol} ${row.tradeMode} | pnl=${row.pnlPct.toFixed(2)}% | ${row.reasonCode}`);
    }
  }

  if (snapshot.adjustRows.length > 0) {
    lines.push('');
    lines.push('ADJUST focus:');
    for (const row of snapshot.adjustRows) {
      lines.push(`- ${row.exchange} ${row.symbol} ${row.tradeMode} | pnl=${row.pnlPct.toFixed(2)}% | ${row.reasonCode}`);
    }
  }

  return lines.join('\n');
}

async function maybeNotify(snapshot, previous, notifyEnabled) {
  if (!notifyEnabled) return { notified: false, reason: 'notify_disabled' };

  const previousSignature = previous?.signature || null;
  const currentSignature = buildSignature(snapshot);
  const statusChanged = previous?.snapshot?.status !== snapshot.status;
  const changed = previousSignature !== currentSignature;

  if (!changed && !statusChanged) {
    return { notified: false, reason: 'unchanged', signature: currentSignature };
  }

  let alertLevel = 1;
  let eventType = 'report';
  if (snapshot.exits > 0) {
    alertLevel = 3;
    eventType = 'alert';
  } else if (snapshot.adjusts > 0) {
    alertLevel = 2;
    eventType = 'report';
  } else if ((previous?.snapshot?.exits || 0) > 0 || (previous?.snapshot?.adjusts || 0) > 0) {
    alertLevel = 1;
    eventType = 'report';
  } else {
    return { notified: false, reason: 'stable_ok', signature: currentSignature };
  }

  await publishAlert({
    from_bot: 'luna-position-watch',
    event_type: eventType,
    alert_level: alertLevel,
    message: renderMessage(snapshot),
    payload: {
      snapshot,
      previous: previous?.snapshot || null,
    },
  });
  return { notified: true, reason: 'state_changed', signature: currentSignature };
}

export async function runPositionWatch(args = {}) {
  const summary = await buildPositionReevaluationSummary({
    json: true,
    persist: args.persist,
    paper: args.paper,
    minutesBack: args.minutesBack,
  });
  const snapshot = buildSnapshot(summary);
  const previous = loadState(args.stateFile);
  const notify = await maybeNotify(snapshot, previous, args.notify);
  const signature = notify.signature || buildSignature(snapshot);
  const state = {
    capturedAt: new Date().toISOString(),
    signature,
    snapshot,
  };
  saveState(args.stateFile, state);

  return {
    ok: true,
    capturedAt: state.capturedAt,
    snapshot,
    notify,
    stateFile: args.stateFile,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionWatch(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderMessage(result.snapshot));
  console.log('');
  console.log(`notify: ${result.notify.notified ? 'sent' : result.notify.reason}`);
  console.log(`stateFile: ${result.stateFile}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ position-watch 오류:',
  });
}
