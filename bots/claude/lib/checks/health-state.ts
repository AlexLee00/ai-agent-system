// @ts-nocheck
'use strict';

/**
 * checks/health-state.js — 전 팀 헬스 상태 파일 감시 + 자동 복구 (덱스터 전용)
 *
 * 역할:
 *   1. health-check-state.json의 exitcode:*:1 키 감지 (모든 팀)
 *   2. launchctl로 현재 서비스 상태 재확인
 *   3. exit 0 회복 서비스 → state 키 자동 삭제 (쿨다운 즉시 해소)
 *   4. 여전히 exit 1 → launchctl kickstart 강제 재실행
 *   5. 개발/점검 서비스(DEV_SERVICES) → [점검] 태그 부착
 *
 * 공통 모듈: packages/core/lib/health-state-manager.js
 * 실행 주기: 덱스터 5분 퀵체크 (ai.claude.dexter.quick)
 */

const { execSync } = require('child_process');
const hsm = require('../../../../packages/core/lib/health-state-manager');
const { LAUNCHD_AVAILABLE } = require('../../../../packages/core/lib/env');

// ─── launchctl 조회 ───────────────────────────────────────────────

function getLaunchctlInfo(label) {
  if (!LAUNCHD_AVAILABLE) return { found: false };
  try {
    const raw = execSync('launchctl list', { encoding: 'utf-8', timeout: 5000 });
    for (const line of raw.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const [pid, exitCode, svcLabel] = parts;
      if (svcLabel === label) {
        return {
          found:    true,
          running:  pid !== '-',
          pid:      pid !== '-' ? parseInt(pid) : null,
          exitCode: parseInt(exitCode) || 0,
        };
      }
    }
    return { found: false };
  } catch {
    return { found: false };
  }
}

// ─── kickstart ───────────────────────────────────────────────────

function kickstart(label) {
  if (!LAUNCHD_AVAILABLE) return false;
  try {
    const uid = process.getuid();
    execSync(`launchctl kickstart -k gui/${uid}/${label}`, { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

// ─── 메인 run ────────────────────────────────────────────────────

async function run() {
  const items = [];
  const state = hsm.loadState();

  if (!LAUNCHD_AVAILABLE) {
    items.push({ label: '헬스 상태 파일', status: 'ok', detail: 'DEV 환경 — launchd 서비스 미등록' });
    return { name: '전 팀 헬스 상태 복구', status: 'ok', items };
  }

  if (!state || Object.keys(state).length === 0) {
    items.push({ label: '헬스 상태 파일', status: 'ok', detail: '비정상 종료 잔존 없음' });
    return { name: '전 팀 헬스 상태 복구', status: 'ok', items };
  }

  // exitcode:*:1 형식 키만 추출
  const exitOneKeys = Object.keys(state).filter(k => /^exitcode:.+:1$/.test(k));

  if (exitOneKeys.length === 0) {
    items.push({ label: '헬스 상태 파일', status: 'ok', detail: '비정상 종료 잔존 없음' });
    return { name: '전 팀 헬스 상태 복구', status: 'ok', items };
  }

  let stateChanged = false;

  for (const key of exitOneKeys) {
    const label       = hsm.parseLabelFromKey(key);
    const short       = hsm.shortLabel(label);
    const tag         = hsm.getAlertTag(label);
    const team        = hsm.getTeam(label) || '?';
    const lastAlertAt = state[key];
    const displayName = `${tag}[${team}] ${short}`;

    const svc = getLaunchctlInfo(label);

    // 1. launchd에 없음 (미로드) → state 키 삭제
    if (!svc.found) {
      hsm.clearAlert(state, key);
      stateChanged = true;
      items.push({
        label:  displayName,
        status: 'warn',
        detail: `launchd 미로드 → 헬스 상태 키 삭제 (마지막 알림: ${lastAlertAt})`,
      });
      continue;
    }

    // 2. 현재 실행 중이거나 exit 0 → 회복, state 키 삭제
    if (svc.running || svc.exitCode === 0) {
      hsm.clearAlert(state, key);
      stateChanged = true;
      const detail = svc.running
        ? `현재 실행 중 (PID: ${svc.pid}) → 헬스 상태 키 자동 삭제`
        : `exit code 0 회복 → 헬스 상태 키 자동 삭제`;
      items.push({ label: displayName, status: 'ok', detail });
      continue;
    }

    // 3. 여전히 exit 1 → kickstart 시도
    const kicked = kickstart(label);
    if (kicked) {
      items.push({
        label:  displayName,
        status: 'warn',
        detail: `exit 1 지속 → kickstart 실행 완료 (마지막 알림: ${lastAlertAt})`,
      });
    } else {
      items.push({
        label:  displayName,
        status: 'error',
        detail: `exit 1 지속 → kickstart 실패 (수동 확인 필요, 마지막 알림: ${lastAlertAt})`,
      });
    }
  }

  if (stateChanged) {
    hsm.saveState(state);
  }

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');
  return {
    name:   '전 팀 헬스 상태 복구',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
