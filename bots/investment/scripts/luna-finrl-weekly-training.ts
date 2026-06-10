#!/usr/bin/env node
// @ts-nocheck
/**
 * 매주 일요일 02:00 KST — FinRL-X 주간 학습 실행
 * launchd: ai.luna.finrl-weekly-training.plist
 */

import { runWeeklyFinRLTraining } from '../shared/luna-finrl-orchestrator.ts';
import { maybeSkipForMemory } from '../shared/memory-pressure-guard.ts';

const MARKETS = ['crypto', 'stocks'];
const TRAINING_ENABLED = process.env.LUNA_FINRL_WEEKLY_TRAINING_ENABLED === 'true';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    dryRun: argv.includes('--dry-run') || !TRAINING_ENABLED,
    json: argv.includes('--json'),
  };
}

function compactResult(result) {
  const report = result.learningReport as any;
  return {
    market: result.market,
    overallSuccess: result.overallSuccess,
    totalDurationMs: result.totalDurationMs,
    dryRun: result.dryRun,
    writeApplied: result.writeApplied,
    layers: (result.layers || []).map((layer) => ({
      market: layer.market,
      layer: layer.layer,
      success: layer.success,
      durationMs: layer.durationMs,
      error: layer.error,
    })),
    learningReport: report
      ? {
          weekStart: report.weekStart,
          weekEnd: report.weekEnd,
          totalTrades: report.totalTrades,
          avgReward: report.avgReward,
          expertAgentCount: report.expertAgents?.length ?? 0,
          noviceAgentCount: report.noviceAgents?.length ?? 0,
          topMutation: report.topMutation,
          learningVelocity: report.learningVelocity,
          nextWeekFocus: report.nextWeekFocus,
        }
      : null,
  };
}

async function main() {
  const options = parseArgs();
  if (maybeSkipForMemory('luna.finrl-weekly-training', { json: options.json })) return;
  const date = new Date().toISOString().split('T')[0];
  const prefix = options.dryRun ? '[FinRLWeekly][DRY-RUN]' : '[FinRLWeekly]';
  console.log(`${prefix} ${date} 주간 학습 시작`);
  if (options.dryRun && !process.argv.includes('--dry-run')) {
    console.log(`${prefix} LUNA_FINRL_WEEKLY_TRAINING_ENABLED=false — Python layer3 dry-run/DB 기록 생략`);
  }

  const results = [];
  for (const market of MARKETS) {
    try {
      const result = await runWeeklyFinRLTraining(market, { dryRun: options.dryRun, write: !options.dryRun });
      results.push(compactResult(result));
      console.log(`${prefix} ${market}: success=${result.overallSuccess}, ${result.totalDurationMs}ms`);
      if (result.learningReport) {
        const report = result.learningReport as any;
        console.log(`${prefix} ${market}: velocity=${report.learningVelocity}, experts=${report.expertAgents?.length}, next=${report.nextWeekFocus}`);
      }
    } catch (err) {
      console.error(`${prefix} ${market} 치명 오류:`, err?.message);
      results.push({ market, error: err?.message || String(err), dryRun: options.dryRun });
    }
  }

  console.log(`${prefix} 완료`);
  if (options.json) {
    console.log(JSON.stringify({ ok: true, dryRun: options.dryRun, trainingEnabled: TRAINING_ENABLED, results }, null, 2));
  }
}

main().catch(err => {
  console.error('[FinRLWeekly] 실행 실패:', err?.message);
  process.exit(1);
});
