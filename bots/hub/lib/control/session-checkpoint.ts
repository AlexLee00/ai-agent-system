import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type CheckpointKind = 'checkpoint' | 'branch' | 'restore';

export type SessionCheckpointInput = {
  sessionId: string;
  label?: string;
  summary: string;
  state?: Record<string, unknown>;
  artifacts?: string[];
  parentId?: string | null;
};

export type SessionCheckpointRecord = {
  id: string;
  kind: CheckpointKind;
  sessionId: string;
  label: string | null;
  summary: string;
  state: Record<string, unknown>;
  artifacts: string[];
  parentId: string | null;
  createdAt: string;
};

const SECRET_KEY_PATTERN = /(token|secret|password|api[_-]?key|authorization|cookie|session[_-]?key|refresh|access[_-]?token)/i;
const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|bot[0-9]+:[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})/i;

function runtimeRoot(): string {
  return process.env.HUB_RUNTIME_DIR
    || process.env.JAY_RUNTIME_DIR
    || path.join(os.homedir(), '.ai-agent-system', 'hub');
}

function checkpointDir(): string {
  return process.env.HUB_SESSION_CHECKPOINT_DIR
    || path.join(runtimeRoot(), 'session-checkpoints');
}

function checkpointFile(): string {
  return path.join(checkpointDir(), 'checkpoints.jsonl');
}

function ensureDir(): void {
  fs.mkdirSync(checkpointDir(), { recursive: true });
}

function stableId(input: Record<string, unknown>): string {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
  return `ckpt_${Date.now().toString(36)}_${hash}`;
}

function sanitizeString(value: string): string {
  if (SECRET_VALUE_PATTERN.test(value)) return '[redacted]';
  return value.length > 20_000 ? `${value.slice(0, 20_000)}…[truncated]` : value;
}

export function sanitizeCheckpointValue(value: unknown, keyHint = ''): unknown {
  if (SECRET_KEY_PATTERN.test(keyHint)) return '[redacted]';
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeCheckpointValue(item, keyHint));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = sanitizeCheckpointValue(child, key);
    }
    return output;
  }
  return String(value);
}

function normalizeArtifacts(artifacts: string[] | undefined): string[] {
  return [...new Set((artifacts || []).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 100);
}

function appendRecord(record: SessionCheckpointRecord): void {
  ensureDir();
  fs.appendFileSync(checkpointFile(), `${JSON.stringify(record)}\n`, 'utf8');
}

export function listSessionCheckpoints(sessionId?: string): SessionCheckpointRecord[] {
  const file = checkpointFile();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as SessionCheckpointRecord;
      } catch {
        return null;
      }
    })
    .filter((row): row is SessionCheckpointRecord => Boolean(row))
    .filter((row) => !sessionId || row.sessionId === sessionId);
}

export function createSessionCheckpoint(input: SessionCheckpointInput): SessionCheckpointRecord {
  const sessionId = String(input.sessionId || '').trim();
  const summary = String(input.summary || '').trim();
  if (!sessionId) throw new Error('session_id_required');
  if (!summary) throw new Error('checkpoint_summary_required');

  const sanitizedState = sanitizeCheckpointValue(input.state || {}) as Record<string, unknown>;
  const record: SessionCheckpointRecord = {
    id: stableId({ sessionId, summary, parentId: input.parentId || null }),
    kind: input.parentId ? 'branch' : 'checkpoint',
    sessionId,
    label: input.label ? String(input.label).slice(0, 120) : null,
    summary: sanitizeString(summary),
    state: sanitizedState,
    artifacts: normalizeArtifacts(input.artifacts),
    parentId: input.parentId || null,
    createdAt: new Date().toISOString(),
  };
  appendRecord(record);
  return record;
}

export function branchSessionCheckpoint(parentId: string, input: Omit<SessionCheckpointInput, 'parentId'>): SessionCheckpointRecord {
  const parent = listSessionCheckpoints().find((row) => row.id === parentId);
  if (!parent) throw new Error('checkpoint_parent_not_found');
  if (input.sessionId !== parent.sessionId) throw new Error('checkpoint_branch_session_mismatch');
  return createSessionCheckpoint({ ...input, parentId });
}

export function restoreSessionCheckpoint(checkpointId: string): SessionCheckpointRecord {
  const record = listSessionCheckpoints().find((row) => row.id === checkpointId);
  if (!record) throw new Error('checkpoint_not_found');
  return {
    ...record,
    kind: 'restore',
    createdAt: new Date().toISOString(),
  };
}

export const _testOnly = {
  checkpointDir,
  checkpointFile,
  sanitizeCheckpointValue,
};
