#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool.js');
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');
const { getBlogHealthRuntimeConfig } = require('../lib/runtime-config.ts');
const { assessInboundComment } = require('../lib/commenter.ts');
const { readDevelopmentBaseline, buildSinceClause } = require('../lib/dev-baseline.ts');
const { readCommenterRunResult } = require('../lib/commenter-run-telemetry.ts');
const { loadStrategyBundle, resolveExecutionTarget } = require('../lib/strategy-loader.ts');

  const runtimeConfig = getBlogHealthRuntimeConfig();
  const strategy = loadStrategyBundle().plan;
const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots/blog');
const BLOG_OPS_ROOT = path.join(BLOG_ROOT, 'output', 'ops');
const BLOG_NEIGHBOR_COLLECT_DIAG_PATH = path.join(BLOG_OPS_ROOT, 'neighbor-collect-diagnostics.json');
const BLOG_ENGAGEMENT_GAP_RUN_PATH = path.join(BLOG_OPS_ROOT, 'engagement-gap-run.json');
const BLOG_NEIGHBOR_REPLAY_PATH = path.join(BLOG_OPS_ROOT, 'neighbor-ui-replay.json');
const BLOG_NEIGHBOR_SYMPATHY_REPLAY_PATH = path.join(BLOG_OPS_ROOT, 'neighbor-sympathy-replay.json');
const RUN_ENGAGEMENT_GAP_COMMAND = `npm --prefix ${BLOG_ROOT} run run:engagement-gap`;
const RUN_NEIGHBOR_COLLECT_ONLY_COMMAND = `node ${path.join(BLOG_ROOT, 'scripts/run-neighbor-commenter.ts')} --collect-only --json`;
const BACKFILL_COURTESY_REPLIES_COMMAND = `npm --prefix ${BLOG_ROOT} run backfill:courtesy-replies`;
const REPLAY_NEIGHBOR_UI_COMMAND = `npm --prefix ${BLOG_ROOT} run replay:neighbor-ui -- --json`;
const REPLAY_NEIGHBOR_SYMPATHY_COMMAND = `npm --prefix ${BLOG_ROOT} run replay:neighbor-sympathy -- --json`;
const RUN_REVENUE_STRATEGY_COMMAND = `npm --prefix ${BLOG_ROOT} run revenue:strategy -- --dry-run --json`;

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
  };
}

function classifyEngagementFailure(meta = {}) {
  const errorText = String(meta?.error || meta?.uiError || meta?.previous_error || '').trim();
  if (!errorText) {
    if (meta?.correction_reason === 'reply_verification_false_positive') return 'verification';
    return 'unknown';
  }
  if (
    errorText.includes('reply_button_not_found')
    || errorText.includes('reply_submit_not_found')
    || errorText.includes('reply_submit_not_confirmed')
    || errorText.includes('comment_submit_not_confirmed')
    || errorText.includes('sympathy_button_not_found')
    || errorText.includes('reply_ui_unavailable')
    || errorText.includes('reply_editor_not_found')
  ) return 'ui';
  if (
    errorText.includes('ECONNREFUSED')
    || errorText.includes('__name is not defined')
    || errorText.includes('browser')
    || errorText.includes('ws 연결 실패')
  ) return 'browser';
  if (
    errorText.includes('fetch failed')
    || errorText.includes('timeout')
    || errorText.includes('429')
    || errorText.includes('Claude Code')
    || errorText.includes('Groq')
  ) return 'llm';
  return 'unknown';
}

function summarizeEngagementFailure(meta = {}) {
  const raw = String(meta?.error || meta?.uiError || meta?.previous_error || meta?.message || '').trim();
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').replace(/snapshotPrefix[^,}\]]*/gi, 'snapshotPrefix').slice(0, 140);
}

function nowKst() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function calcExpectedByWindow(target, startHour, endHour) {
  const numericTarget = Math.max(0, Number(target || 0));
  const start = Number(startHour || 0);
  const end = Number(endHour || 23);
  const now = nowKst();
  const currentHour = now.getHours() + (now.getMinutes() / 60);

  if (numericTarget <= 0 || end <= start) {
    return { target: numericTarget, expectedNow: 0, progressRatio: 0, active: false };
  }
  if (currentHour <= start) {
    return { target: numericTarget, expectedNow: 0, progressRatio: 0, active: false };
  }
  if (currentHour >= end) {
    return { target: numericTarget, expectedNow: numericTarget, progressRatio: 1, active: false };
  }

  const progressRatio = clamp((currentHour - start) / (end - start), 0, 1);
  return {
    target: numericTarget,
    expectedNow: Math.ceil(numericTarget * progressRatio),
    progressRatio,
    active: true,
  };
}

function buildAdaptiveNeighborCadence({
  replySuccess = 0,
  neighborSuccess = 0,
  sympathySuccess = 0,
  replyPlan,
  neighborPlan,
  adaptiveEnabled = true,
  adaptiveMinGapToBoost = 2,
  adaptiveBoostCap = 12,
  adaptiveCollectBoostCap = 20,
  adaptiveSympathyBoostCap = 8,
  baseProcess = 20,
  baseCollect = 20,
} = {}) {
  const neighborDeficit = Math.max(0, Number(neighborPlan?.expectedNow || 0) - Number(neighborSuccess || 0));
  const sympathyDeficit = Math.max(0, Number(neighborPlan?.expectedNow || 0) - Number(sympathySuccess || 0));
  const combinedCommentSuccess = Number(replySuccess || 0) + Number(neighborSuccess || 0);
  const combinedCommentExpectedNow = Number(replyPlan?.expectedNow || 0) + Number(neighborPlan?.expectedNow || 0);
  const combinedCommentDeficit = Math.max(0, combinedCommentExpectedNow - combinedCommentSuccess);
  const drivingGap = Math.max(neighborDeficit, Math.min(Number(neighborPlan?.expectedNow || 0), combinedCommentDeficit));
  const shouldBoost = Boolean(adaptiveEnabled) && Boolean(neighborPlan?.active) && drivingGap >= Math.max(1, Number(adaptiveMinGapToBoost || 2));
  const processBoost = shouldBoost ? Math.min(Math.max(2, Number(adaptiveBoostCap || 12)), drivingGap) : 0;
  const collectBoost = shouldBoost ? Math.min(Math.max(2, Number(adaptiveCollectBoostCap || 20)), Math.max(processBoost, drivingGap * 2)) : 0;
  const sympathyBoost = Boolean(adaptiveEnabled) && Boolean(neighborPlan?.active) && sympathyDeficit >= Math.max(1, Number(adaptiveMinGapToBoost || 2))
    ? Math.min(Math.max(2, Number(adaptiveSympathyBoostCap || 8)), sympathyDeficit)
    : 0;
  return {
    enabled: Boolean(adaptiveEnabled),
    shouldBoost,
    combinedCommentSuccess,
    combinedCommentExpectedNow,
    combinedCommentDeficit,
    neighborDeficit,
    sympathyDeficit,
    processBoost,
    collectBoost,
    sympathyBoost,
    effectiveProcessLimit: Math.max(1, Number(baseProcess || 20)) + processBoost,
    effectiveCollectLimit: Math.max(1, Number(baseCollect || 20)) + collectBoost,
    effectiveSympathyLimit: Math.max(1, Number(baseProcess || 20)) + sympathyBoost,
  };
}

function buildTargetGapDetails(targets = {}) {
  const entries = [
    ['replies', targets?.replies],
    ['neighbor', targets?.neighborComments],
    ['sympathy', targets?.sympathies],
  ];
  const details = [];
  for (const [label, item] of entries) {
    const success = Number(item?.success || 0);
    const expectedNow = Number(item?.expectedNow || 0);
    const target = Number(item?.target || 0);
    const active = Boolean(item?.active);
    const deficit = Math.max(0, expectedNow - success);
    const deficitRatio = expectedNow > 0 ? deficit / expectedNow : 0;
    if (active && expectedNow > 0 && deficit > 0) {
      details.push({
        label,
        success,
        expectedNow,
        target,
        deficit,
        deficitRatio,
        summary: `${label} ${success}/${expectedNow}`,
      });
    }
  }
  return details.sort((a, b) => {
    if (b.deficit !== a.deficit) return b.deficit - a.deficit;
    if (b.deficitRatio !== a.deficitRatio) return b.deficitRatio - a.deficitRatio;
    return a.label.localeCompare(b.label);
  });
}

function getGapActionCommand(label = '') {
  switch (String(label || '')) {
    case 'replies':
      return `node ${path.join(BLOG_ROOT, 'scripts/run-commenter.ts')}`;
    case 'neighbor':
      return `node ${path.join(BLOG_ROOT, 'scripts/run-neighbor-commenter.ts')}`;
    case 'sympathy':
      return `node ${path.join(BLOG_ROOT, 'scripts/run-neighbor-sympathy.ts')}`;
    default:
      return `npm --prefix ${BLOG_ROOT} run doctor:engagement -- --json`;
  }
}

function buildRunPlan(targetGapDetails = []) {
  return (Array.isArray(targetGapDetails) ? targetGapDetails : []).map((item, index) => ({
    step: index + 1,
    label: item.label,
    summary: item.summary,
    deficit: item.deficit,
    command: getGapActionCommand(item.label),
  }));
}

function buildUiFocus(failureByAction = {}) {
  const replyFailures = Number(failureByAction?.reply || 0);
  const neighborFailures = Number(failureByAction?.neighbor_comment || 0);
  const sympathyFailures = Number(failureByAction?.sympathy || 0);
  if (sympathyFailures >= Math.max(replyFailures, neighborFailures) && sympathyFailures > 0) {
    return {
      action: 'sympathy',
      reason: '외부 공감 버튼 탐색 또는 confirm 흐름 실패가 현재 engagement 최우선 병목입니다.',
      focus: '네이버 외부 공감 버튼 selector / toggle / confirm 흐름 재현',
    };
  }
  if (neighborFailures > replyFailures) {
    return {
      action: 'neighbor',
      reason: '외부 댓글 submit 또는 browser 흐름 실패가 현재 engagement 최우선 병목입니다.',
      focus: '네이버 외부 댓글 submit / editor mount / confirm 흐름 재현',
    };
  }
  return {
    action: 'reply',
    reason: 'reply UI 또는 browser 흐름 실패가 현재 engagement 최우선 병목입니다.',
    focus: '네이버 reply button / submit / editor mount 흐름 재현',
  };
}

function readNeighborCollectDiagnostics() {
  try {
    const raw = fs.readFileSync(BLOG_NEIGHBOR_COLLECT_DIAG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readLastEngagementGapRun(baseline = null) {
  try {
    const raw = fs.readFileSync(BLOG_ENGAGEMENT_GAP_RUN_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (baseline?.startedAtIso) {
      const executedAt = Date.parse(String(parsed.executedAt || ''));
      const baselineAt = Date.parse(String(baseline.startedAtIso || ''));
      if (Number.isFinite(executedAt) && Number.isFinite(baselineAt) && executedAt < baselineAt) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function readNeighborUiReplay(baseline = null) {
  try {
    const raw = fs.readFileSync(BLOG_NEIGHBOR_REPLAY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (baseline?.startedAtIso) {
      const replayedAt = Date.parse(String(parsed.replayedAt || ''));
      const baselineAt = Date.parse(String(baseline.startedAtIso || ''));
      if (Number.isFinite(replayedAt) && Number.isFinite(baselineAt) && replayedAt < baselineAt) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function readNeighborSympathyReplay(baseline = null) {
  try {
    const raw = fs.readFileSync(BLOG_NEIGHBOR_SYMPATHY_REPLAY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (baseline?.startedAtIso) {
      const replayedAt = Date.parse(String(parsed.replayedAt || ''));
      const baselineAt = Date.parse(String(baseline.startedAtIso || ''));
      if (Number.isFinite(replayedAt) && Number.isFinite(baselineAt) && replayedAt < baselineAt) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

async function getLatestReplyReplayCandidate(baseline = null) {
  const actionSinceClause = buildSinceClause('a.executed_at', baseline);
  const commentSinceClause = buildSinceClause('detected_at', baseline);
  try {
    const row = await pgPool.get('blog', `
      SELECT
        c.id,
        c.status,
        c.commenter_name,
        c.post_url,
        LEFT(c.comment_text, 80) AS comment_text,
        a.executed_at,
        true AS from_failure
      FROM blog.comment_actions a
      JOIN blog.comments c
        ON (a.meta->>'commentId')::int = c.id
      WHERE a.action_type = 'reply'
        AND a.success = false
        ${actionSinceClause}
      ORDER BY a.executed_at DESC
      LIMIT 1
    `);
    if (row?.id) return row;
    return await pgPool.get('blog', `
      SELECT
        id,
        status,
        commenter_name,
        post_url,
        LEFT(comment_text, 80) AS comment_text,
        detected_at AS executed_at,
        false AS from_failure
      FROM blog.comments
      WHERE detected_at >= now() - interval '7 days'
        ${commentSinceClause}
      ORDER BY detected_at DESC
      LIMIT 1
    `);
  } catch {
    return null;
  }
}

async function getReplyWorkloadStatus(baseline = null) {
  const commentSinceClause = buildSinceClause('detected_at', baseline);
  try {
    const [statusRows, latestRow, skippedTodayRows, skipped14dRows, pendingBacklogRow] = await Promise.all([
      pgPool.query('blog', `
        SELECT status, COUNT(*)::int AS cnt
        FROM blog.comments
        WHERE timezone('Asia/Seoul', detected_at)::date = timezone('Asia/Seoul', now())::date
          ${commentSinceClause}
        GROUP BY 1
      `),
      pgPool.get('blog', `
        SELECT
          id,
          status,
          commenter_name,
          LEFT(comment_text, 80) AS comment_text,
          error_message,
          detected_at
        FROM blog.comments
        WHERE timezone('Asia/Seoul', detected_at)::date = timezone('Asia/Seoul', now())::date
          ${commentSinceClause}
        ORDER BY detected_at DESC
        LIMIT 1
      `),
      pgPool.query('blog', `
        SELECT COALESCE(error_message, '') AS reason, COUNT(*)::int AS cnt
        FROM blog.comments
        WHERE timezone('Asia/Seoul', detected_at)::date = timezone('Asia/Seoul', now())::date
          AND status = 'skipped'
          ${commentSinceClause}
        GROUP BY 1
        ORDER BY cnt DESC, reason ASC
        LIMIT 5
      `),
      pgPool.query('blog', `
        SELECT COALESCE(error_message, '') AS reason, COUNT(*)::int AS cnt
        FROM blog.comments
        WHERE detected_at >= now() - interval '14 days'
          AND status = 'skipped'
          ${commentSinceClause}
        GROUP BY 1
        ORDER BY cnt DESC, reason ASC
        LIMIT 5
      `),
      pgPool.get('blog', `
        SELECT COUNT(*)::int AS cnt
        FROM blog.comments
        WHERE status = 'pending'
          AND reply_at IS NULL
          ${commentSinceClause}
      `),
    ]);

    const counts = new Map();
    for (const row of statusRows || []) {
      counts.set(String(row.status || ''), Number(row.cnt || 0));
    }

    return {
      totalToday: [...counts.values()].reduce((sum, value) => sum + Number(value || 0), 0),
      pendingCount: Number(counts.get('pending') || 0),
      pendingBacklogCount: Number(pendingBacklogRow?.cnt || 0),
      skippedCount: Number(counts.get('skipped') || 0),
      failedCount: Number(counts.get('failed') || 0),
      repliedCount: Number(counts.get('replied') || 0),
      skippedReasonsToday: (skippedTodayRows || []).map((row) => ({
        reason: String(row.reason || ''),
        count: Number(row.cnt || 0),
      })),
      skippedReasons14d: (skipped14dRows || []).map((row) => ({
        reason: String(row.reason || ''),
        count: Number(row.cnt || 0),
      })),
      latest: latestRow
        ? {
            id: latestRow.id,
            status: latestRow.status,
            commenterName: latestRow.commenter_name,
            commentText: latestRow.comment_text,
            errorMessage: latestRow.error_message,
            detectedAt: latestRow.detected_at,
          }
        : null,
    };
  } catch {
    return {
      totalToday: 0,
      pendingCount: 0,
      pendingBacklogCount: 0,
      skippedCount: 0,
      failedCount: 0,
      repliedCount: 0,
      skippedReasonsToday: [],
      skippedReasons14d: [],
      latest: null,
    };
  }
}

async function getNeighborWorkloadStatus(baseline = null) {
  const createdSinceClause = buildSinceClause('created_at', baseline);
  try {
    const rows = await pgPool.query('blog', `
      SELECT status, COUNT(*)::int AS cnt
      FROM blog.neighbor_comments
      WHERE timezone('Asia/Seoul', created_at)::date = timezone('Asia/Seoul', now())::date
        ${createdSinceClause}
      GROUP BY 1
    `);
    const counts = new Map();
    for (const row of rows || []) {
      counts.set(String(row.status || ''), Number(row.cnt || 0));
    }
    return {
      postedCount: Number(counts.get('posted') || 0),
      pendingCount: Number(counts.get('pending') || 0),
      failedCount: Number(counts.get('failed') || 0),
    };
  } catch {
    return {
      postedCount: 0,
      pendingCount: 0,
      failedCount: 0,
    };
  }
}

async function getNeighborRecoveryStatus(baseline = null) {
  const actionSinceClause = buildSinceClause('executed_at', baseline);
  try {
    const [latestSuccess, latestFailure, successCountRow] = await Promise.all([
      pgPool.get('blog', `
        SELECT executed_at
        FROM blog.comment_actions
        WHERE action_type = 'neighbor_comment'
          AND success = true
          ${actionSinceClause}
        ORDER BY executed_at DESC
        LIMIT 1
      `),
      pgPool.get('blog', `
        SELECT executed_at
        FROM blog.comment_actions
        WHERE action_type = 'neighbor_comment'
          AND success = false
          ${actionSinceClause}
        ORDER BY executed_at DESC
        LIMIT 1
      `),
      pgPool.get('blog', `
        SELECT COUNT(*)::int AS cnt
        FROM blog.comment_actions
        WHERE action_type = 'neighbor_comment'
          AND success = true
          ${actionSinceClause}
      `),
    ]);
    const latestSuccessAt = latestSuccess?.executed_at ? new Date(latestSuccess.executed_at) : null;
    const latestFailureAt = latestFailure?.executed_at ? new Date(latestFailure.executed_at) : null;
    const recovered = Boolean(
      latestSuccessAt
      && latestFailureAt
      && latestSuccessAt.getTime() > latestFailureAt.getTime()
    );
    return {
      latestSuccessAt: latestSuccessAt ? latestSuccessAt.toISOString() : '',
      latestFailureAt: latestFailureAt ? latestFailureAt.toISOString() : '',
      successCount: Number(successCountRow?.cnt || 0),
      recovered,
    };
  } catch {
    return {
      latestSuccessAt: '',
      latestFailureAt: '',
      successCount: 0,
      recovered: false,
    };
  }
}

async function getCourtesyReflectionRecheck(baseline = null) {
  const commentSinceClause = buildSinceClause('detected_at', baseline);
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        id,
        commenter_name,
        LEFT(comment_text, 140) AS comment_text,
        error_message,
        detected_at
      FROM blog.comments
      WHERE detected_at >= now() - interval '14 days'
        ${commentSinceClause}
        AND status = 'skipped'
        AND COALESCE(error_message, '') = 'generic_greeting_comment'
      ORDER BY detected_at DESC
      LIMIT 25
    `);

    const reevaluable = [];
    for (const row of rows || []) {
      const reassessed = assessInboundComment({ comment_text: row.comment_text });
      if (reassessed?.ok && ['courtesy_reflection_allowed', 'generic_greeting_reply_allowed'].includes(String(reassessed?.reason || ''))) {
        reevaluable.push({
          id: row.id,
          commenterName: row.commenter_name,
          commentText: row.comment_text,
          detectedAt: row.detected_at,
          reassessedReason: reassessed.reason,
        });
      }
    }

    return {
      reviewedCount: Array.isArray(rows) ? rows.length : 0,
      reevaluableCount: reevaluable.length,
      reevaluableSamples: reevaluable.slice(0, 3),
    };
  } catch {
    return {
      reviewedCount: 0,
      reevaluableCount: 0,
      reevaluableSamples: [],
    };
  }
}

async function getExposureSignal(baseline = null) {
  const commentSinceClause = buildSinceClause('detected_at', baseline);
  const neighborSinceClause = buildSinceClause('created_at', baseline);
  try {
    const rows = await pgPool.query('blog', `
      WITH days AS (
        SELECT generate_series(
          (timezone('Asia/Seoul', now())::date - interval '4 days')::date,
          timezone('Asia/Seoul', now())::date,
          interval '1 day'
        )::date AS day
      ),
      inbound AS (
        SELECT
          timezone('Asia/Seoul', detected_at)::date AS day,
          COUNT(*)::int AS inbound_count,
          COUNT(*) FILTER (WHERE status = 'replied')::int AS replied_count
        FROM blog.comments
        WHERE detected_at >= now() - interval '5 days'
          ${commentSinceClause}
        GROUP BY 1
      ),
      neighbor AS (
        SELECT
          timezone('Asia/Seoul', created_at)::date AS day,
          COUNT(*) FILTER (WHERE status = 'posted')::int AS neighbor_posted
        FROM blog.neighbor_comments
        WHERE created_at >= now() - interval '5 days'
          ${neighborSinceClause}
        GROUP BY 1
      )
      SELECT
        d.day::text AS day,
        COALESCE(i.inbound_count, 0)::int AS inbound_count,
        COALESCE(i.replied_count, 0)::int AS replied_count,
        COALESCE(n.neighbor_posted, 0)::int AS neighbor_posted
      FROM days d
      LEFT JOIN inbound i USING (day)
      LEFT JOIN neighbor n USING (day)
      ORDER BY d.day DESC
    `);

    const normalized = Array.isArray(rows) ? rows.map((row) => ({
      day: String(row.day || ''),
      inboundCount: Number(row.inbound_count || 0),
      repliedCount: Number(row.replied_count || 0),
      neighborPosted: Number(row.neighbor_posted || 0),
    })) : [];

    let consecutiveNoInboundDays = 0;
    for (const row of normalized) {
      if (row.inboundCount > 0) break;
      consecutiveNoInboundDays += 1;
    }

    const daysWithNoInbound = normalized.filter((row) => row.inboundCount === 0).length;
    const totalInbound = normalized.reduce((sum, row) => sum + row.inboundCount, 0);
    const totalNeighborPosted = normalized.reduce((sum, row) => sum + row.neighborPosted, 0);
    const activeDays = normalized.filter((row) => row.inboundCount > 0 || row.neighborPosted > 0).length;
    const needsStrategy =
      consecutiveNoInboundDays >= 3
      || (daysWithNoInbound >= 4 && totalInbound <= 1 && totalNeighborPosted <= 2)
      || (daysWithNoInbound >= 3 && activeDays <= 1);

    return {
      windowDays: normalized.length,
      rows: normalized,
      consecutiveNoInboundDays,
      daysWithNoInbound,
      totalInbound,
      totalNeighborPosted,
      activeDays,
      needsStrategy,
    };
  } catch {
    return {
      windowDays: 0,
      rows: [],
      consecutiveNoInboundDays: 0,
      daysWithNoInbound: 0,
      totalInbound: 0,
      totalNeighborPosted: 0,
      activeDays: 0,
      needsStrategy: false,
    };
  }
}

function buildActions({ latestReplyReplayCandidate, failureByKind, failureByAction, targetGaps, primaryGap, replyWorkload, neighborWorkload, courtesyReflectionRecheck, adaptiveNeighborCadence, neighborCollectDiagnostics, lastGapRun, neighborUiReplay = null, neighborSympathyReplay = null, staleSympathyFailureCount = 0, exposureSignal = null, primary }) {
  const actions = [];
  if (neighborUiReplay?.ok) {
    if (neighborUiReplay?.result?.ok) {
      actions.push(`최근 neighbor replay 성공: ${Number(neighborUiReplay?.candidate?.id || 0)} / ${String(neighborUiReplay?.candidate?.targetBlogId || '').trim() || 'unknown'}`);
    } else if (neighborUiReplay?.result?.skipped) {
      actions.push(`최근 neighbor replay는 UI 재현 후 skip: ${String(neighborUiReplay?.result?.reason || 'unknown')}`);
    } else if (neighborUiReplay?.reason) {
      actions.push(`최근 neighbor replay 실패: ${String(neighborUiReplay.reason)}`);
    }
  }
  if (neighborSympathyReplay?.ok) {
    if (neighborSympathyReplay?.result?.ok) {
      actions.push(`최근 neighbor sympathy replay 성공: ${Number(neighborSympathyReplay?.candidate?.id || 0)} / ${String(neighborSympathyReplay?.candidate?.targetBlogId || '').trim() || 'unknown'}`);
    } else if (neighborSympathyReplay?.result?.skipped) {
      actions.push(`최근 neighbor sympathy replay는 UI 재현 후 skip: ${String(neighborSympathyReplay?.result?.reason || 'unknown')}`);
    } else if (neighborSympathyReplay?.result?.error) {
      actions.push(`최근 neighbor sympathy replay 실패: ${String(neighborSympathyReplay.result.error)}`);
    } else if (neighborSympathyReplay?.error) {
      actions.push(`최근 neighbor sympathy replay 실패: ${String(neighborSympathyReplay.error)}`);
    }
  }
  if (Number(staleSympathyFailureCount || 0) > 0) {
    actions.push(`최근 neighbor sympathy replay 성공 이후 stale sympathy failures ${Number(staleSympathyFailureCount)}건은 현재 우선 병목에서 제외`);
  }
  if ((failureByKind.ui || 0) > 0 || (failureByKind.browser || 0) > 0) {
    const uiFocus = buildUiFocus(failureByAction);
    actions.push(
      uiFocus.action === 'sympathy'
        ? '네이버 외부 공감 button selector와 confirm 흐름 점검'
        : uiFocus.focus.includes('외부 댓글')
          ? '네이버 외부 댓글 submit selector와 confirm 흐름 점검'
          : '네이버 reply UI selector와 browser mount 흐름 점검'
    );
  }
  if ((failureByKind.llm || 0) > 0) {
    actions.push('reply 생성 LLM timeout / fetch 실패 로그 확인');
  }
  if (Array.isArray(targetGaps) && targetGaps.length > 0) {
    if (adaptiveNeighborCadence?.shouldBoost) {
      actions.push(`외부 댓글 cadence boost 적용 중: reply+neighbor ${adaptiveNeighborCadence.combinedCommentSuccess}/${adaptiveNeighborCadence.combinedCommentExpectedNow}, process ${adaptiveNeighborCadence.effectiveProcessLimit}, collect ${adaptiveNeighborCadence.effectiveCollectLimit}`);
    }
    if (primaryGap?.label === 'replies' && Number(replyWorkload?.pendingBacklogCount || 0) > 0) {
      actions.push(`현재 처리 가능한 reply backlog가 ${replyWorkload.pendingBacklogCount}건 있습니다`);
    }
    if (primaryGap?.label === 'neighbor' && Number(neighborWorkload?.pendingCount || 0) > 0) {
      actions.push(`현재 처리 가능한 neighbor queue가 ${neighborWorkload.pendingCount}건 있습니다`);
    }
    if (
      primaryGap?.label === 'replies'
      && Number(replyWorkload?.pendingCount || 0) === 0
      && Number(replyWorkload?.pendingBacklogCount || 0) === 0
      && (
        String(replyWorkload?.latest?.status || '') === 'skipped'
        || Number(replyWorkload?.totalToday || 0) === 0
      )
    ) {
      if (String(replyWorkload?.latest?.status || '') === 'skipped') {
        actions.push(`현재 reply 대상이 없습니다 — latest skipped: ${String(replyWorkload.latest.errorMessage || 'unknown')}`);
      } else {
        actions.push('현재 reply 대상이 없습니다 — baseline 이후 inbound 댓글이 없습니다');
      }
      const dominantSkip = Array.isArray(replyWorkload?.skippedReasons14d) ? replyWorkload.skippedReasons14d[0] : null;
      if (dominantSkip?.reason) {
        actions.push(`최근 14일 주요 inbound 필터: ${dominantSkip.reason} ${dominantSkip.count}건`);
      }
      if (Number(courtesyReflectionRecheck?.reevaluableCount || 0) > 0) {
        actions.push(`최근 generic greeting skip 중 ${courtesyReflectionRecheck.reevaluableCount}건은 현재 inbound reply 정책으로 다시 reply 후보가 될 수 있습니다`);
        actions.push(`${BACKFILL_COURTESY_REPLIES_COMMAND} -- --dry-run`);
      }
    }
    if (
      primaryGap?.label === 'neighbor'
      && Number(neighborWorkload?.pendingCount || 0) === 0
      && Number(neighborWorkload?.postedCount || 0) === 0
      && Number(neighborWorkload?.failedCount || 0) === 0
    ) {
      actions.push('현재 바로 처리할 neighbor comment queue가 없습니다');
      if (neighborCollectDiagnostics) {
        actions.push(
          `최근 수집 진단: buddy ${Number(neighborCollectDiagnostics.buddyFeedSourceCount || 0)} / network ${Number(neighborCollectDiagnostics.commenterNetworkSourceCount || 0)} / resolved ${Number(neighborCollectDiagnostics.commenterNetworkResolvedCount || 0)} / collected ${Number(neighborCollectDiagnostics.rawCollectedCount || 0)} / inserted ${Number(neighborCollectDiagnostics.insertedCount || 0)}`
        );
        if (neighborCollectDiagnostics.relaxedRetryUsed) {
          actions.push(`recent window 완화 재시도 적용: ${Number(neighborCollectDiagnostics.relaxedRecentWindowDays || 0)}일`);
        }
        actions.push(
          `수집 병목: buddy recent ${Number(neighborCollectDiagnostics.buddyFeedRecentBlogSkipCount || 0)} / buddy seen ${Number(neighborCollectDiagnostics.buddyFeedSeenUrlSkipCount || 0)} / network recent ${Number(neighborCollectDiagnostics.commenterNetworkRecentBlogSkipCount || 0)} / network resolve fail ${Number(neighborCollectDiagnostics.commenterNetworkResolveFailedCount || 0)} / network seen ${Number(neighborCollectDiagnostics.commenterNetworkSeenUrlSkipCount || 0)}`
        );
      }
    }
    if (lastGapRun?.allIdle) {
      const attemptedSummary = Array.isArray(lastGapRun.attempted)
        ? lastGapRun.attempted.map((item) => String(item?.label || '')).filter(Boolean).join(' -> ')
        : '';
      actions.push(`최근 gap run도 idle: ${attemptedSummary || 'attempted 없음'} / ${String(lastGapRun.idleReason || '즉시 처리할 workload 없음')}`);
    }
    actions.push(
      primaryGap?.label
        ? `운영 시간대 기준 ${primaryGap.label} 목표치 격차를 먼저 점검`
        : '운영 시간대 기준 댓글/답글/공감 목표치와 현재 실적 차이를 점검'
    );
    if (primaryGap?.label) {
      actions.push(getGapActionCommand(primaryGap.label));
    }
  }
  if (exposureSignal?.needsStrategy) {
    actions.push(`최근 ${Number(exposureSignal.windowDays || 0)}일 중 댓글 유입 없는 날 ${Number(exposureSignal.daysWithNoInbound || 0)}일 / 연속 무유입 ${Number(exposureSignal.consecutiveNoInboundDays || 0)}일`);
    actions.push(`최근 ${Number(exposureSignal.windowDays || 0)}일 inbound ${Number(exposureSignal.totalInbound || 0)}건 / neighbor posted ${Number(exposureSignal.totalNeighborPosted || 0)}건`);
    actions.push(RUN_REVENUE_STRATEGY_COMMAND);
  }
  if (latestReplyReplayCandidate?.id) {
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run replay:reply-ui -- --comment-id ${latestReplyReplayCandidate.id} --json`);
  }
  if (actions.length === 0) {
    actions.push('engagement 실패 없음 — 다음 운영 사이클 관찰');
  }

  const prioritized = [];
  const primaryArea = String(primary?.area || '');
  const hasActivePrimary = primaryArea && primaryArea !== 'clear' && primaryArea !== 'unknown';
  if (hasActivePrimary && primary?.actionFocus) {
    prioritized.push(`focus blocker: ${primary.actionFocus}`);
  }
  if (hasActivePrimary && primary?.nextCommand) {
    prioritized.push(`우선 실행: ${primary.nextCommand}`);
  }

  return Array.from(new Set([...prioritized, ...actions]));
}

function buildPrimary({ failureByKind, failureByAction, latestReplyReplayCandidate, targetGaps, primaryGap, replyWorkload, neighborWorkload, courtesyReflectionRecheck, adaptiveNeighborCadence, neighborCollectDiagnostics, lastGapRun, exposureSignal = null }) {
  const blogPrefix = `npm --prefix ${BLOG_ROOT}`;
  if ((failureByKind.ui || 0) > 0 || (failureByKind.browser || 0) > 0) {
    const uiFocus = buildUiFocus(failureByAction);
    const uiNextCommand = uiFocus.action === 'sympathy'
      ? REPLAY_NEIGHBOR_SYMPATHY_COMMAND
      : uiFocus.action === 'neighbor'
        ? REPLAY_NEIGHBOR_UI_COMMAND
        : (
          latestReplyReplayCandidate?.id
            ? `${blogPrefix} run replay:reply-ui -- --comment-id ${latestReplyReplayCandidate.id} --json`
            : `${blogPrefix} run doctor:engagement -- --json`
        );
    return {
      area: 'engagement.ui',
      reason: uiFocus.reason,
      nextCommand: uiNextCommand,
      actionFocus: uiFocus.focus,
    };
  }
  if ((failureByKind.llm || 0) > 0) {
    const llmNextCommand = Number(failureByAction?.sympathy || 0) >= Math.max(Number(failureByAction?.reply || 0), Number(failureByAction?.neighbor_comment || 0))
      ? REPLAY_NEIGHBOR_SYMPATHY_COMMAND
      : Number(failureByAction?.neighbor_comment || 0) > Number(failureByAction?.reply || 0)
        ? REPLAY_NEIGHBOR_UI_COMMAND
        : `${blogPrefix} run doctor:engagement -- --json`;
    return {
      area: 'engagement.llm',
      reason: 'reply 생성 LLM 실패가 현재 engagement 최우선 병목입니다.',
      nextCommand: llmNextCommand,
      actionFocus: 'timeout, fetch failed, 429 등 생성 경로 로그 확인',
    };
  }
  if ((failureByKind.verification || 0) > 0) {
    return {
      area: 'engagement.verification',
      reason: 'reply verification false positive가 현재 engagement 최우선 병목입니다.',
      nextCommand: `${blogPrefix} run doctor:engagement -- --json`,
      actionFocus: 'verification 로직과 correction reason 확인',
    };
  }
  if (Array.isArray(targetGaps) && targetGaps.length > 0) {
    if (
      primaryGap?.label === 'neighbor'
      && Number(neighborWorkload?.pendingCount || 0) === 0
      && Number(neighborWorkload?.postedCount || 0) === 0
      && Number(neighborWorkload?.failedCount || 0) === 0
    ) {
      const collectSummary = neighborCollectDiagnostics
        ? ` 최근 수집: buddy ${Number(neighborCollectDiagnostics.buddyFeedSourceCount || 0)} / network ${Number(neighborCollectDiagnostics.commenterNetworkSourceCount || 0)} / resolved ${Number(neighborCollectDiagnostics.commenterNetworkResolvedCount || 0)} / collected ${Number(neighborCollectDiagnostics.rawCollectedCount || 0)} / inserted ${Number(neighborCollectDiagnostics.insertedCount || 0)} / resolve_fail ${Number(neighborCollectDiagnostics.commenterNetworkResolveFailedCount || 0)}${neighborCollectDiagnostics.relaxedRetryUsed ? ` / relaxed_window ${Number(neighborCollectDiagnostics.relaxedRecentWindowDays || 0)}d` : ''}.`
        : '';
      return {
        area: 'engagement.target_gap.neighbor.no_workload',
        reason: `neighbor 목표치는 비어 있지만 현재 바로 처리할 neighbor queue가 없습니다 (posted ${Number(neighborWorkload?.postedCount || 0)} / pending ${Number(neighborWorkload?.pendingCount || 0)} / failed ${Number(neighborWorkload?.failedCount || 0)}).${collectSummary}`,
        nextCommand: `${RUN_ENGAGEMENT_GAP_COMMAND} -- --label=neighbor`,
        actionFocus: '외부 댓글 수집/유입과 현재 시간대 queue 생성 여부 점검',
      };
    }
    if (primaryGap?.label === 'replies' && Number(replyWorkload?.pendingBacklogCount || 0) > 0) {
      return {
        area: 'engagement.target_gap.replies.pending_backlog',
        reason: `replies 목표치는 비어 있고 현재 처리 가능한 pending reply backlog가 ${replyWorkload.pendingBacklogCount}건 있습니다.`,
        nextCommand: `${RUN_ENGAGEMENT_GAP_COMMAND} -- --label=replies`,
        actionFocus: 'pending reply backlog를 실제 답글 처리로 전환',
      };
    }
    if (
      primaryGap?.label === 'replies'
      && Number(replyWorkload?.pendingCount || 0) === 0
      && Number(replyWorkload?.pendingBacklogCount || 0) === 0
      && (
        String(replyWorkload?.latest?.status || '') === 'skipped'
        || Number(replyWorkload?.totalToday || 0) === 0
      )
    ) {
      if (Number(courtesyReflectionRecheck?.reevaluableCount || 0) > 0) {
        return {
          area: 'engagement.target_gap.replies.backfillable',
          reason: `replies 목표치는 비어 있지만 최근 generic greeting skip 중 ${courtesyReflectionRecheck.reevaluableCount}건은 현재 inbound reply 정책으로 reply 후보로 되살릴 수 있습니다.`,
          nextCommand: `${BACKFILL_COURTESY_REPLIES_COMMAND}`,
          actionFocus: '재평가 가능한 courtesy 댓글을 pending으로 되살린 뒤 reply 실행',
        };
      }
      if (Number(neighborWorkload?.pendingCount || 0) > 0) {
        return {
          area: 'engagement.target_gap.replies.no_workload',
          reason: `replies 목표치는 비어 있지만 현재 reply 대상 댓글이 없습니다 (baseline 이후 inbound 댓글 0건 / neighbor pending ${Number(neighborWorkload.pendingCount || 0)}건).`,
          nextCommand: `node ${path.join(BLOG_ROOT, 'scripts/run-neighbor-commenter.ts')}`,
          actionFocus: 'reply 대상이 없는 동안 쌓인 neighbor pending queue를 실제 댓글 처리로 전환',
        };
      }
      return {
        area: 'engagement.target_gap.replies.no_workload',
        reason: `replies 목표치는 비어 있지만 현재 reply 대상 댓글이 없습니다 (${String(replyWorkload?.latest?.status || '') === 'skipped' ? `latest skipped: ${String(replyWorkload.latest.errorMessage || 'unknown')}` : 'baseline 이후 inbound 댓글 0건'}${Array.isArray(replyWorkload?.skippedReasons14d) && replyWorkload.skippedReasons14d[0]?.reason ? ` / 14d top filter: ${replyWorkload.skippedReasons14d[0].reason} ${replyWorkload.skippedReasons14d[0].count}건` : ''}${Number(courtesyReflectionRecheck?.reevaluableCount || 0) > 0 ? ` / reevaluable by current reply policy: ${courtesyReflectionRecheck.reevaluableCount}건` : ''}${lastGapRun?.allIdle ? ` / 최근 gap run도 idle` : ''}).`,
        nextCommand: lastGapRun?.allIdle ? RUN_NEIGHBOR_COLLECT_ONLY_COMMAND : `${RUN_ENGAGEMENT_GAP_COMMAND} -- --label=neighbor`,
        actionFocus: lastGapRun?.allIdle
          ? '최근 gap run도 idle이라 이웃/외부 댓글 수집 후보 resolve/insert 병목을 먼저 점검'
          : 'reply 대상이 없을 때 남은 목표를 이웃/외부 댓글로 보충하고 inbound 유입을 함께 점검',
      };
    }
    return {
      area: primaryGap?.label ? `engagement.target_gap.${primaryGap.label}` : 'engagement.target_gap',
      reason: primaryGap?.label
        ? `운영 시간대 기준 ${primaryGap.label} 목표치가 가장 크게 뒤처졌습니다 (${primaryGap.success}/${primaryGap.expectedNow}, deficit ${primaryGap.deficit}).`
        : `운영 시간대 기준 engagement 목표치가 뒤처졌습니다 (${targetGaps.join(', ')}).`,
      nextCommand: primaryGap?.label ? `${RUN_ENGAGEMENT_GAP_COMMAND} -- --label=${primaryGap.label}` : `${blogPrefix} run doctor:engagement -- --json`,
      actionFocus: primaryGap?.label
        ? `${primaryGap.label} 목표치와 현재 시간대 실적 차이 점검`
        : '답글/댓글/공감 목표치와 현재 시간대 실적 차이 점검',
    };
  }
  if (exposureSignal?.needsStrategy) {
    return {
      area: 'engagement.strategy.visibility',
      reason: `최근 ${Number(exposureSignal.windowDays || 0)}일 동안 댓글 유입 부진 신호가 누적됐습니다 (무유입 ${Number(exposureSignal.daysWithNoInbound || 0)}일 / 연속 무유입 ${Number(exposureSignal.consecutiveNoInboundDays || 0)}일 / inbound ${Number(exposureSignal.totalInbound || 0)}건 / neighbor posted ${Number(exposureSignal.totalNeighborPosted || 0)}건). 노출·유입 전략 재수립이 필요합니다.`,
      nextCommand: RUN_REVENUE_STRATEGY_COMMAND,
      actionFocus: '댓글 유입 저하에 대응할 제목·주제·CTA 전략 재수립',
    };
  }
  return {
    area: 'clear',
    reason: '현재 engagement 자동화의 즉시 조치가 필요한 병목은 없습니다.',
    nextCommand: `${blogPrefix} run doctor:engagement -- --json`,
    actionFocus: '다음 운영 시간대 관찰',
  };
}

function buildEngagementDoctorFallback(payload = {}) {
  if (payload.totalFailures > 0) {
    return 'engagement 자동화는 최근 실패 흔적이 있어 replay 대상과 UI/browser 실패 비중부터 확인하는 편이 좋습니다.';
  }
  if (
    payload.primary?.area === 'engagement.target_gap.replies.no_workload'
    || (
      payload.replyWorkload?.pendingCount === 0
      && payload.primaryGap?.label === 'replies'
      && (
        payload.replyWorkload?.latest?.status === 'skipped'
        || Number(payload.replyWorkload?.totalToday || 0) === 0
      )
    )
  ) {
    return 'engagement 자동화는 지금 실행 실패보다 replyable inbound 부족이 더 큰 이유라서, 최신 필터링 사유와 최근 누적 skip 패턴을 먼저 보는 편이 좋습니다.';
  }
  if (payload.primary?.area === 'engagement.target_gap.neighbor.no_workload') {
    return 'engagement 자동화는 지금 외부 댓글 목표 gap은 크지만 바로 처리할 neighbor queue가 없어, 수집/유입 쪽을 먼저 보는 편이 좋습니다.';
  }
  if (payload.primary?.area === 'engagement.strategy.visibility') {
    return 'engagement 자동화 자체는 크게 막히지 않았지만 댓글 유입 저하가 누적돼 있어, 노출과 유입 전략을 다시 짜는 편이 좋습니다.';
  }
  if (Array.isArray(payload.targetGaps) && payload.targetGaps.length > 0) {
    return 'engagement 자동화는 운영 시간대 기준 목표치가 뒤처져 있어 실적 차이와 다음 실행 사이클을 먼저 보는 편이 좋습니다.';
  }
  return 'engagement 자동화는 지금 큰 실패가 없어 다음 운영 시간대에 다시 관찰하면 됩니다.';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const developmentBaseline = readDevelopmentBaseline();
  const actionSinceClause = buildSinceClause('executed_at', developmentBaseline);
  const [rows, latestReplyReplayCandidate, replyWorkload, neighborWorkload, courtesyReflectionRecheck] = await Promise.all([
    pgPool.query('blog', `
      SELECT action_type, meta, executed_at
      FROM blog.comment_actions
      WHERE timezone('Asia/Seoul', executed_at)::date = timezone('Asia/Seoul', now())::date
        AND success = false
        ${actionSinceClause}
      ORDER BY executed_at DESC
      LIMIT 50
    `),
    getLatestReplyReplayCandidate(developmentBaseline),
    getReplyWorkloadStatus(developmentBaseline),
    getNeighborWorkloadStatus(developmentBaseline),
    getCourtesyReflectionRecheck(developmentBaseline),
  ]);
  const neighborRecovery = await getNeighborRecoveryStatus(developmentBaseline);
  const lastGapRun = readLastEngagementGapRun(developmentBaseline);
  const neighborUiReplay = readNeighborUiReplay(developmentBaseline);
  const neighborSympathyReplay = readNeighborSympathyReplay(developmentBaseline);
  const commenterRun = readCommenterRunResult();
  const latestSympathyReplayAt = neighborSympathyReplay?.result?.ok && neighborSympathyReplay?.replayedAt
    ? new Date(neighborSympathyReplay.replayedAt)
    : null;

  const replyConfig = runtimeConfig.commenter || {};
  const neighborConfig = runtimeConfig.neighborCommenter || {};

  const effectiveRows = (rows || []).filter((row) => {
    if (!neighborRecovery?.recovered) return true;
    if (String(row.action_type || '') !== 'neighbor_comment') return true;
    const executedAt = row?.executed_at ? new Date(row.executed_at) : null;
    if (!executedAt || Number.isNaN(executedAt.getTime())) return true;
    return executedAt.getTime() > new Date(neighborRecovery.latestSuccessAt).getTime();
  }).filter((row) => {
    if (!String(row.action_type || '').includes('sympathy')) return true;
    const executedAt = row?.executed_at ? new Date(row.executed_at) : null;
    if (!latestSympathyReplayAt || Number.isNaN(latestSympathyReplayAt.getTime()) || !executedAt || Number.isNaN(executedAt.getTime())) return true;
    return executedAt.getTime() > latestSympathyReplayAt.getTime();
  }).filter((row) => {
    if (String(row.action_type || '') !== 'reply') return true;
    if (!commenterRun?.executedAt || Number(commenterRun?.failed || 0) > 0) return true;
    const executedAt = row?.executed_at ? new Date(row.executed_at) : null;
    const runAt = commenterRun?.executedAt ? new Date(commenterRun.executedAt) : null;
    if (!executedAt || Number.isNaN(executedAt.getTime()) || !runAt || Number.isNaN(runAt.getTime())) return true;
    const sample = summarizeEngagementFailure(row.meta || {});
    if (!String(sample || '').includes('isReplyModeOpen is not defined')) return true;
    return executedAt.getTime() > runAt.getTime();
  });
  const staleFailureCount = Math.max(0, Number((rows || []).length) - Number(effectiveRows.length));
  const staleSympathyFailureCount = Array.isArray(rows)
    ? rows.filter((row) => {
        if (!String(row?.action_type || '').includes('sympathy')) return false;
        const executedAt = row?.executed_at ? new Date(row.executed_at) : null;
        return Boolean(
          latestSympathyReplayAt
          && !Number.isNaN(latestSympathyReplayAt.getTime())
          && executedAt
          && !Number.isNaN(executedAt.getTime())
          && executedAt.getTime() <= latestSympathyReplayAt.getTime()
        );
      }).length
    : 0;

  const failureByKind = { ui: 0, browser: 0, llm: 0, verification: 0, unknown: 0 };
  const failureByAction = { reply: 0, neighbor_comment: 0, sympathy: 0 };
  const failureSamples = [];

  for (const row of effectiveRows || []) {
    const kind = classifyEngagementFailure(row.meta || {});
    failureByKind[kind] = Number(failureByKind[kind] || 0) + 1;
    const sample = summarizeEngagementFailure(row.meta || {});
    if (sample && failureSamples.length < 5) {
      failureSamples.push({
        actionType: String(row.action_type || ''),
        kind,
        sample,
      });
    }
    const actionType = String(row.action_type || '');
    if (actionType === 'reply') failureByAction.reply += 1;
    else if (actionType === 'neighbor_comment') failureByAction.neighbor_comment += 1;
    else if (actionType.includes('sympathy')) failureByAction.sympathy += 1;
  }

  const aggregateRows = await pgPool.query('blog', `
    SELECT action_type, success, COUNT(*)::int AS cnt
    FROM blog.comment_actions
    WHERE timezone('Asia/Seoul', executed_at)::date = timezone('Asia/Seoul', now())::date
      ${actionSinceClause}
    GROUP BY 1, 2
  `);
  const aggregateMap = new Map();
  for (const row of aggregateRows || []) {
    aggregateMap.set(`${row.action_type}:${row.success ? 'ok' : 'fail'}`, Number(row.cnt || 0));
  }

  const replyPlan = calcExpectedByWindow(
    resolveExecutionTarget('replyTargetPerCycle', strategy, replyConfig.maxDaily || 20),
    replyConfig.activeStartHour || 9,
    replyConfig.activeEndHour || 21,
  );
  const neighborPlan = calcExpectedByWindow(
    resolveExecutionTarget('neighborCommentTargetPerCycle', strategy, neighborConfig.maxDaily || 20),
    neighborConfig.activeStartHour || 9,
    neighborConfig.activeEndHour || 21,
  );
  const sympathyPlan = calcExpectedByWindow(
    resolveExecutionTarget('sympathyTargetPerCycle', strategy, neighborConfig.maxDaily || 20),
    neighborConfig.activeStartHour || 9,
    neighborConfig.activeEndHour || 21,
  );

  const replySuccessCount = Number(aggregateMap.get('reply:ok') || 0);
  const neighborCommentSuccessCount = Number(aggregateMap.get('neighbor_comment:ok') || 0);
  const sympathySuccessCount =
    Number(aggregateMap.get('neighbor_sympathy:ok') || 0) +
    Number(aggregateMap.get('neighbor_comment_sympathy:ok') || 0) +
    Number(aggregateMap.get('comment_post_sympathy:ok') || 0);

  const targetGaps = [];
  if (replyPlan.active && replySuccessCount < replyPlan.expectedNow) {
    targetGaps.push(`replies ${replySuccessCount}/${replyPlan.expectedNow}`);
  }
  if (neighborPlan.active && neighborCommentSuccessCount < neighborPlan.expectedNow) {
    targetGaps.push(`neighbor ${neighborCommentSuccessCount}/${neighborPlan.expectedNow}`);
  }
  if (sympathyPlan.active && sympathySuccessCount < sympathyPlan.expectedNow) {
    targetGaps.push(`sympathy ${sympathySuccessCount}/${sympathyPlan.expectedNow}`);
  }

  const targets = {
    replies: { success: replySuccessCount, target: replyPlan.target, expectedNow: replyPlan.expectedNow, active: replyPlan.active },
    neighborComments: { success: neighborCommentSuccessCount, target: neighborPlan.target, expectedNow: neighborPlan.expectedNow, active: neighborPlan.active },
    sympathies: { success: sympathySuccessCount, target: sympathyPlan.target, expectedNow: sympathyPlan.expectedNow, active: sympathyPlan.active },
  };
  const targetGapDetails = buildTargetGapDetails(targets);
  const primaryGap = targetGapDetails[0] || null;
  const runPlan = buildRunPlan(targetGapDetails);
  const adaptiveNeighborCadence = buildAdaptiveNeighborCadence({
    replySuccess: replySuccessCount,
    neighborSuccess: neighborCommentSuccessCount,
    sympathySuccess: sympathySuccessCount,
    replyPlan,
    neighborPlan,
    adaptiveEnabled: neighborConfig.adaptiveEnabled !== false,
    adaptiveMinGapToBoost: neighborConfig.adaptiveMinGapToBoost || 2,
    adaptiveBoostCap: neighborConfig.adaptiveBoostCap || 12,
    adaptiveCollectBoostCap: neighborConfig.adaptiveCollectBoostCap || 20,
    adaptiveSympathyBoostCap: neighborConfig.adaptiveSympathyBoostCap || 8,
    baseProcess: neighborConfig.maxProcessPerCycle || 20,
    baseCollect: neighborConfig.maxCollectPerCycle || 20,
  });
  const neighborCollectDiagnostics = readNeighborCollectDiagnostics();
  const exposureSignal = await getExposureSignal(developmentBaseline);

  const payload = {
    developmentBaseline: developmentBaseline
      ? {
          active: true,
          startedAt: developmentBaseline.startedAtIso,
          source: developmentBaseline.source,
          note: developmentBaseline.note,
          path: developmentBaseline.path,
        }
      : null,
    totalFailures: Array.isArray(effectiveRows) ? effectiveRows.length : 0,
    rawFailureCount: Array.isArray(rows) ? rows.length : 0,
    staleNeighborFailureCount: staleFailureCount,
    staleSympathyFailureCount,
    failureByKind,
    failureByAction,
    failureSamples,
    latestReplyReplayCandidate: latestReplyReplayCandidate
      ? {
          id: latestReplyReplayCandidate.id,
          commenterName: latestReplyReplayCandidate.commenter_name,
          status: latestReplyReplayCandidate.status,
          postUrl: latestReplyReplayCandidate.post_url,
          commentText: latestReplyReplayCandidate.comment_text,
          fromFailure: Boolean(latestReplyReplayCandidate.from_failure),
        }
      : null,
    targets,
    targetGaps,
    targetGapDetails,
    primaryGap,
    runPlan,
    adaptiveNeighborCadence,
    replyWorkload,
    neighborWorkload,
    neighborCollectDiagnostics,
    neighborRecovery,
    neighborUiReplay: neighborUiReplay
      ? {
          ok: Boolean(neighborUiReplay.ok),
          replayedAt: neighborUiReplay.replayedAt || null,
          candidate: neighborUiReplay.candidate || null,
          resultOk: Boolean(neighborUiReplay.result?.ok),
        }
      : null,
    neighborSympathyReplay: neighborSympathyReplay
      ? {
          ok: Boolean(neighborSympathyReplay.ok),
          replayedAt: neighborSympathyReplay.replayedAt || null,
          candidate: neighborSympathyReplay.candidate || null,
          resultOk: Boolean(neighborSympathyReplay.result?.ok),
          resultSkipped: Boolean(neighborSympathyReplay.result?.skipped),
          resultReason: neighborSympathyReplay.result?.reason || neighborSympathyReplay.result?.error || neighborSympathyReplay.error || '',
        }
      : null,
    commenterRun: commenterRun
      ? {
          executedAt: commenterRun.executedAt || null,
          testMode: Boolean(commenterRun.testMode),
          ok: Boolean(commenterRun.ok),
          failed: Number(commenterRun.failed || 0),
          replied: Number(commenterRun.replied || 0),
          reason: String(commenterRun.reason || ''),
        }
      : null,
    courtesyReflectionRecheck,
    lastGapRun,
    exposureSignal,
  };
  payload.needsAttention = payload.totalFailures > 0 || targetGaps.length > 0 || Boolean(exposureSignal?.needsStrategy);
  payload.primary = buildPrimary({ failureByKind, failureByAction, latestReplyReplayCandidate, targetGaps, primaryGap, replyWorkload, neighborWorkload, courtesyReflectionRecheck, adaptiveNeighborCadence, neighborCollectDiagnostics, lastGapRun, exposureSignal });
  payload.actions = buildActions({ latestReplyReplayCandidate, failureByKind, failureByAction, targetGaps, primaryGap, replyWorkload, neighborWorkload, courtesyReflectionRecheck, adaptiveNeighborCadence, neighborCollectDiagnostics, lastGapRun, neighborUiReplay, neighborSympathyReplay, staleSympathyFailureCount, exposureSignal, primary: payload.primary });

  const aiSummary = await buildBlogCliInsight({
    bot: 'doctor-engagement',
    requestType: 'doctor-engagement',
    title: '블로그 engagement doctor 요약',
    data: payload,
    fallback: buildEngagementDoctorFallback(payload),
  });
  payload.aiSummary = aiSummary;

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[engagement doctor] failures=${payload.totalFailures}`);
  if (payload.developmentBaseline?.startedAt) {
    console.log(`[engagement doctor] baseline=${payload.developmentBaseline.startedAt}`);
  }
  console.log(`🔍 AI: ${payload.aiSummary}`);
  console.log(`[engagement doctor] primary=${payload.primary.area} ${payload.primary.reason}`);
  console.log(`[engagement doctor] next=${payload.primary.nextCommand}`);
  if (payload.primaryGap?.label) {
    console.log(`[engagement doctor] deepest_gap=${payload.primaryGap.label} ${payload.primaryGap.success}/${payload.primaryGap.expectedNow}`);
  }
  if (payload.replyWorkload?.latest?.id) {
    console.log(`[engagement doctor] workload=pending ${payload.replyWorkload.pendingCount} / skipped ${payload.replyWorkload.skippedCount} / latest ${payload.replyWorkload.latest.status} (${String(payload.replyWorkload.latest.errorMessage || 'ok')})`);
  }
  console.log(`[engagement doctor] neighbor_queue=posted ${payload.neighborWorkload.postedCount} / pending ${payload.neighborWorkload.pendingCount} / failed ${payload.neighborWorkload.failedCount}`);
  if (Array.isArray(payload.replyWorkload?.skippedReasonsToday) && payload.replyWorkload.skippedReasonsToday.length > 0) {
    console.log(`[engagement doctor] skipped_today=${payload.replyWorkload.skippedReasonsToday.map((item) => `${item.reason}:${item.count}`).join(', ')}`);
  }
  if (Array.isArray(payload.replyWorkload?.skippedReasons14d) && payload.replyWorkload.skippedReasons14d.length > 0) {
    console.log(`[engagement doctor] skipped_14d=${payload.replyWorkload.skippedReasons14d.map((item) => `${item.reason}:${item.count}`).join(', ')}`);
  }
  if (Number(payload.courtesyReflectionRecheck?.reevaluableCount || 0) > 0) {
    console.log(`[engagement doctor] courtesy_recheck=${payload.courtesyReflectionRecheck.reevaluableCount}/${payload.courtesyReflectionRecheck.reviewedCount}`);
  }
  if (Array.isArray(payload.runPlan) && payload.runPlan.length > 0) {
    console.log(`[engagement doctor] run_plan=${payload.runPlan.map((item) => `${item.step}.${item.label}`).join(' -> ')}`);
  }
  if (payload.adaptiveNeighborCadence?.enabled) {
    console.log(`[engagement doctor] adaptive=${payload.adaptiveNeighborCadence.shouldBoost ? 'boosted' : 'baseline'} comments ${payload.adaptiveNeighborCadence.combinedCommentSuccess}/${payload.adaptiveNeighborCadence.combinedCommentExpectedNow} process ${payload.adaptiveNeighborCadence.effectiveProcessLimit} collect ${payload.adaptiveNeighborCadence.effectiveCollectLimit}`);
  }
  if (payload.lastGapRun?.executedAt) {
    console.log(`[engagement doctor] last_gap_run=${payload.lastGapRun.executedAt} all_idle=${payload.lastGapRun.allIdle ? 'yes' : 'no'}`);
  }
  if (payload.neighborUiReplay?.ok && payload.neighborUiReplay?.resultOk) {
    console.log(`[engagement doctor] neighbor_replay_ok=${payload.neighborUiReplay.replayedAt} candidate=${Number(payload.neighborUiReplay?.candidate?.id || 0)}`);
  }
  if (payload.neighborSympathyReplay?.ok) {
    console.log(`[engagement doctor] neighbor_sympathy_replay=${payload.neighborSympathyReplay.replayedAt} ${payload.neighborSympathyReplay.resultOk ? 'ok' : payload.neighborSympathyReplay.resultSkipped ? 'skipped' : 'failed'}${payload.neighborSympathyReplay.resultReason ? ` ${payload.neighborSympathyReplay.resultReason}` : ''}`);
  }
  if (payload.neighborRecovery?.recovered) {
    console.log(`[engagement doctor] neighbor_recovery=success after failure (${payload.neighborRecovery.latestSuccessAt}) stale_failures=${payload.staleNeighborFailureCount}`);
  }
  if (Number(payload.staleSympathyFailureCount || 0) > 0) {
    console.log(`[engagement doctor] sympathy_recovery=recent replay success stale_failures=${payload.staleSympathyFailureCount}`);
  }
  if (payload.targetGaps.length > 0) {
    console.log(`[engagement doctor] target_gap=${payload.targetGaps.join(' / ')}`);
  }
  console.log(`[engagement doctor] mix=ui ${payload.failureByKind.ui} / browser ${payload.failureByKind.browser} / llm ${payload.failureByKind.llm} / verification ${payload.failureByKind.verification}`);
  if (payload.latestReplyReplayCandidate?.id) {
    console.log(`[engagement doctor] replay=comment ${payload.latestReplyReplayCandidate.id} (${String(payload.latestReplyReplayCandidate.commenterName || 'unknown').slice(0, 30)})`);
  }
  for (const item of payload.failureSamples.slice(0, 3)) {
    console.log(`[engagement doctor] sample=${item.kind}/${item.actionType} ${item.sample}`);
  }
  for (const action of payload.actions) {
    console.log(`- ${action}`);
  }
}

main()
  .catch((error) => {
    console.error('[engagement doctor] 실패:', error?.message || error);
    process.exit(1);
  })
  .finally(async () => {
    await pgPool.closeAll().catch(() => {});
  });
