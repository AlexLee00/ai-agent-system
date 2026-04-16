// @ts-nocheck
'use strict';

/**
 * checks/openclaw.js — OpenClaw 게이트웨이 상태 점검
 *
 * 점검 항목:
 *   1. launchd 서비스 (ai.openclaw.gateway) 생존
 *   2. 포트 18789 바인딩 상태
 *      - 127.0.0.1만 바인딩 → 정상
 *      - 0.0.0.0 바인딩 → CRITICAL (보안 위험)
 *      - 미바인딩 → error
 *   3. 프로세스 메모리 사용량
 *      - > MEM_WARN_MB(800MB)  → warn (모니터링)
 *      - > MEM_CRIT_MB(1500MB) → _autoRestart (--fix 자동 재시작)
 *   4. 메모리 누수 추세 (6시간 윈도우, 300MB 이상 증가 → 자동 재시작)
 *   5. 프로세스 장기 운영 (7일+ → 주기적 재시작 트리거)
 *
 * 자동 재시작 조건 (--fix 모드에서 autofix.js가 처리):
 *   - MEM_CRIT_MB 초과
 *   - 6시간 내 LEAK_THRESHOLD_MB(300MB) 이상 증가 추세
 *   - UPTIME_RESTART_DAYS(7일) 이상 장기 운영
 *
 * 참고: network.js의 OpenClaw 포트 체크와 중복 없이
 *       여기서는 보안 바인딩·메모리·launchd 상태에 집중
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { LAUNCHD_AVAILABLE, OPENCLAW_PORT: ENV_OPENCLAW_PORT } = require('../../../../packages/core/lib/env');

const OPENCLAW_SERVICE = 'ai.openclaw.gateway';
const OPENCLAW_PORT    = ENV_OPENCLAW_PORT > 0 ? ENV_OPENCLAW_PORT : 18789;

// 메모리 임계값
const MEM_WARN_MB = 800;    // 경고 (재시작 직후 기준선 ~520MB 포함 여유)
const MEM_CRIT_MB = 1500;   // 자동 재시작 (1.5GB 초과 → 명백한 누수)

// 누수 추세 감지
const LEAK_WINDOW_MS    = 6 * 60 * 60 * 1000; // 6시간 윈도우
const LEAK_THRESHOLD_MB = 300;                  // 6시간 내 300MB 이상 증가 → 누수
const MAX_HISTORY       = 72;                   // 최대 72개 (full 1h 기준 3일분)

// 장기 운영 재시작
const UPTIME_RESTART_DAYS = 7;

// 메모리 시계열 state 파일
const STATE_FILE = path.join(
  process.env.HOME, '.openclaw', 'workspace', 'openclaw-mem-state.json',
);

// ── state 파일 I/O ─────────────────────────────────────────────────

function loadMemState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch { return { history: [] }; }
}

function saveMemState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

// ── launchd 상태 조회 ──────────────────────────────────────────────

function getLaunchdStatus(serviceId) {
  if (!LAUNCHD_AVAILABLE) return null;
  try {
    const out = execSync(
      `launchctl list | awk '$3 == "${serviceId}" {print $1, $2}'`,
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
    if (!out) return null;
    const [pid, exitCode] = out.split(' ');
    return { pid, exitCode: parseInt(exitCode, 10) };
  } catch { return null; }
}

// ── 포트 바인딩 주소 확인 ──────────────────────────────────────────

function getPortBindingInfo(port) {
  try {
    const out = execSync(
      `/usr/sbin/lsof -i :${port} -sTCP:LISTEN -n -P 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 },
    ).trim();

    if (!out) return { listening: false };

    const lines = out.split('\n').filter(l => !l.startsWith('COMMAND'));
    if (lines.length === 0) return { listening: false };

    const addresses = lines.map(l => {
      const parts = l.trim().split(/\s+/);
      const name  = parts[8] || '';
      const ipv6  = name.match(/^\[([^\]]+)\]/);
      if (ipv6) return ipv6[1];
      return name.split(':')[0] || '';
    }).filter(Boolean);

    const IPV6_WILDCARDS = new Set(['', '::', '0:0:0:0:0:0:0:0', '0000:0000:0000:0000:0000:0000:0000:0000']);
    const hasWildcard = addresses.some(a => a === '*' || a === '0.0.0.0' || IPV6_WILDCARDS.has(a));
    const hasLoopback = addresses.some(a => a === '127.0.0.1' || a === 'localhost' || a === '::1');
    const pid         = lines[0]?.trim().split(/\s+/)[1] || null;

    return { listening: true, hasWildcard, hasLoopback, pid, addresses };
  } catch {
    return { listening: false };
  }
}

// ── 프로세스 메모리 조회 (RSS, MB) ────────────────────────────────

function getProcessMemoryMb(pid) {
  if (!pid || pid === '-') return null;
  try {
    const out = execSync(
      `ps -o rss= -p ${pid} 2>/dev/null`,
      { encoding: 'utf8', timeout: 3000 },
    ).trim();
    const kbytes = parseInt(out, 10);
    return isNaN(kbytes) ? null : Math.round(kbytes / 1024);
  } catch { return null; }
}

// ── 프로세스 uptime 조회 (초) ──────────────────────────────────────

function getProcessUptimeSec(pid) {
  if (!pid || pid === '-') return 0;
  try {
    const out = execSync(
      `ps -o etimes= -p ${pid} 2>/dev/null`,
      { encoding: 'utf8', timeout: 3000 },
    ).trim();
    return parseInt(out, 10) || 0;
  } catch { return 0; }
}

// ── 누수 추세 분석 ────────────────────────────────────────────────
// 최근 LEAK_WINDOW_MS 이내 기록 중 가장 오래된 값과 현재 값 비교

function analyzeLeakTrend(history, currentMb) {
  const now    = Date.now();
  const window = history.filter(h => now - new Date(h.ts).getTime() < LEAK_WINDOW_MS);
  if (window.length < 3) return null; // 데이터 부족
  const oldest = window[0].mb;
  const growth = currentMb - oldest;
  return growth >= LEAK_THRESHOLD_MB ? growth : null;
}

// ── 메인 run ──────────────────────────────────────────────────────

async function run() {
  const items = [];

  if (!LAUNCHD_AVAILABLE) {
    items.push({
      label: 'OpenClaw 게이트웨이 (launchd)',
      status: 'ok',
      detail: 'DEV 환경 — launchd 서비스 미등록',
    });
    return { name: 'OpenClaw 게이트웨이 건강', status: 'ok', items };
  }

  // 1. launchd 서비스 상태
  const launchd = getLaunchdStatus(OPENCLAW_SERVICE);

  if (launchd === null) {
    items.push({
      label:  'OpenClaw 게이트웨이 (launchd)',
      status: 'warn',
      detail: '미등록 — launchd plist 확인 필요',
    });
  } else if (launchd.pid === '-' && launchd.exitCode !== 0) {
    items.push({
      label:  'OpenClaw 게이트웨이 (launchd)',
      status: 'error',
      detail: `비정상 종료 (exitCode: ${launchd.exitCode})`,
    });
  } else {
    items.push({
      label:  'OpenClaw 게이트웨이 (launchd)',
      status: 'ok',
      detail: `실행 중 (PID: ${launchd.pid})`,
    });
  }

  // 2. 포트 바인딩 보안 확인
  const portInfo = getPortBindingInfo(OPENCLAW_PORT);

  if (!portInfo.listening) {
    items.push({
      label:  `OpenClaw 포트 ${OPENCLAW_PORT} 바인딩`,
      status: 'error',
      detail: '포트 미바인딩 — OpenClaw 미실행 또는 포트 변경 확인',
    });
  } else if (portInfo.hasWildcard) {
    items.push({
      label:  `OpenClaw 포트 ${OPENCLAW_PORT} 바인딩`,
      status: 'error',
      detail: '⚠️ 0.0.0.0 바인딩 감지 — 외부 노출 위험! loopback 전용으로 설정 확인 필요',
    });
  } else {
    items.push({
      label:  `OpenClaw 포트 ${OPENCLAW_PORT} 바인딩`,
      status: 'ok',
      detail: `127.0.0.1 전용 바인딩 (PID: ${portInfo.pid || '?'})`,
    });
  }

  // 3. 프로세스 메모리 + 누수 추세 + 장기 운영 체크
  const pid = launchd?.pid;
  if (pid && pid !== '-') {
    const memMb = getProcessMemoryMb(pid);

    if (memMb !== null) {
      // 시계열 기록 갱신
      const state = loadMemState();
      state.history = state.history || [];
      state.history.push({ ts: new Date().toISOString(), mb: memMb, pid });
      state.history = state.history.slice(-MAX_HISTORY);

      // 누수 추세 분석 (현재 값 추가 전 이전 이력으로 판단)
      const leakGrowthMb = analyzeLeakTrend(state.history.slice(0, -1), memMb);

      // 장기 운영 체크
      const uptimeSec  = getProcessUptimeSec(pid);
      const uptimeDays = uptimeSec / 86400;

      saveMemState(state);

      // 자동 재시작 트리거 판정
      let autoRestart  = false;
      let restartReason = '';

      if (memMb > MEM_CRIT_MB) {
        autoRestart   = true;
        restartReason = `임계 초과 (${memMb}MB > ${MEM_CRIT_MB}MB)`;
      } else if (leakGrowthMb !== null) {
        autoRestart   = true;
        restartReason = `누수 추세 — 6h +${leakGrowthMb}MB 증가`;
      } else if (uptimeDays >= UPTIME_RESTART_DAYS) {
        autoRestart   = true;
        restartReason = `장기 운영 ${uptimeDays.toFixed(1)}일 — 주기적 재시작`;
      }

      if (autoRestart) {
        // --fix 모드에서 autofix.js가 처리
        items.push({
          label:           'OpenClaw 메모리',
          status:          'warn',
          detail:          `${memMb}MB — 자동 재시작 대기 (${restartReason})`,
          _autoRestart:    true,
          _restartService: OPENCLAW_SERVICE,
          _restartReason:  restartReason,
        });
      } else if (memMb > MEM_WARN_MB) {
        const trendNote = leakGrowthMb ? ` | 6h +${leakGrowthMb}MB` : '';
        items.push({
          label:  'OpenClaw 메모리',
          status: 'warn',
          detail: `${memMb}MB 사용 (임계: ${MEM_WARN_MB}MB)${trendNote} — 모니터링 중`,
        });
      } else {
        const trendNote  = leakGrowthMb ? ` | ⚠️ 6h +${leakGrowthMb}MB` : '';
        const uptimeNote = uptimeDays >= 3 ? ` | 운영 ${uptimeDays.toFixed(1)}일` : '';
        items.push({
          label:  'OpenClaw 메모리',
          status: 'ok',
          detail: `${memMb}MB${trendNote}${uptimeNote}`,
        });
      }
    }
  }

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   'OpenClaw 게이트웨이',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
