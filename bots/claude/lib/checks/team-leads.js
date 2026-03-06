'use strict';

/**
 * checks/team-leads.js — 핵심 봇 프로세스 건강 점검
 *
 * 현재 점검 대상 (실제 존재하는 프로세스):
 *   1. launchd 핵심 서비스 (naver-monitor, kiosk-monitor, openclaw.gateway, investment.crypto)
 *   2. tmux 세션: ska (텔레그램 봇 — skaya)
 *
 * 점검하지 않는 것:
 *   - 아직 존재하지 않는 팀장 봇 프로세스
 *   - 아직 미구현된 OpenClaw 에이전트 세션
 *
 * TODO: 팀장 봇 구축(5주차) 후 agent_state 기반 팀장 건강 점검 추가
 * TODO: 팀장 무응답 감지 → dexter-mode.js 비상 모드 전환 연동
 */

const { execSync } = require('child_process');

// ── 핵심 launchd 서비스 ────────────────────────────────────────────
// bots.js가 전체 서비스를 점검하므로, 여기서는 가장 중요한 것만 집중 점검
const CRITICAL_SERVICES = [
  { id: 'ai.openclaw.gateway',      label: 'OpenClaw 게이트웨이',     key: 'openclaw' },
  { id: 'ai.ska.naver-monitor',     label: '앤디 (네이버모니터)',      key: 'naver_monitor' },
  { id: 'ai.ska.kiosk-monitor',     label: '지미 (키오스크모니터)',    key: 'kiosk_monitor' },
  { id: 'ai.investment.crypto',     label: '루나 크립토 사이클',       key: 'luna_crypto' },
];

// tmux 세션 점검 대상
const TMUX_SESSIONS = [
  { name: 'ska', label: '스카야 텔레그램 봇 (tmux:ska)', key: 'skaya' },
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

// ── tmux 세션 존재 여부 ────────────────────────────────────────────

function isTmuxSessionAlive(sessionName) {
  try {
    const out = execSync(
      `tmux has-session -t "${sessionName}" 2>/dev/null && echo "yes" || echo "no"`,
      { encoding: 'utf8', timeout: 3000 },
    ).trim();
    return out === 'yes';
  } catch { return false; }
}

function isTmuxInstalled() {
  try { execSync('which tmux', { timeout: 2000 }); return true; }
  catch { return false; }
}

// ── 메인 run ──────────────────────────────────────────────────────

async function run() {
  const items = [];

  // 1. launchd 핵심 서비스 점검
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

  // 2. tmux 세션 점검 (tmux 미설치 시 스킵)
  if (isTmuxInstalled()) {
    for (const sess of TMUX_SESSIONS) {
      const alive = isTmuxSessionAlive(sess.name);
      items.push({
        label:  sess.label,
        status: alive ? 'ok' : 'error',
        detail: alive ? `세션 활성 (tmux:${sess.name})` : `세션 없음 — 텔레그램 봇 재시작 필요`,
        _key:   sess.key,
      });
    }
  }

  // TODO: 팀장 봇 구축(5주차) 후 아래 코드 활성화
  // for (const lead of ['ska', 'claude-lead', 'luna']) {
  //   const state = getAgentStateRO(lead);
  //   const mins  = minutesAgo(state?.updated_at);
  //   // 10분 초과 → warn, 30분 초과 → error
  // }

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
 * 스카야(텔레그램 봇) 정상 여부 반환 (dexter-mode 연동용)
 * @returns {boolean}
 */
function isSkayaOk(teamLeadsResult) {
  const item = (teamLeadsResult?.items || []).find(i => i._key === 'skaya');
  return !item || item.status !== 'error';
}

module.exports = { run, isOpenClawOk, isSkayaOk };
