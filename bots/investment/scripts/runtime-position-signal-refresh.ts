#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { refreshPositionSignals } from '../shared/position-signal-refresh.ts';
import { reevaluateOpenPositions } from '../shared/position-reevaluator.ts';

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    symbol: null,
    tradeMode: null,
    limit: 50,
    triggerReeval: false,
    json: false,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--trigger-reeval') args.triggerReeval = true;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--symbol=')) args.symbol = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--trade-mode=')) args.tradeMode = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 50));
  }
  return args;
}

function renderText(result = {}) {
  const lines = [
    '🔄 Position Signal Refresh',
    `ok: ${result.ok === true}`,
    `count: ${result.count || 0}`,
  ];
  for (const row of result.rows || []) {
    lines.push(
      `- ${row.exchange} ${row.symbol} ${row.tradeMode} | evidence=${row.summary?.evidenceCount ?? 0} | sentiment=${Number(row.summary?.sentimentScore || 0).toFixed(3)} | attention=${row.attentionType || 'none'}`,
    );
  }
  return lines.join('\n');
}

export async function runPositionSignalRefresh(args = {}) {
  const refreshed = await refreshPositionSignals({
    exchange: args.exchange || null,
    symbol: args.symbol || null,
    tradeMode: args.tradeMode || null,
    limit: args.limit || 50,
  });

  const triggered = [];
  if (args.triggerReeval === true) {
    for (const row of refreshed.rows || []) {
      if (!row.attentionType) continue;
      const report = await reevaluateOpenPositions({
        symbol: row.symbol,
        exchange: row.exchange,
        tradeMode: row.tradeMode,
        paper: false,
        persist: false,
        eventSource: 'position_signal_refresh',
        attentionType: row.attentionType,
        attentionReason: `refresh:${row.attentionType}`,
      }).catch(() => null);
      triggered.push({
        symbol: row.symbol,
        exchange: row.exchange,
        tradeMode: row.tradeMode,
        attentionType: row.attentionType,
        recommendation: report?.rows?.[0]?.recommendation || null,
      });
    }
  }

  return {
    ok: true,
    ...refreshed,
    triggerReeval: args.triggerReeval === true,
    triggered,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionSignalRefresh(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '[runtime-position-signal-refresh]',
  });
}
