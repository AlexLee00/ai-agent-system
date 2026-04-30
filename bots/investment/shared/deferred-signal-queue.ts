// @ts-nocheck
import { randomUUID } from 'node:crypto';

const memoryQueue = [];

export function enqueueDeferredSignal(signal = {}, reason = 'deferred', opts = {}) {
  const item = {
    id: opts.id || randomUUID(),
    signal,
    reason,
    retryAt: opts.retryAt || null,
    createdAt: opts.now || new Date().toISOString(),
    state: 'queued',
    dryRun: opts.dryRun !== false,
  };
  memoryQueue.push(item);
  return item;
}

export function listDeferredSignals({ state = 'queued', limit = 100 } = {}) {
  return memoryQueue.filter((item) => !state || item.state === state).slice(0, limit);
}

export function claimDueDeferredSignals({ now = new Date(), limit = 50 } = {}) {
  const nowMs = new Date(now).getTime();
  const due = [];
  for (const item of memoryQueue) {
    if (due.length >= limit) break;
    const dueAt = item.retryAt ? new Date(item.retryAt).getTime() : 0;
    if (item.state === 'queued' && dueAt <= nowMs) {
      item.state = 'claimed';
      item.claimedAt = new Date(nowMs).toISOString();
      due.push(item);
    }
  }
  return due;
}

export function clearDeferredSignalQueue() {
  const count = memoryQueue.length;
  memoryQueue.splice(0, memoryQueue.length);
  return { cleared: count };
}

export default { enqueueDeferredSignal, listDeferredSignals, claimDueDeferredSignals, clearDeferredSignalQueue };
