#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/luna-weekly-review.ts — 루나팀 주간 리뷰
 *
 * 집계:
 *   - Strategy Registry 승격/강등 7일
 *   - Validation 결과 분포 7일
 *   - Agentic RAG 품질 추세 7일
 *
 * 전송: general 채널 (마스터 주간 확인용)
 *
 * 실행:
 *   node scripts/luna-weekly-review.ts
 *   node scripts/luna-weekly-review.ts --dry-run
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const path = require('path');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const { pool, query } = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const telegramSender   = require(path.join(PROJECT_ROOT, 'packages/core/lib/telegram-sender'));
const { today }        = require(path.join(PROJECT_ROOT, 'packages/core/lib/kst'));

const DRY_RUN = process.argv.includes('--dry-run');

// ─── DB 집계 ──────────────────────────────────────────────────────

async function fetchValidationStats7d() {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE verdict->>'verdict' = 'promote') AS promotions,
         COUNT(*) FILTER (WHERE verdict->>'verdict' = 'demote')  AS demotions,
         COUNT(*) FILTER (WHERE verdict->>'verdict' = 'hold')    AS holds,
         COUNT(*)                                                  AS total
       FROM luna_strategy_validation_runs
       WHERE created_at > NOW() - INTERVAL '7 days'`
    );
    return rows[0] ?? { promotions: 0, demotions: 0, holds: 0, total: 0 };
  } catch {
    return { promotions: 0, demotions: 0, holds: 0, total: 0 };
  }
}

async function fetchRagQualityTrend7d() {
  try {
    const { rows } = await query(
      `SELECT
         COALESCE(AVG((metrics->>'quality')::float), 0) AS avg_quality,
         COALESCE(MIN((metrics->>'quality')::float), 0) AS min_quality,
         COALESCE(MAX((metrics->>'quality')::float), 0) AS max_quality,
         COUNT(*)                                        AS samples
       FROM luna_strategy_validation_runs
       WHERE created_at > NOW() - INTERVAL '7 days'
         AND metrics ? 'quality'`
    );
    return rows[0] ?? { avg_quality: 0, min_quality: 0, max_quality: 0, samples: 0 };
  } catch {
    return { avg_quality: 0, min_quality: 0, max_quality: 0, samples: 0 };
  }
}

async function fetchPnl7d() {
  try {
    const { rows } = await query(
      `SELECT
         market,
         COUNT(*)              AS trades,
         COALESCE(AVG(pnl_pct), 0) AS avg_pnl
       FROM investment.trade_history
       WHERE closed_at > NOW() - INTERVAL '7 days'
       GROUP BY market`
    );
    return rows;
  } catch {
    return [];
  }
}

// ─── 리포트 빌드 ──────────────────────────────────────────────────

function buildWeeklyReport(validation: any, rag: any, pnlRows: any[]) {
  const pnlLines = pnlRows.map((r: any) => {
    const sign = r.avg_pnl >= 0 ? '+' : '';
    return `  ${r.market}: ${sign}${(r.avg_pnl * 100).toFixed(2)}% (${r.trades}건)`;
  }).join('\n') || '  데이터 없음';

  return `📈 [루나] 주간 리뷰 (${today()})
━━━━━━━━━━━━━━━━━━━
[전략 검증 7일]
  승격: ${validation.promotions}건
  강등: ${validation.demotions}건
  유지: ${validation.holds}건
  총계: ${validation.total}건
━━━━━━━━━━━━━━━━━━━
[PnL 7일]
${pnlLines}
━━━━━━━━━━━━━━━━━━━
[RAG 품질 추세 7일]
  평균: ${parseFloat(rag.avg_quality).toFixed(3)}
  최저: ${parseFloat(rag.min_quality).toFixed(3)}
  최고: ${parseFloat(rag.max_quality).toFixed(3)}
  샘플: ${rag.samples}건`;
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`[luna-weekly-review] 시작 (dry-run=${DRY_RUN})`);

  const [validation, rag, pnlRows] = await Promise.all([
    fetchValidationStats7d(),
    fetchRagQualityTrend7d(),
    fetchPnl7d(),
  ]);

  const report = buildWeeklyReport(validation, rag, pnlRows);
  console.log(`\n${report}`);

  if (!DRY_RUN) {
    try {
      await telegramSender.send('general', report);
      console.log('[luna-weekly-review] 전송 완료');
    } catch (e) {
      console.error('[luna-weekly-review] 전송 실패:', e?.message ?? e);
    }
  }

  console.log('[luna-weekly-review] 완료');
  await pool.end();
}

main().catch((e) => {
  console.error('[luna-weekly-review] 오류:', e);
  process.exit(1);
});
