'use strict';

/**
 * packages/core/lib/heartbeat.js — 팀장 하트비트 (생존 보고 + 이벤트 폴링)
 *
 * 각 팀장 커맨더가 주기적으로 호출:
 *   1. agent_state 갱신 (살아있음 표시)
 *   2. agent_events 미처리 이벤트 폴링
 *   3. 이상 감지 시 텔레그램 알림
 *
 * 설계 원칙:
 *   - heartbeat()는 단독 실행 (동기) — 커맨더 루프에서 호출
 *   - startHeartbeat()는 독립 인터벌 시작 — 데몬 프로세스용
 *   - 오류 발생 시 콘솔 출력 + 텔레그램 알림, 프로세스는 종료하지 않음
 *
 * 사용법:
 *   const hb = require('../../../packages/core/lib/heartbeat');
 *
 *   // 단발 실행 (커맨더 루프 내부)
 *   await hb.heartbeat('ska', { onEvent: async (ev) => { ... } });
 *
 *   // 인터벌 시작 (독립 데몬)
 *   hb.startHeartbeat('claude-lead', 300_000, { onEvent: ... });
 */

const stateBus = require('../../../bots/reservation/lib/state-bus');

// 하트비트 인터벌 핸들 (startHeartbeat용)
const _timers = {};

// 텔레그램 알림 함수 (선택적 주입 — 없으면 콘솔만)
let _notifyFn = null;

/**
 * 텔레그램 알림 함수 등록
 * 각 팀의 커맨더가 자신의 알림 함수를 등록한다.
 * @param {function} fn  async (msg: string) => void
 */
function setNotifyFn(fn) {
  _notifyFn = fn;
}

/**
 * 알림 전송 (텔레그램 또는 콘솔)
 * @param {string} msg
 */
async function _notify(msg) {
  if (_notifyFn) {
    try { await _notifyFn(msg); } catch (e) {
      console.error(`[하트비트] 텔레그램 알림 실패: ${e.message}`);
    }
  } else {
    console.warn(`[하트비트 알림] ${msg}`);
  }
}

/**
 * 단일 하트비트 실행
 *
 * @param {string} teamLeadId  - 'ska' | 'claude-lead' | 'luna'
 * @param {object} [opts]
 * @param {function} [opts.onEvent]      - async (event) => void  미처리 이벤트 핸들러
 * @param {function} [opts.onCheck]      - async () => { ok, issues[] }  추가 점검 콜백
 * @param {number}   [opts.eventLimit]   - 한 번에 처리할 최대 이벤트 수 (기본 10)
 * @param {boolean}  [opts.verbose]      - 상세 로그 출력 여부
 * @returns {Promise<{ eventsProcessed: number, issues: string[] }>}
 */
async function heartbeat(teamLeadId, opts = {}) {
  const { onEvent, onCheck, eventLimit = 10, verbose = false } = opts;
  const now = new Date().toISOString();
  const issues = [];

  // ── 1. agent_state 갱신 ──────────────────────────────────────────
  try {
    stateBus.updateAgentState(teamLeadId, 'idle', null, null);
    if (verbose) console.log(`  ✅ [하트비트:${teamLeadId}] agent_state 갱신 (${now})`);
  } catch (e) {
    const msg = `agent_state 갱신 실패: ${e.message}`;
    issues.push(msg);
    console.error(`  ❌ [하트비트:${teamLeadId}] ${msg}`);
  }

  // ── 2. 미처리 이벤트 폴링 ────────────────────────────────────────
  let eventsProcessed = 0;
  try {
    const events = stateBus.getUnprocessedEvents(teamLeadId, eventLimit);
    if (events.length > 0) {
      if (verbose || events.some(e => e.priority === 'critical' || e.priority === 'high')) {
        console.log(`  📥 [하트비트:${teamLeadId}] 미처리 이벤트 ${events.length}건`);
      }

      for (const ev of events) {
        try {
          // 페이로드 파싱
          let payload = null;
          try { payload = JSON.parse(ev.payload || 'null'); } catch {}
          const enriched = { ...ev, parsedPayload: payload };

          if (onEvent) {
            await onEvent(enriched);
          } else {
            // 기본 핸들러: 이벤트 정보 콘솔 출력
            console.log(`  📨 [하트비트:${teamLeadId}] 이벤트 #${ev.id} [${ev.event_type}/${ev.priority}] from ${ev.from_agent}`);
          }

          stateBus.markEventProcessed(ev.id);
          eventsProcessed++;
        } catch (evErr) {
          const msg = `이벤트 #${ev.id} 처리 실패: ${evErr.message}`;
          issues.push(msg);
          console.error(`  ⚠️  [하트비트:${teamLeadId}] ${msg}`);
          // 처리 실패 이벤트는 미처리 상태로 유지 (재시도 가능)
        }
      }
    } else if (verbose) {
      console.log(`  💤 [하트비트:${teamLeadId}] 미처리 이벤트 없음`);
    }
  } catch (e) {
    const msg = `이벤트 폴링 실패: ${e.message}`;
    issues.push(msg);
    console.error(`  ❌ [하트비트:${teamLeadId}] ${msg}`);
  }

  // ── 3. 추가 점검 콜백 (선택) ─────────────────────────────────────
  if (onCheck) {
    try {
      const checkResult = await onCheck();
      if (checkResult?.issues?.length > 0) {
        issues.push(...checkResult.issues);
        for (const issue of checkResult.issues) {
          console.warn(`  ⚠️  [하트비트:${teamLeadId}] ${issue}`);
        }
      }
    } catch (e) {
      const msg = `추가 점검 실패: ${e.message}`;
      issues.push(msg);
      console.error(`  ❌ [하트비트:${teamLeadId}] ${msg}`);
    }
  }

  // ── 4. 이상 감지 시 알림 ─────────────────────────────────────────
  if (issues.length > 0) {
    const alertMsg = [
      `⚠️ [${teamLeadId}] 하트비트 이상 감지 (${issues.length}건)`,
      ...issues.map((iss, i) => `  ${i + 1}. ${iss}`),
    ].join('\n');
    await _notify(alertMsg);
  }

  return { eventsProcessed, issues };
}

/**
 * 독립 하트비트 인터벌 시작
 * 데몬 프로세스나 커맨더의 setInterval 대체용.
 *
 * @param {string} teamLeadId
 * @param {number} intervalMs  - 기본 300_000 (5분)
 * @param {object} [opts]      - heartbeat() 옵션과 동일
 * @returns {{ stop: function }}  stop()으로 인터벌 정지
 */
function startHeartbeat(teamLeadId, intervalMs = 300_000, opts = {}) {
  if (_timers[teamLeadId]) {
    console.warn(`[하트비트] ${teamLeadId} 인터벌 이미 실행 중 — 기존 정지 후 재시작`);
    stopHeartbeat(teamLeadId);
  }

  console.log(`🔔 [하트비트] ${teamLeadId} 시작 (${intervalMs / 1000}초 주기)`);

  // 즉시 1회 실행
  heartbeat(teamLeadId, opts).catch(e =>
    console.error(`[하트비트:${teamLeadId}] 초기 실행 오류: ${e.message}`)
  );

  _timers[teamLeadId] = setInterval(() => {
    heartbeat(teamLeadId, opts).catch(e =>
      console.error(`[하트비트:${teamLeadId}] 오류: ${e.message}`)
    );
  }, intervalMs);

  return {
    stop: () => stopHeartbeat(teamLeadId),
  };
}

/**
 * 하트비트 인터벌 정지
 * @param {string} teamLeadId
 */
function stopHeartbeat(teamLeadId) {
  if (_timers[teamLeadId]) {
    clearInterval(_timers[teamLeadId]);
    delete _timers[teamLeadId];
    console.log(`🔕 [하트비트] ${teamLeadId} 정지`);
  }
}

/**
 * 현재 실행 중인 하트비트 ID 목록
 * @returns {string[]}
 */
function getActiveHeartbeats() {
  return Object.keys(_timers);
}

module.exports = {
  setNotifyFn,
  heartbeat,
  startHeartbeat,
  stopHeartbeat,
  getActiveHeartbeats,
};
