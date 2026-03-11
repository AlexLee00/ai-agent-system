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

const { execSync } = require('child_process');
const sender = require('../../../packages/core/lib/telegram-sender');
const hsm    = require('../../../packages/core/lib/health-state-manager');

// 상시 실행 서비스 (PID 있어야 정상)
const CONTINUOUS = ['ai.worker.web', 'ai.worker.nextjs'];

// 감지할 전체 서비스
const ALL_SERVICES = ['ai.worker.web', 'ai.worker.nextjs'];

// 정상 종료 코드
const NORMAL_EXIT_CODES = new Set([0, -9, -15]);

// ─── 알림 발송 (general 토픽) ────────────────────────────────────

async function notify(msg, level = 3) {
  try {
    if (level >= 3) {
      await sender.sendCritical('general', msg);
    } else {
      await sender.send('general', msg);
    }
  } catch { /* 무시 */ }
}

// ─── launchctl 파싱 ──────────────────────────────────────────────

function getLaunchctlStatus() {
  const raw = execSync('launchctl list', { encoding: 'utf-8' });
  const services = {};
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, exitCode, label] = parts;
    services[label] = {
      running: pid !== '-',
      pid: pid !== '-' ? parseInt(pid) : null,
      exitCode: parseInt(exitCode) || 0,
    };
  }
  return services;
}

// ─── 메인 ───────────────────────────────────────────────────────

async function main() {
  console.log(`[워커 헬스체크] 시작 — ${new Date().toISOString()}`);

  let status;
  try {
    status = getLaunchctlStatus();
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
      await notify(`✅ [워커 헬스] ${shortName} 회복\nlaunchd 정상 로드 — 자동 감지`, 1);
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
        await notify(`✅ [워커 헬스] ${shortName} 회복\nPID 정상 확인 — 자동 감지`, 1);
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
        await notify(`✅ [워커 헬스] ${shortName} 회복\nexit code 정상 (0) — 자동 감지`, 1);
        prevKeys.forEach(k => hsm.clearAlert(state, k));
      }
    }
  }

  // 알림 발송 + 상태 기록
  for (const { key, msg, level } of issues) {
    console.warn(`[워커 헬스체크] 이슈: ${msg}`);
    await notify(msg, level);
    hsm.recordAlert(state, key);
  }

  hsm.saveState(state);

  if (issues.length === 0) {
    console.log(`[워커 헬스체크] 정상 — 전체 ${ALL_SERVICES.length}개 서비스 이상 없음`);
  }
}

main().catch(e => {
  console.error(`[워커 헬스체크] 예외: ${e.message}`);
  process.exit(1);
});
