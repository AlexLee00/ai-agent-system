#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionRuntimeReport } from './runtime-position-runtime-report.ts';
import { getKisMarketStatus, getKisOverseasMarketStatus } from '../shared/secrets.ts';
import {
  DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE,
  readPositionRuntimeMarketQueue,
  removePositionRuntimeMarketQueueEntry,
  summarizePositionRuntimeMarketQueue,
  upsertPositionRuntimeMarketQueueEntry,
  writePositionRuntimeMarketQueue,
} from './runtime-position-runtime-market-queue-store.ts';

const INVESTMENT_BOT_PREFIX = '/Users/alexlee/projects/ai-agent-system/bots/investment';
const FAILURE_STATUSES = new Set(['failed', 'fail', 'error', 'blocked', 'rejected', 'canceled', 'cancelled', 'child_process_error']);
const PENDING_STATUSES = new Set(['pending', 'queued', 'waiting', 'scheduled']);
const RETRYABLE_STATUSES = new Set(['child_process_error', 'child_output_not_json', 'child_execute_not_verified', 'child_execution_pending']);
const STALE_CANDIDATE_STATUSES = new Set(['candidate_not_found']);

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    execute: false,
    confirm: null,
    limit: 10,
    phase6: false,
    json: false,
    queueFile: DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE,
    retryDelayMinutes: 5,
    maxRetryCount: 5,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--execute') args.execute = true;
    else if (raw === '--phase6') args.phase6 = true;
    else if (raw.startsWith('--confirm=')) args.confirm = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 10));
    else if (raw.startsWith('--queue-file=')) args.queueFile = raw.split('=').slice(1).join('=') || DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE;
    else if (raw.startsWith('--retry-delay-minutes=')) args.retryDelayMinutes = Math.max(1, Number(raw.split('=').slice(1).join('=') || 5));
    else if (raw.startsWith('--max-retry-count=')) args.maxRetryCount = Math.max(1, Number(raw.split('=').slice(1).join('=') || 5));
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
  const brokerAccountId = executionIntent?.brokerAccountId
    || row?.positionSnapshot?.brokerAccountId
    || row?.positionSnapshot?.broker_account_id
    || `${exchange}:${row?.paper === true ? 'paper' : 'live'}`;
  const positionId = executionIntent?.positionId
    || row?.positionSnapshot?.positionId
    || row?.positionSnapshot?.position_id
    || `${exchange}:${symbol}:${tradeMode}`;
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
    executionScope: executionIntent?.executionScope
      || `${brokerAccountId}:${exchange}:${symbol}:${tradeMode}:${positionId}:${action}`,
    brokerScope: executionIntent?.brokerScope
      || `${brokerAccountId}:${exchange}:${symbol}:${positionId}`,
    brokerAccountId,
    positionId,
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
    const key = `${candidate.brokerScope || candidate.executionScope || `${candidate.exchange}:${candidate.symbol}:${candidate.tradeMode}`}:${candidate.action}`;
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
      ? scoped.find((item) => item?.tradeMode === 'normal')
        || scoped.find((item) => item?.executionPolicy?.autonomy === 'hard_exit_required')
        || scoped[0]
      : scoped.find((item) => item?.tradeMode === 'normal') || scoped[0];
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

export function buildExecutionInvocation(candidate, { phase6 = false } = {}) {
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

function addMinutesIso(minutes = 5) {
  return new Date(Date.now() + (Math.max(1, Number(minutes || 5)) * 60 * 1000)).toISOString();
}

export function detectTerminalChildFailure(message = '', stdout = '', stderr = '') {
  const text = [message, stdout, stderr]
    .map((value) => String(value || ''))
    .join('\n')
    .toLowerCase();
  if (!text) return null;
  if (
    text.includes('후보를 찾지 못했습니다')
    || text.includes('candidate_not_found')
    || text.includes('partial-adjust 후보를 찾지 못했습니다')
    || text.includes('strategy-exit 후보를 찾지 못했습니다')
  ) {
    return 'candidate_not_found';
  }
  return null;
}

async function resolveMarketGate(candidate = null) {
  const exchange = String(candidate?.exchange || '').toLowerCase();
  const isStockExchange = exchange === 'kis' || exchange === 'kis_overseas';
  const requiresMarketOpen = exchange !== 'binance'
    && (
      candidate?.executionPolicy?.requiresMarketOpen === true
      || (isStockExchange && candidate?.executionPolicy?.requiresMarketOpen !== false)
    );
  if (!requiresMarketOpen) {
    return {
      requiresMarketOpen: false,
      isOpen: true,
      reason: 'market_not_required',
    };
  }

  if (candidate?.exchange === 'kis') {
    const status = await getKisMarketStatus().catch((error) => ({
      isOpen: false,
      reason: `market_status_error:${error?.message || String(error)}`,
    }));
    return {
      requiresMarketOpen: true,
      isOpen: status?.isOpen === true,
      reason: status?.reason || 'market_status_unknown',
    };
  }

  if (candidate?.exchange === 'kis_overseas') {
    const status = getKisOverseasMarketStatus();
    return {
      requiresMarketOpen: true,
      isOpen: status?.isOpen === true,
      reason: status?.reason || 'market_status_unknown',
    };
  }

  return {
    requiresMarketOpen: true,
    isOpen: true,
    reason: 'market_not_supported_default_open',
  };
}

function toAutonomousActionStatus(result = null) {
  const status = String(result?.status || '').trim();
  if (status === 'autonomous_action_queued') return status;
  if (status === 'autonomous_action_retrying') return status;
  if (result?.ok === true) return 'autonomous_action_executed';
  if (
    status === 'missing_autonomous_execution_path'
    || status.startsWith('child_non_execute_mode_')
    || status === 'position_runtime_dispatch_confirmation_required'
  ) {
    return 'autonomous_action_blocked_by_safety';
  }
  if (status === 'child_execution_pending') return 'autonomous_action_retrying';
  if (STALE_CANDIDATE_STATUSES.has(status)) return 'autonomous_action_skipped_stale_candidate';
  return 'autonomous_action_failed';
}

async function executeCandidate(candidate, { phase6 = false } = {}) {
  const invocation = buildExecutionInvocation(candidate, { phase6 });
  if (!invocation) {
    return {
      ok: false,
      status: phase6 ? 'missing_autonomous_execution_path' : 'missing_command',
      autonomousActionStatus: 'autonomous_action_blocked_by_safety',
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
    const stdoutText = String(error?.stdout || '').trim();
    const stderrText = String(error?.stderr || '').trim();
    const terminalStatus = detectTerminalChildFailure(
      String(error?.message || error),
      stdoutText,
      stderrText,
    );
    if (STALE_CANDIDATE_STATUSES.has(String(terminalStatus || ''))) {
      return {
        ok: true,
        status: terminalStatus,
        autonomousActionStatus: 'autonomous_action_skipped_stale_candidate',
        candidate,
        command: invocation.command,
        staleCandidate: true,
        error: String(error?.message || error),
        output: stdoutText,
        stderr: stderrText,
      };
    }
    return {
      ok: false,
      status: terminalStatus || 'child_process_error',
      autonomousActionStatus: terminalStatus ? 'autonomous_action_failed' : 'autonomous_action_retrying',
      candidate,
      command: invocation.command,
      error: String(error?.message || error),
      output: stdoutText,
      stderr: stderrText,
    };
  }

  const classification = classifyChildExecutionOutput(stdout, { phase6 });
  const autonomousActionStatus = classification.status === 'child_execution_pending'
    ? 'autonomous_action_retrying'
    : classification.ok === true
      ? 'autonomous_action_executed'
      : toAutonomousActionStatus({ ok: false, status: classification.status });
  return {
    ok: classification.ok === true,
    status: classification.status,
    autonomousActionStatus,
    candidate,
    command: invocation.command,
    childPayload: classification.childPayload || null,
    output: String(stdout || '').trim(),
    stderr: String(stderr || '').trim(),
  };
}

export function renderText(result = {}) {
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
  if (Number(result.dedupedCandidates || 0) > 0) {
    lines.push(`dedupedCandidates: ${result.dedupedCandidates}`);
  }
  if (result.marketQueue) {
    lines.push(`marketQueue: total ${result.marketQueue.total || 0} / waiting ${result.marketQueue.waitingMarketOpen || 0} / retrying ${result.marketQueue.retrying || 0}`);
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
  const dedupedCandidates = Math.max(0, phaseCandidates.length - scopeGate.selected.length);
  const blockedCandidates = (args.phase6
    ? allBlockedCandidates.filter((row) => row.action === 'ADJUST' || row.action === 'EXIT')
    : allBlockedCandidates
  ).slice(0, Math.max(args.limit || 10, 10));
  const suppressedCandidates = scopeGate.suppressed.slice(0, Math.max(args.limit || 10, 10));
  const queueSnapshot = readPositionRuntimeMarketQueue(args.queueFile || DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE);
  let marketQueueEntries = queueSnapshot.entries || [];
  let marketQueueSummary = summarizePositionRuntimeMarketQueue(marketQueueEntries, args.exchange || null);

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
      dedupedCandidates,
      guardReasonSummary,
      marketQueue: {
        ...marketQueueSummary,
        file: args.queueFile || DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE,
      },
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
      dedupedCandidates,
      guardReasonSummary,
      marketQueue: {
        ...marketQueueSummary,
        file: args.queueFile || DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE,
      },
      reason: args.phase6 === true
        ? 'use --confirm=phase6-autopilot'
        : 'use --confirm=runtime-dispatch',
    };
  }

  const results = [];
  const handledExecutionKeys = new Set();
  const retryDelayMinutes = Math.max(1, Number(args.retryDelayMinutes || 5));
  const maxRetryCount = Math.max(1, Number(args.maxRetryCount || 5));

  const queueCandidate = (candidate, reason, extra = {}) => {
    marketQueueEntries = upsertPositionRuntimeMarketQueueEntry(marketQueueEntries, {
      candidate,
      reason,
      waitingReason: reason,
      status: extra.autonomousActionStatus || 'autonomous_action_queued',
      attempts: Number.isFinite(Number(extra.attempts)) ? Number(extra.attempts) : null,
      retryCount: Number.isFinite(Number(extra.retryCount)) ? Number(extra.retryCount) : null,
      lastAttemptAt: extra.lastAttemptAt || null,
      nextRetryAt: extra.nextRetryAt || null,
    });
    return {
      ok: true,
      status: 'queued_for_market_open',
      autonomousActionStatus: extra.autonomousActionStatus || 'autonomous_action_queued',
      candidate,
      queueReason: reason,
      nextRetryAt: extra.nextRetryAt || null,
      fromQueue: extra.fromQueue === true,
    };
  };

  const queuedForExchange = (marketQueueEntries || [])
    .filter((entry) => !args.exchange || String(entry?.candidate?.exchange || '') === String(args.exchange))
    .slice(0, Math.max(args.limit || 10, 10));

  for (const entry of queuedForExchange) {
    const candidate = entry?.candidate || null;
    if (!candidate) continue;
    const entryStatus = String(entry?.lastStatus || '').trim().toLowerCase();
    if (entryStatus === 'autonomous_action_failed') continue;
    const executionKey = `${candidate?.executionScope || candidate?.brokerScope || entry.queueKey}:${candidate?.action || 'HOLD'}`;
    const nextRetryAt = entry?.nextRetryAt ? new Date(entry.nextRetryAt).getTime() : null;
    if (nextRetryAt != null && Number.isFinite(nextRetryAt) && nextRetryAt > Date.now()) continue;
    const gate = await resolveMarketGate(candidate);
    if (gate.requiresMarketOpen && gate.isOpen !== true) {
      marketQueueEntries = upsertPositionRuntimeMarketQueueEntry(marketQueueEntries, {
        queueKey: entry.queueKey,
        candidate,
        reason: gate.reason || 'market_closed',
        waitingReason: gate.reason || 'market_closed',
        status: 'autonomous_action_queued',
      });
      continue;
    }

    const executed = await executeCandidate(candidate, { phase6: args.phase6 === true });
    const attempts = Number(entry?.attempts || 0) + 1;
    const lastAttemptAt = new Date().toISOString();
    const retryCount = Number(entry?.retryCount || 0) + (executed.ok === true ? 0 : 1);
    const autonomousActionStatus = executed.ok === true
      ? 'autonomous_action_executed'
      : RETRYABLE_STATUSES.has(String(executed.status || '')) && retryCount < maxRetryCount
        ? 'autonomous_action_retrying'
        : toAutonomousActionStatus(executed);
    const normalizedResult = {
      ...executed,
      fromQueue: true,
      attempts,
      retryCount,
      lastAttemptAt,
      autonomousActionStatus,
    };
    results.push(normalizedResult);
    handledExecutionKeys.add(executionKey);
    if (executed.ok === true) {
      marketQueueEntries = removePositionRuntimeMarketQueueEntry(marketQueueEntries, entry.queueKey);
    } else {
      const shouldRetry = RETRYABLE_STATUSES.has(String(executed.status || '')) && retryCount < maxRetryCount;
      if (shouldRetry) {
        marketQueueEntries = upsertPositionRuntimeMarketQueueEntry(marketQueueEntries, {
          queueKey: entry.queueKey,
          candidate,
          reason: String(executed.status || 'execution_failed'),
          waitingReason: 'retry_scheduled',
          status: 'autonomous_action_retrying',
          attempts,
          retryCount,
          lastAttemptAt,
          nextRetryAt: addMinutesIso(retryDelayMinutes),
        });
      } else {
        marketQueueEntries = removePositionRuntimeMarketQueueEntry(marketQueueEntries, entry.queueKey);
      }
    }
  }

  for (const candidate of candidates) {
    const executionKey = `${candidate?.executionScope || candidate?.brokerScope || `${candidate?.exchange}:${candidate?.symbol}:${candidate?.tradeMode}`}:${candidate?.action || 'HOLD'}`;
    if (handledExecutionKeys.has(executionKey)) continue;
    const gate = await resolveMarketGate(candidate);
    if (gate.requiresMarketOpen && gate.isOpen !== true) {
      results.push(queueCandidate(candidate, gate.reason || 'market_closed', {
        autonomousActionStatus: 'autonomous_action_queued',
      }));
      continue;
    }
    const executed = await executeCandidate(candidate, { phase6: args.phase6 === true });
    const retryableFailure = executed?.ok !== true && RETRYABLE_STATUSES.has(String(executed?.status || ''));
    const attempts = 1;
    const retryCount = retryableFailure ? 1 : 0;
    const lastAttemptAt = new Date().toISOString();
    const retryAt = retryableFailure ? addMinutesIso(retryDelayMinutes) : null;
    if (retryableFailure) {
      marketQueueEntries = upsertPositionRuntimeMarketQueueEntry(marketQueueEntries, {
        candidate,
        reason: String(executed?.status || 'execution_failed'),
        waitingReason: 'retry_scheduled',
        status: 'autonomous_action_retrying',
        attempts,
        retryCount,
        lastAttemptAt,
        nextRetryAt: retryAt,
      });
    }
    results.push({
      ...executed,
      attempts,
      retryCount,
      lastAttemptAt,
      autonomousActionStatus: retryableFailure
        ? 'autonomous_action_retrying'
        : (executed.autonomousActionStatus || toAutonomousActionStatus(executed)),
      nextRetryAt: retryAt,
    });
  }
  const queuePayload = writePositionRuntimeMarketQueue(marketQueueEntries, args.queueFile || DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE);
  marketQueueSummary = summarizePositionRuntimeMarketQueue(queuePayload.entries || [], args.exchange || null);
  const hasFailures = results.some((item) => item?.autonomousActionStatus === 'autonomous_action_failed');
  const queuedActions = results.filter((item) => item?.autonomousActionStatus === 'autonomous_action_queued').length;
  const retryingActions = results.filter((item) => item?.autonomousActionStatus === 'autonomous_action_retrying').length;
  return {
    ok: hasFailures !== true,
    phase6Mode: args.phase6 === true,
    status: hasFailures
      ? 'position_runtime_dispatch_executed_with_failures'
      : queuedActions > 0
        ? 'position_runtime_dispatch_executed_with_queue'
        : retryingActions > 0
          ? 'position_runtime_dispatch_executed_with_retry'
          : 'position_runtime_dispatch_executed',
    candidates,
    blockedCandidates,
    suppressedCandidates,
    dedupedCandidates,
    guardReasonSummary,
    marketQueue: {
      ...marketQueueSummary,
      file: args.queueFile || DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE,
    },
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
