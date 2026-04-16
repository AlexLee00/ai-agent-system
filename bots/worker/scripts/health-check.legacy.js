'use strict';

/**
 * scripts/health-check.js — 워커팀 launchd 서비스 헬스체크
 *
 * 감지 대상:
 *   - 상시 실행: web(포트4000), nextjs(포트4001) — PID 없으면 다운
 *
 * 공통 상태: packages/core/lib/health-state-manager.js
 * 실행: node scripts/health-check.js
 * 자동: launchd ai.worker.health-check (10분마다)
 */

const hsm    = require('../../../packages/core/lib/health-state-manager');
const { getWorkerHealthRuntimeConfig } = require('../lib/runtime-config');
const {
  getLaunchctlStatus,
  DEFAULT_NORMAL_EXIT_CODES,
} = require('../../../packages/core/lib/health-provider');
const {
  buildNoticeEvent,
  renderNoticeEvent,
  buildSeverityTargets,
  publishEventPipeline,
} = require('../../../packages/core/lib/reporting-hub');
const { createHealthMemoryHelper } = require('../../../packages/core/lib/health-memory');
const { buildWorkerCliInsight } = require('../lib/cli-insight.legacy');
const {
  canonicalizeWorkerCriticalAlert,
  appendIncidentLine,
} = require('../lib/critical-alerts.legacy');
const { buildIssueHints, rememberHealthEvent } = createHealthMemoryHelper({
  agentId: 'worker.health',
  team: 'worker',
  domain: 'worker health',
});

// 상시 실행 서비스 (PID 있어야 정상)
const CONTINUOUS = ['ai.worker.web', 'ai.worker.nextjs', 'ai.worker.lead', 'ai.worker.task-runner'];

// 감지할 전체 서비스
const ALL_SERVICES = ['ai.worker.web', 'ai.worker.nextjs', 'ai.worker.lead', 'ai.worker.task-runner'];

// 정상 종료 코드
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const healthRuntimeConfig = getWorkerHealthRuntimeConfig();
const HTTP_TIMEOUT_MS = Number(healthRuntimeConfig.httpTimeoutMs || 5000);

// ─── 알림 발송 (general 토픽) ────────────────────────────────────

async function notify(msg, level = 3) {
  try {
    const incidentState = canonicalizeWorkerCriticalAlert({
      source: 'worker-health-check',
      event_type: 'alert',
      alert_level: level,
      message: msg,
    });
    if (incidentState.suppress) return;
    const finalMessage = appendIncidentLine(msg, incidentState.signature, incidentState.incident);
    const event = buildNoticeEvent({
      from_bot: 'worker-health-check',
      team: 'worker',
      event_type: 'alert',
      alert_level: level,
      title: '워커 헬스 알림',
      summary: finalMessage.split('\n')[0] || '워커 헬스 알림',
      details: finalMessage.split('\n').slice(1).filter(Boolean),
      payload: {
        title: '워커 헬스 알림',
        summary: finalMessage.split('\n')[0] || '워커 헬스 알림',
        details: finalMessage.split('\n').slice(1).filter(Boolean),
      },
    });
    await publishEventPipeline({
      event: {
        ...event,
        message: renderNoticeEvent(event),
      },
      targets: buildSeverityTargets({
        event,
        topicTeam: 'general',
        includeQueue: false,
        includeTelegram: false,
      }),
      policy: {
        cooldownMs: level >= 3 ? 60_000 : 5 * 60_000,
      },
    });
  } catch { /* 무시 */ }
}

async function checkHttp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── 메인 ───────────────────────────────────────────────────────

async function main() {
  console.log(`[워커 헬스체크] 시작 — ${new Date().toISOString()}`);

  let status;
  try {
    status = getLaunchctlStatus(ALL_SERVICES);
  } catch (e) {
    console.error(`[워커 헬스체크] launchctl 실행 실패: ${e.message}`);
    process.exit(1);
  }

  const state  = hsm.loadState();
  const issues = [];

  for (const label of ALL_SERVICES) {
    const svc       = status[label];
    const shortName = hsm.shortLabel(label);

    // 1. 미로드 감지
    if (!svc) {
      const key = `unloaded:${label}`;
      if (hsm.canAlert(state, key)) {
        issues.push({ key, level: hsm.getAlertLevel(label), msg: `🔴 [워커 헬스] ${shortName} 미로드\nlaunchd에 등록되지 않음 → 수동 확인 필요` });
      }
      continue;
    }

    // 미로드 → 회복
    if (state[`unloaded:${label}`]) {
      const recoveryMsg = `✅ [워커 헬스] ${shortName} 회복\nlaunchd 정상 로드 — 자동 감지`;
      await notify(recoveryMsg, 1);
      await rememberHealthEvent(`unloaded:${label}`, 'recovery', recoveryMsg, 1);
      hsm.clearAlert(state, `unloaded:${label}`);
    }

    // 2. 상시 서비스 다운 감지
    if (CONTINUOUS.includes(label)) {
      if (!svc.running) {
        const key = `down:${label}`;
        if (hsm.canAlert(state, key)) {
          issues.push({ key, level: hsm.getAlertLevel(label), msg: `🔴 [워커 헬스] ${shortName} 다운\nPID 없음 — API/웹 서버 응답 불가` });
        }
      } else if (state[`down:${label}`]) {
        const recoveryMsg = `✅ [워커 헬스] ${shortName} 회복\nPID 정상 확인 — 자동 감지`;
        await notify(recoveryMsg, 1);
        await rememberHealthEvent(`down:${label}`, 'recovery', recoveryMsg, 1);
        hsm.clearAlert(state, `down:${label}`);
      }
    }

    // 3. 비정상 종료 코드 감지
    if (!NORMAL_EXIT_CODES.has(svc.exitCode) && !(CONTINUOUS.includes(label) && svc.running)) {
      const key = `exitcode:${label}:${svc.exitCode}`;
      if (hsm.canAlert(state, key)) {
        issues.push({ key, level: hsm.getAlertLevel(label), msg: `⚠️ [워커 헬스] ${shortName} 비정상 종료\nexit code: ${svc.exitCode}` });
      }
    } else {
      const prevKeys = Object.keys(state).filter(k => k.startsWith(`exitcode:${label}:`));
      if (prevKeys.length > 0) {
        const recoveryMsg = `✅ [워커 헬스] ${shortName} 회복\nexit code 정상 (0) — 자동 감지`;
        await notify(recoveryMsg, 1);
        await rememberHealthEvent(`exitcode:${label}:0`, 'recovery', recoveryMsg, 1);
        prevKeys.forEach(k => hsm.clearAlert(state, k));
      }
    }
  }

  const httpChecks = [
    { label: 'ai.worker.web', key: 'http:ai.worker.web', name: 'worker web', url: 'http://127.0.0.1:4000/api/health' },
    { label: 'ai.worker.nextjs', key: 'http:ai.worker.nextjs', name: 'worker nextjs', url: 'http://127.0.0.1:4001' },
  ];

  for (const check of httpChecks) {
    const ok = await checkHttp(check.url);
    if (!ok) {
      if (hsm.canAlert(state, check.key)) {
        issues.push({
          key: check.key,
          level: hsm.getAlertLevel(check.label),
          msg: `🔴 [워커 헬스] ${check.name} HTTP 실패\n${check.url} 응답 없음`,
        });
      }
    } else if (state[check.key]) {
      const recoveryMsg = `✅ [워커 헬스] ${check.name} 회복\nHTTP 응답 정상 — 자동 감지`;
      await notify(recoveryMsg, 1);
      await rememberHealthEvent(check.key, 'recovery', recoveryMsg, 1);
      hsm.clearAlert(state, check.key);
    }
  }

  const apiHealth = await fetchJson('http://127.0.0.1:4000/api/health');
  if (!apiHealth?.websocket?.enabled || !apiHealth?.websocket?.ready) {
    const key = 'ws:ai.worker.web';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: hsm.getAlertLevel('ai.worker.web'),
        msg: '⚠️ [워커 헬스] worker websocket 비정상\n/api/health 기준 WebSocket 준비 상태가 아닙니다.',
      });
    }
  } else if (state['ws:ai.worker.web']) {
    const recoveryMsg = '✅ [워커 헬스] worker websocket 회복\n실시간 채널 준비 상태 정상 — 자동 감지';
    await notify(recoveryMsg, 1);
    await rememberHealthEvent('ws:ai.worker.web', 'recovery', recoveryMsg, 1);
    hsm.clearAlert(state, 'ws:ai.worker.web');
  }

  // 알림 발송 + 상태 기록
  for (const { key, msg, level } of issues) {
    console.warn(`[워커 헬스체크] 이슈: ${msg}`);
    const memoryHints = await buildIssueHints(key, msg);
    await notify(`${msg}${memoryHints}`, level);
    await rememberHealthEvent(key, 'issue', msg, level);
    hsm.recordAlert(state, key);
  }

  hsm.saveState(state);

  const aiSummary = await buildWorkerCliInsight({
    bot: 'worker-health-check',
    requestType: 'worker-health-check',
    title: '워커 헬스체크 요약',
    data: {
      serviceCount: ALL_SERVICES.length,
      issueCount: issues.length,
      issueKeys: issues.map((item) => item.key),
      continuousServices: CONTINUOUS,
      httpChecks: httpChecks.map((item) => item.name),
    },
    fallback:
      issues.length > 0
        ? `워커 헬스 이슈 ${issues.length}건이 감지되어 launchd와 HTTP 응답 경로를 먼저 확인하는 것이 좋습니다.`
        : `워커 헬스체크는 전체 ${ALL_SERVICES.length}개 서비스 기준으로 현재 안정적입니다.`,
  });

  if (issues.length === 0) {
    console.log(`🔍 AI: ${aiSummary}`);
    console.log(`[워커 헬스체크] 정상 — 전체 ${ALL_SERVICES.length}개 서비스 이상 없음`);
  } else {
    console.log(`🔍 AI: ${aiSummary}`);
  }
}

main().catch(e => {
  console.error(`[워커 헬스체크] 예외: ${e.message}`);
  process.exit(1);
});
