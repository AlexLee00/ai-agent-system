/**
 * scripts/screening-monitor.js — 아르고스 스크리닝 장애 모니터
 *
 * - 스크리닝 실패 횟수 추적 (파일 기반 상태)
 * - 연속 3회 이상 실패 시 텔레그램 알림
 * - 스크리닝 성공 시 카운터 초기화
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { publishToMainBot } from '../shared/mainbot-client.js';

const STATE_FILE    = join(homedir(), '.openclaw', 'screening-monitor-state.json');
const ALERT_THRESHOLD = 3;  // 연속 실패 3회 초과 시 알림

function loadMonitorState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { domestic: 0, overseas: 0, crypto: 0, lastAlertAt: {} }; }
}

function saveMonitorState(state) {
  try {
    mkdirSync(join(homedir(), '.openclaw'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* 무시 */ }
}

/**
 * 스크리닝 성공 시 호출 — 카운터 초기화
 * @param {'domestic'|'overseas'|'crypto'} market
 */
export function recordScreeningSuccess(market) {
  const state = loadMonitorState();
  state[market] = 0;
  saveMonitorState(state);
}

/**
 * 스크리닝 실패 시 호출 — 카운터 증가, 임계 초과 시 텔레그램 알림
 * @param {'domestic'|'overseas'|'crypto'} market
 * @param {string} errorMsg
 */
export async function recordScreeningFailure(market, errorMsg) {
  const state = loadMonitorState();
  state[market] = (state[market] || 0) + 1;
  const count = state[market];

  console.warn(`  ⚠️ [스크리닝 모니터] ${market} 실패 ${count}회 누적`);

  if (count >= ALERT_THRESHOLD) {
    const now = Date.now();
    const lastAlert = state.lastAlertAt?.[market] || 0;
    // 동일 시장 알림은 2시간 내 중복 발송 방지
    if (now - lastAlert > 2 * 3600 * 1000) {
      const label = market === 'domestic' ? '국내주식' : market === 'overseas' ? '미국주식' : '암호화폐';
      const msg   = `⚠️ [스크리닝 장애] ${label} 아르고스 스크리닝 ${count}회 연속 실패\n오류: ${errorMsg?.slice(0, 100)}\n→ 보유 포지션만 처리 중`;
      console.error(msg);
      try {
        await publishToMainBot({ from_bot: 'argos', event_type: 'alert', alert_level: 2, message: msg });
      } catch { /* 알림 실패 무시 */ }
      if (!state.lastAlertAt) state.lastAlertAt = {};
      state.lastAlertAt[market] = now;
    }
  }

  saveMonitorState(state);
}
