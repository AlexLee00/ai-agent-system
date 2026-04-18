#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/luna-shadow-auto-promote.ts — Shadow 3일 자동 검증 알림
 *
 * 체크:
 *   - luna_v2_shadow_comparison 최근 72시간(3일) 레코드 수 ≥ 50건
 *   - avg_similarity ≥ 0.85
 *
 * 조건 충족 시: Telegram general 채널에 마스터 승인 요청 메시지 전송
 * 자동 LIVE flip 하지 않음 — 마스터 최종 결정 필수
 *
 * 실행:
 *   node scripts/luna-shadow-auto-promote.ts
 *   node scripts/luna-shadow-auto-promote.ts --dry-run
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const path = require('path');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const { pool, query } = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const telegramSender   = require(path.join(PROJECT_ROOT, 'packages/core/lib/telegram-sender'));
const { today }        = require(path.join(PROJECT_ROOT, 'packages/core/lib/kst'));

const DRY_RUN = process.argv.includes('--dry-run');

const REQUIRED_RUNS    = 50;
const REQUIRED_SIM     = 0.85;
const WINDOW_HOURS     = 72;

// ─── DB 집계 ──────────────────────────────────────────────────────

async function fetchShadowStats(): Promise<{
  runs: number;
  avg_similarity: number;
  sufficient: boolean;
}> {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(*)                          AS runs,
         COALESCE(AVG(similarity_score), 0) AS avg_similarity
       FROM luna_v2_shadow_comparison
       WHERE created_at > NOW() - INTERVAL '${WINDOW_HOURS} hours'`
    );
    const runs          = parseInt(rows[0]?.runs ?? 0, 10);
    const avg_similarity = parseFloat(rows[0]?.avg_similarity ?? 0);
    return {
      runs,
      avg_similarity,
      sufficient: runs >= REQUIRED_RUNS && avg_similarity >= REQUIRED_SIM,
    };
  } catch (e) {
    console.error('[shadow-auto-promote] DB 조회 실패:', e?.message ?? e);
    return { runs: 0, avg_similarity: 0, sufficient: false };
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`[luna-shadow-auto-promote] 시작 (dry-run=${DRY_RUN})`);
  console.log(`  조건: runs ≥ ${REQUIRED_RUNS}, avg_similarity ≥ ${REQUIRED_SIM} (최근 ${WINDOW_HOURS}h)`);

  const stats = await fetchShadowStats();
  console.log(`  실제: runs=${stats.runs}, avg_similarity=${stats.avg_similarity.toFixed(4)}, 충족=${stats.sufficient}`);

  if (!stats.sufficient) {
    const remaining = Math.max(0, REQUIRED_RUNS - stats.runs);
    console.log(`[shadow-auto-promote] 조건 미충족 — 대기 중 (추가 필요: ${remaining}건)`);
    await pool.end();
    return;
  }

  const message = `🚀 [루나] Shadow 3일 검증 완료 — 마스터 승인 필요

Shadow 통계 (최근 72h):
  실행 수: ${stats.runs}건 (≥${REQUIRED_RUNS} ✅)
  유사도:  ${stats.avg_similarity.toFixed(4)} (≥${REQUIRED_SIM} ✅)
  기준일:  ${today()}

▶ 국내주식 LIVE 전환 승인 시:
  launchctl setenv LUNA_LIVE_DOMESTIC true

▶ 미국주식 LIVE 전환 승인 시:
  launchctl setenv LUNA_LIVE_OVERSEAS true

⚠️ 자동 전환 없음 — 마스터 직접 명령 필요`;

  console.log(`\n${message}`);

  if (!DRY_RUN) {
    try {
      await telegramSender.send('general', message);
      console.log('[shadow-auto-promote] general 채널 전송 완료');
    } catch (e) {
      console.error('[shadow-auto-promote] 전송 실패:', e?.message ?? e);
    }
  }

  console.log('[shadow-auto-promote] 완료');
  await pool.end();
}

main().catch((e) => {
  console.error('[luna-shadow-auto-promote] 오류:', e);
  process.exit(1);
});
