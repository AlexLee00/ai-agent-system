#!/usr/bin/env node
// @ts-nocheck
/**
 * runtime-phase6-feedback-suggestions.ts
 *
 * Phase 6 closeout review 결과를 분석해 runtime config suggestion으로 이어지는 피드백 루프.
 *
 * 논리:
 *   1. 최근 closeout review에서 family/setupType별 성과를 집계
 *   2. 낮은 성과 (avgPnl < threshold, winRate < threshold) → downweight suggestion
 *   3. 좋은 성과 → upweight 또는 현행 유지 suggestion
 *   4. governance allow 키 → runtime-suggest apply 후보
 *   5. governance escalate 키 → 알림 + review 상태로 보류
 *
 * 완료 기준: closeout review 3건 이상 → suggestion preview 생성
 */

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { annotateRuntimeSuggestions, getParameterGovernance } from '../shared/runtime-parameter-governance.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { days: 30, minSamples: 3, json: false };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    if (raw.startsWith('--days=')) args.days = Math.max(1, Number(raw.split('=')[1] || 30));
    if (raw.startsWith('--min-samples=')) args.minSamples = Math.max(1, Number(raw.split('=')[1] || 3));
  }
  return args;
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function aggregateCloseoutResults({ days = 30 } = {}) {
  return db.query(`
    SELECT
      COALESCE(NULLIF(strategy_family, ''), 'unknown') AS strategy_family,
      COALESCE(NULLIF(setup_type, ''), 'unknown')       AS setup_type,
      COALESCE(NULLIF(family_bias, ''), 'unknown')       AS family_bias,
      closeout_type,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE review_status IN ('completed', 'failed')) AS closed,
      COUNT(*) FILTER (WHERE review_status = 'completed' AND COALESCE(pnl_realized, 0) > 0) AS wins,
      ROUND(AVG(CASE WHEN review_status = 'completed' THEN pnl_realized ELSE NULL END)::numeric, 4) AS avg_pnl,
      ROUND(
        AVG(CASE WHEN review_status = 'completed' AND planned_notional > 0
          THEN (pnl_realized / planned_notional) * 100
          ELSE NULL END)::numeric, 4
      ) AS avg_pnl_pct,
      ROUND(AVG(CASE WHEN review_status = 'completed' THEN slippage_pct ELSE NULL END)::numeric, 4) AS avg_slippage,
      MAX(created_at) AS latest_at
    FROM investment.position_closeout_reviews
    WHERE created_at >= now() - ($1::int * INTERVAL '1 day')
    GROUP BY 1, 2, 3, 4
    ORDER BY total DESC
  `, [days]).catch(() => []);
}

function buildSuggestions(rows, minSamples = 3) {
  const suggestions = [];
  for (const row of rows) {
    const total = safeNumber(row.total);
    const closed = safeNumber(row.closed);
    const wins = safeNumber(row.wins);
    if (total < minSamples) continue;

    const winRate = closed > 0 ? wins / closed : null;
    const avgPnlPct = row.avg_pnl_pct != null ? safeNumber(row.avg_pnl_pct) : null;
    const avgSlippage = row.avg_slippage != null ? safeNumber(row.avg_slippage) : null;
    const family = row.strategy_family;
    const setupType = row.setup_type;
    const bias = row.family_bias;
    const closeoutType = row.closeout_type;

    // 저성과: avgPnl% < -2% 또는 winRate < 40%
    if (avgPnlPct != null && avgPnlPct < -2) {
      suggestions.push({
        key: `strategy_family.${family}.partialExitRatioBias`,
        action: 'increase',
        delta: 0.1,
        reason: `avg pnl ${avgPnlPct.toFixed(2)}% < -2% (${total} samples, ${closeoutType})`,
        priority: 'allow',
        context: { family, setupType, bias, closeoutType, total, winRate, avgPnlPct },
      });
      if (setupType !== 'unknown') {
        suggestions.push({
          key: `setup_type.${setupType}.stopLossPct`,
          action: 'decrease',
          delta: 0.005,
          reason: `avg pnl ${avgPnlPct.toFixed(2)}% < -2% → tighter stop loss`,
          priority: 'allow',
          context: { family, setupType, bias, closeoutType, total },
        });
      }
    }

    if (winRate != null && winRate < 0.4 && closed >= minSamples) {
      suggestions.push({
        key: `strategy_family.${family}.reentryLock`,
        action: 'set',
        value: true,
        reason: `win rate ${(winRate * 100).toFixed(1)}% < 40% → reentry lock 권고`,
        priority: 'escalate',
        context: { family, setupType, bias, closeoutType, total, winRate },
      });
    }

    // 고성과: avgPnl% > 3% 이상
    if (avgPnlPct != null && avgPnlPct > 3 && winRate != null && winRate > 0.6) {
      suggestions.push({
        key: `strategy_family.${family}.partialExitRatioBias`,
        action: 'decrease',
        delta: 0.05,
        reason: `avg pnl ${avgPnlPct.toFixed(2)}% > 3%, win ${(winRate * 100).toFixed(1)}% → partial exit 줄여서 수익 연장`,
        priority: 'allow',
        context: { family, setupType, bias, closeoutType, total, winRate, avgPnlPct },
      });
    }

    // 높은 슬리피지
    if (avgSlippage != null && avgSlippage > 0.5) {
      suggestions.push({
        key: `execution.slippage_guard.${closeoutType}`,
        action: 'tighten',
        delta: 0.1,
        reason: `avg slippage ${avgSlippage.toFixed(2)}% > 0.5% → execution timing/limit order 검토`,
        priority: 'escalate',
        context: { family, setupType, closeoutType, avgSlippage, total },
      });
    }
  }
  return suggestions;
}

export async function buildPhase6FeedbackSuggestions({ days = 30, minSamples = 3 } = {}) {
  await db.initSchema();

  const aggregated = await aggregateCloseoutResults({ days });
  const suggestions = buildSuggestions(aggregated, minSamples);

  let annotated = [];
  try {
    const governance = await getParameterGovernance();
    annotated = annotateRuntimeSuggestions(suggestions, governance);
  } catch {
    annotated = suggestions.map((s) => ({ ...s, governanceStatus: s.priority || 'unknown' }));
  }

  const allowSuggestions = annotated.filter((s) => s.governanceStatus === 'allow' || s.priority === 'allow');
  const escalateSuggestions = annotated.filter((s) => s.governanceStatus === 'escalate' || s.priority === 'escalate');
  const blockSuggestions = annotated.filter((s) => s.governanceStatus === 'block');

  const totalSamples = aggregated.reduce((sum, r) => sum + safeNumber(r.total), 0);
  const status = suggestions.length === 0 && totalSamples < minSamples
    ? 'waiting_samples'
    : suggestions.length === 0
      ? 'no_suggestions'
      : 'has_suggestions';

  return {
    ok: true,
    days,
    minSamples,
    generatedAt: new Date().toISOString(),
    status,
    totalSamples,
    aggregatedBuckets: aggregated.length,
    suggestionCount: suggestions.length,
    allowCount: allowSuggestions.length,
    escalateCount: escalateSuggestions.length,
    blockCount: blockSuggestions.length,
    allowSuggestions,
    escalateSuggestions,
    blockSuggestions,
    aggregated,
  };
}

function renderText(payload) {
  const lines = [
    '🔄 Phase 6 Feedback Suggestions',
    `period: ${payload.days}d | status: ${payload.status}`,
    `samples: ${payload.totalSamples} | buckets: ${payload.aggregatedBuckets} | suggestions: ${payload.suggestionCount}`,
    `allow=${payload.allowCount}, escalate=${payload.escalateCount}, block=${payload.blockCount}`,
    '',
  ];

  if (payload.allowSuggestions.length > 0) {
    lines.push('✅ Allow (자동 적용 후보):');
    for (const s of payload.allowSuggestions) {
      lines.push(`  - [${s.key}] ${s.action}${s.delta != null ? ` ${s.delta}` : ''} | ${s.reason}`);
    }
    lines.push('');
  }
  if (payload.escalateSuggestions.length > 0) {
    lines.push('⚠️  Escalate (운영 검토 필요):');
    for (const s of payload.escalateSuggestions) {
      lines.push(`  - [${s.key}] ${s.action} | ${s.reason}`);
    }
    lines.push('');
  }
  if (payload.status === 'waiting_samples') {
    lines.push(`ℹ️  closeout review 표본이 ${payload.minSamples}건 미만. 실행 후 다시 확인하세요.`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  const payload = await buildPhase6FeedbackSuggestions(args);
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else console.log(renderText(payload));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-phase6-feedback-suggestions 오류:',
  });
}

export default { buildPhase6FeedbackSuggestions };
