'use strict';

/**
 * checks/team-leads.js — 핵심 봇 프로세스 건강 점검
 *
 * 현재 점검 대상 (실제 존재하는 프로세스):
 *   1. launchd 핵심 서비스 (naver-monitor, kiosk-monitor, openclaw.gateway, investment.crypto, ska.commander)
 *
 * 점검하지 않는 것:
 *   - tmux 세션 (2026-03-08 제거: 스카 텔레그램봇은 제이가 담당, ska.commander로 대체)
 *   - 아직 존재하지 않는 팀장 봇 프로세스
 */

const { execSync } = require('child_process');

// ── 핵심 launchd 서비스 ────────────────────────────────────────────
// bots.js가 전체 서비스를 점검하므로, 여기서는 가장 중요한 것만 집중 점검
const CRITICAL_SERVICES = [
  { id: 'ai.openclaw.gateway',      label: 'OpenClaw 게이트웨이',     key: 'openclaw' },
  { id: 'ai.ska.naver-monitor',     label: '앤디 (네이버모니터)',      key: 'naver_monitor' },
  { id: 'ai.ska.kiosk-monitor',     label: '지미 (키오스크모니터)',    key: 'kiosk_monitor' },
  { id: 'ai.investment.crypto',     label: '루나 크립토 사이클',       key: 'luna_crypto' },
  { id: 'ai.ska.commander',         label: '스카 커맨더 (launchd)',    key: 'skaya' },
];

// ── launchd 상태 조회 ──────────────────────────────────────────────

function getLaunchdStatus(serviceId) {
  try {
    const out = execSync(
      `launchctl list | awk '$3 == "${serviceId}" {print $1, $2}'`,
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
    if (!out) return null; // 미등록
    const [pid, exitCode] = out.split(' ');
    return { pid, exitCode: parseInt(exitCode, 10) };
  } catch { return null; }
}

// ── 메인 run ──────────────────────────────────────────────────────

async function run() {
  const items = [];

  // launchd 핵심 서비스 점검
  for (const svc of CRITICAL_SERVICES) {
    const info = getLaunchdStatus(svc.id);

    if (info === null) {
      items.push({
        label:  svc.label,
        status: 'warn',
        detail: '미등록 — launchd plist 확인 필요',
        _key:   svc.key,
      });
      continue;
    }

    const crashed = info.pid === '-' && info.exitCode !== 0;
    if (crashed) {
      items.push({
        label:  svc.label,
        status: 'error',
        detail: `비정상 종료 (exitCode: ${info.exitCode})`,
        _key:   svc.key,
      });
    } else {
      items.push({
        label:  svc.label,
        status: 'ok',
        detail: `실행 중 (PID: ${info.pid})`,
        _key:   svc.key,
      });
    }
  }

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '핵심 봇 프로세스 건강',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

/**
 * OpenClaw 게이트웨이 정상 여부 반환 (dexter-mode 연동용)
 * @returns {boolean}
 */
function isOpenClawOk(teamLeadsResult) {
  const item = (teamLeadsResult?.items || []).find(i => i._key === 'openclaw');
  return !item || item.status !== 'error';
}

/**
 * 스카 커맨더 정상 여부 반환 (dexter-mode 연동용)
 * @returns {boolean}
 */
function isSkayaOk(teamLeadsResult) {
  const item = (teamLeadsResult?.items || []).find(i => i._key === 'skaya');
  return !item || item.status !== 'error';
}

module.exports = { run, isOpenClawOk, isSkayaOk };
