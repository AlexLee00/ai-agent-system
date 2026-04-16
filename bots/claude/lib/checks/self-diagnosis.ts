// @ts-nocheck
'use strict';

/**
 * checks/self-diagnosis.js — 덱스터 자기진단
 *
 * 확인 항목:
 *   1. 마지막 실행 시각 (dexter-state.json)
 *   2. 체크 항목 수 급감 감지 (이전 대비 20% 이상 감소 → warn)
 *   3. 실행 소요시간 이상치 감지 (3분 초과 → warn)
 *   4. 텔레그램 전송 성공 기록
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const STATE_FILE = path.join(os.homedir(), '.openclaw', 'workspace', 'dexter-state.json');

// 상태 파일 로드
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// 상태 파일 저장
function saveState(data) {
  try {
    const existing = loadState();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...existing, ...data }, null, 2));
  } catch { /* 저장 실패는 무시 */ }
}

// ── 체크 1: 마지막 실행 시각 ──────────────────────────────────────
function checkLastRun(items, state) {
  const lastRun = state.lastRunAt;
  if (!lastRun) {
    items.push({ label: '덱스터 마지막 실행', status: 'ok', detail: '최초 실행' });
    return;
  }

  const elapsedMs  = Date.now() - new Date(lastRun).getTime();
  const elapsedMin = Math.floor(elapsedMs / 60000);

  // 2시간(120분) 이상 미실행이면 warn (launchd 1시간 주기 기준)
  if (elapsedMin > 120) {
    items.push({
      label:  '덱스터 마지막 실행',
      status: 'warn',
      detail: `${elapsedMin}분 전 — launchd 주기(1h) 초과 (launchd 확인 필요)`,
    });
  } else {
    items.push({
      label:  '덱스터 마지막 실행',
      status: 'ok',
      detail: `${elapsedMin}분 전 (${lastRun})`,
    });
  }
}

// ── 체크 2: 체크 항목 수 급감 감지 ──────────────────────────────
function checkItemCountDrop(items, state, currentCount) {
  const prevCount = state.lastItemCount ?? 0;
  if (!prevCount) {
    items.push({ label: '체크 항목 수', status: 'ok', detail: `${currentCount}개 (최초 기록)` });
    return;
  }

  const dropRatio = prevCount > 0 ? (prevCount - currentCount) / prevCount : 0;
  if (dropRatio > 0.2) {
    items.push({
      label:  '체크 항목 수 급감',
      status: 'warn',
      detail: `${prevCount}개 → ${currentCount}개 (${Math.round(dropRatio * 100)}% 감소 — 모듈 오류 의심)`,
    });
  } else {
    items.push({
      label:  '체크 항목 수',
      status: 'ok',
      detail: `${currentCount}개 (이전: ${prevCount}개)`,
    });
  }
}

// ── 체크 3: 실행 소요시간 ───────────────────────────────────────
function checkElapsed(items, state) {
  const lastElapsedMs = state.lastElapsedMs ?? 0;
  if (!lastElapsedMs) {
    items.push({ label: '체크 소요시간', status: 'ok', detail: '기록 없음' });
    return;
  }

  const sec = Math.round(lastElapsedMs / 1000);
  if (lastElapsedMs > 3 * 60 * 1000) {
    items.push({
      label:  '체크 소요시간',
      status: 'warn',
      detail: `${sec}초 — 3분 초과 (네트워크/DB 지연 의심)`,
    });
  } else {
    items.push({
      label:  '체크 소요시간',
      status: 'ok',
      detail: `${sec}초`,
    });
  }
}

// ── 체크 4: 텔레그램 전송 성공 기록 ─────────────────────────────
function checkTelegramHistory(items, state) {
  const lastTg = state.lastTelegramAt;
  const lastTgOk = state.lastTelegramOk;

  if (!lastTg) {
    items.push({ label: '텔레그램 전송 이력', status: 'ok', detail: '없음 (이상 없음 상태 지속)' });
    return;
  }

  const elapsedH = Math.floor((Date.now() - new Date(lastTg).getTime()) / 3600000);
  const statusTxt = lastTgOk ? '성공' : '실패';
  items.push({
    label:  '텔레그램 마지막 전송',
    status: lastTgOk ? 'ok' : 'warn',
    detail: `${elapsedH}시간 전 (${statusTxt}) — ${lastTg}`,
  });
}

// ─── 공개 API: 상태 기록 (dexter.js에서 실행 완료 후 호출) ────────
function recordRun({ itemCount, elapsedMs, telegramSent, telegramOk }) {
  const now = new Date().toISOString();
  const update = {
    lastRunAt:       now,
    lastItemCount:   itemCount,
    lastElapsedMs:   elapsedMs,
  };
  if (telegramSent) {
    update.lastTelegramAt = now;
    update.lastTelegramOk = !!telegramOk;
  }
  saveState(update);
}

// ─── 메인 run ────────────────────────────────────────────────────
async function run(currentItemCount) {
  const items = [];
  const state = loadState();

  checkLastRun(items, state);
  checkItemCountDrop(items, state, currentItemCount ?? 0);
  checkElapsed(items, state);
  checkTelegramHistory(items, state);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '덱스터 자기진단',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run, recordRun };
