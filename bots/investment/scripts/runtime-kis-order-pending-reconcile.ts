#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { processHanulPendingReconcileQueue } from '../team/hanul.ts';

function parseArgs(argv = []) {
  const args = {
    json: false,
    dryRun: true,
    confirmLive: false,
    limit: 40,
    includePartialFill: true,
    delayMs: 250,
  };

  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--write') args.dryRun = false;
    else if (raw === '--confirm-live') args.confirmLive = true;
    else if (raw === '--no-partial-fill') args.includePartialFill = false;
    else if (raw.startsWith('--limit=')) {
      args.limit = Math.max(1, Math.min(200, Number(raw.split('=').slice(1).join('=') || 40)));
    } else if (raw.startsWith('--delay-ms=')) {
      args.delayMs = Math.max(0, Number(raw.split('=').slice(1).join('=') || 250));
    }
  }

  return args;
}

export async function runKisOrderPendingReconcile({
  dryRun = true,
  confirmLive = false,
  limit = 40,
  includePartialFill = true,
  delayMs = 250,
} = {}) {
  return processHanulPendingReconcileQueue({
    dryRun,
    confirmLive,
    limit,
    includePartialFill,
    delayMs,
  });
}

function renderSummary(result = {}) {
  const lines = [
    `pending reconcile: candidates ${Number(result.candidates || 0)} / processed ${Number(result.processed || 0)}`,
    `dryRun: ${result.dryRun !== false}`,
  ];
  if (result.blocked) {
    lines.push(`blocked: ${result.reason || 'unknown'}`);
    if (result.message) lines.push(result.message);
    return lines.join('\n');
  }
  if (result.summary) {
    lines.push(
      `completed ${Number(result.summary.completed || 0)} | partial ${Number(result.summary.partial || 0)} | queued ${Number(result.summary.queued || 0)} | invalid ${Number(result.summary.invalid || 0)} | apply ${Number(result.summary.applyCount || 0)}`,
    );
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runKisOrderPendingReconcile(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderSummary(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ KIS pending reconcile 실패:',
  });
}
