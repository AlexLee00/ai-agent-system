#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionRuntimeReport } from './runtime-position-runtime-report.ts';

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    execute: false,
    confirm: null,
    limit: 10,
    json: false,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--execute') args.execute = true;
    else if (raw.startsWith('--confirm=')) args.confirm = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 10));
  }
  return args;
}

function buildCandidates(rows = []) {
  return rows
    .filter((row) => row.runtimeState?.executionIntent?.executionAllowed)
    .map((row) => ({
      exchange: row.exchange,
      symbol: row.symbol,
      tradeMode: row.tradeMode || 'normal',
      strategyName: row.strategyName || null,
      setupType: row.setupType || null,
      action: row.runtimeState?.executionIntent?.action || 'HOLD',
      command: row.runtimeState?.executionIntent?.command || null,
      urgency: row.runtimeState?.executionIntent?.urgency || 'low',
      validationSeverity: row.runtimeState?.validationState?.severity || 'stable',
      cadenceMs: row.runtimeState?.monitoringPolicy?.cadenceMs || null,
      regime: row.runtimeState?.regime?.regime || null,
      reasonCode: row.runtimeState?.reasonCode || null,
    }))
    .sort((a, b) => {
      const urgencyScore = (value) => value === 'high' ? 3 : value === 'normal' ? 2 : 1;
      return urgencyScore(b.urgency) - urgencyScore(a.urgency);
    });
}

async function executeCandidate(candidate) {
  if (!candidate?.command) {
    return { ok: false, status: 'missing_command', candidate };
  }
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  const parts = candidate.command.split(' ');
  const executable = parts.shift();
  const args = parts || [];
  const { stdout } = await execFileAsync(executable, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 4,
  });
  return {
    ok: true,
    status: 'executed',
    candidate,
    output: String(stdout || '').trim(),
  };
}

function renderText(result = {}) {
  const lines = [
    '🚦 Position Runtime Dispatch',
    `status: ${result.status || 'unknown'}`,
    `candidates: ${result.candidates?.length || 0}`,
  ];
  for (const candidate of result.candidates || []) {
    lines.push(`- ${candidate.exchange} ${candidate.symbol} ${candidate.tradeMode} | ${candidate.action} | ${candidate.regime || 'n/a'} | ${candidate.urgency}`);
  }
  return lines.join('\n');
}

export async function runPositionRuntimeDispatch(args = {}) {
  const runtimeReport = await runPositionRuntimeReport({
    exchange: args.exchange || null,
    limit: Math.max(args.limit || 10, 50),
    json: true,
  });
  const candidates = buildCandidates(runtimeReport.rows || []).slice(0, args.limit || 10);

  if (!args.execute) {
    return {
      ok: true,
      status: candidates.length > 0 ? 'position_runtime_dispatch_ready' : 'position_runtime_dispatch_idle',
      candidates,
      runtimeDecision: runtimeReport.decision,
    };
  }

  if (args.confirm !== 'runtime-dispatch') {
    return {
      ok: false,
      status: 'position_runtime_dispatch_confirmation_required',
      candidates,
      reason: 'use --confirm=runtime-dispatch',
    };
  }

  const results = [];
  for (const candidate of candidates) {
    results.push(await executeCandidate(candidate));
  }
  return {
    ok: true,
    status: 'position_runtime_dispatch_executed',
    candidates,
    results,
    runtimeDecision: runtimeReport.decision,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionRuntimeDispatch(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-position-runtime-dispatch 오류:',
  });
}
