// @ts-nocheck
'use strict';

/**
 * scripts/health-check.js — 클로드팀 launchd 서비스 헬스체크
 *
 * 감지 대상:
 *   - 상시 실행: commander (PID 없으면 다운)
 *   - 스케줄: dexter, dexter.quick, dexter.daily, archer, health-dashboard
 *
 * 클로드팀 서비스 exit 1 → [점검] 태그 자동 부착
 * 공통 상태: packages/core/lib/health-state-manager.js
 * 실행: node scripts/health-check.js
 * 자동: launchd ai.claude.health-check (10분마다)
 */

const fs = require('fs');
const path = require('path');
const { publishAlert } = require('../lib/mainbot-client');
const hsm = require('../../../packages/core/lib/health-state-manager');
const {
  getLaunchctlStatus,
  DEFAULT_NORMAL_EXIT_CODES,
} = require('../../../packages/core/lib/health-provider');

const CONTINUOUS = ['ai.claude.commander'];
const ALL_SERVICES = [
  'ai.claude.commander',
  'ai.claude.dexter.quick',
  'ai.claude.dexter',
  'ai.claude.dexter.daily',
  'ai.claude.archer',
  'ai.claude.health-dashboard',
];

const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const CLAUDE_ROOT = path.join(__dirname, '..');

function hasRecentDexterReport() {
  try {
    const logPath = path.join(CLAUDE_ROOT, 'dexter.log');
    const stat = fs.statSync(logPath);
    if (Date.now() - stat.mtimeMs > 90 * 60 * 1000) return false;

    const tail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-80).join('\n');
    return (
      tail.includes('📋 요약:') ||
      tail.includes('🎉 모든 체크 통과') ||
      tail.includes('이상 없음 — 텔레그램 발송 생략')
    );
  } catch {
    return false;
  }
}

function isExpectedExit(label, exitCode) {
  if (label === 'ai.claude.dexter' && exitCode === 1) {
    return hasRecentDexterReport();
  }
  return false;
}

async function main() {
  console.log(`[클로드 헬스체크] 시작 — ${new Date().toISOString()}`);

  let status;
  try {
    status = getLaunchctlStatus(ALL_SERVICES);
  } catch (e) {
    console.error(`[클로드 헬스체크] launchctl 실행 실패: ${e.message}`);
    process.exit(1);
  }

  const state = hsm.loadState();
  const issues = [];
  const recovers = [];

  for (const label of ALL_SERVICES) {
    const svc = status[label];
    const shortName = hsm.shortLabel(label);
    const tag = hsm.getAlertTag(label);

    if (!svc) {
      const key = `unloaded:${label}`;
      if (hsm.canAlert(state, key)) {
        issues.push({
          key,
          level: hsm.getAlertLevel(label),
          msg: `🔴 ${tag}[클로드 헬스] ${shortName} 미로드\nlaunchd에 등록되지 않음 → 수동 확인 필요`,
        });
      }
      continue;
    }

    if (state[`unloaded:${label}`]) {
      recovers.push({
        from_bot: 'claude',
        event_type: 'health_check',
        alert_level: 1,
        message: `✅ ${tag}[클로드 헬스] ${shortName} 회복\nlaunchd 정상 로드 — 자동 감지`,
      });
      hsm.clearAlert(state, `unloaded:${label}`);
    }

    if (CONTINUOUS.includes(label)) {
      if (!svc.running) {
        const key = `down:${label}`;
        if (hsm.canAlert(state, key)) {
          issues.push({
            key,
            level: hsm.getAlertLevel(label),
            msg: `🔴 ${tag}[클로드 헬스] ${shortName} 다운\nPID 없음 — launchd 재시작 실패 가능성`,
          });
        }
      } else if (state[`down:${label}`]) {
        recovers.push({
          from_bot: 'claude',
          event_type: 'health_check',
          alert_level: 1,
          message: `✅ ${tag}[클로드 헬스] ${shortName} 회복\nPID 정상 확인 — 자동 감지`,
        });
        hsm.clearAlert(state, `down:${label}`);
      }
    }

    if (
      !NORMAL_EXIT_CODES.has(svc.exitCode) &&
      !isExpectedExit(label, svc.exitCode) &&
      !(CONTINUOUS.includes(label) && svc.running)
    ) {
      const key = `exitcode:${label}:${svc.exitCode}`;
      if (hsm.canAlert(state, key)) {
        issues.push({
          key,
          level: hsm.getAlertLevel(label),
          msg: `⚠️ ${tag}[클로드 헬스] ${shortName} 비정상 종료\nexit code: ${svc.exitCode}`,
        });
      }
    } else {
      const prevKeys = Object.keys(state).filter((key) => key.startsWith(`exitcode:${label}:`));
      if (prevKeys.length > 0) {
        recovers.push({
          from_bot: 'claude',
          event_type: 'health_check',
          alert_level: 1,
          message: `✅ ${tag}[클로드 헬스] ${shortName} 회복\nexit code 정상 (0) — 자동 감지`,
        });
        prevKeys.forEach((key) => hsm.clearAlert(state, key));
      }
    }
  }

  for (const { key, level, msg } of issues) {
    console.warn(`[클로드 헬스체크] 이슈: ${msg}`);
    await publishAlert({
      from_bot: 'claude',
      event_type: 'health_check',
      alert_level: level,
      message: msg,
    });
    hsm.recordAlert(state, key);
  }

  for (const opts of recovers) {
    await publishAlert(opts);
  }

  hsm.saveState(state);

  if (issues.length === 0) {
    console.log(`[클로드 헬스체크] 정상 — 전체 ${ALL_SERVICES.length}개 서비스 이상 없음`);
  }
}

main().catch((e) => {
  console.error(`[클로드 헬스체크] 예외: ${e.message}`);
  process.exit(1);
});
