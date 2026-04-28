// @ts-nocheck

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { investmentOpsRuntimeFile } from './runtime-ops-path.ts';

export const POSITION_SYNC_FINAL_GATE_HISTORY_FILE = 'position-sync-final-gate-history.jsonl';

function compact(value, depth = 0) {
  if (value == null) return value;
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => compact(item, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|secret|password|credential|api[_-]?key/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = compact(raw, depth + 1);
  }
  return out;
}

export function getPositionSyncFinalGateHistoryPath() {
  return investmentOpsRuntimeFile(POSITION_SYNC_FINAL_GATE_HISTORY_FILE);
}

export function appendPositionSyncFinalGateHistory(event = {}) {
  const file = getPositionSyncFinalGateHistoryPath();
  mkdirSync(dirname(file), { recursive: true });
  const record = {
    recordedAt: new Date().toISOString(),
    ...compact(event),
  };
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return { ok: true, file, record };
}

export function readRecentPositionSyncFinalGateHistory({ limit = 20 } = {}) {
  const file = getPositionSyncFinalGateHistoryPath();
  let lines = [];
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { ok: true, file, rows: [] };
  }
  const rows = lines.slice(-Math.max(1, Number(limit || 20))).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { malformed: true, line };
    }
  });
  return { ok: true, file, rows };
}

export default {
  appendPositionSyncFinalGateHistory,
  getPositionSyncFinalGateHistoryPath,
  readRecentPositionSyncFinalGateHistory,
};
