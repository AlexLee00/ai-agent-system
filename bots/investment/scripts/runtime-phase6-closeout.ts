#!/usr/bin/env node
// @ts-nocheck
/**
 * runtime-phase6-closeout.ts
 *
 * Phase 6 (부분조정/청산/회고) 현황 보고 + dry-run 실행.
 * --dry-run: 후보 목록만 출력 (실행 없음)
 * --execute: 완전자율 autopilot에서 실행 (autopilot dispatch 경유)
 */

import * as db from '../shared/db.ts';
import { buildLifecycleAuditReport } from './runtime-lifecycle-audit.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { dryRun: false, execute: false, json: false, days: 7 };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    if (raw === '--execute') args.execute = true;
    if (raw === '--json') args.json = true;
    if (raw.startsWith('--days=')) args.days = Math.max(1, Number(raw.split('=')[1] || 7));
  }
  return args;
}

async function loadPhase6Candidates() {
  return db.query(`
    SELECT p.symbol, p.exchange, p.trade_mode,
           p.strategy_state->>'latestRecommendation' AS recommendation,
           p.strategy_state->>'latestReasonCode' AS reason_code,
           p.strategy_state->>'latestPartialExitRatio' AS partial_exit_ratio,
           p.strategy_state->>'latestFamilyPerformanceBias' AS family_bias,
           p.last_evaluation_at,
           p.updated_at
    FROM investment.position_strategy_profiles p
    WHERE p.status = 'active'
      AND p.strategy_state->>'latestRecommendation' IN ('ADJUST', 'EXIT')
    ORDER BY p.updated_at DESC
  `).catch(() => []);
}

async function loadPendingCloseoutReviews({ days = 7 } = {}) {
  return db.query(`
    SELECT id, symbol, exchange, trade_mode, closeout_type, closeout_reason,
           planned_ratio, executed_ratio, review_status,
           pnl_realized, regime, setup_type, strategy_family, family_bias,
           created_at, reviewed_at
    FROM investment.position_closeout_reviews
    WHERE created_at >= now() - ($1::int * INTERVAL '1 day')
    ORDER BY created_at DESC
    LIMIT 50
  `, [days]).catch(() => []);
}

async function buildPhase6Report({ days = 7 } = {}) {
  await db.initSchema();

  const [candidates, reviews, lifecycleAudit] = await Promise.all([
    loadPhase6Candidates(),
    loadPendingCloseoutReviews({ days }),
    buildLifecycleAuditReport({ days }),
  ]);

  const pendingReviews = reviews.filter((r) => r.review_status === 'pending');
  const failedReviews = reviews.filter((r) => r.review_status === 'failed');
  const completedReviews = reviews.filter((r) => r.review_status === 'completed');

  return {
    ok: true,
    days,
    generatedAt: new Date().toISOString(),
    candidates: {
      total: candidates.length,
      adjust: candidates.filter((c) => c.recommendation === 'ADJUST').length,
      exit: candidates.filter((c) => c.recommendation === 'EXIT').length,
      rows: candidates,
    },
    closeoutReviews: {
      total: reviews.length,
      pending: pendingReviews.length,
      failed: failedReviews.length,
      completed: completedReviews.length,
      rows: reviews,
    },
    lifecycleAudit: {
      phase6CoverageRatePct: lifecycleAudit.phase6Coverage?.coverageRatePct ?? null,
      gaps: lifecycleAudit.phase6Coverage?.gaps?.length ?? 0,
      warnings: lifecycleAudit.warnings,
    },
  };
}

function renderText(payload) {
  const lines = [
    '⚡ Phase 6 Closeout 현황',
    `period: ${payload.days}d | generatedAt: ${payload.generatedAt}`,
    '',
    `후보: total=${payload.candidates.total} (ADJUST=${payload.candidates.adjust}, EXIT=${payload.candidates.exit})`,
    `closeout reviews: total=${payload.closeoutReviews.total} (pending=${payload.closeoutReviews.pending}, failed=${payload.closeoutReviews.failed}, completed=${payload.closeoutReviews.completed})`,
    `lifecycle coverage: ${payload.lifecycleAudit.phase6CoverageRatePct ?? 'n/a'}% (gaps=${payload.lifecycleAudit.gaps})`,
    '',
  ];
  if (payload.candidates.rows.length > 0) {
    lines.push('후보 목록:');
    for (const c of payload.candidates.rows) {
      lines.push(`  - ${c.symbol} ${c.exchange} ${c.trade_mode} → ${c.recommendation} (${c.reason_code || '-'}) bias=${c.family_bias || '-'}`);
    }
    lines.push('');
  }
  if (payload.lifecycleAudit.warnings.length > 0) {
    lines.push('경고:');
    for (const w of payload.lifecycleAudit.warnings) lines.push(`  ⚠️  ${w}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  const payload = await buildPhase6Report(args);

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(renderText(payload));

  if (args.execute) {
    console.log('');
    console.log('⚡ execute 모드: runtime-position-runtime-dispatch를 통해 phase6 후보를 처리하세요.');
    console.log('   npm run runtime:position-runtime-dispatch -- --phase6 --confirm=phase6-autopilot');
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-phase6-closeout 오류:',
  });
}

export { buildPhase6Report };
