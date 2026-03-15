'use strict';

const rag = require('./rag');
const pgPool = require('./pg-pool');
const { publishEventPipeline } = require('./reporting-hub');

const RAG_BACKOFF_MS = 2 * 3600 * 1000;
const RAG_ALERT_COOLDOWN_MS = 2 * 3600 * 1000;

const _state = {
  disabledUntil: 0,
  lastError: '',
  lastAlertAt: 0,
  recoveredNoticePending: false,
};

function _isDisabled(now = Date.now()) {
  return _state.disabledUntil > now;
}

function _isCapacityError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return [
    'rate limit',
    'too many requests',
    'quota',
    'insufficient_quota',
    'billing',
    'embedding',
    'timeout',
    'timed out',
    'openai',
    '429',
    '503',
    'capacity',
  ].some(token => message.includes(token));
}

async function _publish(message, payload, fromBot = 'rag') {
  await publishEventPipeline({
    event: {
      from_bot: fromBot,
      team: 'system',
      event_type: 'system',
      alert_level: payload?.status === 'recovered' ? 1 : 2,
      message,
      payload: payload || {},
    },
    targets: [
      {
        type: 'queue',
        pgPool,
        schema: 'claude',
      },
    ],
  });
}

async function _notifyDegraded(reason, operation, collection, sourceBot = 'rag') {
  const now = Date.now();
  if ((now - _state.lastAlertAt) < RAG_ALERT_COOLDOWN_MS) return;
  _state.lastAlertAt = now;
  await _publish(`RAG 우회 모드 진입 — ${reason}`, {
    status: 'degraded',
    component: 'rag_embedding',
    operation,
    collection,
    disabled_until: new Date(_state.disabledUntil).toISOString(),
    reason,
  }, sourceBot);
}

async function _notifyRecovered(sourceBot = 'rag') {
  await _publish('RAG 우회 모드 해제 — 임베딩 검색/저장 재개', {
    status: 'recovered',
    component: 'rag_embedding',
  }, sourceBot);
}

async function _enterBackoff(error, operation, collection, sourceBot) {
  if (!_isCapacityError(error)) return;
  const reason = String(error?.message || error || 'unknown_rag_error').slice(0, 240);
  _state.disabledUntil = Date.now() + RAG_BACKOFF_MS;
  _state.lastError = reason;
  _state.recoveredNoticePending = true;
  console.warn(`[RAG] 우회 모드 진입 (${operation}/${collection}): ${reason}`);
  await _notifyDegraded(reason, operation, collection, sourceBot);
}

async function _beforeCall(sourceBot = 'rag') {
  const now = Date.now();
  if (_isDisabled(now)) return false;
  if (_state.disabledUntil > 0 && _state.recoveredNoticePending) {
    _state.disabledUntil = 0;
    _state.lastError = '';
    _state.recoveredNoticePending = false;
    await _notifyRecovered(sourceBot);
  }
  return true;
}

function _remainingMinutes() {
  return Math.max(1, Math.ceil((_state.disabledUntil - Date.now()) / 60000));
}

function getRagGuardStatus() {
  return {
    disabled: _isDisabled(),
    disabledUntil: _state.disabledUntil,
    lastError: _state.lastError,
  };
}

async function search(collection, query, opts = {}, guardOpts = {}) {
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

async function store(collection, content, metadata = {}, sourceBot = 'rag') {
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

async function storeBatch(collection, items, sourceBot = 'rag') {
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

module.exports = {
  ...rag,
  search,
  store,
  storeBatch,
  getRagGuardStatus,
};
