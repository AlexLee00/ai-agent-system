#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import {
  buildJaenongBriefFromPostScore,
  getJaenongBriefStatus,
} from '../shared/jaenong-operations.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export const JAENONG_DAILY_WRITE_CONFIRM = 'jaenong-daily-shadow';

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
  const collected = await collectFn({ write: true, now: options.now });
  if (collected?.status !== 'ok') {
    await runFn(
      `INSERT INTO investment.jaenong_brief_event
         (event_type, to_state, reason, payload, shadow_only)
       VALUES ('parse_failed', 'parse_failed', $1, $2::jsonb, true)`,
      [String(collected?.status || 'collector_failed'), JSON.stringify({
        stage: 'collector',
        failureRate: collected?.failureRate ?? null,
        error: collected?.error || null,
      })],
    );
    return {
      ok: false,
      stage: 'collect',
      mode: 'shadow_write',
      write: true,
      state: 'parse_failed',
      collected,
      parsed: [],
      executionConnected: false,
    };
  }
  const parsed = await parseFn({ write: true }, { runFn, queryFn: deps.queryFn || db.query });
  return {
    ok: true,
    stage: 'collect',
    mode: 'shadow_write',
    write: true,
    state: parsed.length > 0 ? 'parsed' : 'absent',
    collected,
    parsedCount: parsed.length,
    executionConnected: false,
  };
}

async function latestPostScore(queryFn) {
  const rows = await queryFn(
    `SELECT p.source_post_id, p.published_at, ps.scored_at AS parsed_at, ps.brief, ps.status
       FROM investment.jaenong_post_scores ps
       JOIN investment.jaenong_posts p ON p.id = ps.post_id
      WHERE ps.status IN ('available', 'partial')
      ORDER BY p.published_at DESC NULLS LAST, ps.scored_at DESC, ps.id DESC
      LIMIT 1`,
    [],
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'awaiting_ack', true, $6)
     ON CONFLICT (brief_ref) DO UPDATE SET
       reference_snapshot_hash = EXCLUDED.reference_snapshot_hash,
       parsed_at = EXCLUDED.parsed_at,
       expires_at = EXCLUDED.expires_at,
       market_adjustment = EXCLUDED.market_adjustment,
       market_view = EXCLUDED.market_view,
       candidate_symbols = EXCLUDED.candidate_symbols,
       state = CASE
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
    ],
  );
}

async function briefStage(options, deps) {
  const queryFn = deps.queryFn || db.query;
  const runFn = deps.runFn || db.run;
  const now = options.now || new Date();
  const current = await getJaenongBriefStatus({ now }, { queryFn });
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

  const scoreRow = await latestPostScore(queryFn);
  if (!scoreRow) {
    return {
      ok: true,
      stage: 'brief',
      mode: options.write === true ? 'shadow_write' : 'dry_run',
      write: options.write === true,
      state: current.state.status,
      brief: null,
      executionConnected: false,
    };
  }
  const referenceSnapshotHash = await latestReferenceHash(queryFn);
  const brief = buildJaenongBriefFromPostScore(scoreRow, { now, referenceSnapshotHash });
  if (options.write === true) await upsertBrief(brief, runFn);
  return {
    ok: true,
    stage: 'brief',
    mode: options.write === true ? 'shadow_write' : 'dry_run',
    write: options.write === true,
    state: 'awaiting_ack',
    brief,
    currentState: current.state,
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
    onSuccess: (result) => console.log(JSON.stringify(summarizeJaenongDailyShadowResult(result), null, 2)),
    errorPrefix: 'jaenong daily shadow failed:',
  });
}
