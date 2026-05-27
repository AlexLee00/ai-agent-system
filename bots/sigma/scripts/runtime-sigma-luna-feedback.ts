#!/usr/bin/env tsx
// @ts-nocheck

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function fetchSigmaFeedback({ limit = 20 } = {}) {
  return pgPool.query('sigma', `
    SELECT id, feedback_date, target_team, feedback_type, content, formation,
           analyst_used, effectiveness, effective, measured_at, created_at
      FROM sigma.feedback_effectiveness
     WHERE target_team IN ('luna', 'investment')
     ORDER BY created_at DESC
     LIMIT $1
  `, [limit]).catch(() => []);
}

function buildCurriculumPatch(rows) {
  const effective = rows.filter((row) => row.effective === true || Number(row.effectiveness || 0) > 0.55);
  const weak = rows.filter((row) => row.effective === false || Number(row.effectiveness || 0) < 0.35);
  return {
    source: 'sigma_luna_feedback_bridge_v1',
    effectiveFeedbackCount: effective.length,
    weakFeedbackCount: weak.length,
    recommendedPolicy: {
      reinforce: effective.slice(0, 5).map((row) => ({
        type: row.feedback_type,
        analyst: row.analyst_used,
        effectiveness: row.effectiveness,
      })),
      deEmphasize: weak.slice(0, 5).map((row) => ({
        type: row.feedback_type,
        analyst: row.analyst_used,
        effectiveness: row.effectiveness,
      })),
    },
    shadowOnly: true,
    updatedAt: new Date().toISOString(),
  };
}

async function persistCurriculumPatch(patch) {
  await pgPool.run('investment', `
    INSERT INTO investment.agent_curriculum_state
      (agent_name, market, invocation_count, success_count, failure_count, current_level, config, updated_at)
    VALUES ('sigma_feedback_bridge', 'all', 1, $1, $2, $3, $4::jsonb, NOW())
    ON CONFLICT (agent_name, market) DO UPDATE SET
      invocation_count = investment.agent_curriculum_state.invocation_count + 1,
      success_count = investment.agent_curriculum_state.success_count + EXCLUDED.success_count,
      failure_count = investment.agent_curriculum_state.failure_count + EXCLUDED.failure_count,
      current_level = EXCLUDED.current_level,
      config = COALESCE(investment.agent_curriculum_state.config, '{}'::jsonb) || EXCLUDED.config,
      updated_at = NOW()
  `, [
    patch.effectiveFeedbackCount > 0 ? 1 : 0,
    patch.weakFeedbackCount > patch.effectiveFeedbackCount ? 1 : 0,
    patch.effectiveFeedbackCount >= patch.weakFeedbackCount ? 'intermediate' : 'novice',
    JSON.stringify(patch),
  ]);
}

export async function runSigmaLunaFeedback({ limit = 20, dryRun = true, write = false } = {}) {
  const effectiveDryRun = dryRun !== false || write !== true;
  const rows = await fetchSigmaFeedback({ limit });
  const patch = buildCurriculumPatch(rows);
  if (!effectiveDryRun) await persistCurriculumPatch(patch);
  return {
    ok: true,
    dryRun: effectiveDryRun,
    feedbackRows: rows.length,
    curriculumUpdated: !effectiveDryRun,
    patch,
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  const json = process.argv.includes('--json');
  const write = process.argv.includes('--write');
  const noDryRun = process.argv.includes('--no-dry-run');
  const result = await runSigmaLunaFeedback({
    limit: Math.max(1, Number(argValue('limit', '20')) || 20),
    dryRun: !noDryRun,
    write,
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[sigma-luna-feedback] rows=${result.feedbackRows} dryRun=${result.dryRun}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  });
}
