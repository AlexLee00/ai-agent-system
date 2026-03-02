'use strict';

/**
 * scripts/health-check.js — launchd 서비스 헬스체크
 *
 * 감지 대상:
 *   - naver-monitor (KeepAlive): PID 없으면 다운으로 판단
 *   - naver-monitor 로그 staleness: 15분 이상 무활동 → 크래시루프 감지
 *   - 전체 서비스: launchctl list에서 사라지면 미로드 경고
 *   - 스케줄 서비스: LastExitStatus 비정상(≠0) 감지
 *
 * 중복 알림 방지: ~/.openclaw/workspace/health-check-state.json
 *   - 같은 서비스 경고는 30분 내 재발송 안 함
 *
 * 실행: node scripts/health-check.js
 * 자동: launchd ai.ska.health-check (10분마다)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');
const STATE_FILE = path.join(WORKSPACE, 'health-check-state.json');
const SECRETS_FILE = path.join(__dirname, '..', 'secrets.json');

// 상시 실행 서비스 (PID 있어야 정상)
const CONTINUOUS = ['ai.ska.naver-monitor'];

// 감지할 전체 서비스
const ALL_SERVICES = [
  'ai.ska.naver-monitor',
  'ai.ska.kiosk-monitor',
  'ai.ska.pickko-verify',
  'ai.ska.pickko-daily-audit',
  'ai.ska.pickko-daily-summary',
  'ai.ska.log-report',
  'ai.ska.db-backup',
  'ai.ska.log-rotate',
];

// 정상 종료 코드 (0: 성공, -15: SIGTERM, -9: KeepAlive 재시작)
const NORMAL_EXIT_CODES = new Set([0, -9, -15]);

// 중복 알림 방지 간격 (30분)
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

// naver-monitor 로그 staleness 체크
const NAVER_LOG = '/tmp/naver-ops-mode.log';
const LOG_STALE_MS = 15 * 60 * 1000; // 15분 무활동 → 크래시루프 의심

// ─── 상태 파일 ──────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`[헬스체크] 상태 저장 실패: ${e.message}`);
  }
}

function canAlert(state, key) {
  const last = state[key];
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > ALERT_COOLDOWN_MS;
}

// ─── naver-monitor 로그 staleness ───────────────────────────────

function checkNaverLogStaleness() {
  try {
    const stat = fs.statSync(NAVER_LOG);
    const ageMs = Date.now() - stat.mtimeMs;
    return { exists: true, ageMs, stale: ageMs > LOG_STALE_MS };
  } catch {
    return { exists: false, ageMs: null, stale: false }; // 파일 없으면 스킵
  }
}

// ─── launchctl 파싱 ──────────────────────────────────────────────

function getLaunchctlStatus() {
  // 출력 형식: PID  LastExitStatus  Label
  const raw = execSync('launchctl list', { encoding: 'utf-8' });
  const services = {};
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, exitCode, label] = parts;
    services[label] = {
      running: pid !== '-',
      pid: pid !== '-' ? parseInt(pid) : null,
      exitCode: parseInt(exitCode) || 0,
    };
  }
  return services;
}

// ─── 텔레그램 ───────────────────────────────────────────────────

async function sendTelegram(message) {
  try {
    const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
    const { telegram_bot_token, telegram_chat_id } = secrets;
    if (!telegram_bot_token || !telegram_chat_id) return;

    const body = JSON.stringify({ chat_id: telegram_chat_id, text: message });
    await new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'api.telegram.org',
          path: `/bot${telegram_bot_token}/sendMessage`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        resolve
      );
      req.on('error', resolve);
      req.write(body);
      req.end();
    });
    console.log(`[헬스체크] 텔레그램 발송: ${message.slice(0, 60)}`);
  } catch (e) {
    console.error(`[헬스체크] 텔레그램 실패: ${e.message}`);
  }
}

// ─── 메인 ───────────────────────────────────────────────────────

async function main() {
  const now = new Date().toISOString();
  console.log(`[헬스체크] 시작 — ${now}`);

  let status;
  try {
    status = getLaunchctlStatus();
  } catch (e) {
    console.error(`[헬스체크] launchctl 실행 실패: ${e.message}`);
    process.exit(1);
  }

  const state = loadState();
  const issues = [];

  for (const label of ALL_SERVICES) {
    const svc = status[label];
    const shortName = label.replace('ai.ska.', '');

    // 1. 미로드 감지 (launchctl list에 없음)
    if (!svc) {
      const key = `unloaded:${label}`;
      if (canAlert(state, key)) {
        issues.push({ key, msg: `🔴 [스카 헬스] ${shortName} 미로드\nlaunchd에 등록되지 않음 → 수동 확인 필요` });
      }
      continue;
    }

    // 2. 상시 서비스 다운 감지 (PID 없음)
    if (CONTINUOUS.includes(label) && !svc.running) {
      const key = `down:${label}`;
      if (canAlert(state, key)) {
        issues.push({ key, msg: `🔴 [스카 헬스] ${shortName} 다운\nPID 없음 — launchd 재시작 실패 가능성` });
      }
    }

    // 3. 비정상 종료 코드 감지
    if (!NORMAL_EXIT_CODES.has(svc.exitCode)) {
      const key = `exitcode:${label}:${svc.exitCode}`;
      if (canAlert(state, key)) {
        issues.push({ key, msg: `⚠️ [스카 헬스] ${shortName} 비정상 종료\nexit code: ${svc.exitCode}` });
      }
    }
  }

  // 4. naver-monitor 로그 staleness 체크 (크래시루프 감지)
  //    PID가 있어도 크래시 반복 시 로그가 멈출 수 있음
  const naverLog = checkNaverLogStaleness();
  if (naverLog.exists && naverLog.stale) {
    const key = 'stale:ai.ska.naver-monitor';
    if (canAlert(state, key)) {
      const minAgo = Math.floor(naverLog.ageMs / 60000);
      issues.push({ key, msg: `⚠️ [스카 헬스] naver-monitor 로그 무활동\n${minAgo}분간 로그 미기록 — 크래시루프 가능성` });
    }
  }

  if (issues.length === 0) {
    console.log(`[헬스체크] 정상 — 전체 ${ALL_SERVICES.length}개 서비스 이상 없음`);
    return;
  }

  // 알림 발송 + 상태 기록
  for (const { key, msg } of issues) {
    console.warn(`[헬스체크] 이슈 감지: ${msg}`);
    await sendTelegram(msg);
    state[key] = now;
  }

  saveState(state);
}

main().catch((e) => {
  console.error(`[헬스체크] 예외: ${e.message}`);
  process.exit(1);
});
