import fs from 'fs';
const { getModeSuffix } = require('./mode');

export type StatusState = 'starting' | 'running' | 'idle' | 'error';

export interface SkaStatus {
  status?: StatusState;
  pid?: number | null;
  checkCount?: number;
  lastRun?: string;
  lastError?: string | null;
  consecutiveErrors?: number;
  durationMs?: number;
  updatedAt?: string;
}

export interface RecordHeartbeatOptions {
  status?: StatusState;
  error?: Error | string | null;
}

const STATUS_FILE = `/tmp/ska-status${getModeSuffix()}.json`;

let cycleStart: number | null = null;

export function readStatus(): SkaStatus {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')) as SkaStatus;
  } catch {
    return {};
  }
}

export function writeStatus(patch: Partial<SkaStatus>): SkaStatus {
  const current = readStatus();
  const next: SkaStatus = { ...current, ...patch, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2));
  } catch {
    // /tmp status writing is auxiliary only.
  }
  return next;
}

export function recordHeartbeat({ status = 'running', error = null }: RecordHeartbeatOptions = {}): void {
  const prev = readStatus();
  const errorMessage = error
    ? (error instanceof Error ? error.message : String(error))
    : null;

  writeStatus({
    status,
    pid: process.pid,
    checkCount: status === 'running' ? (prev.checkCount || 0) + 1 : (prev.checkCount || 0),
    lastRun: status === 'running' ? new Date().toISOString() : prev.lastRun,
    lastError: errorMessage ?? (status === 'idle' ? null : prev.lastError),
    consecutiveErrors: errorMessage
      ? (prev.consecutiveErrors || 0) + 1
      : (status === 'idle' ? 0 : prev.consecutiveErrors || 0),
    durationMs: status === 'idle' && cycleStart ? Date.now() - cycleStart : prev.durationMs,
  });

  if (status === 'running') cycleStart = Date.now();
}

export function getStatus(): SkaStatus {
  return readStatus();
}

export function markStopped({ reason = '정상 종료', error = false }: { reason?: string; error?: boolean } = {}): void {
  writeStatus({
    status: error ? 'error' : 'idle',
    pid: null,
    lastError: error ? reason : null,
  });
}
