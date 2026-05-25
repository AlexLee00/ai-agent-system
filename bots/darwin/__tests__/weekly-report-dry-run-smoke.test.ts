'use strict';

const assert = require('assert');
const Module = require('module');

const opsReportPath = '/Users/alexlee/projects/ai-agent-system/bots/darwin/scripts/darwin-weekly-ops-report.ts';
const weeklyReviewPath = '/Users/alexlee/projects/ai-agent-system/bots/darwin/scripts/darwin-weekly-review.ts';

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main() {
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const originalLog = console.log;
  const output: string[] = [];
  let postAlarmCalls = 0;
  let legacyCostTableQueried = false;
  let shadowRunAtQueried = false;

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (String(request).endsWith('packages/core/lib/pg-pool')) {
      return {
        query: async (sql: string) => {
          const text = String(sql || '');
          if (text.includes('darwin_cycle_history') && text.includes('llm_cost_usd')) {
            return { rows: [{ total_cycles: 3, successes: 2, failures: 1, applied: 1, llm_cost_usd: 0.25 }] };
          }
          if (text.includes('darwin_cycle_history')) {
            return { rows: [{ total: 3, successes: 2, applied: 1 }] };
          }
          if (text.includes('darwin_research_registry') && text.includes('GROUP BY')) {
            return { rows: [{ stage: 'discovered', count: 4 }, { stage: 'evaluated', count: 2 }, { stage: 'planned', count: 1 }] };
          }
          if (text.includes('darwin_research_registry')) {
            return { rows: [{ new_papers: 4, applied_papers: 1 }] };
          }
          if (text.includes('darwin_principle_violations')) {
            return { rows: [{ count: 0 }] };
          }
          if (text.includes('darwin_dpo_preference_pairs')) {
            return { rows: [{ preferred: 2, rejected: 1 }] };
          }
          if (text.includes('darwin_v2_shadow_runs')) {
            if (text.includes('run_at')) shadowRunAtQueried = true;
            return { rows: [{ avg_match: 0.85 }] };
          }
          if (text.includes('darwin_v2_llm_cost_log')) {
            legacyCostTableQueried = true;
            throw new Error('legacy cost table should not be first choice');
          }
          if (text.includes('darwin_llm_cost_tracking')) {
            return { rows: [{ weekly_cost: 0.35 }] };
          }
          return { rows: [{}] };
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
    return originalLoad.call(this, request, parent, isMain);
  };
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };

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
  assert.match(opsPayload.payload.message, /다윈 주간 운영 리포트/);
  assert.match(reviewPayload.payload.message, /다윈 주간 리뷰/);
  console.log('✅ darwin weekly reports dry-run smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
