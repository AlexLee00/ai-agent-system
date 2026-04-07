'use strict';

/**
 * packages/core/lib/trace.js — 통합 trace_id 체계
 *
 * AsyncLocalStorage로 trace_id를 요청 전체에서 자동 전파한다.
 * 하나의 요청이 여러 봇·함수를 거쳐도 같은 trace_id로 추적 가능.
 *
 * 사용법:
 *   const { startTrace, getTraceId, withTrace } = require('./trace');
 *
 *   // trace 시작 (요청 진입점)
 *   const ctx = startTrace({ bot: 'dexter', action: 'run_check' });
 *   withTrace(ctx, async () => {
 *     // 이 블록 안에서 getTraceId()는 ctx.trace_id 반환
 *     const id = getTraceId();  // ctx.trace_id
 *     await someAsyncFunction();  // 내부에서도 동일 trace_id
 *   });
 *
 *   // trace 외부에서는 null
 *   getTraceId();  // null
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const traceStore = new AsyncLocalStorage();

/**
 * 새 trace 컨텍스트 생성
 * @param {object} [metadata] - 추가 메타데이터 (bot, action, run_id 등)
 * @returns {{ trace_id: string, started_at: number } & Record<string, any>}
 */
function startTrace(metadata = {}) {
  return {
    trace_id:   crypto.randomUUID(),
    started_at: Date.now(),
    ...metadata,
  };
}

/**
 * 현재 trace_id 반환 (컨텍스트 없으면 null)
 * @returns {string|null}
 */
function getTraceId() {
  const store = traceStore.getStore();
  return store?.trace_id || null;
}

/**
 * 현재 trace 컨텍스트 전체 반환
 * @returns {object|null}
 */
function getTraceContext() {
  return traceStore.getStore() || null;
}

/**
 * trace 컨텍스트 내에서 함수 실행 (trace_id 자동 전파)
 * @param {object} traceContext - startTrace()로 생성한 컨텍스트
 * @param {() => any} fn - 실행할 함수
 * @returns {any} fn의 반환값
 */
function withTrace(traceContext, fn) {
  return traceStore.run(traceContext, fn);
}

/**
 * 기존 trace_id를 이어받아 실행 (봇 간 위임 시)
 * @param {string} traceId - 이어받을 trace_id
 * @param {() => any} fn - 실행할 함수
 * @param {object} [extra] - 추가 컨텍스트
 */
function continueTrace(traceId, fn, extra = {}) {
  const ctx = {
    trace_id:    traceId,
    continued:   true,
    started_at:  Date.now(),
    ...extra,
  };
  return traceStore.run(ctx, fn);
}

/**
 * trace_id를 로그에 자동 주입하는 래퍼
 * @param {string} level - 'log' | 'info' | 'warn' | 'error'
 * @param {string} message
 * @param {object} [data]
 */
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
