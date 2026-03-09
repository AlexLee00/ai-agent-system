'use strict';

/**
 * checks/openclaw.js — OpenClaw 게이트웨이 상태 점검
 *
 * 현재 점검 항목 (게이트웨이 프로세스만):
 *   1. launchd 서비스 (ai.openclaw.gateway) 생존
 *   2. 포트 18789 바인딩 상태
 *      - 127.0.0.1만 바인딩 → 정상
 *      - 0.0.0.0 바인딩 → CRITICAL (보안 위험)
 *      - 미바인딩 → error
 *   3. 프로세스 메모리 사용량 (800MB 초과 → warn, 재시작 직후 기준선 ~520MB)
 *
 * 점검하지 않는 것 (아직 미구현):
 *   - 팀장 에이전트 세션 존재 여부 (OpenClaw 에이전트 미구현)
 *   - sessions_send 동작 여부
 *
 * 참고: network.js의 OpenClaw 포트 체크와 중복 없이
 *       여기서는 보안 바인딩·메모리·launchd 상태에 집중
 */

const { execSync } = require('child_process');

const OPENCLAW_SERVICE = 'ai.openclaw.gateway';
const OPENCLAW_PORT    = 18789;
const MEM_WARN_MB      = 800;   // 재시작 직후 기준선 ~520MB → 여유 포함 800MB

// ── launchd 상태 조회 ──────────────────────────────────────────────

function getLaunchdStatus(serviceId) {
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
    // lsof -i :<port> -sTCP:LISTEN → 바인딩 중인 프로세스 목록
    const out = execSync(
      `/usr/sbin/lsof -i :${port} -sTCP:LISTEN -n -P 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 },
    ).trim();

    if (!out) return { listening: false };

    const lines = out.split('\n').filter(l => !l.startsWith('COMMAND'));
    if (lines.length === 0) return { listening: false };

    // NAME 컬럼에서 주소 추출
    // IPv4: 127.0.0.1:18789 → '127.0.0.1'
    // IPv6: [::1]:18789 → '::1'  (bracket notation 처리)
    // 와일드카드: *:18789 → '*'
    const addresses = lines.map(l => {
      const parts = l.trim().split(/\s+/);
      const name  = parts[8] || '';           // NAME 컬럼
      const ipv6  = name.match(/^\[([^\]]+)\]/);
      if (ipv6) return ipv6[1];               // [::1]:18789 → '::1'
      return name.split(':')[0] || '';
    }).filter(Boolean);

    const IPV6_WILDCARDS  = new Set(['', '::', '0:0:0:0:0:0:0:0', '0000:0000:0000:0000:0000:0000:0000:0000']);
    const hasWildcard  = addresses.some(a => a === '*' || a === '0.0.0.0' || IPV6_WILDCARDS.has(a));
    const hasLoopback  = addresses.some(a => a === '127.0.0.1' || a === 'localhost' || a === '::1');
    const pid          = lines[0]?.trim().split(/\s+/)[1] || null;

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

// ── 메인 run ──────────────────────────────────────────────────────

async function run() {
  const items = [];

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
    // 0.0.0.0 바인딩 → 외부 노출 — 보안 위험
    items.push({
      label:  `OpenClaw 포트 ${OPENCLAW_PORT} 바인딩`,
      status: 'error',
      detail: `⚠️ 0.0.0.0 바인딩 감지 — 외부 노출 위험! loopback 전용으로 설정 확인 필요`,
    });
  } else {
    items.push({
      label:  `OpenClaw 포트 ${OPENCLAW_PORT} 바인딩`,
      status: 'ok',
      detail: `127.0.0.1 전용 바인딩 (PID: ${portInfo.pid || '?'})`,
    });
  }

  // 3. 프로세스 메모리
  const pid = launchd?.pid;
  if (pid && pid !== '-') {
    const memMb = getProcessMemoryMb(pid);
    if (memMb !== null) {
      if (memMb > MEM_WARN_MB) {
        items.push({
          label:  'OpenClaw 메모리',
          status: 'warn',
          detail: `${memMb}MB 사용 (임계: ${MEM_WARN_MB}MB) — 재시작 고려`,
        });
      } else {
        items.push({
          label:  'OpenClaw 메모리',
          status: 'ok',
          detail: `${memMb}MB`,
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
