// @ts-nocheck
'use strict';

/**
 * checks/team-leads.js — 핵심 봇 프로세스 건강 점검
 *
 * 현재 점검 대상 (실제 존재하는 프로세스):
 *   1. launchd 핵심 서비스 (naver-monitor, kiosk-monitor, luna marketdata/elixir, ska.commander)
 *
 * 점검하지 않는 것:
 *   - tmux 세션 (2026-03-08 제거: 스카 텔레그램봇은 제이가 담당, ska.commander로 대체)
 *   - 아직 존재하지 않는 팀장 봇 프로세스
 */

const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const { LAUNCHD_AVAILABLE } = require('../../../../packages/core/lib/env');
const {
  isElixirOwnedService,
  isExpectedIdleService,
  isRetiredService,
} = require('../../../../packages/core/lib/service-ownership.js');
const runtimePaths = require('../runtime-paths.js');

// crashed 알람 쿨다운: 동일 서비스 1시간 이내 중복 발송 방지
const CRASH_COOLDOWN_MS = 60 * 60 * 1000;
const STATE_FILE = runtimePaths.workspacePath('team-leads-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; }
}
function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* ignore */ }
}
function canAlert(state, key) {
  const last = state[key];
  return !last || Date.now() - new Date(last).getTime() > CRASH_COOLDOWN_MS;
}

// ── 핵심 launchd 서비스 ────────────────────────────────────────────
// bots.js가 전체 서비스를 점검하므로, 여기서는 가장 중요한 것만 집중 점검
const CRITICAL_SERVICES = [
  { id: 'ai.ska.naver-monitor',     label: '앤디 (네이버모니터)',      key: 'naver_monitor' },
  { id: 'ai.ska.kiosk-monitor',     label: '지미 (키오스크모니터)',    key: 'kiosk_monitor' },
  { id: 'ai.luna.marketdata-mcp',   label: '루나 마켓데이터 MCP',      key: 'luna_marketdata_mcp' },
  { id: 'ai.elixir.supervisor',     label: '루나 엘릭서 슈퍼바이저',    key: 'luna_elixir_supervisor' },
  { id: 'ai.ska.commander',         label: '스카 커맨더 (launchd)',    key: 'skaya' },
];

// ── launchd 상태 조회 ──────────────────────────────────────────────

function getLaunchdStatus(serviceId) {
  if (!LAUNCHD_AVAILABLE) return null;
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
  const state = loadState();
  let stateChanged = false;

  if (!LAUNCHD_AVAILABLE) {
    items.push({
      label: '핵심 launchd 서비스',
      status: 'ok',
      detail: 'DEV 환경 — launchd 서비스 미등록',
    });
    return { name: '핵심 봇 프로세스 건강', status: 'ok', items };
  }

  // launchd 핵심 서비스 점검
  for (const svc of CRITICAL_SERVICES) {
    if (isRetiredService(svc.id)) {
      items.push({
        label: svc.label,
        status: 'ok',
        detail: '퇴역 서비스 — 점검 제외',
        _key: svc.key,
      });
      continue;
    }

    const info = getLaunchdStatus(svc.id);
    const crashKey = `crash:${svc.key}`;

    if (info === null) {
      if (isElixirOwnedService(svc.id)) {
        items.push({
          label: svc.label,
          status: 'ok',
          detail: isExpectedIdleService(svc.id)
            ? 'Elixir ownership — 주기 실행형 정상 대기'
            : 'Elixir ownership — launchd 미등록 정상',
          _key: svc.key,
        });
        continue;
      }
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
      // 쿨다운: 1시간 이내 동일 서비스 중복 알람 방지
      const suppress = !canAlert(state, crashKey);
      if (!suppress) {
        state[crashKey] = new Date().toISOString();
        stateChanged = true;
      }
      items.push({
        label:    svc.label,
        status:   'error',
        detail:   `비정상 종료 (exitCode: ${info.exitCode})`,
        _key:     svc.key,
        _suppress: suppress,
      });
    } else {
      // 회복 시 쿨다운 키 초기화
      if (state[crashKey]) {
        delete state[crashKey];
        stateChanged = true;
      }
      items.push({
        label:  svc.label,
        status: 'ok',
        detail: info.pid === '-' ? `대기 중 (exitCode: ${info.exitCode})` : `실행 중 (PID: ${info.pid})`,
        _key:   svc.key,
      });
    }
  }

  if (stateChanged) saveState(state);

  // suppress된 항목은 알람 레벨 산정에서 제외 (쿨다운 중복 방지)
  const hasError = items.some(i => i.status === 'error' && !i._suppress);
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '핵심 봇 프로세스 건강',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

/**
 * 스카 커맨더 정상 여부 반환 (dexter-mode 연동용)
 * @returns {boolean}
 */
function isSkayaOk(teamLeadsResult) {
  const item = (teamLeadsResult?.items || []).find(i => i._key === 'skaya');
  return !item || item.status !== 'error';
}

module.exports = { run, isSkayaOk };
