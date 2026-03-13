'use strict';

/**
 * scripts/health-check.js — 블로그팀 launchd 서비스 헬스체크
 *
 * 감지 대상:
 *   - 스케줄: daily (06:00 KST 자동 실행)
 *
 * 공통 상태: packages/core/lib/health-state-manager.js
 * 실행: node scripts/health-check.js
 * 자동: launchd ai.blog.health-check (10분마다)
 */

const { execSync } = require('child_process');
const http   = require('http');
const sender = require('../../../packages/core/lib/telegram-sender');
const hsm    = require('../../../packages/core/lib/health-state-manager');

async function notify(msg, level = 3) {
  try {
    if (level >= 3) {
      await sender.sendCritical('blog', msg);
    } else {
      await sender.send('blog', msg);
    }
  } catch { /* 무시 */ }
}

// 상시 실행 서비스 없음 (블로그팀은 전부 스케줄)
const CONTINUOUS = [];

// 감지할 전체 서비스
const ALL_SERVICES = [
  'ai.blog.daily',
  'ai.blog.node-server',
];

// 정상 종료 코드
const NORMAL_EXIT_CODES = new Set([0, -9, -15]);

// ─── launchctl 파싱 ──────────────────────────────────────────────

function getLaunchctlStatus() {
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

function checkNodeServerHealth() {
  return new Promise(resolve => {
    const req = http.request(
      { hostname: 'localhost', port: 3100, path: '/health', method: 'GET', timeout: 3000 },
      res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.ok === true) {
              resolve({ ok: true, detail: `포트 ${json.port || 3100} 응답 정상` });
            } else {
              resolve({ ok: false, detail: `비정상 응답: ${body.slice(0, 80)}` });
            }
          } catch {
            resolve({ ok: false, detail: `JSON 파싱 실패 (HTTP ${res.statusCode})` });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, detail: '응답 없음 (3000ms 타임아웃)' });
    });
    req.on('error', e => {
      resolve({ ok: false, detail: e.code === 'ECONNREFUSED' ? '포트 3100 연결 거부' : e.message.slice(0, 80) });
    });
    req.end();
  });
}

// ─── 메인 ───────────────────────────────────────────────────────

async function main() {
  console.log(`[블로그 헬스체크] 시작 — ${new Date().toISOString()}`);

  let status;
  try {
    status = getLaunchctlStatus();
  } catch (e) {
    console.error(`[블로그 헬스체크] launchctl 실행 실패: ${e.message}`);
    process.exit(1);
  }

  const state  = hsm.loadState();
  const issues = [];

  for (const label of ALL_SERVICES) {
    const svc       = status[label];
    const shortName = hsm.shortLabel(label);

    // 1. 미로드 감지
    if (!svc) {
      const key = `unloaded:${label}`;
      if (hsm.canAlert(state, key)) {
        issues.push({ key, level: hsm.getAlertLevel(label), msg: `🔴 [블로그 헬스] ${shortName} 미로드\nlaunchd에 등록되지 않음 → 수동 확인 필요` });
      }
      continue;
    }

    // 미로드 → 회복
    if (state[`unloaded:${label}`]) {
      await notify(`✅ [블로그 헬스] ${shortName} 회복\nlaunchd 정상 로드 — 자동 감지`, 1);
      hsm.clearAlert(state, `unloaded:${label}`);
    }

    // 2. 비정상 종료 코드 감지
    if (!NORMAL_EXIT_CODES.has(svc.exitCode) && !(CONTINUOUS.includes(label) && svc.running)) {
      const key = `exitcode:${label}:${svc.exitCode}`;
      if (hsm.canAlert(state, key)) {
        issues.push({ key, level: hsm.getAlertLevel(label), msg: `⚠️ [블로그 헬스] ${shortName} 비정상 종료\nexit code: ${svc.exitCode}` });
      }
    } else {
      const prevKeys = Object.keys(state).filter(k => k.startsWith(`exitcode:${label}:`));
      if (prevKeys.length > 0) {
        await notify(`✅ [블로그 헬스] ${shortName} 회복\nexit code 정상 (0) — 자동 감지`, 1);
        prevKeys.forEach(k => hsm.clearAlert(state, k));
      }
    }
  }

  // 블로그 node-server 추가 헬스체크
  if (status['ai.blog.node-server']?.running) {
    const nodeServer = await checkNodeServerHealth();
    const key = 'node-server:http';
    if (!nodeServer.ok) {
      if (hsm.canAlert(state, key)) {
        issues.push({
          key,
          level: 2,
          msg: `⚠️ [블로그 헬스] node-server 비정상\n${nodeServer.detail}`,
        });
      }
    } else if (state[key]) {
      await notify(`✅ [블로그 헬스] node-server 회복\n${nodeServer.detail}`, 1);
      hsm.clearAlert(state, key);
    }
  }

  // 알림 발송 + 상태 기록
  for (const { key, level, msg } of issues) {
    console.warn(`[블로그 헬스체크] 이슈: ${msg}`);
    await notify(msg, level);
    hsm.recordAlert(state, key);
  }

  hsm.saveState(state);

  if (issues.length === 0) {
    console.log(`[블로그 헬스체크] 정상 — 전체 ${ALL_SERVICES.length}개 서비스 이상 없음`);
  }
}

main().catch(e => {
  console.error(`[블로그 헬스체크] 예외: ${e.message}`);
  process.exit(1);
});
