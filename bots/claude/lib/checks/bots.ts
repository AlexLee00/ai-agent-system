// @ts-nocheck
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
const { LAUNCHD_AVAILABLE } = require('../../../../packages/core/lib/env');
const {
  isElixirOwnedService,
  isExpectedIdleService,
  isRetiredService,
} = require('../../../../packages/core/lib/service-ownership.js');

function parsePsLine(line = '') {
  const trimmed = String(line || '').trim();
  const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    etime: match[3],
    command: match[4],
  };
}

function etimeToMinutes(etime = '') {
  const value = String(etime || '').trim();
  if (!value) return 0;
  const dayParts = value.split('-');
  let days = 0;
  let timePart = value;
  if (dayParts.length === 2) {
    days = parseInt(dayParts[0], 10) || 0;
    timePart = dayParts[1];
  }
  const segments = timePart.split(':').map((part) => parseInt(part, 10) || 0);
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (segments.length === 3) {
    [hours, minutes, seconds] = segments;
  } else if (segments.length === 2) {
    [minutes, seconds] = segments;
  } else if (segments.length === 1) {
    seconds = segments[0];
  }
  return (days * 24 * 60) + (hours * 60) + minutes + (seconds / 60);
}

function getKnownLaunchdPids() {
  if (!LAUNCHD_AVAILABLE) return new Set();
  try {
    const raw = execSync('launchctl list', { encoding: 'utf8', timeout: 5000 });
    const pids = new Set();
    for (const line of raw.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    return pids;
  } catch {
    return new Set();
  }
}

function isAllowedNodeCommand(command = '') {
  const cmd = String(command || '');
  const ALLOWED_PATTERNS = [
    ' n8n start',
    'node_modules/.bin/next start',
    'scripts/telegram-callback-poller.js',
    'bots/worker/web/server.js',
    'bots/worker/scripts/',
    'bots/hub/src/hub.ts',
    'bots/claude/src/dexter.js',
    'bots/claude/src/dexter-quickcheck.js',
    'bots/claude/src/claude-commander.js',
    'bots/claude/scripts/health-dashboard-server.js',
    'bots/orchestrator/',
    'bots/investment/',
    'bots/reservation/',
    'bots/blog/',
    'scripts/reviews/',
  ];
  return ALLOWED_PATTERNS.some((pattern) => cmd.includes(pattern));
}

function classifySuspiciousNode(proc) {
  const cmd = String(proc?.command || '');
  if (cmd.includes('bots/worker/src/task-runner.legacy.js') || cmd.includes('bots/worker/src/worker-lead.legacy.js')) {
    return 'worker-legacy';
  }
  if (cmd.includes('bots/worker/src/task-runner.ts') || cmd.includes('bots/worker/src/worker-lead.ts')) {
    return 'worker-duplicate';
  }
  return 'other';
}

// launchd 서비스 상태
function launchdStatus(label) {
  if (!LAUNCHD_AVAILABLE) return null;
  try {
    const out = execSync(`launchctl list | grep "${label}"`, { encoding: 'utf8', timeout: 5000 }).trim();
    if (!out) return null;
    const parts = out.split(/\s+/);
    const pid   = parts[0];
    const status= parts[1]; // 종료 코드
    return { pid, status };
  } catch { return null; }
}

function daemonOwnedByElixir(serviceId = '') {
  return isElixirOwnedService(serviceId);
}

function checkLaunchd(items) {
  if (!LAUNCHD_AVAILABLE) {
    items.push({
      label: 'launchd 서비스 상태',
      status: 'ok',
      detail: 'DEV 환경 — launchd 서비스 미등록',
    });
    return;
  }

  const SERVICES = [
    // 클로드팀
    { id: 'ai.claude.dexter',         label: '클로드팀 덱스터 full (launchd)' },
    { id: 'ai.claude.dexter.quick',   label: '클로드팀 덱스터 quick (launchd)' },
    { id: 'ai.claude.dexter.daily',   label: '클로드팀 덱스터 일일보고 (launchd)' },
    { id: 'ai.claude.archer',         label: '클로드팀 아처 (launchd)' },
    { id: 'ai.claude.commander',      label: '클로드팀 커맨더 (launchd)' },
    // 제이팀
    { id: 'ai.orchestrator',            label: '제이팀 오케스트레이터 (launchd)' },
    // 스카팀 — 핵심
    { id: 'ai.ska.naver-monitor',       label: '스카팀 앤디 네이버모니터 (launchd)' },
    { id: 'ai.ska.kiosk-monitor',       label: '스카팀 지미 키오스크모니터 (launchd)' },
    { id: 'ai.ska.commander',           label: '스카팀 커맨더 (launchd)' },
    // 스카팀 — 데이터/예측 파이프라인 (미구현 서비스는 ok 정상)
    { id: 'ai.ska.etl',                 label: '스카팀 ETL (launchd)', optional: true },
    { id: 'ai.ska.eve',                 label: '스카팀 이브 환경수집 (launchd)', optional: true },
    { id: 'ai.ska.eve-crawl',           label: '스카팀 이브 크롤 (launchd)', optional: true },
    { id: 'ai.ska.rebecca',             label: '스카팀 레베카 일간보고 (launchd)', optional: true },
    { id: 'ai.ska.rebecca-weekly',      label: '스카팀 레베카 주간보고 (launchd)', optional: true },
    { id: 'ai.ska.forecast-daily',      label: '스카팀 포캐스트 일간 (launchd)', optional: true },
    { id: 'ai.ska.forecast-weekly',     label: '스카팀 포캐스트 주간 (launchd)', optional: true },
    { id: 'ai.ska.pickko-verify',       label: '스카팀 픽코 검증 (launchd)', optional: true },
    { id: 'ai.ska.pickko-daily-audit',  label: '스카팀 일간감사 (launchd)', optional: true },
    // 루나팀 Phase 3
    { id: 'ai.investment.crypto',       label: '루나팀 크립토 사이클 (launchd)' },
    { id: 'ai.investment.crypto.validation', label: '루나팀 크립토 검증거래 (launchd)', optional: true },
    { id: 'ai.investment.domestic',     label: '루나팀 국내주식 사이클 (launchd)' },
    { id: 'ai.investment.domestic.validation', label: '루나팀 국내주식 검증거래 (launchd)', optional: true },
    { id: 'ai.investment.overseas',     label: '루나팀 미국주식 사이클 (launchd)' },
    { id: 'ai.investment.overseas.validation', label: '루나팀 미국주식 검증거래 (launchd)', optional: true },
    { id: 'ai.investment.commander',    label: '루나팀 커맨더 (launchd)' },
    { id: 'ai.investment.argos',        label: '루나팀 아르고스 모니터 (launchd)', optional: true },
    { id: 'ai.investment.reporter',     label: '루나팀 리포터 (launchd)', optional: true },
    // 워커팀
    { id: 'ai.worker.web',             label: '워커팀 웹서버 (Elixir ownership)' },
    { id: 'ai.worker.nextjs',          label: '워커팀 Next.js (Elixir ownership)' },
  ];

  for (const svc of SERVICES) {
    if (isRetiredService(svc.id) || svc.retired) {
      items.push({
        label: svc.label,
        status: 'ok',
        detail: '퇴역 서비스 — 점검 제외',
      });
      continue;
    }
    const s = launchdStatus(svc.id);
    if (!s) {
      if (isExpectedIdleService(svc.id)) {
        items.push({
          label: svc.label,
          status: 'ok',
          detail: '미등록 정상 — expected-idle 서비스',
        });
        continue;
      }
      if (daemonOwnedByElixir(svc.id)) {
        items.push({
          label: svc.label,
          status: 'ok',
          detail: 'launchd 미등록 정상 — Elixir ownership으로 승격됨',
        });
        continue;
      }
      // optional: 아직 미구현 서비스는 info 수준 (warn 아님)
      const status = svc.optional ? 'ok' : 'warn';
      const detail = svc.optional ? '미등록 (선택적 서비스)' : 'launchd 미등록 또는 중지';
      items.push({ label: svc.label, status, detail });
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

// ppid=1 고아 Node.js 프로세스 감지 (launchd 외 비정상 고아)
function checkOrphanProcesses(items) {
  try {
    const out = execSync('ps -eo pid,ppid,etime,args | awk \'$2==1 && /node/ {print}\'',
      { encoding: 'utf8', timeout: 5000 }).trim();
    if (!out) {
      items.push({ label: '고아 Node 프로세스 (ppid=1)', status: 'ok', detail: '없음' });
      return;
    }
    const launchdPids = getKnownLaunchdPids();
    const lines = out
      .split('\n')
      .map(parsePsLine)
      .filter(Boolean);

    const suspicious = lines.filter((proc) => {
      if (launchdPids.has(proc.pid)) return false;
      if (isAllowedNodeCommand(proc.command)) return false;
      return etimeToMinutes(proc.etime) >= 10;
    });

    if (suspicious.length === 0) {
      items.push({
        label: '고아 Node 프로세스 (ppid=1)',
        status: 'ok',
        detail: `${lines.length}개 중 모두 정상 서비스/최근 프로세스로 판단`,
      });
      return;
    }

    const groups = suspicious.reduce((acc, proc) => {
      const key = classifySuspiciousNode(proc);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const otherCount = groups.other || 0;
    const workerLegacyCount = groups['worker-legacy'] || 0;
    const workerDuplicateCount = groups['worker-duplicate'] || 0;

    if (otherCount > 2) {
      items.push({
        label:  '고아 Node 프로세스 (ppid=1)',
        status: 'warn',
        detail: `${suspicious.length}개 — 미분류 비정상 프로세스 의심 (worker duplicate ${workerDuplicateCount}, legacy ${workerLegacyCount}, other ${otherCount})`,
      });
    } else if (workerLegacyCount + workerDuplicateCount > 0) {
      items.push({
        label: '워커 중복/legacy Node 프로세스',
        status: workerLegacyCount >= 4 ? 'warn' : 'ok',
        detail: `duplicate ${workerDuplicateCount}개, legacy ${workerLegacyCount}개 — launchd 외 잔존 워커 점검 권장`,
      });
    } else {
      items.push({
        label: '고아 Node 프로세스 (ppid=1)',
        status: 'ok',
        detail: `${suspicious.length}개 (관찰 범위)`,
      });
    }
  } catch {
    items.push({ label: '고아 Node 프로세스', status: 'ok', detail: '확인 스킵' });
  }
}

// Playwright/Chromium 프로세스 수 체크 (10개 초과 → warn)
function checkPlaywrightChrome(items) {
  try {
    const out = execSync('pgrep -c -f "Chromium|chromium|playwright.*chrome" 2>/dev/null || echo 0',
      { encoding: 'utf8', timeout: 5000 }).trim();
    const cnt = parseInt(out, 10) || 0;
    if (cnt > 10) {
      items.push({
        label:  'Playwright Chromium 프로세스',
        status: 'warn',
        detail: `${cnt}개 실행 중 (10개 초과 — 좀비 크롬 의심, 스카팀 확인)`,
      });
    } else if (cnt > 0) {
      items.push({ label: 'Playwright Chromium 프로세스', status: 'ok', detail: `${cnt}개` });
    } else {
      items.push({ label: 'Playwright Chromium 프로세스', status: 'ok', detail: '없음' });
    }
  } catch {
    items.push({ label: 'Playwright Chromium 프로세스', status: 'ok', detail: '확인 스킵' });
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
      const ageMin  = lastRun ? Math.floor((Date.now() - lastRun.getTime()) / 60000) : null;
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
  checkOrphanProcesses(items);
  checkPlaywrightChrome(items);
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
