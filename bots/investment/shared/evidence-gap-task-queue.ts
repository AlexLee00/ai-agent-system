// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import {
  investmentOpsLegacyFile,
  investmentOpsRuntimeFile,
} from './runtime-ops-path.ts';

export const EXTERNAL_EVIDENCE_GAP_QUEUE_FILENAME = 'position-runtime-evidence-gap-queue.json';
export const LEGACY_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE = investmentOpsLegacyFile(EXTERNAL_EVIDENCE_GAP_QUEUE_FILENAME);
export const DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE = investmentOpsRuntimeFile(EXTERNAL_EVIDENCE_GAP_QUEUE_FILENAME);
const INVESTMENT_BOT_PREFIX = '/Users/alexlee/projects/ai-agent-system/bots/investment';
const OPEN_TASK_MAX_AGE_MS = 3 * 60 * 60 * 1000;

function ensureDir(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeKey({
  symbol = null,
  exchange = null,
  tradeMode = 'normal',
} = {}) {
  return `${String(exchange || 'unknown')}:${String(symbol || 'unknown')}:${String(tradeMode || 'normal')}`;
}

function emptyState(file) {
  return {
    file,
    version: 1,
    updatedAt: null,
    states: {},
    tasks: [],
  };
}

function isDefaultQueueFile(file = DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE) {
  return path.resolve(String(file || '')) === path.resolve(DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE);
}

function resolveQueueReadFile(file = DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE) {
  if (
    isDefaultQueueFile(file)
    && !fs.existsSync(file)
    && fs.existsSync(LEGACY_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE)
  ) {
    return LEGACY_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE;
  }
  return file;
}

function readQueueRaw(file = DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE) {
  const readFile = resolveQueueReadFile(file);
  if (!fs.existsSync(readFile)) return emptyState(file);
  try {
    const raw = JSON.parse(String(fs.readFileSync(readFile, 'utf8') || '{}'));
    return {
      file,
      version: Number(raw?.version || 1),
      updatedAt: raw?.updatedAt || null,
      states: raw?.states && typeof raw.states === 'object' ? { ...raw.states } : {},
      tasks: Array.isArray(raw?.tasks) ? raw.tasks : [],
    };
  } catch {
    return emptyState(file);
  }
}

function pruneOpenTasks(tasks = [], nowMs = Date.now()) {
  return (Array.isArray(tasks) ? tasks : []).map((task) => {
    const status = String(task?.status || '');
    if (!['queued', 'retrying', 'running'].includes(status)) return task;
    const baseTime = task?.updatedAt || task?.createdAt || null;
    const ageMs = baseTime ? (nowMs - new Date(baseTime).getTime()) : 0;
    if (!(ageMs > OPEN_TASK_MAX_AGE_MS)) return task;
    return {
      ...task,
      status: 'expired',
      updatedAt: new Date(nowMs).toISOString(),
      resolution: 'stale_open_task_pruned',
    };
  });
}

function writeQueueRaw(payload = null, file = DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE) {
  ensureDir(file);
  const normalized = {
    file,
    version: 1,
    updatedAt: new Date().toISOString(),
    states: payload?.states && typeof payload.states === 'object' ? payload.states : {},
    tasks: Array.isArray(payload?.tasks) ? payload.tasks : [],
  };
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function buildTaskCommand(taskType = null, {
  symbol = null,
  exchange = null,
  tradeMode = 'normal',
} = {}) {
  if (taskType === 'collection_refresh') {
    return `npm --prefix ${INVESTMENT_BOT_PREFIX} run runtime:position-reeval-event -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --event-source=evidence-gap --attention-type=evidence_gap_refresh --json`;
  }
  if (taskType === 'tradingview_refresh') {
    return `npm --prefix ${INVESTMENT_BOT_PREFIX} run runtime:position-reeval-event -- --symbol=${symbol} --exchange=${exchange} --trade-mode=${tradeMode} --event-source=tradingview_refresh --attention-type=tradingview_refresh --json`;
  }
  if (taskType === 'backtest_refresh') {
    return `npm --prefix ${INVESTMENT_BOT_PREFIX} run runtime-active-backtest -- --symbol=${symbol} --market=${exchange} --attention=evidence_gap_refresh --source=position_watch --json`;
  }
  return null;
}

function queueTaskIfNeeded(payload, {
  scopeKey,
  taskType,
  symbol,
  exchange,
  tradeMode,
  reason,
} = {}) {
  const hasOpenTask = (payload.tasks || []).some((task) =>
    task?.scopeKey === scopeKey
    && task?.taskType === taskType
    && ['queued', 'retrying', 'running'].includes(String(task?.status || '')),
  );
  if (hasOpenTask) return null;
  const createdAt = new Date().toISOString();
  const task = {
    taskId: `${scopeKey}:${taskType}:${Date.now().toString(36)}`,
    scopeKey,
    symbol,
    exchange,
    tradeMode,
    taskType,
    status: 'queued',
    reason: reason || 'external_evidence_gap',
    createdAt,
    updatedAt: createdAt,
    command: buildTaskCommand(taskType, { symbol, exchange, tradeMode }),
  };
  payload.tasks = [...(payload.tasks || []), task].slice(-600);
  return task;
}

export function readExternalEvidenceGapTaskQueue(file = DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE) {
  const payload = readQueueRaw(file);
  const tasks = pruneOpenTasks(payload.tasks);
  if (JSON.stringify(tasks) !== JSON.stringify(payload.tasks || [])) {
    writeQueueRaw({ ...payload, tasks }, file);
  }
  return {
    ...payload,
    tasks,
    summary: {
      scopes: Object.keys(payload.states || {}).length,
      tasks: tasks.length,
      queued: tasks.filter((task) => task?.status === 'queued').length,
      retrying: tasks.filter((task) => task?.status === 'retrying').length,
      running: tasks.filter((task) => task?.status === 'running').length,
    },
  };
}

export function updateExternalEvidenceGapTaskQueue({
  symbol = null,
  exchange = null,
  tradeMode = 'normal',
  evidenceCount = 0,
  threshold = 3,
  cooldownMinutes = 60,
  reason = null,
  file = DEFAULT_EXTERNAL_EVIDENCE_GAP_QUEUE_FILE,
} = {}) {
  if (!symbol || !exchange) {
    return {
      ok: false,
      status: 'invalid_scope',
      scopeKey: null,
      queuedNow: false,
      queuedTasks: [],
      activeTasks: [],
      state: null,
    };
  }
  const payload = readQueueRaw(file);
  payload.tasks = pruneOpenTasks(payload.tasks);
  const scopeKey = normalizeKey({ symbol, exchange, tradeMode });
  const now = new Date();
  const nowIso = now.toISOString();
  const previous = payload.states?.[scopeKey] || {};
  const evidence = Math.max(0, Number(evidenceCount || 0));
  const previousConsecutive = Math.max(0, Number(previous?.consecutiveGapCount || 0));
  const consecutiveGapCount = evidence > 0 ? 0 : previousConsecutive + 1;
  const lastQueuedAtMs = previous?.lastQueuedAt ? new Date(previous.lastQueuedAt).getTime() : null;
  const cooldownMs = Math.max(1, Number(cooldownMinutes || 60)) * 60 * 1000;
  const cooldownReady = lastQueuedAtMs == null || (Date.now() - lastQueuedAtMs) >= cooldownMs;
  const shouldQueue = evidence <= 0 && consecutiveGapCount >= Math.max(1, Number(threshold || 3)) && cooldownReady;

  const state = {
    scopeKey,
    symbol,
    exchange,
    tradeMode,
    evidenceCount: evidence,
    consecutiveGapCount,
    threshold: Math.max(1, Number(threshold || 3)),
    cooldownMinutes: Math.max(1, Number(cooldownMinutes || 60)),
    lastSeenAt: nowIso,
    lastEvidenceAt: evidence > 0 ? nowIso : (previous?.lastEvidenceAt || null),
    lastQueuedAt: previous?.lastQueuedAt || null,
    status: evidence > 0
      ? 'evidence_recovered'
      : shouldQueue
        ? 'evidence_gap_task_queued'
        : consecutiveGapCount > 0
          ? 'evidence_gap_observed'
          : 'evidence_stable',
  };

  payload.states[scopeKey] = state;
  const queuedTasks = [];
  if (shouldQueue) {
    for (const taskType of ['collection_refresh', 'tradingview_refresh', 'backtest_refresh']) {
      const queued = queueTaskIfNeeded(payload, {
        scopeKey,
        taskType,
        symbol,
        exchange,
        tradeMode,
        reason: reason || `external_evidence_gap:${consecutiveGapCount}`,
      });
      if (queued) queuedTasks.push(queued);
    }
    state.lastQueuedAt = nowIso;
    payload.states[scopeKey] = state;
  }

  if (evidence > 0) {
    payload.tasks = (payload.tasks || []).map((task) => {
      if (task?.scopeKey !== scopeKey) return task;
      if (!['queued', 'retrying', 'running'].includes(String(task?.status || ''))) return task;
      return {
        ...task,
        status: 'resolved',
        updatedAt: nowIso,
        resolution: 'evidence_recovered',
      };
    });
  }

  const written = writeQueueRaw(payload, file);
  const activeTasks = (written.tasks || [])
    .filter((task) => task?.scopeKey === scopeKey && ['queued', 'retrying', 'running'].includes(String(task?.status || '')))
    .slice(0, 10);
  return {
    ok: true,
    status: state.status,
    scopeKey,
    queuedNow: shouldQueue && queuedTasks.length > 0,
    queuedTasks,
    activeTasks,
    state,
    queueSummary: {
      scopes: Object.keys(written.states || {}).length,
      tasks: (written.tasks || []).length,
    },
    file,
  };
}
