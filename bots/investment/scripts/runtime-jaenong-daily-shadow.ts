#!/usr/bin/env node
// @ts-nocheck

import { randomUUID } from 'node:crypto';
import * as db from '../shared/db.ts';
import {
  buildJaenongBriefFromPostScore,
  getJaenongBriefStatus,
} from '../shared/jaenong-operations.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export const JAENONG_DAILY_WRITE_CONFIRM = 'jaenong-daily-shadow';
const DEFAULT_COLLECTOR_WAIT_MAX_MS = 30 * 60 * 1_000;
const DEFAULT_COLLECTOR_WAIT_POLL_MS = 5_000;

function normalizeStage(value) {
  const stage = String(value || '').trim().toLowerCase();
  if (!['collect', 'brief'].includes(stage)) throw new Error('jaenong_daily_stage_invalid');
  return stage;
}

function requireWriteConfirmation(options) {
  if (options.write === true && options.confirm !== JAENONG_DAILY_WRITE_CONFIRM) {
    throw new Error('jaenong_daily_write_confirmation_required');
  }
}

export function getJaenongBusinessDateKst(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('jaenong_business_date_invalid');
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function boundedWaitMs(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(Math.floor(number), maximum);
}

export async function waitForJaenongCollectorReadiness(options = {}, deps = {}) {
  const businessDateKst = String(options.businessDateKst || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDateKst)) {
    throw new Error('jaenong_business_date_invalid');
  }
  const queryFn = deps.queryFn || db.query;
  const sleepFn = deps.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowFn = deps.nowFn || Date.now;
  const maxWaitMs = boundedWaitMs(options.maxWaitMs, DEFAULT_COLLECTOR_WAIT_MAX_MS, DEFAULT_COLLECTOR_WAIT_MAX_MS);
  const pollIntervalMs = Math.max(1, boundedWaitMs(
    options.pollIntervalMs,
    DEFAULT_COLLECTOR_WAIT_POLL_MS,
    DEFAULT_COLLECTOR_WAIT_MAX_MS,
  ));
  const startedAtMs = Number(nowFn());

  while (true) {
    const rows = await queryFn(
      `WITH run_states AS (
         SELECT payload->>'runId' AS run_id,
                BOOL_OR(event_type = 'collector_started') AS started,
                BOOL_OR(event_type = 'collector_succeeded') AS succeeded,
                BOOL_OR(event_type = 'parse_failed') AS failed,
                MIN((payload->>'startedAt')::timestamptz)
                  FILTER (WHERE event_type = 'collector_started') AS started_at,
                MAX(created_at) FILTER (WHERE event_type = 'collector_succeeded') AS succeeded_at,
                MAX(created_at) FILTER (WHERE event_type = 'parse_failed') AS failed_at
           FROM investment.jaenong_brief_event
          WHERE event_type IN ('collector_started', 'collector_succeeded', 'parse_failed')
            AND payload->>'businessDateKst' = $1
          GROUP BY payload->>'runId'
       )
       SELECT COUNT(*) FILTER (WHERE succeeded)::int AS success_count,
              COUNT(*) FILTER (WHERE failed)::int AS failure_count,
              COUNT(*) FILTER (WHERE started AND NOT succeeded AND NOT failed)::int AS running_count,
              MIN(started_at) AS started_at,
              MAX(succeeded_at) AS succeeded_at,
              MAX(failed_at) AS failed_at
         FROM run_states`,
      [businessDateKst],
    );
    const row = rows?.[0] || {};
    const waitedMs = Math.max(0, Number(nowFn()) - startedAtMs);
    if (Number(row.success_count || 0) > 0) {
      return {
        businessDateKst,
        status: 'succeeded',
        ready: true,
        fallbackUsed: false,
        waitedMs,
        markerAt: row.succeeded_at || null,
        collectorStartedAt: row.started_at || null,
      };
    }
    if (Number(row.failure_count || 0) > 0 && Number(row.running_count || 0) === 0) {
      return {
        businessDateKst,
        status: 'failed',
        ready: false,
        fallbackUsed: true,
        waitedMs,
        markerAt: row.failed_at || null,
        collectorStartedAt: row.started_at || null,
      };
    }
    if (waitedMs >= maxWaitMs) {
      return {
        businessDateKst,
        status: 'timeout',
        ready: false,
        fallbackUsed: true,
        waitedMs,
        markerAt: null,
        collectorStartedAt: row.started_at || null,
      };
    }
    await sleepFn(Math.min(pollIntervalMs, maxWaitMs - waitedMs));
  }
}

async function recordCollectorEvent(runFn, eventType, reason, payload) {
  return runFn(
    `INSERT INTO investment.jaenong_brief_event
       (event_type, to_state, reason, payload, shadow_only)
     VALUES ($1, $1, $2, $3::jsonb, true)`,
    [eventType, reason, JSON.stringify(payload)],
  );
}

async function collectStage(options, deps) {
  if (options.write !== true) {
    return {
      ok: true,
      stage: 'collect',
      mode: 'dry_run',
      write: false,
      plan: ['fanding collector private snapshot', 'deterministic parser', 'parse-failure event'],
      executionConnected: false,
    };
  }
  const collectFn = deps.collectFn || await import('./fanding-post-collector.ts')
    .then((module) => module.collectFandingPosts);
  const parseFn = deps.parseFn || await import('./jaenong-post-parser.ts')
    .then((module) => module.parseStoredJaenongPosts);
  const runFn = deps.runFn || db.run;
  const startedAt = new Date(options.now || new Date());
  const businessDateKst = getJaenongBusinessDateKst(startedAt);
  const runId = String(deps.runIdFn?.() || randomUUID());
  const markerBase = { runId, businessDateKst, startedAt: startedAt.toISOString() };
  await recordCollectorEvent(runFn, 'collector_started', 'collector_started', markerBase);
  let collected;
  let parsed;
  try {
    collected = await collectFn({ write: true, now: options.now });
    if (collected?.status !== 'ok') throw new Error(String(collected?.status || 'collector_failed'));
    parsed = await parseFn({ write: true }, { runFn, queryFn: deps.queryFn || db.query });
  } catch (error) {
    await recordCollectorEvent(runFn, 'parse_failed', String(error?.message || 'collector_failed'), {
      ...markerBase,
      completedAt: new Date().toISOString(),
      stage: collected?.status === 'ok' ? 'parser' : 'collector',
      failureRate: collected?.failureRate ?? null,
      error: String(error?.message || error),
    });
    return {
      ok: false,
      stage: 'collect',
      mode: 'shadow_write',
      write: true,
      state: 'parse_failed',
      collected,
      parsed: [],
      dependency: { runId, businessDateKst, status: 'failed' },
      executionConnected: false,
    };
  }
  await recordCollectorEvent(runFn, 'collector_succeeded', 'collector_succeeded', {
    ...markerBase,
    completedAt: new Date().toISOString(),
    parsedCount: parsed.length,
  });
  return {
    ok: true,
    stage: 'collect',
    mode: 'shadow_write',
    write: true,
    state: parsed.length > 0 ? 'parsed' : 'absent',
    collected,
    parsedCount: parsed.length,
    dependency: { runId, businessDateKst, status: 'succeeded' },
    executionConnected: false,
  };
}

async function latestPostScore(queryFn, snapshotCutoffAt = null) {
  const rows = await queryFn(
    `SELECT p.source_post_id, p.published_at, ps.scored_at AS parsed_at, ps.brief, ps.status
       FROM investment.jaenong_post_scores ps
       JOIN investment.jaenong_posts p ON p.id = ps.post_id
      WHERE ps.status IN ('available', 'partial')
        AND ($1::timestamptz IS NULL OR ps.scored_at < $1::timestamptz)
      ORDER BY p.published_at DESC NULLS LAST, ps.scored_at DESC, ps.id DESC
      LIMIT 1`,
    [snapshotCutoffAt],
  );
  return rows?.[0] || null;
}

async function latestReferenceHash(queryFn) {
  const rows = await queryFn(
    `SELECT snapshot_hash
       FROM investment.jaenong_reference_snapshot
      WHERE parse_status IN ('parsed', 'partial')
      ORDER BY captured_at DESC, id DESC
      LIMIT 1`,
    [],
  );
  return String(rows?.[0]?.snapshot_hash || '').trim() || null;
}

async function upsertBrief(brief, runFn) {
  return runFn(
    `INSERT INTO investment.jaenong_brief
       (brief_ref, source_kind, source_post_id, reference_snapshot_hash,
        published_at, parsed_at, expires_at, market_adjustment, market_view,
        candidate_symbols, state, shadow_only, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, true, $6)
     ON CONFLICT (brief_ref) DO UPDATE SET
       reference_snapshot_hash = EXCLUDED.reference_snapshot_hash,
       parsed_at = EXCLUDED.parsed_at,
       expires_at = LEAST(investment.jaenong_brief.expires_at, EXCLUDED.expires_at),
       market_adjustment = EXCLUDED.market_adjustment,
       market_view = EXCLUDED.market_view,
       candidate_symbols = EXCLUDED.candidate_symbols,
       state = CASE
         WHEN investment.jaenong_brief.invalidated_at IS NOT NULL THEN 'invalid'
         WHEN EXCLUDED.state = 'stale' THEN 'stale'
         WHEN investment.jaenong_brief.updated_at < EXCLUDED.updated_at THEN 'awaiting_ack'
         ELSE investment.jaenong_brief.state
       END,
       updated_at = GREATEST(investment.jaenong_brief.updated_at, EXCLUDED.updated_at)`,
    [
      brief.briefRef,
      brief.sourceKind,
      brief.sourcePostId,
      brief.referenceSnapshotHash,
      brief.publishedAt,
      brief.parsedAt,
      brief.expiresAt,
      brief.marketAdjustment,
      brief.marketView,
      JSON.stringify(brief.candidateSymbols),
      brief.state,
    ],
  );
}

async function briefStage(options, deps) {
  const queryFn = deps.queryFn || db.query;
  const runFn = deps.runFn || db.run;
  const now = options.now || new Date();
  const env = options.env || process.env;
  const businessDateKst = getJaenongBusinessDateKst(now);
  const dependency = await waitForJaenongCollectorReadiness({
    businessDateKst,
    maxWaitMs: options.write === true
      ? boundedWaitMs(options.collectorWaitMaxMs ?? env.JAENONG_COLLECTOR_WAIT_MAX_MS, DEFAULT_COLLECTOR_WAIT_MAX_MS, DEFAULT_COLLECTOR_WAIT_MAX_MS)
      : 0,
    pollIntervalMs: boundedWaitMs(options.collectorWaitPollMs ?? env.JAENONG_COLLECTOR_WAIT_POLL_MS, DEFAULT_COLLECTOR_WAIT_POLL_MS, DEFAULT_COLLECTOR_WAIT_MAX_MS),
  }, {
    queryFn,
    sleepFn: deps.sleepFn,
    nowFn: deps.nowFn,
  });
  const current = await getJaenongBriefStatus({
    now,
    env,
    maxPublishedAgeHours: options.maxPublishedAgeHours,
  }, { queryFn });
  if (options.write === true && current.brief && current.brief.state !== current.state.status
    && ['stale', 'expired', 'invalid'].includes(current.state.status)) {
    await runFn(
      `WITH changed AS (
         UPDATE investment.jaenong_brief
            SET state = $2, updated_at = $3
          WHERE brief_ref = $1 AND shadow_only = true AND state <> $2
          RETURNING brief_ref, state
       )
       INSERT INTO investment.jaenong_brief_event
         (brief_ref, event_type, from_state, to_state, reason, payload, shadow_only)
       SELECT brief_ref, 're_sanity', $4, state, $5, '{}'::jsonb, true FROM changed`,
      [current.brief.briefRef, current.state.status, new Date(now).toISOString(), current.brief.state, current.state.reason],
    );
  }

  const snapshotCutoffAt = dependency.ready ? null : dependency.collectorStartedAt;
  const scoreRow = await latestPostScore(queryFn, snapshotCutoffAt);
  const sourceDependency = {
    ...dependency,
    sourceMode: dependency.ready ? 'current_collector' : 'prior_snapshot_fallback',
    sourceScorePublishedAt: scoreRow?.published_at || null,
    sourceScoreParsedAt: scoreRow?.parsed_at || null,
    snapshotCutoffAt: snapshotCutoffAt || null,
  };
  if (sourceDependency.fallbackUsed) {
    console.warn(`  ⚠️ [재농 brief] ${businessDateKst} collector ${dependency.status}; 이전 데이터 사용`);
  }
  if (!scoreRow) {
    if (options.write === true) {
      await runFn(
        `INSERT INTO investment.jaenong_brief_event
           (event_type, to_state, reason, payload, shadow_only)
         VALUES ('brief_dependency', 'absent', $1, $2::jsonb, true)`,
        [sourceDependency.sourceMode, JSON.stringify(sourceDependency)],
      );
    }
    return {
      ok: true,
      stage: 'brief',
      mode: options.write === true ? 'shadow_write' : 'dry_run',
      write: options.write === true,
      state: current.state.status,
      brief: null,
      sourceDependency,
      executionConnected: false,
    };
  }
  const referenceSnapshotHash = await latestReferenceHash(queryFn);
  const brief = buildJaenongBriefFromPostScore(scoreRow, {
    now,
    referenceSnapshotHash,
    env,
    maxPublishedAgeHours: options.maxPublishedAgeHours,
  });
  brief.sourceDependency = sourceDependency;
  if (options.write === true) {
    await upsertBrief(brief, runFn);
    await runFn(
      `INSERT INTO investment.jaenong_brief_event
         (brief_ref, event_type, to_state, reason, payload, shadow_only)
       VALUES ($1, 'brief_dependency', $2, $3, $4::jsonb, true)`,
      [brief.briefRef, brief.state, sourceDependency.sourceMode, JSON.stringify(sourceDependency)],
    );
  }
  return {
    ok: true,
    stage: 'brief',
    mode: options.write === true ? 'shadow_write' : 'dry_run',
    write: options.write === true,
    state: brief.state,
    brief,
    currentState: current.state,
    sourceDependency,
    executionConnected: false,
  };
}

export async function runJaenongDailyShadow(options = {}, deps = {}) {
  const stage = normalizeStage(options.stage);
  requireWriteConfirmation(options);
  const normalized = { ...options, stage };
  return stage === 'collect' ? collectStage(normalized, deps) : briefStage(normalized, deps);
}

export function summarizeJaenongDailyShadowResult(result = {}) {
  const summary = {
    ok: result.ok === true,
    stage: result.stage || null,
    mode: result.mode || null,
    write: result.write === true,
    state: result.state || null,
    executionConnected: result.executionConnected === true,
  };
  if (result.stage === 'collect') {
    if (Array.isArray(result.plan)) summary.plan = result.plan;
    if (result.collected) {
      summary.collected = {
        status: result.collected.status || null,
        written: Number(result.collected.written || 0),
        totalCount: Number(result.collected.totalCount || 0),
        successCount: Number(result.collected.successCount || 0),
        failureCount: Number(result.collected.failureCount || 0),
        skippedCount: Number(result.collected.skippedCount || 0),
        failureRate: Number(result.collected.failureRate || 0),
        failureThreshold: Number(result.collected.failureThreshold || 0),
        cutoff: result.collected.cutoff || null,
        privateSnapshot: result.collected.privateSnapshot === true,
      };
    }
    summary.parsedCount = Number(result.parsedCount || 0);
    return summary;
  }
  if (result.brief) {
    summary.brief = {
      briefRef: result.brief.briefRef || null,
      state: result.brief.state || null,
      candidateCount: Array.isArray(result.brief.candidateSymbols)
        ? result.brief.candidateSymbols.length
        : 0,
    };
  } else {
    summary.brief = null;
  }
  if (result.sourceDependency) {
    summary.sourceDependency = {
      businessDateKst: result.sourceDependency.businessDateKst || null,
      status: result.sourceDependency.status || null,
      sourceMode: result.sourceDependency.sourceMode || null,
      fallbackUsed: result.sourceDependency.fallbackUsed === true,
      waitedMs: Number(result.sourceDependency.waitedMs || 0),
      sourceScorePublishedAt: result.sourceDependency.sourceScorePublishedAt || null,
      sourceScoreParsedAt: result.sourceDependency.sourceScoreParsedAt || null,
      snapshotCutoffAt: result.sourceDependency.snapshotCutoffAt || null,
    };
  }
  return summary;
}

if (isDirectExecution(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
  void runCliMain({
    run: () => runJaenongDailyShadow({
      stage: value('stage'),
      write: argv.includes('--write'),
      confirm: value('confirm'),
    }),
    onSuccess: (result) => {
      console.log(JSON.stringify(summarizeJaenongDailyShadowResult(result), null, 2));
      if (result.ok !== true) process.exitCode = 1;
    },
    errorPrefix: 'jaenong daily shadow failed:',
  });
}
