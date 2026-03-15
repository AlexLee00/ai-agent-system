'use strict';

/**
 * scripts/health-check.js — launchd 서비스 헬스체크
 *
 * 감지 대상:
 *   - naver-monitor (KeepAlive): PID 없으면 다운으로 판단
 *   - naver-monitor 로그 staleness: 15분 이상 무활동 → 크래시루프 감지
 *   - 전체 서비스: launchctl list에서 사라지면 미로드 경고
 *   - 스케줄 서비스: LastExitStatus 비정상(≠0) 감지
 *
 * 중복 알림 방지: ~/.openclaw/workspace/health-check-state.json
 *   - 같은 서비스 경고는 30분 내 재발송 안 함
 *
 * 실행: node scripts/health-check.js
 * 자동: launchd ai.ska.health-check (10분마다)
 */

const fs = require('fs');
const { publishToMainBot } = require('../lib/mainbot-client');
const hsm = require('../../../packages/core/lib/health-state-manager');
const { getLaunchctlStatus, DEFAULT_NORMAL_EXIT_CODES } = require('../../../packages/core/lib/health-provider');

// 상시 실행 서비스 (PID 있어야 정상)
const CONTINUOUS = ['ai.ska.commander', 'ai.ska.naver-monitor'];

// 핵심 서비스: 미로드/다운 자체가 바로 운영 경고
const CORE_SERVICES = [
  'ai.ska.commander',
  'ai.ska.naver-monitor',
  'ai.ska.kiosk-monitor',
  'ai.ska.health-check',
];

// 스케줄 작업: 비정상 종료는 보되, 미로드 자체는 경고로 보지 않음
const SCHEDULED_SERVICES = [
  'ai.ska.pickko-verify',
  'ai.ska.pickko-daily-audit',
  'ai.ska.pickko-daily-summary',
  'ai.ska.log-report',
  'ai.ska.db-backup',
  'ai.ska.log-rotate',
];

const ALL_SERVICES = [...CORE_SERVICES, ...SCHEDULED_SERVICES];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;

// naver-monitor 로그 staleness 체크
const NAVER_LOG = '/tmp/naver-ops-mode.log';
const LOG_STALE_MS = 15 * 60 * 1000; // 15분 무활동 → 크래시루프 의심

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

// ─── 메인 ───────────────────────────────────────────────────────

function main() {
  console.log(`[헬스체크] 시작 — ${new Date().toISOString()}`);

  let status;
  try {
    status = getLaunchctlStatus();
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
      publishToMainBot({
        from_bot: 'ska', event_type: 'health_check', alert_level: 1,
        message: `✅ [스카 헬스] ${shortName} 회복\nlaunchd 정상 로드 — 자동 감지`,
      });
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
          publishToMainBot({
            from_bot: 'ska', event_type: 'health_check', alert_level: 1,
            message: `✅ [스카 헬스] ${shortName} 회복\nPID 정상 확인 — 자동 감지`,
          });
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
        publishToMainBot({
          from_bot: 'ska', event_type: 'health_check', alert_level: 1,
          message: `✅ [스카 헬스] ${shortName} 회복\nexit code 정상 (0) — 자동 감지`,
        });
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
      publishToMainBot({
        from_bot: 'ska', event_type: 'health_check', alert_level: 1,
        message: `✅ [스카 헬스] naver-monitor 회복\n로그 활동 재개 — 자동 감지`,
      });
      delete state['stale:ai.ska.naver-monitor'];
    }
  }

  // 알림 발송 + 상태 기록
  for (const { key, level, msg } of issues) {
    console.warn(`[헬스체크] 이슈 감지: ${msg}`);
    publishToMainBot({ from_bot: 'ska', event_type: 'health_check', alert_level: level, message: msg });
    hsm.recordAlert(state, key);
  }

  // 이슈 유무 관계없이 state 저장 (회복 시 클리어된 키도 반영)
  saveState(state);

  if (issues.length === 0) {
    console.log(`[헬스체크] 정상 — 핵심 ${CORE_SERVICES.length}개 + 스케줄 ${SCHEDULED_SERVICES.length}개 이상 없음`);
  }
}

try {
  main();
} catch (e) {
  console.error(`[헬스체크] 예외: ${e.message}`);
  process.exit(1);
}
