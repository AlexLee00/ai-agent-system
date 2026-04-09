'use strict';

/**
 * lib/response-cache.js — 조회 결과 인메모리 캐싱
 *
 * /status 같은 빈번한 조회를 짧은 시간 캐싱.
 * 프로세스 재시작 시 초기화 (의도적 단순성).
 */

const _cache = new Map(); // key → { data, expiresAt }

/**
 * 캐시에서 가져오기
 * @param {string} key
 * @returns {any|null}
 */
function get(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * 캐시에 저장
 * @param {string} key
 * @param {any}    data
 * @param {number} ttlMs 유효시간 (기본 60초)
 */
function set(key, data, ttlMs = 60_000) {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/**
 * 캐시 무효화
 */
function invalidate(key) {
  _cache.delete(key);
}

/**
 * 전체 초기화
 */
function clear() {
  _cache.clear();
}

/**
 * 캐시된 함수 실행 (캐시 미스 시 fn 호출 후 저장)
 * @param {string}   key
 * @param {Function} fn    async 가능
 * @param {number}   ttlMs
 */
async function cached(key, fn, ttlMs = 60_000) {
  const hit = get(key);
  if (hit !== null) return hit;
  const result = await fn();
  set(key, result, ttlMs);
  return result;
}

module.exports = { get, set, invalidate, clear, cached };
