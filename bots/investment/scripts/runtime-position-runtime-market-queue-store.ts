#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import {
  investmentOpsLegacyFile,
  investmentOpsRuntimeFile,
} from '../shared/runtime-ops-path.ts';

export const POSITION_RUNTIME_MARKET_QUEUE_FILENAME = 'position-runtime-market-open-queue.json';
export const LEGACY_POSITION_RUNTIME_MARKET_QUEUE_FILE = investmentOpsLegacyFile(POSITION_RUNTIME_MARKET_QUEUE_FILENAME);
export const DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE = investmentOpsRuntimeFile(POSITION_RUNTIME_MARKET_QUEUE_FILENAME);

function ensureDir(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeEntry(entry = {}) {
  const candidate = entry?.candidate && typeof entry.candidate === 'object'
    ? { ...entry.candidate }
    : {};
  const queueKey = String(
    entry?.queueKey
    || candidate.executionScope
    || candidate.brokerScope
    || `${candidate.exchange || 'unknown'}:${candidate.symbol || 'unknown'}:${candidate.tradeMode || 'normal'}:${candidate.action || 'HOLD'}`
  );
  const createdAt = entry?.createdAt || new Date().toISOString();
  const updatedAt = entry?.updatedAt || createdAt;
  return {
    queueKey,
    createdAt,
    updatedAt,
    candidate,
    reason: String(entry?.reason || 'market_closed'),
    waitingReason: String(entry?.waitingReason || entry?.reason || 'market_closed'),
    attempts: Number.isFinite(Number(entry?.attempts)) ? Number(entry.attempts) : 0,
    retryCount: Number.isFinite(Number(entry?.retryCount)) ? Number(entry.retryCount) : 0,
    nextRetryAt: entry?.nextRetryAt || null,
    lastAttemptAt: entry?.lastAttemptAt || null,
    lastStatus: entry?.lastStatus || 'autonomous_action_queued',
  };
}

function normalizeQueue(rows = []) {
  const dedup = new Map();
  for (const row of rows || []) {
    const entry = normalizeEntry(row);
    const existing = dedup.get(entry.queueKey);
    if (!existing) {
      dedup.set(entry.queueKey, entry);
      continue;
    }
    const preferred = new Date(existing.updatedAt).getTime() >= new Date(entry.updatedAt).getTime()
      ? existing
      : {
        ...entry,
        createdAt: existing.createdAt || entry.createdAt,
      };
    dedup.set(entry.queueKey, preferred);
  }
  return Array.from(dedup.values())
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function isDefaultMarketQueueFile(file = DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE) {
  return path.resolve(String(file || '')) === path.resolve(DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE);
}

function resolveMarketQueueReadFile(file = DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE) {
  if (
    isDefaultMarketQueueFile(file)
    && !fs.existsSync(file)
    && fs.existsSync(LEGACY_POSITION_RUNTIME_MARKET_QUEUE_FILE)
  ) {
    return LEGACY_POSITION_RUNTIME_MARKET_QUEUE_FILE;
  }
  return file;
}

export function readPositionRuntimeMarketQueue(file = DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE) {
  const readFile = resolveMarketQueueReadFile(file);
  if (!fs.existsSync(readFile)) {
    return {
      file,
      updatedAt: null,
      entries: [],
    };
  }
  try {
    const raw = JSON.parse(String(fs.readFileSync(readFile, 'utf8') || '{}'));
    const entries = normalizeQueue(Array.isArray(raw?.entries) ? raw.entries : []);
    return {
      file,
      updatedAt: raw?.updatedAt || null,
      entries,
    };
  } catch {
    return {
      file,
      updatedAt: null,
      entries: [],
    };
  }
}

export function writePositionRuntimeMarketQueue(entries = [], file = DEFAULT_POSITION_RUNTIME_MARKET_QUEUE_FILE) {
  ensureDir(file);
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: normalizeQueue(entries),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

export function upsertPositionRuntimeMarketQueueEntry(
  entries = [],
  options = {},
) {
  const hasExplicitNextRetryAt = Object.prototype.hasOwnProperty.call(options || {}, 'nextRetryAt');
  const {
    queueKey = null,
    candidate = null,
    reason = 'market_closed',
    waitingReason = null,
    status = 'autonomous_action_queued',
    attempts = null,
    retryCount = null,
    lastAttemptAt = null,
    nextRetryAt = null,
  } = options || {};
  const key = String(
    queueKey
    || candidate?.executionScope
    || candidate?.brokerScope
    || `${candidate?.exchange || 'unknown'}:${candidate?.symbol || 'unknown'}:${candidate?.tradeMode || 'normal'}:${candidate?.action || 'HOLD'}`
  );
  const now = new Date().toISOString();
  const existing = (entries || []).find((item) => String(item?.queueKey || '') === key) || null;
  const nextAttempts = Number.isFinite(Number(attempts))
    ? Number(attempts)
    : Number(existing?.attempts || 0);
  const nextRetryCount = Number.isFinite(Number(retryCount))
    ? Number(retryCount)
    : Number(existing?.retryCount || 0);
  const nextLastAttemptAt = lastAttemptAt != null
    ? String(lastAttemptAt || '').trim() || null
    : (existing?.lastAttemptAt || null);
  const merged = normalizeEntry({
    ...(existing || {}),
    queueKey: key,
    candidate: candidate || existing?.candidate || null,
    reason,
    waitingReason: waitingReason || reason,
    updatedAt: now,
    attempts: nextAttempts,
    retryCount: nextRetryCount,
    lastAttemptAt: nextLastAttemptAt,
    lastStatus: status,
    nextRetryAt: hasExplicitNextRetryAt
      ? (nextRetryAt ? String(nextRetryAt) : null)
      : (existing?.nextRetryAt || null),
  });
  if (!existing) merged.createdAt = now;
  return normalizeQueue([...(entries || []).filter((item) => String(item?.queueKey || '') !== key), merged]);
}

export function removePositionRuntimeMarketQueueEntry(entries = [], queueKey = null) {
  const key = String(queueKey || '').trim();
  if (!key) return normalizeQueue(entries || []);
  return normalizeQueue((entries || []).filter((item) => String(item?.queueKey || '') !== key));
}

export function summarizePositionRuntimeMarketQueue(entries = [], exchange = null) {
  const filtered = (entries || []).filter((entry) => !exchange || String(entry?.candidate?.exchange || '') === String(exchange));
  const now = Date.now();
  let waitingMarketOpen = 0;
  let retrying = 0;
  let deferredGuard = 0;
  let readyRetry = 0;
  for (const entry of filtered) {
    const status = String(entry?.lastStatus || '');
    if (status === 'autonomous_action_retrying') retrying += 1;
    if (status === 'autonomous_action_queued') waitingMarketOpen += 1;
    if (status === 'autonomous_action_deferred_guard') deferredGuard += 1;
    const nextRetryAt = entry?.nextRetryAt ? new Date(entry.nextRetryAt).getTime() : null;
    if (nextRetryAt != null && Number.isFinite(nextRetryAt) && nextRetryAt <= now) readyRetry += 1;
  }
  return {
    total: filtered.length,
    waitingMarketOpen,
    retrying,
    deferredGuard,
    readyRetry,
  };
}
