#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionRuntimeReport } from './runtime-position-runtime-report.ts';

const INVESTMENT_BOT_PREFIX = '/Users/alexlee/projects/ai-agent-system/bots/investment';
const FAILURE_STATUSES = new Set(['failed', 'fail', 'error', 'blocked', 'rejected', 'canceled', 'cancelled', 'child_process_error']);
const PENDING_STATUSES = new Set(['pending', 'queued', 'waiting', 'scheduled']);

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    execute: false,
    confirm: null,
    limit: 10,
    phase6: false,
    json: false,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--execute') args.execute = true;
    else if (raw === '--phase6') args.phase6 = true;
    else if (raw.startsWith('--confirm=')) args.confirm = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 10));
  }
  return args;
}

function urgencyScore(value) {
  return value === 'high' ? 3 : value === 'normal' ? 2 : 1;
}

function mapRuntimeCandidate(row = {}) {
  const executionIntent = row.runtimeState?.executionIntent || {};
  const executionPolicy = executionIntent?.executionPolicy || {};
  const autonomy = String(executionPolicy?.autonomy || '').trim();
  const isHardExit = autonomy === 'hard_exit_required'
    || String(row.runtimeState?.reasonCode || '').trim() === 'stop_loss_threshold';
  const action = executionIntent?.action || 'HOLD';
  const exchange = row.exchange;
  const symbol = row.symbol;
  const tradeMode = row.tradeMode || 'normal';
  const fallbackRunner = action === 'EXIT'
    ? 'runtime:strategy-exit'
    : action === 'ADJUST'
      ? 'runtime:partial-adjust'
      : null;
  const runner = executionIntent?.runner || fallbackRunner;
  const fallbackPreviewCommand = runner && symbol && exchange
    ? `npm --prefix ${INVESTMENT_BOT_PREFIX} run ${runner} -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --json`
    : null;
  const fallbackManualExecuteCommand = runner && symbol && exchange
    ? `${fallbackPreviewCommand} --execute --confirm=${runner === 'runtime:strategy-exit' ? 'strategy-exit' : 'partial-adjust'}`
    : null;
  const fallbackAutonomousExecuteCommand = runner && symbol && exchange
    ? `${fallbackPreviewCommand} --execute --confirm=position-runtime-autopilot --run-context=position-runtime-autopilot`
    : null;
  const fallbackRunnerArgs = runner && symbol && exchange
    ? {
      symbol,
      exchange,
      'trade-mode': tradeMode,
      execute: true,
      confirm: 'position-runtime-autopilot',
      'run-context': 'position-runtime-autopilot',
      json: true,
    }
    : null;
  return {
    exchange,
    symbol,
    tradeMode,
    strategyName: row.strategyName || null,
    setupType: row.setupType || null,
    action,
    command: executionIntent?.command || null,
    previewCommand: executionIntent?.previewCommand || executionIntent?.command || fallbackPreviewCommand,
    manualExecuteCommand: executionIntent?.manualExecuteCommand || fallbackManualExecuteCommand,
    autonomousExecuteCommand: executionIntent?.autonomousExecuteCommand || fallbackAutonomousExecuteCommand,
    runner,
    runnerArgs: executionIntent?.runnerArgs || fallbackRunnerArgs,
    executionPolicy,
    executionScope: executionIntent?.executionScope || `${exchange}:${symbol}:${action}:${row.tradeMode || 'normal'}`,
    brokerScope: executionIntent?.brokerScope || `${exchange}:${symbol}`,
    isHardExit,
    urgency: executionIntent?.urgency || 'low',
    executionAllowed: executionIntent?.executionAllowed === true,
    guardReasons: executionIntent?.guardReasons || [],
    sourceQualityBlocked: row.runtimeState?.policyMatrix?.sourceQualityBlocked === true
      || row.runtimeState?.monitoringPolicy?.sourceQualityBlocked === true,
    validationSeverity: row.runtimeState?.validationState?.severity || 'stable',
    cadenceMs: row.runtimeState?.monitoringPolicy?.cadenceMs || null,
    regime: row.runtimeState?.regime?.regime || null,
    reasonCode: row.runtimeState?.reasonCode || null,
  };
}

function isActionableAction(action = null) {
  return action === 'ADJUST' || action === 'EXIT';
}

export function buildCandidates(rows = []) {
  return rows
    .map(mapRuntimeCandidate)
    .filter((row) => isActionableAction(row.action) && row.executionAllowed)
    .sort((a, b) => urgencyScore(b.urgency) - urgencyScore(a.urgency));
}

export function buildBlockedCandidates(rows = []) {
  return rows
    .map(mapRuntimeCandidate)
    .filter((row) => isActionableAction(row.action) && row.executionAllowed !== true)
    .sort((a, b) => urgencyScore(b.urgency) - urgencyScore(a.urgency));
}

export function buildGuardReasonSummary(blockedRows = [], limit = 5) {
  const reasonMap = new Map();
  let criticalValidation = 0;
  let sourceQuality = 0;

  for (const row of blockedRows || []) {
    const reasons = Array.isArray(row.guardReasons) && row.guardReasons.length > 0
      ? row.guardReasons
      : [
        row.sourceQualityBlocked ? 'source_quality_blocked' : null,
        row.validationSeverity === 'critical' ? 'validation_severity_critical' : null,
        'execution_allowed_false',
      ].filter(Boolean);

    if (row.validationSeverity === 'critical') criticalValidation += 1;
    if (row.sourceQualityBlocked === true) sourceQuality += 1;

    for (const reason of reasons) {
      if (!reasonMap.has(reason)) {
        reasonMap.set(reason, { reason, count: 0, symbols: [], exchanges: new Set() });
      }
      const bucket = reasonMap.get(reason);
      bucket.count += 1;
      if (bucket.symbols.length < 4) {
        bucket.symbols.push(`${row.exchange}:${row.symbol}`);
      }
      bucket.exchanges.add(row.exchange || 'unknown');
    }
  }

  const topReasons = Array.from(reasonMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, Number(limit || 5)))
    .map((item) => ({
      reason: item.reason,
      count: item.count,
      symbols: item.symbols,
      exchanges: Array.from(item.exchanges),
    }));

  return {
    blockedActionable: blockedRows.length,
    criticalValidation,
    sourceQualityBlocked: sourceQuality,
    topReasons,
  };
}

export function applyExecutionScopeGate(candidates = []) {
  const groups = new Map();
  for (const candidate of candidates || []) {
    const key = `${candidate.exchange}:${candidate.symbol}:${candidate.action}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const selected = [];
  const suppressed = [];

  for (const [scopeKey, scoped] of groups.entries()) {
    if (!Array.isArray(scoped) || scoped.length === 0) continue;
    if (scoped.length === 1) {
      selected.push(scoped[0]);
      continue;
    }

    const hasHardExit = scoped.some((item) => item?.isHardExit === true);
    const preferred = hasHardExit
      ? scoped.find((item) => item?.tradeMode === 'normal') || scoped[0]
      : scoped[0];
    selected.push(preferred);

    for (const candidate of scoped) {
      if (candidate === preferred) continue;
      suppressed.push({
        ...candidate,
        scopeKey,
        suppressedBy: `${preferred.exchange}:${preferred.symbol}:${preferred.tradeMode}`,
        suppressedReason: hasHardExit ? 'shadow_suppressed_by_live_scope' : 'duplicate_execution_scope',
      });
    }
  }

  return { selected, suppressed };
}

function serializeRunnerArgs(runnerArgs = {}) {
  const args = [];
  for (const [key, value] of Object.entries(runnerArgs || {})) {
    if (value == null || value === false) continue;
    const flag = `--${key}`;
    if (value === true) args.push(flag);
    else args.push(`${flag}=${String(value)}`);
  }
  return args;
}

function buildExecutionInvocation(candidate, { phase6 = false } = {}) {
  if (phase6) {
    if (candidate?.runner && candidate?.runnerArgs && typeof candidate.runnerArgs === 'object') {
      return {
        kind: 'runner',
        executable: 'npm',
        args: [
          '--prefix',
          INVESTMENT_BOT_PREFIX,
          'run',
          candidate.runner,
          '--',
          ...serializeRunnerArgs(candidate.runnerArgs),
        ],
        command: `npm --prefix ${INVESTMENT_BOT_PREFIX} run ${candidate.runner} -- ${serializeRunnerArgs(candidate.runnerArgs).join(' ')}`.trim(),
      };
    }
    if (candidate?.autonomousExecuteCommand) {
      return {
        kind: 'shell',
        executable: 'bash',
        args: ['-lc', candidate.autonomousExecuteCommand],
        command: candidate.autonomousExecuteCommand,
      };
    }
    return null;
  }

  const command = candidate?.manualExecuteCommand || candidate?.command || null;
  if (!command) return null;
  return {
    kind: 'shell',
    executable: 'bash',
    args: ['-lc', command],
    command,
  };
}

function parseJsonTail(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}

  const starts = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i] !== '{') continue;
    starts.push(i);
    if (starts.length >= 40) break;
  }
  for (const index of starts) {
    try {
      return JSON.parse(raw.slice(index));
    } catch {}
  }
  return null;
}

function normalizeStatus(payload = null) {
  const normalized = String(
    payload?.executionStatus
    || payload?.reviewStatus
    || payload?.status
    || '',
  ).trim().toLowerCase();
  return normalized || null;
}

export function classifyChildExecutionOutput(stdout = '', { phase6 = false } = {}) {
  const payload = parseJsonTail(stdout);
  if (!payload) {
    return { ok: false, status: 'child_output_not_json', childPayload: null };
  }

  const mode = String(payload?.mode || '').trim().toLowerCase();
  const status = normalizeStatus(payload);
  if (mode === 'preview') {
    return { ok: false, status: 'child_preview_not_execution', childPayload: payload };
  }
  if (phase6 && mode && mode !== 'execute') {
    return { ok: false, status: `child_non_execute_mode_${mode}`, childPayload: payload };
  }
  if (payload?.ok === false) {
    return { ok: false, status: 'child_reported_failure', childPayload: payload };
  }
  if (status && FAILURE_STATUSES.has(status)) {
    return { ok: false, status: `child_status_${status}`, childPayload: payload };
  }

  const hasExecutionProof = mode === 'execute'
    || payload?.signalId != null
    || payload?.closeoutReviewId != null
    || payload?.result != null;
  if (!hasExecutionProof) {
    return { ok: false, status: 'child_execute_not_verified', childPayload: payload };
  }
  if (status && PENDING_STATUSES.has(status)) {
    return { ok: true, status: 'child_execution_pending', childPayload: payload };
  }
  return { ok: true, status: 'child_executed_verified', childPayload: payload };
}

async function executeCandidate(candidate, { phase6 = false } = {}) {
  const invocation = buildExecutionInvocation(candidate, { phase6 });
  if (!invocation) {
    return {
      ok: false,
      status: phase6 ? 'missing_autonomous_execution_path' : 'missing_command',
      candidate,
    };
  }

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(invocation.executable, invocation.args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
    });
    stdout = String(result?.stdout || '');
    stderr = String(result?.stderr || '');
  } catch (error) {
    return {
      ok: false,
      status: 'child_process_error',
      candidate,
      command: invocation.command,
      error: String(error?.message || error),
      output: String(error?.stdout || '').trim(),
      stderr: String(error?.stderr || '').trim(),
    };
  }

  const classification = classifyChildExecutionOutput(stdout, { phase6 });
  return {
    ok: classification.ok === true,
    status: classification.status,
    candidate,
    command: invocation.command,
    childPayload: classification.childPayload || null,
    output: String(stdout || '').trim(),
    stderr: String(stderr || '').trim(),
  };
}

function renderText(result = {}) {
  const lines = [
    '🚦 Position Runtime Dispatch',
    `status: ${result.status || 'unknown'}`,
    `candidates: ${result.candidates?.length || 0}`,
  ];
  if (result.blockedCandidates?.length > 0) {
    lines.push(`blockedActionable: ${result.blockedCandidates.length}`);
  }
  if (result.suppressedCandidates?.length > 0) {
    lines.push(`suppressedByScope: ${result.suppressedCandidates.length}`);
  }
  for (const candidate of result.candidates || []) {
    lines.push(`- ${candidate.exchange} ${candidate.symbol} ${candidate.tradeMode} | ${candidate.action} | ${candidate.regime || 'n/a'} | ${candidate.urgency}`);
  }
  if ((result.results || []).some((item) => item?.ok !== true)) {
    lines.push('');
    lines.push('dispatch failures:');
    for (const failure of (result.results || []).filter((item) => item?.ok !== true).slice(0, 5)) {
      lines.push(`- ${failure?.candidate?.exchange || 'unknown'} ${failure?.candidate?.symbol || 'unknown'}: ${failure?.status || 'failed'}`);
    }
  }
  if ((result.candidates?.length || 0) === 0 && (result.guardReasonSummary?.topReasons?.length || 0) > 0) {
    lines.push('');
    lines.push('guard reason top:');
    for (const reason of result.guardReasonSummary.topReasons) {
      lines.push(`- ${reason.reason} (${reason.count}) ${reason.symbols.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function isAllowedConfirm(confirm = null, { phase6 = false } = {}) {
  if (phase6) return confirm === 'phase6-autopilot' || confirm === 'runtime-dispatch';
  return confirm === 'runtime-dispatch';
}

export async function runPositionRuntimeDispatch(args = {}) {
  const runtimeReport = await runPositionRuntimeReport({
    exchange: args.exchange || null,
    limit: Math.max(args.limit || 10, 50),
    json: true,
  });
  const allRows = runtimeReport.rows || [];
  const allCandidates = buildCandidates(allRows);
  const allBlockedCandidates = buildBlockedCandidates(allRows);
  const guardReasonSummary = buildGuardReasonSummary(allBlockedCandidates, 5);
  const phaseCandidates = (args.phase6
    ? allCandidates.filter((row) => row.action === 'ADJUST' || row.action === 'EXIT')
    : allCandidates
  );
  const scopeGate = applyExecutionScopeGate(phaseCandidates);
  const candidates = scopeGate.selected.slice(0, args.limit || 10);
  const blockedCandidates = (args.phase6
    ? allBlockedCandidates.filter((row) => row.action === 'ADJUST' || row.action === 'EXIT')
    : allBlockedCandidates
  ).slice(0, Math.max(args.limit || 10, 10));
  const suppressedCandidates = scopeGate.suppressed.slice(0, Math.max(args.limit || 10, 10));

  if (!args.execute) {
    const hasBlockedActionable = guardReasonSummary.blockedActionable > 0;
    return {
      ok: true,
      phase6Mode: args.phase6 === true,
      status: candidates.length > 0
        ? 'position_runtime_dispatch_ready'
        : hasBlockedActionable
          ? 'position_runtime_dispatch_blocked'
          : 'position_runtime_dispatch_idle',
      candidates,
      blockedCandidates,
      suppressedCandidates,
      guardReasonSummary,
      runtimeDecision: runtimeReport.decision,
    };
  }

  if (!isAllowedConfirm(args.confirm, { phase6: args.phase6 === true })) {
    return {
      ok: false,
      status: 'position_runtime_dispatch_confirmation_required',
      phase6Mode: args.phase6 === true,
      candidates,
      blockedCandidates,
      suppressedCandidates,
      guardReasonSummary,
      reason: args.phase6 === true
        ? 'use --confirm=phase6-autopilot'
        : 'use --confirm=runtime-dispatch',
    };
  }

  const results = [];
  for (const candidate of candidates) {
    results.push(await executeCandidate(candidate, { phase6: args.phase6 === true }));
  }
  const hasFailures = results.some((item) => item?.ok !== true);
  return {
    ok: hasFailures !== true,
    phase6Mode: args.phase6 === true,
    status: hasFailures ? 'position_runtime_dispatch_executed_with_failures' : 'position_runtime_dispatch_executed',
    candidates,
    blockedCandidates,
    suppressedCandidates,
    guardReasonSummary,
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
