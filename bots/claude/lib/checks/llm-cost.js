'use strict';

/**
 * checks/llm-cost.js — LLM API 비용 모니터링
 *
 * 점검 항목:
 *   1. 오늘 LLM API 호출 건수 및 비용 (token-tracker 데이터 기반)
 *   2. 팀별 당일 비용 집계
 *   3. 예산 대비 사용률 (월간 $10 기준, warn: 80%, error: 100%)
 *   4. 전일 대비 비용 200% 초과 급증 → warn
 *
 * 데이터 소스: bots/orchestrator/lib/token-tracker.js
 *   → claude-team.db의 token_usage 테이블
 */

const path = require('path');

// 월간 예산 한도 (USD) — 마스터 승인 후 변경
const MONTHLY_BUDGET_USD = 10;

// ── token-tracker 로드 (없으면 스킵) ──────────────────────────────

function loadTokenTracker() {
  try {
    return require(path.join(__dirname, '..', '..', '..', 'orchestrator', 'lib', 'token-tracker'));
  } catch {
    return null;
  }
}

// ── KST 날짜 문자열 ────────────────────────────────────────────────

function kstDate(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().split('T')[0];
}

function kstMonth() {
  return kstDate().slice(0, 7);
}

// ── 메인 run ──────────────────────────────────────────────────────

async function run() {
  const items = [];
  const tracker = loadTokenTracker();

  if (!tracker) {
    items.push({
      label:  'LLM 비용 추적',
      status: 'ok',
      detail: '토큰 트래커 미연결 (token-tracker.js 없음)',
    });
    return { name: 'LLM 비용', status: 'ok', items };
  }

  try {
    // 1. 오늘 일간 요약
    const today     = kstDate();
    const yesterday = kstDate(-1);
    const todaySummary     = await tracker.getDailySummary(today);
    const yesterdaySummary = await tracker.getDailySummary(yesterday);

    const todayCalls  = todaySummary?.total_calls  || 0;
    const todayCostUsd = todaySummary?.total_cost_usd || 0;
    const yesterdayCostUsd = yesterdaySummary?.total_cost_usd || 0;

    items.push({
      label:  `오늘 LLM 호출 (${today})`,
      status: 'ok',
      detail: `${todayCalls}건 / $${todayCostUsd.toFixed(4)}`,
    });

    // 2. 전일 대비 급증 감지
    if (yesterdayCostUsd > 0 && todayCostUsd > yesterdayCostUsd * 2) {
      items.push({
        label:  'LLM 비용 급증',
        status: 'warn',
        detail: `오늘 $${todayCostUsd.toFixed(4)} vs 어제 $${yesterdayCostUsd.toFixed(4)} (+${Math.round((todayCostUsd / yesterdayCostUsd - 1) * 100)}%) — 비정상 급증`,
      });
    }

    // 3. 월간 예산 대비 사용률
    const monthReport = await tracker.buildCostReport();
    const monthlyCost = monthReport?.monthly_total_usd || 0;
    const usageRatio  = monthlyCost / MONTHLY_BUDGET_USD;

    let budgetStatus = 'ok';
    if (usageRatio >= 1.0)      budgetStatus = 'error';
    else if (usageRatio >= 0.8) budgetStatus = 'warn';

    items.push({
      label:  `월간 예산 사용률 (${kstMonth()})`,
      status: budgetStatus,
      detail: `$${monthlyCost.toFixed(3)} / $${MONTHLY_BUDGET_USD} (${Math.round(usageRatio * 100)}%)`,
    });

    // 4. 팀별 당일 비용 (summary에 teams 데이터가 있으면)
    if (todaySummary?.by_team) {
      for (const [team, data] of Object.entries(todaySummary.by_team)) {
        if (data.cost_usd > 0) {
          items.push({
            label:  `팀별 비용: ${team}`,
            status: 'ok',
            detail: `${data.calls}건 / $${data.cost_usd.toFixed(4)}`,
          });
        }
      }
    }

  } catch (e) {
    items.push({
      label:  'LLM 비용 조회 오류',
      status: 'warn',
      detail: e.message,
    });
  }

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   'LLM 비용',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

module.exports = { run };
