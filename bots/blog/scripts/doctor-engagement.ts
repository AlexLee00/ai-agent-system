#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool.js');
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');
const { getBlogHealthRuntimeConfig } = require('../lib/runtime-config.ts');

const runtimeConfig = getBlogHealthRuntimeConfig();

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
  const blogRoot = path.join(env.PROJECT_ROOT, 'bots/blog');
  switch (String(label || '')) {
    case 'replies':
      return `node ${path.join(blogRoot, 'scripts/run-commenter.ts')}`;
    case 'neighbor':
      return `node ${path.join(blogRoot, 'scripts/run-neighbor-commenter.ts')}`;
    case 'sympathy':
      return `node ${path.join(blogRoot, 'scripts/run-neighbor-sympathy.ts')}`;
    default:
      return `npm --prefix ${blogRoot} run doctor:engagement -- --json`;
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

async function getLatestReplyReplayCandidate() {
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
      ORDER BY detected_at DESC
      LIMIT 1
    `);
  } catch {
    return null;
  }
}

function buildActions({ latestReplyReplayCandidate, failureByKind, targetGaps, primaryGap }) {
  const actions = [];
  if ((failureByKind.ui || 0) > 0 || (failureByKind.browser || 0) > 0) {
    actions.push('네이버 reply UI selector와 browser mount 흐름 점검');
  }
  if ((failureByKind.llm || 0) > 0) {
    actions.push('reply 생성 LLM timeout / fetch 실패 로그 확인');
  }
  if (Array.isArray(targetGaps) && targetGaps.length > 0) {
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
  return actions;
}

function buildPrimary({ failureByKind, latestReplyReplayCandidate, targetGaps, primaryGap }) {
  const blogPrefix = `npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')}`;
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
    return {
      area: primaryGap?.label ? `engagement.target_gap.${primaryGap.label}` : 'engagement.target_gap',
      reason: primaryGap?.label
        ? `운영 시간대 기준 ${primaryGap.label} 목표치가 가장 크게 뒤처졌습니다 (${primaryGap.success}/${primaryGap.expectedNow}, deficit ${primaryGap.deficit}).`
        : `운영 시간대 기준 engagement 목표치가 뒤처졌습니다 (${targetGaps.join(', ')}).`,
      nextCommand: primaryGap?.label ? getGapActionCommand(primaryGap.label) : `${blogPrefix} run doctor:engagement -- --json`,
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
  if (Array.isArray(payload.targetGaps) && payload.targetGaps.length > 0) {
    return 'engagement 자동화는 운영 시간대 기준 목표치가 뒤처져 있어 실적 차이와 다음 실행 사이클을 먼저 보는 편이 좋습니다.';
  }
  return 'engagement 자동화는 지금 큰 실패가 없어 다음 운영 시간대에 다시 관찰하면 됩니다.';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [rows, latestReplyReplayCandidate] = await Promise.all([
    pgPool.query('blog', `
      SELECT action_type, meta
      FROM blog.comment_actions
      WHERE timezone('Asia/Seoul', executed_at)::date = timezone('Asia/Seoul', now())::date
        AND success = false
      ORDER BY executed_at DESC
      LIMIT 50
    `),
    getLatestReplyReplayCandidate(),
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

  const payload = {
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
  };
  payload.needsAttention = payload.totalFailures > 0 || targetGaps.length > 0;
  payload.actions = buildActions({ latestReplyReplayCandidate, failureByKind, targetGaps, primaryGap });
  payload.primary = buildPrimary({ failureByKind, latestReplyReplayCandidate, targetGaps, primaryGap });

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
  console.log(`🔍 AI: ${payload.aiSummary}`);
  console.log(`[engagement doctor] primary=${payload.primary.area} ${payload.primary.reason}`);
  console.log(`[engagement doctor] next=${payload.primary.nextCommand}`);
  if (payload.primaryGap?.label) {
    console.log(`[engagement doctor] deepest_gap=${payload.primaryGap.label} ${payload.primaryGap.success}/${payload.primaryGap.expectedNow}`);
  }
  if (Array.isArray(payload.runPlan) && payload.runPlan.length > 0) {
    console.log(`[engagement doctor] run_plan=${payload.runPlan.map((item) => `${item.step}.${item.label}`).join(' -> ')}`);
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
