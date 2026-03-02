'use strict';

/**
 * checks/bots.js — 봇 가동 상태 체크
 * - launchd 서비스 상태
 * - lock 파일 PID 유효성
 * - 좀비 프로세스 감지
 * - 봇 기능 자가 진단 (health 파일 기반)
 */

const fs   = require('fs');
const { execSync } = require('child_process');
const cfg  = require('../config');

// launchd 서비스 상태
function launchdStatus(label) {
  try {
    const out = execSync(`launchctl list | grep "${label}"`, { encoding: 'utf8', timeout: 5000 }).trim();
    if (!out) return null;
    const parts = out.split(/\s+/);
    const pid   = parts[0];
    const status= parts[1]; // 종료 코드
    return { pid, status };
  } catch { return null; }
}

function checkLaunchd(items) {
  const SERVICES = [
    { id: 'ai.openclaw.gateway',  label: 'OpenClaw 게이트웨이' },
    { id: 'ai.invest.dev',        label: '루나팀 신호집계-DEV (launchd)' },
    { id: 'ai.invest.tpsl',       label: '루나팀 TP/SL 모니터 (launchd)' },
    { id: 'ai.invest.fund',       label: '루나팀 펀드매니저 (launchd)' },
    { id: 'ai.invest.report',     label: '루나팀 성과리포트 (launchd)' },
    { id: 'ai.invest.bridge',     label: '루나팀 브릿지 (launchd)' },
    { id: 'ai.investment.crypto',   label: '루나팀 Phase 3-A 암호화폐 사이클 (launchd)' },
    { id: 'ai.investment.domestic', label: '루나팀 Phase 3-B 국내주식 사이클 (launchd)' },
    { id: 'ai.investment.overseas', label: '루나팀 Phase 3-B 미국주식 사이클 (launchd)' },
    { id: 'ai.ska.tmux',            label: '스카팀 tmux 세션 (launchd)' },
    { id: 'ai.claude.speed-test',   label: 'LLM 속도 테스트 (launchd)' },
  ];

  for (const svc of SERVICES) {
    const s = launchdStatus(svc.id);
    if (!s) {
      items.push({ label: svc.label, status: 'warn', detail: 'launchd 미등록 또는 중지' });
    } else if (s.pid === '-') {
      // 등록됐지만 실행 중 아님 (주기 실행 봇은 정상)
      items.push({ label: svc.label, status: 'ok', detail: `등록됨 (대기, 종료코드: ${s.status})` });
    } else {
      items.push({ label: svc.label, status: 'ok', detail: `실행 중 (PID: ${s.pid})` });
    }
  }
}

// lock 파일 PID 유효성
function checkLocks(items) {
  for (const [name, lockPath] of Object.entries(cfg.LOCKS)) {
    if (name === 'dexter') continue;
    if (!fs.existsSync(lockPath)) {
      items.push({ label: `${name} lock`, status: 'ok', detail: '없음 (정상 대기)' });
      continue;
    }

    const pid = fs.readFileSync(lockPath, 'utf8').trim();
    try {
      process.kill(Number(pid), 0); // 프로세스 존재 여부
      items.push({ label: `${name} lock`, status: 'ok', detail: `실행 중 (PID: ${pid})` });
    } catch {
      items.push({ label: `${name} lock`, status: 'warn', detail: `stale lock (PID: ${pid} 종료됨)` });
    }
  }
}

// 좀비 invest 프로세스
function checkZombies(items) {
  try {
    const out = execSync('pgrep -f "node.*(signal-aggregator|binance-executor|upbit-bridge)" 2>/dev/null || true',
      { encoding: 'utf8', timeout: 5000 }).trim();
    const pids = out ? out.split('\n').filter(Boolean) : [];
    if (pids.length > 2) {
      items.push({ label: '좀비 프로세스', status: 'warn', detail: `의심 프로세스 ${pids.length}개 (PID: ${pids.join(', ')})` });
    } else {
      items.push({ label: '좀비 프로세스', status: 'ok', detail: '없음' });
    }
  } catch {
    items.push({ label: '좀비 프로세스', status: 'ok', detail: '확인 스킵' });
  }
}

// 투자봇 상태 파일 체크 (DEV/OPS 분리)
function checkInvestStatus(items) {
  const modes = [
    { path: '/tmp/invest-status-dev.json', label: '루나팀 상태 (DEV)', mode: 'DEV' },
    { path: '/tmp/invest-status.json',     label: '루나팀 상태 (OPS)', mode: 'OPS' },
  ];

  let anyFound = false;
  for (const { path: statusPath, label, mode } of modes) {
    if (!fs.existsSync(statusPath)) continue;
    anyFound = true;

    try {
      const s = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      const lastRun = s.lastRun ? new Date(s.lastRun) : null;
      const ageMin  = lastRun ? Math.floor((Date.now() - lastRun) / 60000) : null;
      const ageStr  = ageMin !== null ? `${ageMin}분 전` : 'N/A';

      if (s.status === 'error') {
        items.push({ label, status: 'error', detail: `오류: ${s.error || '알 수 없음'} (${ageStr})` });
      } else {
        items.push({ label, status: 'ok', detail: `${s.status} (${ageStr})` });
      }

      if ((s.consecutiveErrors || 0) > 2) {
        items.push({ label: `${label} 연속 오류`, status: 'warn', detail: `${s.consecutiveErrors}회 연속 오류` });
      }
    } catch (e) {
      items.push({ label, status: 'warn', detail: `파싱 실패: ${e.message}` });
    }
  }

  if (!anyFound) {
    items.push({ label: '루나팀 상태', status: 'ok', detail: '미실행 (정상 대기)' });
  }
}

async function run() {
  const items = [];

  checkLaunchd(items);
  checkLocks(items);
  checkZombies(items);
  checkInvestStatus(items);

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   '봇 가동 상태',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
