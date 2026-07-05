'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const opsReportPath = path.join(__dirname, '../scripts/darwin-weekly-ops-report.ts');
const weeklyReviewPath = path.join(__dirname, '../scripts/darwin-weekly-review.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main() {
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const originalLog = console.log;
  const originalAutonomyLevel = process.env.DARWIN_AUTONOMY_LEVEL;
  const originalAutonomyConsecutiveSuccesses = process.env.DARWIN_AUTONOMY_CONSECUTIVE_SUCCESSES;
  const originalAutonomyAppliedSuccesses = process.env.DARWIN_AUTONOMY_APPLIED_SUCCESSES;
  const originalKillSwitch = process.env.DARWIN_KILL_SWITCH;
  const output: string[] = [];
  let postAlarmCalls = 0;
  let legacyCostTableQueried = false;
  let shadowRunAtQueried = false;

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (String(request).endsWith('packages/core/lib/pg-pool')) {
      return {
        query: async (schemaOrSql: string, sqlMaybe?: string) => {
          const text = String(sqlMaybe || schemaOrSql || '');
          if (text.includes('darwin_cycle_history') && text.includes('llm_cost_usd')) {
            return [{ total_cycles: 3, successes: 2, failures: 1, applied: 1, llm_cost_usd: 0.25 }];
          }
          if (text.includes('darwin_cycle_history')) {
            return [{ total: 3, successes: 2, applied: 1 }];
          }
          if (text.includes('darwin_research_registry') && text.includes('GROUP BY')) {
            return [{ stage: 'discovered', count: 4 }, { stage: 'evaluated', count: 2 }, { stage: 'planned', count: 1 }];
          }
          if (text.includes('darwin_research_registry')) {
            return [{ new_papers: 4, applied_papers: 1 }];
          }
          if (text.includes('darwin_principle_violations')) {
            return [{ count: 0 }];
          }
          if (text.includes('reservation.rag_research')) {
            return [{
                scanner_runs: 2,
                scanner_collected: 24,
                scanner_evaluated: 20,
                scanner_stored: 18,
                scanner_high_relevance: 5,
                scanner_evaluation_failures: 1,
                scanner_alarm_failures: 1,
                scanner_alarm_bypassed: 1,
                scanner_alarm_failure_reasons: 'rate_limit_cooldown',
                scanner_latest_metric_at: '2026-05-25 03:35:54+00',
                scanner_latest_high_relevance: 0,
                scanner_latest_alarm_sent: 'false',
                scanner_latest_alarm_bypassed: 'false',
                scanner_latest_alarm_failure: '',
                scanner_summary_alarm_failures: 1,
                scanner_registry_synced: 20,
                scanner_registry_sync_failures: 0,
                scanner_proposals: 2,
                scanner_verified: 1,
                scanner_avg_duration_sec: 123,
                scanner_keyword_evolution_count: 3,
            }];
          }
          if (text.includes('darwin_dpo_preference_pairs')) {
            return [{ preferred: 2, rejected: 1 }];
          }
          if (text.includes('darwin_v2_shadow_runs')) {
            if (text.includes('run_at')) shadowRunAtQueried = true;
            if (text.includes('ORDER BY inserted_at DESC')) {
              return [
                { match_score: 1, notes: 'v1=7 v2=7', cycle_result: JSON.stringify({ v1_score: 7, v2_score: 7 }) },
                { match_score: 0, notes: 'v1=7 v2=9.5', cycle_result: JSON.stringify({ v1_score: 7, v2_score: 9.5 }) },
              ];
            }
            return [{
              shadow_total_runs: 21,
              shadow_distinct_days: 7,
              avg_match: 0.85,
              shadow_min_match: 0.2,
              shadow_regressions: 3,
            }];
          }
          if (text.includes('darwin_v2_llm_cost_log')) {
            legacyCostTableQueried = true;
            throw new Error('legacy cost table should not be first choice');
          }
          if (text.includes('darwin_llm_cost_tracking')) {
            return [{ weekly_cost: 0.35 }];
          }
          return [{}];
        },
      };
    }
    if (String(request).endsWith('packages/core/lib/hub-alarm-client')) {
      return {
        postAlarm: async () => {
          postAlarmCalls += 1;
          throw new Error('dry-run must not send alarms');
        },
      };
    }
    if (String(request).endsWith('bots/darwin/lib/proposal-store.ts') || request === './proposal-store.ts') {
      return {
        listProposals: () => [
          { id: 'm', status: 'measured', measurement: { predicate_results: [{ ok: true }, { ok: false }] } },
          { id: 'a', status: 'adopted', measurement: { predicate_results: [{ ok: true }] } },
        ],
        normalizeProposalState: (status: unknown) => String(status || 'proposed'),
        runProposalTriage: ({ dryRun }: { dryRun?: boolean } = {}) => ({
          ok: true,
          dryRun: dryRun !== false,
          archived: dryRun === false ? 1 : 0,
          actions: [{
            id: 'triage-fixture',
            reason: 'triage_stale',
            previousStatus: 'implementing',
          }],
        }),
      };
    }
    if (String(request).endsWith('bots/darwin/lib/telemetry')) {
      return {
        recordTelemetry: () => ({ ok: true }),
        tailTelemetry: () => [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  process.env.DARWIN_AUTONOMY_LEVEL = '5';
  process.env.DARWIN_AUTONOMY_CONSECUTIVE_SUCCESSES = '10';
  process.env.DARWIN_AUTONOMY_APPLIED_SUCCESSES = '3';
  process.env.DARWIN_KILL_SWITCH = 'false';

  try {
    delete require.cache[opsReportPath];
    delete require.cache[weeklyReviewPath];
    const opsReport = require(opsReportPath);
    const weeklyReview = require(weeklyReviewPath);

    await opsReport.main({ dryRun: true, json: true });
    await weeklyReview.main({ dryRun: true, json: true });
  } finally {
    Module._load = originalLoad;
    console.log = originalLog;
    if (originalAutonomyLevel === undefined) delete process.env.DARWIN_AUTONOMY_LEVEL;
    else process.env.DARWIN_AUTONOMY_LEVEL = originalAutonomyLevel;
    if (originalAutonomyConsecutiveSuccesses === undefined) delete process.env.DARWIN_AUTONOMY_CONSECUTIVE_SUCCESSES;
    else process.env.DARWIN_AUTONOMY_CONSECUTIVE_SUCCESSES = originalAutonomyConsecutiveSuccesses;
    if (originalAutonomyAppliedSuccesses === undefined) delete process.env.DARWIN_AUTONOMY_APPLIED_SUCCESSES;
    else process.env.DARWIN_AUTONOMY_APPLIED_SUCCESSES = originalAutonomyAppliedSuccesses;
    if (originalKillSwitch === undefined) delete process.env.DARWIN_KILL_SWITCH;
    else process.env.DARWIN_KILL_SWITCH = originalKillSwitch;
    delete require.cache[opsReportPath];
    delete require.cache[weeklyReviewPath];
  }

  assert.strictEqual(postAlarmCalls, 0);
  assert.strictEqual(legacyCostTableQueried, false);
  assert.strictEqual(shadowRunAtQueried, false);
  assert.strictEqual(output.length, 2);
  const opsPayload = JSON.parse(output[0]);
  const reviewPayload = JSON.parse(output[1]);
  assert.strictEqual(opsPayload.ok, true);
  assert.strictEqual(opsPayload.dryRun, true);
  assert.strictEqual(opsPayload.alarmSent, false);
  assert.strictEqual(reviewPayload.ok, true);
  assert.strictEqual(reviewPayload.dryRun, true);
  assert.strictEqual(reviewPayload.alarmSent, false);
  assert.strictEqual(reviewPayload.stats.weekly_cost_usd, 0.35);
  assert.strictEqual(reviewPayload.stats.shadow_total_runs, 21);
  assert.strictEqual(reviewPayload.stats.shadow_distinct_days, 7);
  assert.strictEqual(reviewPayload.stats.shadow_recent_runs, 2);
  assert.strictEqual(reviewPayload.stats.shadow_recent_match_rate, '50.0');
  assert.strictEqual(reviewPayload.stats.shadow_recent_avg_delta, '1.25');
  assert.strictEqual(reviewPayload.stats.shadow_recent_within_2_rate, '50.0');
  assert.strictEqual(reviewPayload.stats.shadow_promotion_ready, false);
  assert.match(reviewPayload.stats.shadow_blocker, /avg_match 85\.0%\/95%/);
  assert.strictEqual(reviewPayload.stats.triage_candidates, 1);
  assert.strictEqual(reviewPayload.stats.triage_archived, 0);
  assert.strictEqual(reviewPayload.stats.triage_dry_run, true);
  assert.strictEqual(reviewPayload.stats.triage_actions[0].reason, 'triage_stale');
  assert.strictEqual(opsPayload.stats.scanner_runs, 2);
  assert.strictEqual(opsPayload.stats.autonomy_level, 5);
  assert.strictEqual(opsPayload.stats.autonomy_source, 'env');
  assert.strictEqual(opsPayload.stats.autonomy_promotion_ready, true);
  assert.strictEqual(opsPayload.stats.scanner_alarm_failures, 1);
  assert.strictEqual(opsPayload.stats.scanner_alarm_bypassed, 1);
  assert.strictEqual(opsPayload.stats.scanner_alarm_failure_reasons, 'rate_limit_cooldown');
  assert.strictEqual(opsPayload.stats.scanner_latest_high_relevance, 0);
  assert.strictEqual(opsPayload.stats.scanner_latest_alarm_sent, false);
  assert.strictEqual(opsPayload.stats.scanner_summary_alarm_failures, 1);
  assert.strictEqual(opsPayload.stats.scanner_registry_synced, 20);
  assert.strictEqual(opsPayload.stats.scanner_registry_sync_failures, 0);
  assert.strictEqual(opsPayload.stats.scanner_keyword_evolution_count, 3);
  assert.strictEqual(opsPayload.stats.learn_report.keywordEvolutionCount, 3);
  assert.strictEqual(opsPayload.stats.learn_report.proposalStats.predicatePassed, 2);
  assert.strictEqual(reviewPayload.stats.scanner_high_relevance, 5);
  assert.match(opsPayload.payload.message, /Scanner evidence/);
  assert.match(opsPayload.payload.message, /LEARN/);
  assert.match(opsPayload.payload.message, /promotionReady: true/);
  assert.match(opsPayload.payload.message, /최신 알림 상태: high=0, sent=false/);
  assert.match(opsPayload.payload.message, /Registry sync: 20\/0/);
  assert.match(reviewPayload.payload.message, /후보 알림 실패: 1 \| observe-only 생략: 1 \| 주간 summary 실패: 1/);
  assert.match(reviewPayload.payload.message, /후보 알림 실패 사유: rate_limit_cooldown/);
  assert.match(reviewPayload.payload.message, /promotionReady: false/);
  assert.match(reviewPayload.payload.message, /최근 2건: match=50\.0% \| avg_delta=1\.25 \| within±2=50\.0%/);
  assert.match(reviewPayload.payload.message, /Proposal triage/);
  assert.match(opsPayload.payload.message, /다윈 주간 운영 리포트/);
  assert.match(reviewPayload.payload.message, /다윈 주간 리뷰/);
  console.log('✅ darwin weekly reports dry-run smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
