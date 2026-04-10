'use strict';

/**
 * lib/status.js — 프로세스 상태 파일 관리 (SKA-P08)
 *
 * 루나팀 lib/health.js 패턴 적용 (경량화).
 *
 * /tmp/ska-status.json 에 런타임 상태를 기록.
 * 덱스터(Dexter) 헬스체크 및 iPad 원격 모니터링에서 활용.
 *
 * 상태값:
 *   'starting'  — 초기화 중
 *   'running'   — 사이클 진행 중
 *   'idle'      — 사이클 완료, 다음 대기
 *   'error'     — 오류 발생
 *
 * 사용법:
 *   const { recordHeartbeat, getStatus } = require('../lib/status');
 *   recordHeartbeat({ status: 'running' });        // 사이클 시작
 *   recordHeartbeat({ status: 'idle' });           // 사이클 완료
 *   recordHeartbeat({ status: 'error', error: e }); // 오류
 */

const fs = require('fs');
const { getModeSuffix } = require('./mode');

// OPS: /tmp/ska-status.json  |  DEV: /tmp/ska-status-dev.json
// → OPS 상태와 DEV 상태가 충돌하지 않음
const STATUS_FILE = `/tmp/ska-status${getModeSuffix()}.json`;

let _cycleStart = null;

// ─── 기본 읽기/쓰기 ─────────────────────────────────────────────────

function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); }
  catch { return {}; }
}

function writeStatus(patch) {
  const current = readStatus();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2)); }
  catch (e) { /* /tmp 쓰기 실패는 무시 (코어 기능 아님) */ }
  return next;
}

// ─── 하트비트 ────────────────────────────────────────────────────────

/**
 * 사이클 상태 갱신
 * @param {object} opts
 * @param {'starting'|'running'|'idle'|'error'} [opts.status='running']
 * @param {Error|string|null} [opts.error=null]
 */
function recordHeartbeat({ status = 'running', error = null } = {}) {
  const prev = readStatus();
  const errMsg = error
    ? (error instanceof Error ? error.message : String(error))
    : null;

  writeStatus({
    status,
    pid:               process.pid,
    checkCount:        status === 'running'
      ? (prev.checkCount || 0) + 1
      : (prev.checkCount || 0),
    lastRun:           status === 'running'
      ? new Date().toISOString()
      : prev.lastRun,
    lastError:         errMsg ?? (status === 'idle' ? null : prev.lastError),
    consecutiveErrors: errMsg
      ? (prev.consecutiveErrors || 0) + 1
      : (status === 'idle' ? 0 : prev.consecutiveErrors || 0),
    durationMs:        status === 'idle' && _cycleStart
      ? Date.now() - _cycleStart
      : prev.durationMs,
  });

  if (status === 'running') _cycleStart = Date.now();
}

/** 현재 상태 조회 */
function getStatus() {
  return readStatus();
}

/**
 * 프로세스 종료 시 상태 파일 정리
 * @param {object} opts
 * @param {string} [opts.reason='정상 종료']
 * @param {boolean} [opts.error=false]
 */
function markStopped({ reason = '정상 종료', error = false } = {}) {
  writeStatus({
    status:    error ? 'error' : 'idle',
    pid:       null,
    lastError: error ? reason : null,
  });
}

module.exports = { readStatus, writeStatus, recordHeartbeat, getStatus, markStopped };
