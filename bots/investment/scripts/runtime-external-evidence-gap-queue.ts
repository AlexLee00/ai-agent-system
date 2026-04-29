#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE,
  readExternalEvidenceGapTaskQueue,
  summarizeExternalEvidenceGapTaskQueue,
  updateExternalEvidenceGapTaskStatus,
} from '../shared/evidence-gap-task-queue.ts';
import { runPositionReevaluationEvent } from './runtime-position-reeval-event.ts';
import { runActiveBacktest } from './runtime-active-backtest.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    execute: false,
    confirm: null,
    includeBacktest: false,
    limit: 5,
    file: DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--execute') args.execute = true;
    else if (raw === '--include-backtest') args.includeBacktest = true;
    else if (raw.startsWith('--confirm=')) args.confirm = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 5));
    else if (raw.startsWith('--file=')) args.file = raw.split('=').slice(1).join('=') || args.file;
  }
  return args;
}

function openTasks(queue = {}, { includeBacktest = false, limit = 5 } = {}) {
  return (queue.tasks || [])
    .filter((task) => ['queued', 'retrying'].includes(String(task?.status || '')))
    .filter((task) => includeBacktest || String(task?.taskType || '') !== 'backtest_refresh')
    .sort((a, b) => new Date(a.createdAt || a.updatedAt || 0).getTime() - new Date(b.createdAt || b.updatedAt || 0).getTime())
    .slice(0, Math.max(1, Number(limit || 5)));
}

async function executeTask(task = {}) {
  const taskType = String(task?.taskType || '');
  const symbol = task.symbol;
  const exchange = task.exchange;
  const tradeMode = task.tradeMode || 'normal';
  if (!symbol || !exchange) {
    return { ok: false, status: 'invalid_task_scope' };
  }

  if (taskType === 'collection_refresh' || taskType === 'tradingview_refresh') {
    return runPositionReevaluationEvent({
      symbol,
      exchange,
      tradeMode,
      eventSource: taskType === 'tradingview_refresh' ? 'tradingview_refresh' : 'evidence-gap',
      attentionType: taskType === 'tradingview_refresh' ? 'tradingview_refresh' : 'evidence_gap_refresh',
      attentionReason: task.reason || null,
      persist: true,
      json: true,
    });
  }

  if (taskType === 'backtest_refresh') {
    return runActiveBacktest({
      symbol,
      market: exchange,
      attention: 'evidence_gap_refresh',
      source: 'position_watch',
      urgency: 'low',
      noAlert: true,
      json: true,
    });
  }

  return { ok: false, status: `unsupported_task_type:${taskType || 'unknown'}` };
}

function isBenignStaleScopeResult(result = {}) {
  return String(result?.status || '') === 'position_reeval_event_not_found';
}

export async function runExternalEvidenceGapQueue(args = {}) {
  const queue = readExternalEvidenceGapTaskQueue(args.file || DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE);
  const candidates = openTasks(queue, {
    includeBacktest: args.includeBacktest === true,
    limit: args.limit || 5,
  });
  const summary = summarizeExternalEvidenceGapTaskQueue(args.file || DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE);

  if (args.execute !== true) {
    return {
      ok: true,
      status: 'external_evidence_gap_queue_preview',
      execute: false,
      includeBacktest: args.includeBacktest === true,
      candidateCount: candidates.length,
      candidates,
      summary,
      nextCommand: candidates.length > 0
        ? 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:external-evidence-gap-queue -- --execute --confirm=evidence-gap-queue --json'
        : null,
    };
  }

  if (args.confirm !== 'evidence-gap-queue') {
    return {
      ok: false,
      status: 'external_evidence_gap_queue_confirmation_required',
      reason: 'use --confirm=evidence-gap-queue',
      candidateCount: candidates.length,
      summary,
    };
  }

  const results = [];
  for (const task of candidates) {
    updateExternalEvidenceGapTaskStatus({
      taskId: task.taskId,
      status: 'running',
      resolution: 'evidence_gap_queue_worker_started',
      file: args.file || DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE,
    });
    try {
      const result = await executeTask(task);
      const staleScope = isBenignStaleScopeResult(result);
      const ok = result?.ok !== false || staleScope;
      updateExternalEvidenceGapTaskStatus({
        taskId: task.taskId,
        status: ok ? 'resolved' : 'retrying',
        resolution: staleScope
          ? 'stale_scope_no_live_position'
          : ok
            ? 'evidence_gap_queue_worker_resolved'
            : (result?.status || 'evidence_gap_queue_worker_retrying'),
        error: ok ? null : (result?.reason || result?.error || result?.status || 'task returned ok:false'),
        file: args.file || DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE,
      });
      results.push({
        taskId: task.taskId,
        taskType: task.taskType,
        symbol: task.symbol,
        exchange: task.exchange,
        ok,
        status: result?.status || null,
        resolution: staleScope ? 'stale_scope_no_live_position' : null,
      });
    } catch (error) {
      updateExternalEvidenceGapTaskStatus({
        taskId: task.taskId,
        status: 'retrying',
        resolution: 'evidence_gap_queue_worker_error',
        error: error?.message || String(error),
        file: args.file || DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE,
      });
      results.push({
        taskId: task.taskId,
        taskType: task.taskType,
        symbol: task.symbol,
        exchange: task.exchange,
        ok: false,
        status: 'worker_error',
        error: error?.message || String(error),
      });
    }
  }

  const after = summarizeExternalEvidenceGapTaskQueue(args.file || DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE);
  return {
    ok: results.every((item) => item.ok === true),
    status: results.every((item) => item.ok === true)
      ? 'external_evidence_gap_queue_drained'
      : 'external_evidence_gap_queue_partial',
    execute: true,
    includeBacktest: args.includeBacktest === true,
    processed: results.length,
    results,
    before: summary,
    after,
  };
}

function renderText(payload = {}) {
  const summary = payload.summary || payload.after || {};
  const counts = summary.statusCounts || {};
  return [
    '🧩 External Evidence Gap Queue',
    `status: ${payload.status || 'unknown'}`,
    `execute: ${payload.execute === true}`,
    `candidates: ${payload.candidateCount ?? payload.processed ?? 0}`,
    `queued/retrying/running: ${counts.queued || 0}/${counts.retrying || 0}/${counts.running || 0}`,
    payload.nextCommand ? `next: ${payload.nextCommand}` : null,
  ].filter(Boolean).join('\n');
}

async function main() {
  const args = parseArgs();
  const result = await runExternalEvidenceGapQueue(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-external-evidence-gap-queue 오류:',
  });
}
