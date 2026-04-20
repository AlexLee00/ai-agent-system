#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool.js');
const { buildBlogCliInsight } = require('../lib/cli-insight.ts');

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

function buildActions({ latestReplyReplayCandidate, failureByKind }) {
  const actions = [];
  if ((failureByKind.ui || 0) > 0 || (failureByKind.browser || 0) > 0) {
    actions.push('네이버 reply UI selector와 browser mount 흐름 점검');
  }
  if ((failureByKind.llm || 0) > 0) {
    actions.push('reply 생성 LLM timeout / fetch 실패 로그 확인');
  }
  if (latestReplyReplayCandidate?.id) {
    actions.push(`npm --prefix ${path.join(env.PROJECT_ROOT, 'bots/blog')} run replay:reply-ui -- --comment-id ${latestReplyReplayCandidate.id} --json`);
  }
  if (actions.length === 0) {
    actions.push('engagement 실패 없음 — 다음 운영 사이클 관찰');
  }
  return actions;
}

function buildEngagementDoctorFallback(payload = {}) {
  if (payload.totalFailures > 0) {
    return 'engagement 자동화는 최근 실패 흔적이 있어 replay 대상과 UI/browser 실패 비중부터 확인하는 편이 좋습니다.';
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
  };
  payload.actions = buildActions({ latestReplyReplayCandidate, failureByKind });

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
