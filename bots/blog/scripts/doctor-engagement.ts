#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool.js');
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');
const { getBlogHealthRuntimeConfig } = require('../lib/runtime-config.ts');
const { assessInboundComment } = require('../lib/commenter.ts');
const { readDevelopmentBaseline, buildSinceClause } = require('../lib/dev-baseline.ts');

const runtimeConfig = getBlogHealthRuntimeConfig();
const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots/blog');
const RUN_ENGAGEMENT_GAP_COMMAND = `npm --prefix ${BLOG_ROOT} run run:engagement-gap`;
const BACKFILL_COURTESY_REPLIES_COMMAND = `npm --prefix ${BLOG_ROOT} run backfill:courtesy-replies`;

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

function buildActions({ latestReplyReplayCandidate, failureByKind, targetGaps, primaryGap, replyWorkload, courtesyReflectionRecheck, adaptiveNeighborCadence, primary }) {
  const actions = [];
  if ((failureByKind.ui || 0) > 0 || (failureByKind.browser || 0) > 0) {
    actions.push('네이버 reply UI selector와 browser mount 흐름 점검');
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
    if (
      primaryGap?.label === 'replies'
      && Number(replyWorkload?.pendingCount || 0) === 0
      && Number(replyWorkload?.pendingBacklogCount || 0) === 0
      && String(replyWorkload?.latest?.status || '') === 'skipped'
    ) {
      actions.push(`현재 reply 대상이 없습니다 — latest skipped: ${String(replyWorkload.latest.errorMessage || 'unknown')}`);
      const dominantSkip = Array.isArray(replyWorkload?.skippedReasons14d) ? replyWorkload.skippedReasons14d[0] : null;
      if (dominantSkip?.reason) {
        actions.push(`최근 14일 주요 inbound 필터: ${dominantSkip.reason} ${dominantSkip.count}건`);
      }
      if (Number(courtesyReflectionRecheck?.reevaluableCount || 0) > 0) {
        actions.push(`최근 generic greeting skip 중 ${courtesyReflectionRecheck.reevaluableCount}건은 현재 inbound reply 정책으로 다시 reply 후보가 될 수 있습니다`);
        actions.push(`${BACKFILL_COURTESY_REPLIES_COMMAND} -- --dry-run`);
      }
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

function buildPrimary({ failureByKind, latestReplyReplayCandidate, targetGaps, primaryGap, replyWorkload, courtesyReflectionRecheck, adaptiveNeighborCadence }) {
  const blogPrefix = `npm --prefix ${BLOG_ROOT}`;
  if ((failureByKind.ui || 0) > 0 || (failureByKind.browser || 0) > 0) {
    return {
      area: 'engagement.ui',
      reason: 'reply UI 또는 browser 흐름 실패가 현재 engagement 최우선 병목입니다.',
      nextCommand: latestReplyReplayCandidate?.id
        ? `${blogPrefix} run replay:reply-ui -- --comment-id ${latestReplyReplayCandidate.id} --json`
        : `${blogPrefix} run doctor:engagement -- --json`,
      actionFocus: '네이버 reply button / submit / editor mount 흐름 재현',
    };
  }
  if ((failureByKind.llm || 0) > 0) {
    return {
      area: 'engagement.llm',
      reason: 'reply 생성 LLM 실패가 현재 engagement 최우선 병목입니다.',
      nextCommand: `${blogPrefix} run doctor:engagement -- --json`,
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
      && String(replyWorkload?.latest?.status || '') === 'skipped'
    ) {
      if (Number(courtesyReflectionRecheck?.reevaluableCount || 0) > 0) {
        return {
          area: 'engagement.target_gap.replies.backfillable',
          reason: `replies 목표치는 비어 있지만 최근 generic greeting skip 중 ${courtesyReflectionRecheck.reevaluableCount}건은 현재 inbound reply 정책으로 reply 후보로 되살릴 수 있습니다.`,
          nextCommand: `${BACKFILL_COURTESY_REPLIES_COMMAND}`,
          actionFocus: '재평가 가능한 courtesy 댓글을 pending으로 되살린 뒤 reply 실행',
        };
      }
      return {
        area: 'engagement.target_gap.replies.no_workload',
        reason: `replies 목표치는 비어 있지만 현재 reply 대상 댓글이 없습니다 (latest skipped: ${String(replyWorkload.latest.errorMessage || 'unknown')}${Array.isArray(replyWorkload?.skippedReasons14d) && replyWorkload.skippedReasons14d[0]?.reason ? ` / 14d top filter: ${replyWorkload.skippedReasons14d[0].reason} ${replyWorkload.skippedReasons14d[0].count}건` : ''}${Number(courtesyReflectionRecheck?.reevaluableCount || 0) > 0 ? ` / reevaluable by current reply policy: ${courtesyReflectionRecheck.reevaluableCount}건` : ''}).`,
        nextCommand: `${RUN_ENGAGEMENT_GAP_COMMAND} -- --label=replies`,
        actionFocus: 'replyable inbound 유입과 필터링 기준 점검',
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
  if (payload.replyWorkload?.pendingCount === 0 && payload.replyWorkload?.latest?.status === 'skipped' && payload.primaryGap?.label === 'replies') {
    return 'engagement 자동화는 지금 실행 실패보다 replyable inbound 부족이 더 큰 이유라서, 최신 필터링 사유와 최근 누적 skip 패턴을 먼저 보는 편이 좋습니다.';
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
  const [rows, latestReplyReplayCandidate, replyWorkload, courtesyReflectionRecheck] = await Promise.all([
    pgPool.query('blog', `
      SELECT action_type, meta
      FROM blog.comment_actions
      WHERE timezone('Asia/Seoul', executed_at)::date = timezone('Asia/Seoul', now())::date
        AND success = false
        ${actionSinceClause}
      ORDER BY executed_at DESC
      LIMIT 50
    `),
    getLatestReplyReplayCandidate(developmentBaseline),
    getReplyWorkloadStatus(developmentBaseline),
    getCourtesyReflectionRecheck(developmentBaseline),
  ]);

  const replyConfig = runtimeConfig.commenter || {};
  const neighborConfig = runtimeConfig.neighborCommenter || {};

  const failureByKind = { ui: 0, browser: 0, llm: 0, verification: 0, unknown: 0 };
  const failureByAction = { reply: 0, neighbor_comment: 0, sympathy: 0 };
  const failureSamples = [];

  for (const row of rows || []) {
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
    replyConfig.maxDaily || 20,
    replyConfig.activeStartHour || 9,
    replyConfig.activeEndHour || 21,
  );
  const neighborPlan = calcExpectedByWindow(
    neighborConfig.maxDaily || 20,
    neighborConfig.activeStartHour || 9,
    neighborConfig.activeEndHour || 21,
  );
  const sympathyPlan = calcExpectedByWindow(
    neighborConfig.maxDaily || 20,
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
    totalFailures: Array.isArray(rows) ? rows.length : 0,
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
    courtesyReflectionRecheck,
  };
  payload.needsAttention = payload.totalFailures > 0 || targetGaps.length > 0;
  payload.primary = buildPrimary({ failureByKind, latestReplyReplayCandidate, targetGaps, primaryGap, replyWorkload, courtesyReflectionRecheck, adaptiveNeighborCadence });
  payload.actions = buildActions({ latestReplyReplayCandidate, failureByKind, targetGaps, primaryGap, replyWorkload, courtesyReflectionRecheck, adaptiveNeighborCadence, primary: payload.primary });

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
