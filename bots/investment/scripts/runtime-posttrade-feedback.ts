#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/runtime-posttrade-feedback.ts — Phase A/B/C 오케스트레이터
 *
 * 종료된 거래에 대해 순서대로 실행:
 *   Phase A: Trade Quality Score 4-차원 평가
 *   Phase B: Stage Attribution 분석
 *   Phase C: Reflexion + Hindsight (rejected 거래만)
 *
 * 사용:
 *   node runtime-posttrade-feedback.ts [--limit=N] [--dry-run] [--trade-id=N] [--json]
 *
 * Kill switches (config.yaml posttrade_feedback.*):
 *   LUNA_TRADE_QUALITY_EVALUATOR_ENABLED
 *   LUNA_STAGE_ATTRIBUTION_ENABLED
 *   LUNA_REFLEXION_ENGINE_ENABLED
 */

import * as db from '../shared/db.ts';
import { getPosttradeFeedbackConfig } from '../shared/runtime-config.ts';
import { evaluateTradeQuality, fetchPendingTradeIds } from '../shared/trade-quality-evaluator.ts';
import { analyzeStageAttribution } from '../shared/stage-attribution-analyzer.ts';
import { runReflexion } from '../shared/reflexion-engine.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { limit: 20, dryRun: false, tradeId: null, json: false };
  for (const raw of argv) {
    if (raw === '--dry-run')                        args.dryRun = true;
    else if (raw === '--json')                      args.json = true;
    else if (raw.startsWith('--limit='))            args.limit = Math.max(1, Number(raw.split('=')[1]) || 20);
    else if (raw.startsWith('--trade-id='))         args.tradeId = Number(raw.split('=')[1]);
  }
  return args;
}

async function runPosttradeFeedback(args) {
  const cfg = getPosttradeFeedbackConfig();
  const enabledA = cfg.trade_quality?.enabled ?? false;
  const enabledB = cfg.stage_attribution?.enabled ?? false;
  const enabledC = cfg.reflexion?.enabled ?? false;

  console.log(`[PosttradeFeedback] enabled: A=${enabledA} B=${enabledB} C=${enabledC} dryRun=${args.dryRun}`);

  if (!enabledA && !enabledB && !enabledC) {
    console.log('[PosttradeFeedback] 모든 Phase 비활성 — Kill switch: posttrade_feedback.*.enabled=false');
    return { skipped: true, reason: 'all_disabled' };
  }

  // 처리할 trade ID 목록 결정
  let tradeIds: number[];
  if (args.tradeId) {
    tradeIds = [args.tradeId];
  } else {
    tradeIds = await fetchPendingTradeIds(args.limit);
  }

  if (tradeIds.length === 0) {
    console.log('[PosttradeFeedback] 처리할 거래 없음 (모두 이미 평가됨)');
    return { processed: 0 };
  }

  console.log(`[PosttradeFeedback] 처리 대상: ${tradeIds.length}건`);

  const results = { preferred: 0, neutral: 0, rejected: 0, errors: 0, reflexions: 0 };

  for (const tradeId of tradeIds) {
    try {
      // ── Phase A: Trade Quality Score ──────────────────────────────────────
      let quality = null;
      if (enabledA) {
        quality = await evaluateTradeQuality(tradeId, { dryRun: args.dryRun });
        if (quality) {
          results[quality.category]++;
          console.log(`[A] trade=${tradeId} overall=${quality.overall_score.toFixed(3)} category=${quality.category}`);
        }
      } else {
        // Phase A 비활성 시 DB에서 기존 결과 조회
        quality = await db.get(
          `SELECT * FROM investment.trade_quality_evaluations WHERE trade_id = $1`,
          [tradeId]
        );
      }

      if (!quality) continue;

      const pnlPct = quality.sub_score_breakdown?.pnl_pct
        ?? quality.sub_score_breakdown?.market_decision_score
        ?? 0;

      // ── Phase B: Stage Attribution ────────────────────────────────────────
      let stageAttrs = [];
      if (enabledB) {
        stageAttrs = await analyzeStageAttribution(tradeId, Number(pnlPct), { dryRun: args.dryRun });
        if (stageAttrs.length > 0) {
          console.log(`[B] trade=${tradeId} stages=${stageAttrs.length}`);
        }
      }

      // ── Phase C: Reflexion (rejected만) ───────────────────────────────────
      if (enabledC && quality.category === 'rejected') {
        const reflexion = await runReflexion(quality, stageAttrs, { dryRun: args.dryRun });
        if (reflexion) {
          results.reflexions++;
          console.log(`[C] trade=${tradeId} hindsight="${reflexion.hindsight?.slice(0, 60)}..."`);
        }
      }

    } catch (err) {
      results.errors++;
      console.error(`[PosttradeFeedback] trade=${tradeId} 처리 오류:`, err);
    }
  }

  console.log(`[PosttradeFeedback] 완료 — preferred:${results.preferred} neutral:${results.neutral} rejected:${results.rejected} reflexions:${results.reflexions} errors:${results.errors}`);

  return { processed: tradeIds.length, ...results };
}

async function main() {
  const args = parseArgs();
  await db.initSchema();
  const result = await runPosttradeFeedback(args);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  }
  return result;
}

if (isDirectExecution(import.meta.url)) {
  runCliMain(main);
}

export { runPosttradeFeedback };
