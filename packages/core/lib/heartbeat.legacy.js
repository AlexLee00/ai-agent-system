'use strict';

const stateBus = require('../../../bots/reservation/lib/state-bus');

const _timers = {};
let _notifyFn = null;

function setNotifyFn(fn) {
  _notifyFn = fn;
}

async function _notify(msg) {
  if (_notifyFn) {
    try { await _notifyFn(msg); } catch (e) {
      console.error(`[하트비트] 텔레그램 알림 실패: ${e.message}`);
    }
  } else {
    console.warn(`[하트비트 알림] ${msg}`);
  }
}

async function heartbeat(teamLeadId, opts = {}) {
  const { onEvent, onCheck, eventLimit = 10, verbose = false } = opts;
  const now = new Date().toISOString();
  const issues = [];

  try {
    await stateBus.updateAgentState(teamLeadId, 'idle', null, null);
    if (verbose) console.log(`  ✅ [하트비트:${teamLeadId}] agent_state 갱신 (${now})`);
  } catch (e) {
    const msg = `agent_state 갱신 실패: ${e.message}`;
    issues.push(msg);
    console.error(`  ❌ [하트비트:${teamLeadId}] ${msg}`);
  }

  let eventsProcessed = 0;
  try {
    const events = await stateBus.getUnprocessedEvents(teamLeadId, eventLimit);
    if (events.length > 0) {
      if (verbose || events.some(e => e.priority === 'critical' || e.priority === 'high')) {
        console.log(`  📥 [하트비트:${teamLeadId}] 미처리 이벤트 ${events.length}건`);
      }

      for (const ev of events) {
        try {
          let payload = null;
          try { payload = JSON.parse(ev.payload || 'null'); } catch {}
          const enriched = { ...ev, parsedPayload: payload };

          if (onEvent) {
            await onEvent(enriched);
          } else {
            console.log(`  📨 [하트비트:${teamLeadId}] 이벤트 #${ev.id} [${ev.event_type}/${ev.priority}] from ${ev.from_agent}`);
          }

          await stateBus.markEventProcessed(ev.id);
          eventsProcessed++;
        } catch (evErr) {
          const msg = `이벤트 #${ev.id} 처리 실패: ${evErr.message}`;
          issues.push(msg);
          console.error(`  ⚠️  [하트비트:${teamLeadId}] ${msg}`);
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

  if (issues.length > 0) {
    const alertMsg = [
      `⚠️ [${teamLeadId}] 하트비트 이상 감지 (${issues.length}건)`,
      ...issues.map((iss, i) => `  ${i + 1}. ${iss}`),
    ].join('\n');
    await _notify(alertMsg);
  }

  return { eventsProcessed, issues };
}

function startHeartbeat(teamLeadId, intervalMs = 300_000, opts = {}) {
  if (_timers[teamLeadId]) {
    console.warn(`[하트비트] ${teamLeadId} 인터벌 이미 실행 중 — 기존 정지 후 재시작`);
    stopHeartbeat(teamLeadId);
  }

  console.log(`🔔 [하트비트] ${teamLeadId} 시작 (${intervalMs / 1000}초 주기)`);

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

function stopHeartbeat(teamLeadId) {
  if (_timers[teamLeadId]) {
    clearInterval(_timers[teamLeadId]);
    delete _timers[teamLeadId];
    console.log(`🔕 [하트비트] ${teamLeadId} 정지`);
  }
}

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
