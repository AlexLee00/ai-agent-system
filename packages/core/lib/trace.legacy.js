'use strict';

/**
 * packages/core/lib/trace.js — 통합 trace_id 체계
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const traceStore = new AsyncLocalStorage();

function startTrace(metadata = {}) {
  return {
    trace_id: crypto.randomUUID(),
    started_at: Date.now(),
    ...metadata,
  };
}

function getTraceId() {
  const store = traceStore.getStore();
  return store?.trace_id || null;
}

function getTraceContext() {
  return traceStore.getStore() || null;
}

function withTrace(traceContext, fn) {
  return traceStore.run(traceContext, fn);
}

function continueTrace(traceId, fn, extra = {}) {
  const ctx = {
    trace_id: traceId,
    continued: true,
    started_at: Date.now(),
    ...extra,
  };
  return traceStore.run(ctx, fn);
}

function traceLog(level, message, data = {}) {
  const traceId = getTraceId();
  const enriched = traceId ? { trace_id: traceId, ...data } : data;
  const prefix = traceId ? `[${traceId.slice(0, 8)}]` : '';
  const fn = console[level] || console.log;
  fn(`${prefix} ${message}`, Object.keys(enriched).length > 0 ? enriched : '');
}

module.exports = {
  startTrace,
  getTraceId,
  getTraceContext,
  withTrace,
  continueTrace,
  traceLog,
  traceStore,
};
