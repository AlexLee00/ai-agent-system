/**
 * scripts/health-check.js — 루나팀 launchd 서비스 헬스체크
 *
 * 감지 대상:
 *   - 상시 실행: commander, crypto, domestic, overseas, argos (PID 없으면 다운)
 *   - 스케줄: market-alert-*, prescreen-*, reporter
 *
 * 공통 상태: packages/core/lib/health-state-manager.js
 * 실행: node scripts/health-check.js
 * 자동: launchd ai.investment.health-check (10분마다)
 */

import { execSync } from 'child_process';
import { createRequire } from 'module';
import { validateTradeReview } from './validate-trade-review.js';

const require = createRequire(import.meta.url);
const hsm     = require('../../../packages/core/lib/health-state-manager');
const {
  buildNoticeEvent,
  renderNoticeEvent,
  buildSeverityTargets,
  publishEventPipeline,
} = require('../../../packages/core/lib/reporting-hub');

// 상시 실행 서비스 (PID 있어야 정상) — KeepAlive=true인 데몬만
const CONTINUOUS = [
  'ai.investment.commander',
  // crypto: StartInterval 300s, KeepAlive=false → 스케줄 봇
  // domestic: StartCalendarInterval, KeepAlive=false → 스케줄 봇
  // overseas: StartCalendarInterval, KeepAlive=false → 스케줄 봇
  // argos: StartCalendarInterval, KeepAlive=false → 스케줄 봇
];

// 감지할 전체 서비스
const ALL_SERVICES = [
  'ai.investment.commander',
  'ai.investment.crypto',
  'ai.investment.domestic',
  'ai.investment.overseas',
  'ai.investment.argos',
  'ai.investment.market-alert-crypto-daily',
  'ai.investment.market-alert-domestic-open',
  'ai.investment.market-alert-domestic-close',
  'ai.investment.market-alert-overseas-open',
  'ai.investment.market-alert-overseas-close',
  'ai.investment.prescreen-domestic',
  'ai.investment.prescreen-overseas',
  'ai.investment.reporter',
];

// 정상 종료 코드
const NORMAL_EXIT_CODES = new Set([0, -9, -15]);

// ─── 알림 발송 ───────────────────────────────────────────────────

async function notify(msg, level = 3) {
  try {
    const event = buildNoticeEvent({
      from_bot: 'luna-health-check',
      team: 'luna',
      event_type: 'alert',
      alert_level: level,
      title: '루나 헬스 알림',
      summary: msg.split('\n')[0] || '루나 헬스 알림',
      details: msg.split('\n').slice(1).filter(Boolean),
      payload: {
        title: '루나 헬스 알림',
        summary: msg.split('\n')[0] || '루나 헬스 알림',
        details: msg.split('\n').slice(1).filter(Boolean),
      },
    });
    await publishEventPipeline({
      event: {
        ...event,
        message: renderNoticeEvent(event),
      },
      targets: buildSeverityTargets({
        event,
        topicTeam: 'luna',
        includeQueue: false,
        includeTelegram: false,
      }),
      policy: {
        cooldownMs: level >= 3 ? 60_000 : 5 * 60_000,
      },
    });
  } catch { /* 무시 */ }
}

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

// ─── 메인 ───────────────────────────────────────────────────────

async function main() {
  console.log(`[루나 헬스체크] 시작 — ${new Date().toISOString()}`);

  let status;
  try {
    status = getLaunchctlStatus();
  } catch (e) {
    console.error(`[루나 헬스체크] launchctl 실행 실패: ${e.message}`);
    process.exit(1);
  }

  const state    = hsm.loadState();
  const issues   = [];
  const recovers = [];

  for (const label of ALL_SERVICES) {
    const svc       = status[label];
    const shortName = hsm.shortLabel(label);

    // 1. 미로드 감지
    if (!svc) {
      const key = `unloaded:${label}`;
      if (hsm.canAlert(state, key)) {
        issues.push({ key, level: hsm.getAlertLevel(label), msg: `🔴 [루나 헬스] ${shortName} 미로드\nlaunchd에 등록되지 않음 → 수동 확인 필요` });
      }
      continue;
    }

    // 미로드 → 회복
    if (state[`unloaded:${label}`]) {
      recovers.push(`✅ [루나 헬스] ${shortName} 회복\nlaunchd 정상 로드 — 자동 감지`);
      hsm.clearAlert(state, `unloaded:${label}`);
    }

    // 2. 상시 서비스 다운 감지
    if (CONTINUOUS.includes(label)) {
      if (!svc.running) {
        const key = `down:${label}`;
        if (hsm.canAlert(state, key)) {
          issues.push({ key, level: hsm.getAlertLevel(label), msg: `🔴 [루나 헬스] ${shortName} 다운\nPID 없음 — launchd 재시작 실패 가능성` });
        }
      } else if (state[`down:${label}`]) {
        recovers.push(`✅ [루나 헬스] ${shortName} 회복\nPID 정상 확인 — 자동 감지`);
        hsm.clearAlert(state, `down:${label}`);
      }
    }

    // 3. 비정상 종료 코드 감지
    if (!NORMAL_EXIT_CODES.has(svc.exitCode) && !(CONTINUOUS.includes(label) && svc.running)) {
      const key = `exitcode:${label}:${svc.exitCode}`;
      if (hsm.canAlert(state, key)) {
        issues.push({ key, level: hsm.getAlertLevel(label), msg: `⚠️ [루나 헬스] ${shortName} 비정상 종료\nexit code: ${svc.exitCode}` });
      }
    } else {
      const prevKeys = Object.keys(state).filter(k => k.startsWith(`exitcode:${label}:`));
      if (prevKeys.length > 0) {
        recovers.push(`✅ [루나 헬스] ${shortName} 회복\nexit code 정상 (0) — 자동 감지`);
        prevKeys.forEach(k => hsm.clearAlert(state, k));
      }
    }
  }

  try {
    const validation = await validateTradeReview({ days: 90, fix: false });
    if (validation.findings > 0) {
      const key = 'trade-review-integrity';
      if (hsm.canAlert(state, key)) {
        issues.push({
          key,
          level: 2,
          msg: `⚠️ [루나 헬스] trade_review 정합성 이상\n종료 거래 ${validation.closedTrades}건 중 ${validation.findings}건 점검 필요`,
        });
      }
    } else if (state['trade-review-integrity']) {
      recovers.push(`✅ [루나 헬스] trade_review 정합성 회복\n거래 리뷰 누락/불일치 없음 — 자동 감지`);
      hsm.clearAlert(state, 'trade-review-integrity');
    }
  } catch (e) {
    const key = 'trade-review-check-failed';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 2,
        msg: `⚠️ [루나 헬스] trade_review 점검 실패\n${e.message}`,
      });
    }
  }

  // 이슈 알림 발송
  for (const { key, level, msg } of issues) {
    console.warn(`[루나 헬스체크] 이슈: ${msg}`);
    await notify(msg, level);
    hsm.recordAlert(state, key);
  }

  // 회복 알림 발송
  for (const msg of recovers) {
    await notify(msg, 1);
  }

  hsm.saveState(state);

  if (issues.length === 0) {
    console.log(`[루나 헬스체크] 정상 — 전체 ${ALL_SERVICES.length}개 서비스 이상 없음`);
  }
}

main().catch(e => {
  console.error(`[루나 헬스체크] 예외: ${e.message}`);
  process.exit(1);
});
