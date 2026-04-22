// @ts-nocheck
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
import fs from 'node:fs';
import { createRequire } from 'module';
import { publishAlert } from '../shared/alert-publisher.ts';
import { validateTradeReview } from './validate-trade-review.ts';
import { buildRuntimeLearningLoopReport } from './runtime-learning-loop-report.ts';

const require = createRequire(import.meta.url);
const hsm     = require('../../../packages/core/lib/health-state-manager');
const {
  getServiceOwnership,
  isElixirOwnedService,
  isRetiredService,
} = require('../../../packages/core/lib/service-ownership');
const { createHealthMemoryHelper } = require('../shared/health-memory-bridge.cjs');
const { buildIssueHints, rememberHealthEvent } = createHealthMemoryHelper({
  agentId: 'investment.health',
  team: 'investment',
  domain: 'investment health',
});

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
const LOCAL_LLM_HEALTH_HISTORY_FILE = '/tmp/investment-local-llm-health-history.jsonl';
const LATEST_OPS_SNAPSHOT_FILE = '/Users/alexlee/projects/ai-agent-system/bots/investment/output/ops/parallel-ops-snapshot.json';

function loadLatestOpsSnapshot() {
  try {
    if (!fs.existsSync(LATEST_OPS_SNAPSHOT_FILE)) return null;
    return JSON.parse(fs.readFileSync(LATEST_OPS_SNAPSHOT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function getWeakestRegimeSummary(runtimeLearningLoop) {
  const weakest = runtimeLearningLoop?.sections?.regimeLaneSummary?.weakestRegime
    || runtimeLearningLoop?.sections?.collect?.regimePerformance?.weakestRegime
    || null;
  const weakestMode = weakest?.tradeMode || weakest?.worstMode?.tradeMode || weakest?.bestMode?.tradeMode || 'n/a';
  return { weakest, weakestMode };
}

// ─── 알림 발송 ───────────────────────────────────────────────────

async function notify(msg, level = 3) {
  try {
    await publishAlert({
      from_bot: 'luna-health-check',
      event_type: 'health_check',
      alert_level: level,
      message: msg,
    });
  } catch { /* 무시 */ }
}

function loadRecentLocalProbeTrend() {
  try {
    if (!fs.existsSync(LOCAL_LLM_HEALTH_HISTORY_FILE)) {
      return { status: 'unknown', okCount: 0, failCount: 0, transitionCount: 0, lastError: null, latest: null };
    }

    const recent = String(fs.readFileSync(LOCAL_LLM_HEALTH_HISTORY_FILE, 'utf8') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-6)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (recent.length === 0) {
      return { status: 'unknown', okCount: 0, failCount: 0, transitionCount: 0, lastError: null, latest: null };
    }

    let transitionCount = 0;
    for (let i = 1; i < recent.length; i += 1) {
      if (Boolean(recent[i - 1]?.probeOk) !== Boolean(recent[i]?.probeOk)) transitionCount += 1;
    }

    const okCount = recent.filter((row) => row?.probeOk).length;
    const failCount = recent.filter((row) => row && !row.probeOk).length;
    const latest = recent[recent.length - 1] || null;
    const lastError = recent.slice().reverse().find((row) => row && !row.probeOk)?.probeError || null;

    let status = 'stable';
    if (recent.length < 2) status = 'warming_up';
    else if (failCount > 0 && transitionCount >= 2) status = 'flapping';
    else if (latest && !latest.probeOk) status = 'degraded';

    return { status, okCount, failCount, transitionCount, lastError, latest };
  } catch (error) {
    return {
      status: 'unknown',
      okCount: 0,
      failCount: 0,
      transitionCount: 0,
      lastError: error?.message || String(error),
      latest: null,
    };
  }
}

function getLocalStandbySummary() {
  if (!LOCAL_STANDBY_ENABLED) {
    return 'standby 비활성화됨 (Groq 우선)';
  }
  try {
    const output = execSync(`lsof -nP -iTCP:${SECONDARY_LOCAL_PORT} -sTCP:LISTEN`, { encoding: 'utf8' });
    return output.trim() ? `standby 준비됨 (127.0.0.1:${SECONDARY_LOCAL_PORT})` : `standby 없음 (127.0.0.1:${SECONDARY_LOCAL_PORT})`;
  } catch {
    return `standby 없음 (127.0.0.1:${SECONDARY_LOCAL_PORT})`;
  }
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
    const ownership = getServiceOwnership(label);

    // 1. 미로드 감지
    if (!svc) {
      if (isElixirOwnedService(label) || isRetiredService(label)) {
        hsm.clearAlert(state, `unloaded:${label}`);
        continue;
      }

      const key = `unloaded:${label}`;
      if (hsm.canAlert(state, key)) {
        const ownerHint = ownership?.owner === 'launchd' ? '' : `\nownership=${ownership?.owner || 'unknown'}`;
        issues.push({ key, level: hsm.getAlertLevel(label), msg: `🔴 [루나 헬스] ${shortName} 미로드\nlaunchd에 등록되지 않음 → 수동 확인 필요${ownerHint}` });
      }
      continue;
    }

    // 미로드 → 회복
    if (state[`unloaded:${label}`]) {
      recovers.push({ key: `unloaded:${label}`, msg: `✅ [루나 헬스] ${shortName} 회복\nlaunchd 정상 로드 — 자동 감지` });
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
        recovers.push({ key: `down:${label}`, msg: `✅ [루나 헬스] ${shortName} 회복\nPID 정상 확인 — 자동 감지` });
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
        recovers.push({ key: `exitcode:${label}:0`, msg: `✅ [루나 헬스] ${shortName} 회복\nexit code 정상 (0) — 자동 감지` });
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
      recovers.push({ key: 'trade-review-integrity', msg: `✅ [루나 헬스] trade_review 정합성 회복\n거래 리뷰 누락/불일치 없음 — 자동 감지` });
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

  try {
    const learningLoop = await buildRuntimeLearningLoopReport({ days: 14, json: true });
    if (learningLoop?.decision?.status === 'regime_strategy_tuning_needed') {
      const key = 'learning-loop-regime-tuning';
      const topSuggestion = learningLoop?.sections?.strategy?.runtimeSuggestionTop || null;
      const latestOpsSnapshot = loadLatestOpsSnapshot();
      const { weakest: latestWeakest, weakestMode: latestWeakestMode } = getWeakestRegimeSummary(
        latestOpsSnapshot?.health?.runtimeLearningLoop,
      );
      if (hsm.canAlert(state, key)) {
        issues.push({
          key,
          level: 2,
          msg: `⚠️ [루나 헬스] regime strategy tuning\n${learningLoop.decision.headline}\nweakest: ${learningLoop?.sections?.collect?.regimePerformance?.weakestRegime?.regime || 'n/a'} / ${learningLoop?.sections?.collect?.regimePerformance?.weakestRegime?.worstMode?.tradeMode || 'n/a'}\ntop suggestion: ${topSuggestion?.key || 'n/a'} -> ${topSuggestion?.suggested ?? 'n/a'} (${topSuggestion?.action || 'n/a'})${latestOpsSnapshot?.capturedAt ? `\nlatest snapshot: ${latestOpsSnapshot.capturedAt} / ${latestWeakest?.regime || 'n/a'} / ${latestWeakestMode}` : ''}\nnext command: npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime-suggest -- --json`,
        });
      }
    } else if (state['learning-loop-regime-tuning']) {
      recovers.push({
        key: 'learning-loop-regime-tuning',
        msg: '✅ [루나 헬스] regime strategy tuning 회복\n현재 learning loop 기준 레짐 튜닝 긴급 신호 없음 — 자동 감지',
      });
      hsm.clearAlert(state, 'learning-loop-regime-tuning');
    }
  } catch (e) {
    const key = 'learning-loop-check-failed';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 2,
        msg: `⚠️ [루나 헬스] learning loop 점검 실패\n${e.message}`,
      });
    }
  }

  hsm.clearAlert(state, 'local-llm-standby-missing');

  const localLlmTrend = loadRecentLocalProbeTrend();
  if (localLlmTrend.status === 'flapping') {
    const key = 'local-llm-flapping';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 3,
        msg: `⚠️ [루나 헬스] local LLM flapping\n최근 probe ok ${localLlmTrend.okCount} / fail ${localLlmTrend.failCount} / 전환 ${localLlmTrend.transitionCount}회\n11434는 embeddings 전용이며, chat 경로는 Groq 우선${localLlmTrend.lastError ? `\nlast error: ${localLlmTrend.lastError}` : ''}`,
      });
    }
  } else if (localLlmTrend.status === 'degraded') {
    const key = 'local-llm-degraded';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 2,
        msg: `⚠️ [루나 헬스] local LLM degraded\n최근 embeddings probe 실패\n11434는 embeddings 전용이며, chat 경로는 Groq 우선${localLlmTrend.lastError ? `\n${localLlmTrend.lastError}` : ''}`,
      });
    }
  } else {
    ['local-llm-flapping', 'local-llm-degraded'].forEach((key) => {
      if (state[key]) {
        recovers.push({ key, msg: `✅ [루나 헬스] local LLM 회복\n최근 생성 probe 기준 ${localLlmTrend.status} 상태 — 자동 감지` });
        hsm.clearAlert(state, key);
      }
    });
  }

  // 이슈 알림 발송
  for (const { key, level, msg } of issues) {
    console.warn(`[루나 헬스체크] 이슈: ${msg}`);
    const memoryHints = await buildIssueHints(key, msg);
    await notify(`${msg}${memoryHints}`, level);
    await rememberHealthEvent(key, 'issue', msg, level);
    hsm.recordAlert(state, key);
  }

  // 회복 알림 발송
  for (const { key, msg } of recovers) {
    await notify(msg, 1);
    await rememberHealthEvent(key, 'recovery', msg, 1);
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
