// @ts-nocheck
'use strict';

/**
 * src/dexter-quickcheck.js — 덱스터 퀵체크 (5분 주기)
 * 클로드팀 소속 / launchd: ai.claude.dexter.quick
 *
 * 목적: 핵심 서비스 크래시·디스크 위기를 5분 내 감지 + 자동 재시작
 *   (전체 점검은 1시간 주기 dexter.js에서 수행)
 *
 * 사용법:
 *   node src/dexter-quickcheck.js               # 콘솔 출력만
 *   node src/dexter-quickcheck.js --telegram    # 이슈 시 텔레그램 알림
 *   node src/dexter-quickcheck.js --telegram --fix  # 알림 + 자동 재시작
 */

const kst = require('../../../packages/core/lib/kst.js');

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { publishToMainBot } = require('../lib/mainbot-client.js');
const cfg = require('../lib/config.ts');
const runtimePaths = require('../lib/runtime-paths.js');
const {
  isElixirOwnedService,
  isExpectedIdleService,
  isRetiredService,
} = require('../../../packages/core/lib/service-ownership.js');

// v2: 핵심 봇 프로세스 빠른 점검 모듈
const teamLeadsCheck = require('../lib/checks/team-leads.legacy.js');
// NOTE: Legacy gateway checks are retired; Hub health is covered by dexter full checks.

// ── 상수 ─────────────────────────────────────────────────────────────

const STATE_FILE    = runtimePaths.workspacePath('quickcheck-state.json');
const ALERT_CD_MS = Number(cfg.RUNTIME?.quickcheck?.alertCooldownMs || (60 * 60 * 1000));
const RESTART_CD_MS = Number(cfg.RUNTIME?.quickcheck?.restartCooldownMs || (30 * 60 * 1000));
const MAX_RESTARTS = Number(cfg.RUNTIME?.quickcheck?.maxRestarts || 3);
const DISK_CRITICAL = Number(cfg.RUNTIME?.quickcheck?.diskCriticalPercent || 90);

// ── 핵심 서비스 목록 ──────────────────────────────────────────────────
// restartable: Playwright 기반 서비스는 zombie chrome 위험으로 false
const SERVICES = [
  { id: 'ai.ska.commander',         label: '스카 커맨더',             restartable: true  },
  { id: 'ai.investment.commander',  label: '루나 커맨더',             restartable: true  },
  { id: 'ai.luna.marketdata-mcp',   label: '루나 마켓데이터 MCP',     restartable: true  },
  { id: 'ai.elixir.supervisor',     label: '루나 엘릭서 슈퍼바이저',   restartable: true  },
  { id: 'ai.claude.commander',      label: '클로드 커맨더',           restartable: true  },
  { id: 'ai.ska.naver-monitor',     label: '앤디 네이버모니터',       restartable: false }, // Playwright
  { id: 'ai.ska.kiosk-monitor',     label: '지미 키오스크모니터',     restartable: false }, // Playwright
];

// ── 유틸 ─────────────────────────────────────────────────────────────

function kstNow() {
  return kst.datetimeStr();
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { services: {}, disk: {} };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { return { services: {}, disk: {} }; }
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* 저장 실패 무시 */ }
}

// 알림 쿨다운 초과 여부
function cooldownExpired(lastAt, cdMs = ALERT_CD_MS) {
  if (!lastAt) return true;
  return (Date.now() - new Date(lastAt).getTime()) > cdMs;
}

// ── launchd 조회 ──────────────────────────────────────────────────────

/**
 * launchctl list에서 서비스 상태 파싱
 * 포맷: PID  ExitCode  Label
 * @returns {{ pid: string, exitCode: number } | null}
 */
function getLaunchdInfo(serviceId) {
  try {
    // awk로 정확한 label 일치 (부분 문자열 매칭 방지)
    const out = execSync(
      `launchctl list | awk '$3 == "${serviceId}" {print $1, $2}'`,
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
    if (!out) return null;
    const [pid, exitCode] = out.split(' ');
    return { pid, exitCode: parseInt(exitCode, 10) };
  } catch { return null; }
}

// ── 자동 재시작 ───────────────────────────────────────────────────────

function restartService(serviceId) {
  const uid = process.getuid();
  execSync(`launchctl kickstart gui/${uid}/${serviceId}`, { timeout: 10000 });
}

// ── 디스크 사용률 ─────────────────────────────────────────────────────

function getDiskUsage() {
  try {
    const out = execSync("df -k / | tail -1", { encoding: 'utf8', timeout: 5000 }).trim();
    const parts = out.split(/\s+/);
    // df 컬럼: Filesystem  1K-blocks  Used  Available  Capacity  Mounted
    // macOS capacity 컬럼은 5번째 (index 4), '%' 포함
    const cap = parts[4]?.replace('%', '');
    return cap ? parseInt(cap, 10) : 0;
  } catch { return 0; }
}

// ── 메인 ─────────────────────────────────────────────────────────────

async function main() {
  const TELEGRAM = process.argv.includes('--telegram');
  const FIX      = process.argv.includes('--fix');

  const state    = loadState();
  const now      = kstNow();

  const alerts    = []; // { label, detail, restartable, restarted? }
  const recoveries = []; // { label, downSince }

  // ── 1. 서비스 생존 체크 ─────────────────────────────────────────────
  for (const svc of SERVICES) {
    if (isRetiredService(svc.id)) {
      state.services[svc.id] = { status: 'ok', restartCount: 0, restartedAt: null, restartResult: null };
      continue;
    }

    if (isElixirOwnedService(svc.id)) {
      state.services[svc.id] = {
        status: 'ok',
        restartCount: 0,
        restartedAt: null,
        restartResult: null,
        note: isExpectedIdleService(svc.id)
          ? 'elixir-owned-expected-idle'
          : 'elixir-owned',
      };
      continue;
    }

    const info = getLaunchdInfo(svc.id);
    const prev = state.services?.[svc.id] || {};

    if (!info) {
      // launchd 미등록 → 전체 점검(dexter.js)에서 처리, 퀵체크는 스킵
      continue;
    }

    // 비정상 종료 감지: pid='-' (미실행) + exitCode 비정상
    const crashed = info.pid === '-' && info.exitCode !== 0;

    if (crashed) {
      const isNew       = !prev.status || prev.status === 'ok';
      const reAlert     = prev.status === 'down' && cooldownExpired(prev.alertedAt);
      const needAlert   = isNew || reAlert;

      // 연속 실패 횟수 누적
      const failCount = (prev.failCount || 0) + 1;

      // 상태 업데이트
      state.services[svc.id] = {
        status:       'down',
        exitCode:     info.exitCode,
        failCount,
        downSince:    prev.downSince || now,
        alertedAt:    needAlert ? now : (prev.alertedAt || now),
        restartedAt:  prev.restartedAt  || null,
        restartCount: prev.restartCount || 0,
        restartResult: prev.restartResult || null,
      };

      // 자동 재시작 시도
      let restarted = false;
      if (FIX && svc.restartable) {
        const restartCdOk = cooldownExpired(prev.restartedAt, RESTART_CD_MS);
        const countOk     = (prev.restartCount || 0) < MAX_RESTARTS;

        if (restartCdOk && countOk) {
          try {
            restartService(svc.id);
            restarted = true;
            state.services[svc.id].restartedAt   = now;
            state.services[svc.id].restartCount  = (prev.restartCount || 0) + 1;
            state.services[svc.id].restartResult = 'success';
            console.log(`  ✅ 자동 재시작: ${svc.label} (${svc.id})`);
          } catch (e) {
            state.services[svc.id].restartResult = `fail: ${e.message}`;
            console.warn(`  ❌ 재시작 실패: ${svc.label} — ${e.message}`);
          }
        } else if (!countOk) {
          console.warn(`  ⚠️ 재시작 한도 초과: ${svc.label} (${prev.restartCount}/${MAX_RESTARTS}회)`);
        }
      }

      if (needAlert) {
        alerts.push({
          label:      svc.label,
          detail:     failCount === 1
            ? `일시 실패 (exitCode: ${info.exitCode})`
            : `연속 ${failCount}회 실패 (exitCode: ${info.exitCode})`,
          restartable: svc.restartable,
          restarted,
          failCount,
        });
      }

    } else {
      // 정상 — 회복 감지
      if (prev.status === 'down') {
        recoveries.push({ label: svc.label, downSince: prev.downSince });
      }
      state.services[svc.id] = { status: 'ok', restartCount: 0, restartedAt: null, restartResult: null };
    }
  }

  // ── v2: 팀장 봇 빠른 점검 ──────────────────────────────────────────
  try {
    const leadResult = await teamLeadsCheck.run();
    const leadErrors = (leadResult.items || []).filter(i => i.status === 'error');
    for (const item of leadErrors) {
      const prev = state.services?.[`team-lead:${item.label}`] || {};
      const needAlert = !prev.status || prev.status === 'ok' ||
        (prev.status === 'down' && cooldownExpired(prev.alertedAt));

      state.services = state.services || {};
      state.services[`team-lead:${item.label}`] = {
        status: 'down', alertedAt: needAlert ? now : (prev.alertedAt || now),
      };

      if (needAlert) {
        alerts.push({ label: item.label, detail: item.detail, restartable: false, restarted: false });
      }
    }
    // 정상 회복 감지
    for (const item of (leadResult.items || []).filter(i => i.status === 'ok')) {
      const key  = `team-lead:${item.label}`;
      const prev = state.services?.[key];
      if (prev?.status === 'down') {
        recoveries.push({ label: item.label, downSince: null });
      }
      if (state.services) state.services[key] = { status: 'ok' };
    }
  } catch { /* 팀장 점검 실패 — 기존 체크에 영향 없음 */ }

  // ── 2. 디스크 위기 체크 ─────────────────────────────────────────────
  // NOTE: Hub 상태는 full 체크에서 처리하고, 퀵체크는 핵심 launchd 생존만 본다.
  const diskUsage = getDiskUsage();
  const diskPrev  = state.disk || {};

  if (diskUsage >= DISK_CRITICAL) {
    const isNew     = !diskPrev.status || diskPrev.status === 'ok';
    const reAlert   = diskPrev.status === 'critical' && cooldownExpired(diskPrev.alertedAt);
    const needAlert = isNew || reAlert;

    state.disk = {
      status:    'critical',
      usage:     diskUsage,
      alertedAt: needAlert ? now : (diskPrev.alertedAt || now),
    };

    if (needAlert) {
      alerts.push({ label: '디스크', detail: `사용률 ${diskUsage}% (${DISK_CRITICAL}% 초과 — 즉시 정리 필요)`, restartable: false, restarted: false });
    }
  } else {
    if (diskPrev.status === 'critical') {
      recoveries.push({ label: '디스크', detail: `${diskUsage}%로 회복`, downSince: null });
    }
    state.disk = { status: 'ok', usage: diskUsage, alertedAt: null };
  }

  // ── 3. 상태 저장 ────────────────────────────────────────────────────
  saveState(state);

  // ── 4. 콘솔 출력 ────────────────────────────────────────────────────
  if (alerts.length === 0 && recoveries.length === 0) {
    console.log(`[${now}] ✅ 퀵체크 이상 없음`);
  } else {
    alerts.forEach(a => {
      const restart = a.restarted ? ' → 자동 재시작 완료' : (a.restartable ? ' → 수동 재시작 필요' : '');
      console.log(`[${now}] ❌ ${a.label}: ${a.detail}${restart}`);
    });
    recoveries.forEach(r => console.log(`[${now}] ✅ ${r.label} 회복${r.downSince ? ` (중단: ${r.downSince}부터)` : ''}`));
  }

  // ── 5. 텔레그램 발송 ────────────────────────────────────────────────
  if (!TELEGRAM) return;

  if (alerts.length > 0) {
    // 1회 실패는 경고, 2회 이상 연속은 CRITICAL
    const maxFail    = Math.max(...alerts.map(a => a.failCount || 1));
    const isCritical = maxFail >= 2;
    const header     = isCritical ? `🚨 덱스터 긴급 감지 (퀵체크)` : `⚠️ 덱스터 감지 (퀵체크)`;
    const alertLevel = isCritical ? 4 : 2;

    const lines = [
      header,
      ...alerts.map(a => {
        const icon = (a.failCount || 1) >= 2 ? '❌' : '⚠️';
        const restartLine = a.restarted
          ? '  → 🔄 자동 재시작 완료 — 상태 모니터링 중'
          : (FIX && a.restartable)
            ? '  → ❌ 재시작 실패 — 수동 확인 필요'
            : a.restartable
              ? '  → ⚠️ 수동 재시작 필요'
              : (a.failCount || 1) >= 2
                ? '  → ⚠️ 수동 확인 필요'
                : '  → 다음 사이클에 자동 재시도';
        return `${icon} ${a.label}: ${a.detail}\n${restartLine}`;
      }),
    ];

    publishToMainBot({
      from_bot:    'dexter',
      event_type:  'system',
      alert_level: alertLevel,
      message:     lines.join('\n'),
      payload:     { quickcheck: true, issue_count: alerts.length },
    });
  }

  if (recoveries.length > 0) {
    const lines = [
      `✅ 덱스터 회복 감지 (퀵체크)`,
      ...recoveries.map(r =>
        `✅ ${r.label}${r.downSince ? ` (중단: ${r.downSince}부터)` : ''}${r.detail ? ` — ${r.detail}` : ''}`
      ),
    ];

    publishToMainBot({
      from_bot:    'dexter',
      event_type:  'system',
      alert_level: 2,
      message:     lines.join('\n'),
      payload:     { quickcheck: true, recovery: true },
    });
  }
}

main().catch(e => {
  console.error('❌ 퀵체크 오류:', e.message);
  process.exit(1);
});
