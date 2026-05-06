'use strict';

/**
 * scripts/health-check.js — launchd 서비스 헬스체크
 *
 * 감지 대상:
 *   - 핵심 서비스 (commander/naver-monitor/kiosk-monitor/health-check): 미로드·다운 감지
 *   - naver-monitor 로그 staleness: 15분 이상 무활동 → 크래시루프 감지
 *   - 스케줄 서비스: 비정상 종료 코드 감지
 *
 * 중복 알림 방지: ~/.ai-agent-system/workspace/health-check-state.json
 *   - 같은 서비스 경고는 30분 내 재발송 안 함
 *
 * 실행: node scripts/health-check.js
 * 자동: launchd ai.ska.health-check (10분마다)
 */

const fs = require('fs');
const { publishReservationAlert } = require('../lib/alert-client');
const { initHubSecrets } = require('../lib/secrets');
const hsm = require('../../../packages/core/lib/health-state-manager');
const { getLaunchctlStatus, DEFAULT_NORMAL_EXIT_CODES } = require('../../../packages/core/lib/health-provider');
const { createHealthMemoryHelper } = require('../lib/health-memory-bridge');

// 상시 실행 서비스 (PID 있어야 정상)
const CONTINUOUS = ['ai.ska.commander', 'ai.ska.naver-monitor'];

// 핵심 서비스: 미로드/다운 자체가 바로 운영 경고
const CORE_SERVICES = [
  'ai.ska.commander',
  'ai.ska.naver-monitor',
  'ai.ska.kiosk-monitor',
];

// 스케줄 작업: 비정상 종료는 보되, 미로드 자체는 경고로 보지 않음
const SCHEDULED_SERVICES = [
  'ai.ska.health-check',
  'ai.ska.today-audit',
  'ai.ska.pickko-verify',
  'ai.ska.pickko-daily-audit',
  'ai.ska.pickko-daily-summary',
  'ai.ska.db-backup',
  'ai.ska.log-rotate',
];

const ALL_SERVICES = [...CORE_SERVICES, ...SCHEDULED_SERVICES];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const { buildIssueHints, rememberHealthEvent } = createHealthMemoryHelper({
  agentId: 'reservation.health',
  team: 'reservation',
  domain: 'reservation health',
});

// naver-monitor 로그 staleness 체크
const NAVER_LOG = '/tmp/naver-ops-mode.log';
const TODAY_AUDIT_LOG = '/tmp/today-audit.log';
const LOG_STALE_MS = 15 * 60 * 1000; // 15분 무활동 → 크래시루프 의심

function getCurrentKstParts() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return {
    isoDate: now.toISOString().slice(0, 10),
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
  };
}

// ─── 상태 파일 (공통 모듈 위임) ─────────────────────────────────

const loadState  = () => hsm.loadState();
const saveState  = (state) => hsm.saveState(state);
const canAlert   = (state, key) => hsm.canAlert(state, key);

// ─── naver-monitor 로그 staleness ───────────────────────────────

function checkNaverLogStaleness() {
  try {
    const stat = fs.statSync(NAVER_LOG);
    const ageMs = Date.now() - stat.mtimeMs;
    return { exists: true, ageMs, stale: ageMs > LOG_STALE_MS };
  } catch {
    return { exists: false, ageMs: null, stale: false }; // 파일 없으면 스킵
  }
}

function readTodayAuditStatus() {
  try {
    if (!fs.existsSync(TODAY_AUDIT_LOG)) {
      return { exists: false, lastExitCode: null, lastCompletedLine: null, recentSuccess: false };
    }

    const text = fs.readFileSync(TODAY_AUDIT_LOG, 'utf8');
    const lines = text.split('\n').map((line) => line.trimEnd()).filter(Boolean);
    const kst = getCurrentKstParts();
    const shouldHaveRunToday = kst.hour > 9 || (kst.hour === 9 && kst.minute >= 0);
    const completionRows = lines.map((line, index) => ({ line, index }))
      .filter((row) => row.line.includes('⏹ today-audit 완료'))
      .map((row) => {
        const candidateLines = lines.slice(0, row.index + 1);
        const lastAuditStartLine = [...candidateLines].reverse().find((line) => line.includes('📋 [오늘 예약 검증]')) || null;
        const lastAuditSummaryLine = [...candidateLines].reverse().find((line) => line.includes('✅ 오늘 예약 검증 완료')) || null;
        const match = row.line.match(/exit:\s*(\d+)/i);
        const lastExitCode = match ? Number(match[1]) : null;
        const summaryMatch = lastAuditSummaryLine
          ? lastAuditSummaryLine.match(/확인:\s*(\d+),\s*차단추가:\s*(\d+),\s*해제:\s*(\d+),\s*실패:\s*(\d+)/)
          : null;
        const summary = summaryMatch
          ? {
            okCount: Number(summaryMatch[1]),
            blockedCount: Number(summaryMatch[2]),
            unblockedCount: Number(summaryMatch[3]),
            failedCount: Number(summaryMatch[4]),
          }
          : null;
        const lastAuditDate = lastAuditStartLine ? (lastAuditStartLine.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null : null;
        return {
          ...row,
          lastExitCode,
          lastAuditDate,
          summary,
        };
      });
    const latestCompletion = completionRows[completionRows.length - 1] || null;
    const latestSuccessfulToday = [...completionRows].reverse().find((row) =>
      row.lastExitCode === 0 && row.lastAuditDate === kst.isoDate
    ) || null;
    const selected = latestSuccessfulToday || latestCompletion;
    const lastCompletedLine = selected?.line || null;
    const lastExitCode = selected?.lastExitCode ?? null;
    const summary = selected?.summary || null;
    const lastAuditDate = selected?.lastAuditDate || null;
    const missingTodayRun = shouldHaveRunToday && !latestSuccessfulToday && lastAuditDate !== kst.isoDate;

    return {
      exists: true,
      lastExitCode,
      lastCompletedLine,
      lastAuditDate,
      missingTodayRun,
      summary,
      recentSuccess: Boolean(latestSuccessfulToday || lastExitCode === 0),
    };
  } catch (error) {
    return {
      exists: true,
      lastExitCode: null,
      lastCompletedLine: `read-failed:${error.message}`,
      lastAuditDate: null,
      missingTodayRun: false,
      summary: null,
      recentSuccess: false,
    };
  }
}

// ─── 메인 ───────────────────────────────────────────────────────

async function main() {
  await initHubSecrets();
  console.log(`[헬스체크] 시작 — ${new Date().toISOString()}`);

  let status;
  try {
    status = getLaunchctlStatus(ALL_SERVICES);
  } catch (e) {
    console.error(`[헬스체크] launchctl 실행 실패: ${e.message}`);
    process.exit(1);
  }

  const state = loadState();
  const issues = [];

  for (const label of ALL_SERVICES) {
    const svc = status[label];
    const shortName = label.replace('ai.ska.', '');

    const isCoreService = CORE_SERVICES.includes(label);

    // 1. 핵심 서비스 미로드 감지
    if (!svc) {
      if (isCoreService) {
        const key = `unloaded:${label}`;
        if (canAlert(state, key)) {
          issues.push({ key, level: hsm.getAlertLevel(label), msg: `🔴 [스카 헬스] ${shortName} 미로드\nlaunchd에 등록되지 않음 → 수동 확인 필요` });
        }
      }
      continue;
    }

    // 미로드 → 회복 시 state 클리어 + 알림
    if (isCoreService && state[`unloaded:${label}`]) {
      console.log(`[헬스체크] ${shortName} 로드 회복 확인`);
      const recoveryMsg = `✅ [스카 헬스] ${shortName} 회복\nlaunchd 정상 로드 — 자동 감지`;
      await publishReservationAlert({
        from_bot: 'ska', event_type: 'health_check', alert_level: 1,
        message: recoveryMsg,
      });
      await rememberHealthEvent(`unloaded:${label}`, 'recovery', recoveryMsg, 1);
      delete state[`unloaded:${label}`];
    }

    // 2. 상시 서비스 다운 감지 (PID 없음)
    if (CONTINUOUS.includes(label)) {
      if (!svc.running) {
        const key = `down:${label}`;
        if (canAlert(state, key)) {
          issues.push({ key, level: hsm.getAlertLevel(label), msg: `🔴 [스카 헬스] ${shortName} 다운\nPID 없음 — launchd 재시작 실패 가능성` });
        }
      } else {
        // PID 회복 시 state 클리어 + 알림
        if (state[`down:${label}`]) {
          console.log(`[헬스체크] ${shortName} PID 회복 확인`);
          const recoveryMsg = `✅ [스카 헬스] ${shortName} 회복\nPID 정상 확인 — 자동 감지`;
          await publishReservationAlert({
            from_bot: 'ska', event_type: 'health_check', alert_level: 1,
            message: recoveryMsg,
          });
          await rememberHealthEvent(`down:${label}`, 'recovery', recoveryMsg, 1);
          delete state[`down:${label}`];
        }
      }
    }

    // 3. 비정상 종료 코드 감지
    // CONTINUOUS 서비스는 현재 실행 중(PID 있음)이면 이전 exitCode 무시
    if (!NORMAL_EXIT_CODES.has(svc.exitCode) && !(CONTINUOUS.includes(label) && svc.running)) {
      const key = `exitcode:${label}:${svc.exitCode}`;
      if (canAlert(state, key)) {
        issues.push({ key, level: hsm.getAlertLevel(label), msg: `⚠️ [스카 헬스] ${shortName} 비정상 종료\nexit code: ${svc.exitCode}` });
      }
    } else {
      // exit code 정상(0) → 이전 오류 키 있으면 회복으로 판단
      const prevKeys = Object.keys(state).filter(k => k.startsWith(`exitcode:${label}:`));
      if (prevKeys.length > 0) {
        console.log(`[헬스체크] ${shortName} 회복 확인 (exit code → 0)`);
        const recoveryMsg = `✅ [스카 헬스] ${shortName} 회복\nexit code 정상 (0) — 자동 감지`;
        await publishReservationAlert({
          from_bot: 'ska', event_type: 'health_check', alert_level: 1,
          message: recoveryMsg,
        });
        await rememberHealthEvent(`exitcode:${label}:0`, 'recovery', recoveryMsg, 1);
        prevKeys.forEach(k => delete state[k]);
      }
    }
  }

  // 4. naver-monitor 로그 staleness 체크 (크래시루프 감지)
  //    PID가 있어도 크래시 반복 시 로그가 멈출 수 있음
  const naverLog = checkNaverLogStaleness();
  if (naverLog.exists && naverLog.stale) {
    const key = 'stale:ai.ska.naver-monitor';
    if (canAlert(state, key)) {
      const minAgo = Math.floor(naverLog.ageMs / 60000);
      issues.push({ key, msg: `⚠️ [스카 헬스] naver-monitor 로그 무활동\n${minAgo}분간 로그 미기록 — 크래시루프 가능성` });
    }
  } else if (naverLog.exists && !naverLog.stale) {
    // 로그 정상화 시 state 클리어 + 알림
    if (state['stale:ai.ska.naver-monitor']) {
      console.log('[헬스체크] naver-monitor 로그 활동 재개 확인');
      const recoveryMsg = `✅ [스카 헬스] naver-monitor 회복\n로그 활동 재개 — 자동 감지`;
      await publishReservationAlert({
        from_bot: 'ska', event_type: 'health_check', alert_level: 1,
        message: recoveryMsg,
      });
      await rememberHealthEvent('stale:ai.ska.naver-monitor', 'recovery', recoveryMsg, 1);
      delete state['stale:ai.ska.naver-monitor'];
    }
  }

  // 5. today-audit 최근 실행 결과 체크
  const todayAudit = readTodayAuditStatus();
  if (todayAudit.exists && todayAudit.missingTodayRun) {
    const key = 'audit-missing:ai.ska.today-audit';
    if (canAlert(state, key)) {
      issues.push({
        key,
        level: 3,
        msg: `⚠️ [스카 헬스] today-audit 오늘 실행 누락 의심\n오늘(${getCurrentKstParts().isoDate}) 성공 이력 없음`,
      });
    }
  } else if (todayAudit.exists && todayAudit.recentSuccess && todayAudit.summary?.failedCount > 0) {
    const key = `audit-partial:ai.ska.today-audit:${todayAudit.summary.failedCount}`;
    if (canAlert(state, key)) {
      issues.push({
        key,
        level: 2,
        msg: `⚠️ [스카 헬스] today-audit 내부 실패 감지\n확인 ${todayAudit.summary.okCount} / 차단추가 ${todayAudit.summary.blockedCount} / 해제 ${todayAudit.summary.unblockedCount} / 실패 ${todayAudit.summary.failedCount}`,
      });
    }
  } else if (todayAudit.exists && todayAudit.lastExitCode != null && todayAudit.lastExitCode !== 0) {
    const key = `audit-failed:ai.ska.today-audit:${todayAudit.lastExitCode}`;
    if (canAlert(state, key)) {
      issues.push({
        key,
        level: 3,
        msg: `⚠️ [스카 헬스] today-audit 최근 실행 실패\n${todayAudit.lastCompletedLine || `exit code: ${todayAudit.lastExitCode}`}`,
      });
    }
  } else if (todayAudit.exists && todayAudit.recentSuccess) {
    const prevKeys = Object.keys(state).filter((k) =>
      k.startsWith('audit-failed:ai.ska.today-audit:')
      || k === 'audit-missing:ai.ska.today-audit'
      || k.startsWith('audit-partial:ai.ska.today-audit:'));
    if (prevKeys.length > 0) {
      console.log('[헬스체크] today-audit 최근 성공 확인');
      const recoveryMsg = `✅ [스카 헬스] today-audit 회복\n최근 실행 성공 — 자동 감지`;
      await publishReservationAlert({
        from_bot: 'ska', event_type: 'health_check', alert_level: 1,
        message: recoveryMsg,
      });
      await rememberHealthEvent('audit-failed:ai.ska.today-audit:0', 'recovery', recoveryMsg, 1);
      prevKeys.forEach((k) => delete state[k]);
    }
  }

  // 알림 발송 + 상태 기록
  for (const { key, level, msg } of issues) {
    console.warn(`[헬스체크] 이슈 감지: ${msg}`);
    const memoryHints = await buildIssueHints(key, msg);
    await publishReservationAlert({ from_bot: 'ska', event_type: 'health_check', alert_level: level, message: `${msg}${memoryHints}` });
    await rememberHealthEvent(key, 'issue', msg, level);
    hsm.recordAlert(state, key);
  }

  // 이슈 유무 관계없이 state 저장 (회복 시 클리어된 키도 반영)
  saveState(state);

  if (issues.length === 0) {
    console.log(`[헬스체크] 정상 — 핵심 ${CORE_SERVICES.length}개 + 스케줄 ${SCHEDULED_SERVICES.length}개 이상 없음`);
  }
}

try {
  main().catch((e) => {
    console.error(`[헬스체크] 예외: ${e.message}`);
    process.exit(1);
  });
} catch (e) {
  console.error(`[헬스체크] 예외: ${e.message}`);
  process.exit(1);
}
