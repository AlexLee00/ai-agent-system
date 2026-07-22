#!/usr/bin/env node
// @ts-nocheck

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendTransitionTelemetry } from '../shared/transition-telemetry.ts';
import {
  applyTeamTransitionPlan,
  buildTeamTransitionPlan,
  fetchValidatedVaultRows,
  fetchVaultRowsForSourceRefs,
  isSigmaPredictionEnabled,
  isSigmaTransitionEnabled,
  normalizeLessonKey,
} from '../vault/validation-transition.ts';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const DEFAULT_SKA_SHADOW_HISTORY = path.join(
  os.homedir(),
  '.ai-agent-system/workspace/reservation/cancel-shadow-diff-history.jsonl',
);

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.trunc(parsed) : fallback));
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows : rows?.rows ?? [];
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items || []) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function safeQuery(schema, label, sql, params, warnings, queryReadonly) {
  try {
    return normalizeRows(await queryReadonly(schema, sql, params));
  } catch (error) {
    warnings.push(`${label}:${String(error?.message || error).slice(0, 180)}`);
    return [];
  }
}

function trigger({ team, table, id, polarity, reason, evidence = {}, occurredAt = null, lessonKey = null, title = null }) {
  return {
    team,
    source_ref: { team, table, id: String(id) },
    polarity,
    reason,
    evidence,
    occurredAt,
    lessonKey,
    title,
  };
}

export async function collectBlogTriggers({ sinceHours, limit, warnings = [], queryReadonly = pgPool.queryReadonly } = {}) {
  const events = await safeQuery('blog', 'blog.ai_feedback_events', `
    SELECT id,
           field_key,
           after_value_json,
           event_meta_json,
           created_at,
           COALESCE(event_meta_json->>'post_id', after_value_json->>'post_id') AS post_id,
           COALESCE(after_value_json->>'lesson', event_meta_json->>'lesson') AS lesson
    FROM blog.ai_feedback_events
    WHERE event_type = 'crank_diagnosis'
      AND created_at >= NOW() - ($1::int * INTERVAL '1 hour')
    ORDER BY created_at DESC
    LIMIT $2
  `, [sinceHours, limit], warnings, queryReadonly);
  const eventTriggers = events
    .filter((row) => row.post_id)
    .map((row) => trigger({
      team: 'blog',
      table: 'blog.posts',
      id: row.post_id,
      polarity: 'neutral',
      reason: 'crank_diagnosis',
      occurredAt: row.created_at,
      lessonKey: row.lesson || row.field_key || null,
      evidence: {
        eventId: row.id,
        fieldKey: row.field_key,
        lesson: row.lesson || null,
      },
    }));

  const scores = await safeQuery('blog', 'blog.crank_scores', `
    SELECT id, post_id, overall, scored_date, created_at
    FROM (
      SELECT DISTINCT ON (post_id)
             id, post_id, overall, scored_date, created_at
      FROM blog.crank_scores
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
         OR scored_date >= (CURRENT_DATE - ($1::int * INTERVAL '1 hour'))::date
      ORDER BY post_id, scored_date DESC, id DESC
    ) AS latest_by_post
    ORDER BY created_at DESC, id DESC
    LIMIT $2
  `, [sinceHours, limit], warnings, queryReadonly);
  const scoreTriggers = scores
    .filter((row) => Number(row.overall) >= 70 || Number(row.overall) < 50)
    .map((row) => trigger({
      team: 'blog',
      table: 'blog.posts',
      id: row.post_id,
      polarity: Number(row.overall) >= 70 ? 'positive' : 'negative',
      reason: 'crank_score_threshold',
      occurredAt: row.created_at || row.scored_date,
      lessonKey: `blog_crank_overall_${row.overall}`,
      evidence: {
        crankScoreId: row.id,
        overall: Number(row.overall),
        scoredDate: row.scored_date,
      },
    }));
  return [...eventTriggers, ...scoreTriggers];
}

export async function collectLunaTriggers({ sinceHours, limit, warnings = [], queryReadonly = pgPool.queryReadonly } = {}) {
  const rows = await safeQuery('investment', 'investment.trade_journal', `
    SELECT id, trade_id, symbol, pnl_net, pnl_percent, exit_reason, exit_time, entry_time
    FROM investment.trade_journal
    WHERE pnl_net IS NOT NULL
      AND (
        exit_time >= (EXTRACT(EPOCH FROM NOW()) - $1::float * 3600)::bigint * 1000
        OR (exit_time IS NULL AND entry_time >= (EXTRACT(EPOCH FROM NOW()) - $1::float * 3600)::bigint * 1000)
      )
    ORDER BY COALESCE(exit_time, entry_time) DESC
    LIMIT $2
  `, [String(sinceHours), limit], warnings, queryReadonly);
  return rows
    .filter((row) => Number(row.pnl_net) !== 0)
    .map((row) => trigger({
      team: 'luna',
      table: 'investment.trade_journal',
      id: row.trade_id || row.id,
      polarity: Number(row.pnl_net) > 0 ? 'positive' : 'negative',
      reason: 'closed_trade_pnl',
      occurredAt: row.exit_time ? new Date(Number(row.exit_time)).toISOString() : null,
      lessonKey: row.symbol || row.trade_id || row.id,
      evidence: {
        tradeId: row.trade_id,
        symbol: row.symbol,
        pnlNet: Number(row.pnl_net),
        pnlPercent: row.pnl_percent,
        exitReason: row.exit_reason,
      },
    }));
}

export function collectDarwinTriggers({ limit = 100, warnings = [] } = {}) {
  try {
    const store = require(path.join(PROJECT_ROOT, 'bots/darwin/lib/proposal-store.ts'));
    const proposals = store.listProposals().slice(0, limit);
    return proposals
      .filter((proposal) => store.normalizeProposalState(proposal.status) === 'measured')
      .map((proposal) => {
        const results = Array.isArray(proposal.measurement?.predicate_results)
          ? proposal.measurement.predicate_results
          : [];
        const allPass = results.length > 0 && results.every((item) => item?.ok !== false && item?.passed !== false);
        return trigger({
          team: 'darwin',
          table: 'darwin.proposal_store',
          id: proposal.id,
          polarity: allPass ? 'positive' : 'neutral',
          reason: allPass ? 'predicate_measured_all_pass' : 'measured_without_complete_predicate',
          occurredAt: proposal.measured_at || proposal.updated_at || proposal.created_at || null,
          lessonKey: proposal.title || proposal.id,
          title: proposal.title || proposal.id,
          evidence: {
            predicateResults: results.length,
            branch: proposal.branch || null,
          },
        });
      });
  } catch (error) {
    warnings.push(`darwin.proposal_store:${String(error?.message || error).slice(0, 180)}`);
    return [];
  }
}

export function collectSkaTriggers({
  warnings = [],
  historyPath = DEFAULT_SKA_SHADOW_HISTORY,
  sinceHours = 24 * 7,
  now = new Date(),
} = {}) {
  try {
    if (!fs.existsSync(historyPath)) {
      warnings.push('ska:cancel_shadow_history_missing');
      return [];
    }
    const latestLine = fs.readFileSync(historyPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!latestLine) {
      warnings.push('ska:cancel_shadow_history_empty');
      return [];
    }
    const latest = JSON.parse(latestLine);
    const occurredAt = Date.parse(`${String(latest.recordedAt || '').replace(' ', 'T')}+09:00`);
    const cutoff = (now instanceof Date ? now : new Date(now)).getTime() - Number(sinceHours) * 3_600_000;
    if (!Number.isFinite(occurredAt) || occurredAt < cutoff) {
      warnings.push('ska:cancel_shadow_history_stale');
      return [];
    }
    const counts = latest.counts || {};
    const mismatchCount = Number(counts.todayMissingInLegacy || 0) + Number(counts.todayMissingInUnified || 0);
    const failed = latest.ok === false || latest.skipped === true || latest.scannerOk === false || mismatchCount > 0;
    const date = String(latest.today || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      warnings.push('ska:cancel_shadow_date_invalid');
      return [];
    }
    return [trigger({
      team: 'ska',
      table: 'reservation.daily_summary',
      id: date,
      polarity: failed ? 'negative' : 'positive',
      reason: failed ? 'cancel_shadow_mismatch_or_skip' : 'cancel_shadow_clear',
      occurredAt: new Date(occurredAt).toISOString(),
      lessonKey: `ska_cancel_shadow_${date}`,
      evidence: {
        skipped: Boolean(latest.skipped),
        scannerOk: latest.scannerOk !== false,
        todayMissingInLegacy: Number(counts.todayMissingInLegacy || 0),
        todayMissingInUnified: Number(counts.todayMissingInUnified || 0),
        futureUnifiedOnly: Number(counts.futureUnifiedOnly || 0),
      },
    })];
  } catch (error) {
    warnings.push(`ska:cancel_shadow_history_invalid:${String(error?.message || error).slice(0, 120)}`);
    return [];
  }
}

export async function collectClaudeTriggers({ sinceHours, limit, warnings = [], queryReadonly = pgPool.queryReadonly } = {}) {
  const rows = await safeQuery('claude', 'claude.pr_review_scores', `
    SELECT score.id, score.pr_number, score.total, score.verdict, score.created_at,
           outcome.id AS outcome_id
    FROM claude.pr_review_scores AS score
    LEFT JOIN LATERAL (
      SELECT id
      FROM claude.auto_dev_outcomes
      WHERE pr_number = score.pr_number
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) AS outcome ON true
    WHERE score.created_at >= NOW() - ($1::int * INTERVAL '1 hour')
    ORDER BY score.created_at DESC
    LIMIT $2
  `, [sinceHours, limit], warnings, queryReadonly);
  return rows.map((row) => {
    const verdict = String(row.verdict || '').toLowerCase();
    const total = Number(row.total || 0);
    const negative = /blocked|fail|red|reject/.test(verdict);
    const positive = !negative && (total >= 90 || /pass|eligible|green|approved/.test(verdict));
    const matchedOutcomeId = row.outcome_id == null ? null : `claude_auto_dev:${row.outcome_id}`;
    return trigger({
      team: 'claude',
      table: matchedOutcomeId ? 'claude.auto_dev_outcomes' : 'claude.pr_review_scores',
      id: matchedOutcomeId || row.id,
      polarity: positive ? 'positive' : negative ? 'negative' : 'neutral',
      reason: 'quality_gate_score',
      occurredAt: row.created_at,
      lessonKey: `claude_pr_${row.pr_number || row.id}`,
      evidence: {
        prNumber: row.pr_number,
        total,
        verdict: row.verdict,
      },
    });
  });
}

export async function collectSigma5AxisTriggers(options = {}) {
  const sinceHours = boundedInt(options.sinceHours, 24 * 7, 1, 24 * 30);
  const limit = boundedInt(options.limit, 100, 1, 500);
  const warnings = [];
  const queryReadonly = options.queryReadonly || pgPool.queryReadonly;
  const [blog, luna, claude] = await Promise.all([
    collectBlogTriggers({ sinceHours, limit, warnings, queryReadonly }),
    collectLunaTriggers({ sinceHours, limit, warnings, queryReadonly }),
    collectClaudeTriggers({ sinceHours, limit, warnings, queryReadonly }),
  ]);
  const darwin = collectDarwinTriggers({ limit, warnings });
  const ska = collectSkaTriggers({ warnings, sinceHours, now: options.now || new Date() });
  return {
    triggers: [...blog, ...luna, ...darwin, ...ska, ...claude],
    warnings: [
      ...warnings,
      'hub:manual_pending',
    ],
    sourceCounts: {
      blog: blog.length,
      luna: luna.length,
      darwin: darwin.length,
      ska: ska.length,
      claude: claude.length,
      hub: 0,
    },
  };
}

export async function buildSigma5AxisTransitionReport(options = {}) {
  const dryRun = options.dryRun !== false;
  const source = await collectSigma5AxisTriggers(options);
  const vaultRows = options.vaultRows || await fetchVaultRowsForSourceRefs({
    sourceRefs: source.triggers.map((item) => item.source_ref),
    limit: options.limit || 100,
    queryReadonly: options.queryReadonly || pgPool.queryReadonly,
  });
  const validatedHistoryLimit = boundedInt(options.validatedHistoryLimit, 5000, 1, 5000);
  let validatedHistoryRows = options.validatedHistoryRows;
  if (!Array.isArray(validatedHistoryRows)) {
    try {
      validatedHistoryRows = await fetchValidatedVaultRows({
        lessonKeys: source.triggers.map((item) => normalizeLessonKey(item.lessonKey || item.title)),
        limit: validatedHistoryLimit,
        queryReadonly: options.queryReadonly || pgPool.queryReadonly,
      });
      if (validatedHistoryRows.length >= validatedHistoryLimit) {
        source.warnings.push(`sigma_validated_history_limit_reached:${validatedHistoryLimit}`);
      }
    } catch (error) {
      source.warnings.push(`sigma_validated_history_skipped:${error?.message || String(error)}`);
      validatedHistoryRows = [];
    }
  }
  const plan = buildTeamTransitionPlan({
    vaultRows,
    validatedHistoryRows,
    triggers: source.triggers,
    minPromotionRepeats: options.minPromotionRepeats || 3,
    predictionEnabled: isSigmaPredictionEnabled(options.env || process.env),
    now: options.now || new Date(),
  });
  const rawApplyLimit = Number(options.applyLimit || 0);
  const applyLimit = Number.isFinite(rawApplyLimit) && rawApplyLimit > 0
    ? Math.max(1, Math.min(500, Math.trunc(rawApplyLimit)))
    : null;
  const applicableCount = plan.filter((item) => item.apply && item.matched).length;
  let seenApplicable = 0;
  const applyPlan = applyLimit == null
    ? plan
    : plan.map((item) => {
      if (!item.apply || !item.matched) return item;
      seenApplicable += 1;
      if (seenApplicable <= applyLimit) return item;
      return {
        ...item,
        apply: false,
        applySkippedReason: 'apply_limit_reached',
      };
    });
  let applyResult = { applied: [], count: 0, skipped: true, reason: dryRun ? 'dry_run' : 'apply_not_requested' };
  const shouldApply = !dryRun && options.apply === true && isSigmaTransitionEnabled(options.env || process.env);
  if (shouldApply) {
    applyResult = await applyTeamTransitionPlan(applyPlan, { pg: options.pg || pgPool, env: options.env || process.env });
  }
  const counts = {
    triggers: source.triggers.length,
    matched: plan.filter((item) => item.matched).length,
    plannedValidated: plan.filter((item) => item.nextCoords?.validation_state === 'validated').length,
    plannedContradicted: plan.filter((item) => item.nextCoords?.validation_state === 'contradicted').length,
    plannedPredictionResolved: plan.filter((item) => item.nextCoords?.prediction_state === 'resolved').length,
    promotionCandidates: plan.filter((item) => item.metaPatch?.promotion_candidate === true).length,
    validatedHistoryRows: validatedHistoryRows.length,
    applicable: applicableCount,
    applyLimit,
    applyCapReached: applyLimit != null && applicableCount > applyLimit,
    applied: applyResult.count || 0,
  };
  const report = {
    ok: true,
    source: 'sigma_5axis_transition',
    dryRun,
    liveMutation: Boolean(applyResult.count > 0),
    transitionEnabled: isSigmaTransitionEnabled(options.env || process.env),
    predictionEnabled: isSigmaPredictionEnabled(options.env || process.env),
    generatedAt: new Date().toISOString(),
    sourceCounts: source.sourceCounts,
    counts,
    warnings: source.warnings,
    plan,
    applyResult,
    safety: {
      teamDbReadOnly: true,
      sigmaWriteRequiresEnvAndApply: true,
      launchctlImpact: false,
      ddlApply: false,
    },
  };
  appendTransitionTelemetry({
    type: 'sigma_5axis_transition',
    dryRun,
    transitionEnabled: report.transitionEnabled,
    predictionEnabled: report.predictionEnabled,
    sourceCounts: report.sourceCounts,
    counts,
    pAxis: {
      plannedResolved: counts.plannedPredictionResolved,
      linked: plan.filter((item) => item.pAxis?.linked).length,
    },
    warnings: source.warnings.slice(0, 10),
  }, { path: options.telemetryPath, env: options.env });
  return report;
}

async function main() {
  const result = await buildSigma5AxisTransitionReport({
    sinceHours: boundedInt(argValue('since-hours', '168'), 168, 1, 720),
    limit: boundedInt(argValue('limit', '100'), 100, 1, 500),
    dryRun: !hasFlag('no-dry-run') || hasFlag('dry-run'),
    apply: hasFlag('apply'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[sigma-5axis-transition] triggers=${result.counts.triggers} matched=${result.counts.matched} applicable=${result.counts.applicable} applied=${result.counts.applied} dryRun=${result.dryRun}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  });
}

export default {
  collectSigma5AxisTriggers,
  buildSigma5AxisTransitionReport,
};
