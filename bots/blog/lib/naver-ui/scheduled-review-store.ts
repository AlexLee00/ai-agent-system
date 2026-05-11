'use strict';
// @ts-nocheck

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { ensureBlogCoreSchema } = require('../schema.ts');
const { ensurePublishLogSchema } = require('../publish-reporter.ts');

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function buildScheduledReviewMetadata({ scheduledAt, result }) {
  return {
    naver_scheduled_at: scheduledAt,
    naver_publish_assist_status: result?.status || 'unknown',
    naver_publish_assist_checked_at: new Date().toISOString(),
    naver_publish_assist_page_url: result?.pageUrl || null,
    naver_publish_assist_schedule_fields: result?.schedule || result?.scheduleResult?.fields || null,
    naver_publish_assist_dry_run: Boolean(result?.dryRun),
  };
}

async function recordNaverScheduledReview({ postId, title, scheduledAt, result }) {
  if (!postId) {
    return { ok: false, skipped: true, reason: 'missing_post_id' };
  }

  await ensureBlogCoreSchema();
  await ensurePublishLogSchema();

  const metadata = buildScheduledReviewMetadata({ scheduledAt, result });
  const row = await pgPool.get('blog', `
    SELECT metadata
    FROM blog.posts
    WHERE id = $1
  `, [postId]);

  const existing = safeJson(row?.metadata, {});
  const merged = { ...existing, ...metadata };

  await pgPool.run('blog', `
    UPDATE blog.posts
    SET status = 'naver_scheduled_review',
        metadata = $2::jsonb
    WHERE id = $1
  `, [postId, JSON.stringify(merged)]);

  await pgPool.run('blog', `
    INSERT INTO blog.publish_log (
      platform,
      status,
      title,
      url,
      post_id,
      source_mode,
      metadata,
      dry_run
    )
    VALUES ('naver', 'scheduled_review', $1, $2, $3, 'naver_ui_assist', $4::jsonb, false)
  `, [
    title || `post:${postId}`,
    result?.pageUrl || null,
    String(postId),
    JSON.stringify(metadata),
  ]);

  return { ok: true, postId, metadata };
}

module.exports = {
  buildScheduledReviewMetadata,
  recordNaverScheduledReview,
};
