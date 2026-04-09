import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rag = require('./rag');
const { postAlarm } = require('./openclaw-client');

type RagGuardState = {
  disabledUntil: number;
  lastError: string;
  lastAlertAt: number;
  recoveredNoticePending: boolean;
};

const RAG_BACKOFF_MS = 2 * 3600 * 1000;
const RAG_ALERT_COOLDOWN_MS = 2 * 3600 * 1000;
const RAG_STATE_FILE = path.join(os.tmpdir(), 'rag-safe-state.json');

const _state: RagGuardState = {
  disabledUntil: 0,
  lastError: '',
  lastAlertAt: 0,
  recoveredNoticePending: false,
};

function _readStateFile(): RagGuardState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(RAG_STATE_FILE, 'utf8')) as Partial<RagGuardState>;
    return {
      disabledUntil: Number(parsed.disabledUntil || 0),
      lastError: String(parsed.lastError || ''),
      lastAlertAt: Number(parsed.lastAlertAt || 0),
      recoveredNoticePending: parsed.recoveredNoticePending === true,
    };
  } catch {
    return null;
  }
}

function _syncStateFromFile(): void {
  const disk = _readStateFile();
  if (!disk) return;
  _state.disabledUntil = Number(disk.disabledUntil || 0);
  _state.lastError = String(disk.lastError || '');
  _state.lastAlertAt = Number(disk.lastAlertAt || 0);
  _state.recoveredNoticePending = disk.recoveredNoticePending === true;
}

function _persistState(): void {
  try {
    fs.writeFileSync(RAG_STATE_FILE, JSON.stringify({
      disabledUntil: _state.disabledUntil,
      lastError: _state.lastError,
      lastAlertAt: _state.lastAlertAt,
      recoveredNoticePending: _state.recoveredNoticePending,
    }, null, 2));
  } catch {
    // 상태 파일 기록 실패는 guard 동작을 막지 않는다.
  }
}

function _isDisabled(now = Date.now()): boolean {
  return _state.disabledUntil > now;
}

function _isCapacityError(error: unknown): boolean {
  const message = String((error as { message?: string } | null)?.message || error || '').toLowerCase();
  return [
    'rate limit',
    'too many requests',
    'quota',
    'insufficient_quota',
    'billing',
    'embedding',
    'different vector dimensions',
    'dimensions, not',
    'timeout',
    'timed out',
    'openai',
    '429',
    '503',
    'capacity',
  ].some((token) => message.includes(token));
}

async function _publish(message: string, payload: Record<string, unknown>, fromBot = 'rag'): Promise<void> {
  await postAlarm({
    message,
    team: 'system',
    alertLevel: payload?.status === 'recovered' ? 1 : 2,
    fromBot,
    payload: payload || {},
  } as any);
}

async function _notifyDegraded(reason: string, operation: string, collection: string, sourceBot = 'rag'): Promise<void> {
  _syncStateFromFile();
  const now = Date.now();
  if ((now - _state.lastAlertAt) < RAG_ALERT_COOLDOWN_MS) return;
  _state.lastAlertAt = now;
  _persistState();
  await _publish(`RAG 우회 모드 진입 — ${reason}`, {
    status: 'degraded',
    component: 'rag_embedding',
    operation,
    collection,
    disabled_until: new Date(_state.disabledUntil).toISOString(),
    reason,
  }, sourceBot);
}

async function _notifyRecovered(sourceBot = 'rag'): Promise<void> {
  _syncStateFromFile();
  await _publish('RAG 우회 모드 해제 — 임베딩 검색/저장 재개', {
    status: 'recovered',
    component: 'rag_embedding',
  }, sourceBot);
}

async function _enterBackoff(error: unknown, operation: string, collection: string, sourceBot: string): Promise<void> {
  if (!_isCapacityError(error)) return;
  _syncStateFromFile();
  const reason = String((error as { message?: string } | null)?.message || error || 'unknown_rag_error').slice(0, 240);
  _state.disabledUntil = Math.max(_state.disabledUntil, Date.now() + RAG_BACKOFF_MS);
  _state.lastError = reason;
  _state.recoveredNoticePending = true;
  _persistState();
  console.warn(`[RAG] 우회 모드 진입 (${operation}/${collection}): ${reason}`);
  await _notifyDegraded(reason, operation, collection, sourceBot);
}

async function _beforeCall(sourceBot = 'rag'): Promise<boolean> {
  _syncStateFromFile();
  const now = Date.now();
  if (_isDisabled(now)) return false;
  if (_state.disabledUntil > 0 && _state.recoveredNoticePending) {
    _state.disabledUntil = 0;
    _state.lastError = '';
    _state.recoveredNoticePending = false;
    _persistState();
    await _notifyRecovered(sourceBot);
  }
  return true;
}

function _remainingMinutes(): number {
  return Math.max(1, Math.ceil((_state.disabledUntil - Date.now()) / 60000));
}

function getRagGuardStatus(): { disabled: boolean; disabledUntil: number; lastError: string } {
  return {
    disabled: _isDisabled(),
    disabledUntil: _state.disabledUntil,
    lastError: _state.lastError,
  };
}

async function search(collection: string, query: string, opts: Record<string, unknown> = {}, guardOpts: { sourceBot?: string } = {}): Promise<any[]> {
  const sourceBot = guardOpts.sourceBot || 'rag';
  if (!(await _beforeCall(sourceBot))) {
    console.warn(`[RAG] search 우회 중 (${collection}) — ${_remainingMinutes()}분 남음`);
    return [];
  }
  try {
    return await rag.search(collection, query, opts);
  } catch (error) {
    await _enterBackoff(error, 'search', collection, sourceBot);
    if (_isCapacityError(error)) return [];
    throw error;
  }
}

async function store(collection: string, content: string, metadata: Record<string, unknown> = {}, sourceBot = 'rag'): Promise<unknown | null> {
  if (!(await _beforeCall(sourceBot))) {
    console.warn(`[RAG] store 우회 중 (${collection}) — ${_remainingMinutes()}분 남음`);
    return null;
  }
  try {
    return await rag.store(collection, content, metadata, sourceBot);
  } catch (error) {
    await _enterBackoff(error, 'store', collection, sourceBot);
    if (_isCapacityError(error)) return null;
    throw error;
  }
}

async function storeBatch(collection: string, items: unknown[], sourceBot = 'rag'): Promise<unknown[]> {
  if (!(await _beforeCall(sourceBot))) {
    console.warn(`[RAG] storeBatch 우회 중 (${collection}) — ${_remainingMinutes()}분 남음`);
    return [];
  }
  try {
    return await rag.storeBatch(collection, items, sourceBot);
  } catch (error) {
    await _enterBackoff(error, 'storeBatch', collection, sourceBot);
    if (_isCapacityError(error)) return [];
    throw error;
  }
}

export = {
  ...rag,
  search,
  store,
  storeBatch,
  getRagGuardStatus,
};
