'use strict';

/**
 * bots/blog/lib/omnichannel/publish-queue.ts
 *
 * marketing_publish_queue 조작 모듈.
 * - enqueueMarketingVariants: variant → 큐 삽입
 * - claimNextPublishJob: 플랫폼별 다음 실행 대상 claim
 * - markPublishSuccess / markPublishFailure: 결과 기록
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');
const kst = require('../../../../packages/core/lib/kst');
const { ensureMarketingOsSchema } = require('./marketing-os-schema.ts');

const DEFAULT_PREPARING_LEASE_MINUTES = 20;
const DEFAULT_MAX_ATTEMPTS = 4;

class QueueUnavailableError extends Error {
  constructor(message = 'queue_unavailable') {
    super(message);
    this.name = 'QueueUnavailableError';
    this.code = 'queue_unavailable';
  }
}

function generateId(prefix = 'q') {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}_${ts}_${rand}`;
}

/**
 * idempotency_key: campaign_id + platform + variant_hash + scheduled_date
 * Date.now() 단독 사용 금지.
 */
function buildIdempotencyKey({ campaignId, platform, variantId, scheduledDate }) {
  const dateStr = scheduledDate || kst.today();
  return `${campaignId}__${platform}__${variantId}__${dateStr}`;
}

/**
 * 플랫폼별 기본 예약 시각 (KST)
 * Instagram: 18:00, Facebook: 19:00 (기존 launchd 스케줄 기준)
 */
function getDefaultScheduledAt(platform) {
  const today = kst.today(); // 'YYYY-MM-DD'
  const timeMap = {
    instagram_reel: '18:00',
    instagram_feed: '18:00',
    instagram_story: '09:00',
    facebook_page: '19:00',
    naver_blog: '06:00',
  };
  const timeStr = timeMap[platform] || '18:00';
  // KST ISO string
  return `${today}T${timeStr}:00+09:00`;
}

/**
 * variants 배열을 큐에 삽입.
 * @param {object} opts
 * @param {string} opts.campaignId
 * @param {Array} opts.variants
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<Array>} 삽입된 queue jobs
 */
async function enqueueMarketingVariants({ campaignId, variants = [], dryRun = false }) {
  await ensureMarketingOsSchema();
  const jobs = [];
  const today = kst.today();

  for (const variant of variants) {
    const queueId = generateId('q');
    const scheduledAt = getDefaultScheduledAt(variant.platform);
    const idempotencyKey = buildIdempotencyKey({
      campaignId,
      platform: variant.platform,
      variantId: variant.variant_id,
      scheduledDate: today,
    });

    const job = {
      queue_id: queueId,
      variant_id: variant.variant_id,
      platform: variant.platform,
      scheduled_at: scheduledAt,
      status: 'queued',
      attempt_count: 0,
      last_error: null,
      failure_kind: null,
      idempotency_key: idempotencyKey,
      dry_run: dryRun,
    };

    if (!dryRun) {
      await pgPool.query('blog', `
        INSERT INTO blog.marketing_publish_queue
          (queue_id, variant_id, platform, scheduled_at, status,
           attempt_count, last_error, failure_kind, idempotency_key, dry_run)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [
        job.queue_id,
        job.variant_id,
        job.platform,
        job.scheduled_at,
        job.status,
        job.attempt_count,
        job.last_error,
        job.failure_kind,
        job.idempotency_key,
        job.dry_run,
      ]);
    }

    jobs.push(job);
  }

  console.log(`[publish-queue] ${jobs.length}개 큐 삽입 campaign=${campaignId} dryRun=${dryRun}`);
  return jobs;
}

/**
 * 플랫폼별 다음 실행 대상을 claim (status: queued → preparing).
 * @param {string} platform
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @param {number} [opts.scheduleHorizonHours]
 * @returns {Promise<object|null>}
 */
async function claimNextPublishJob(platform, { dryRun = false, scheduleHorizonHours = 2 } = {}) {
  try {
    await ensureMarketingOsSchema();
    const horizonHours = Math.max(0, Number(scheduleHorizonHours) || 0);
    // stale preparing 복구: lease 시간 초과 시 queued로 복귀
    await pgPool.query('blog', `
      UPDATE blog.marketing_publish_queue
      SET status = 'queued',
          last_error = COALESCE(last_error, 'stale_preparing_requeued'),
          updated_at = NOW()
      WHERE platform = $1
        AND dry_run = $2
        AND status = 'preparing'
        AND updated_at < NOW() - (($3::text || ' minutes')::interval)
    `, [platform, dryRun, DEFAULT_PREPARING_LEASE_MINUTES]);

    // 과도 재시도는 자동 차단
    await pgPool.query('blog', `
      UPDATE blog.marketing_publish_queue
      SET status = 'blocked',
          failure_kind = COALESCE(failure_kind, 'retry_exhausted'),
          last_error = COALESCE(last_error, 'max_attempts_exhausted'),
          updated_at = NOW()
      WHERE platform = $1
        AND dry_run = $2
        AND status IN ('queued', 'preparing')
        AND attempt_count >= $3
    `, [platform, dryRun, DEFAULT_MAX_ATTEMPTS]);

    const rows = await pgPool.query('blog', `
      UPDATE blog.marketing_publish_queue
      SET status = 'preparing',
          attempt_count = attempt_count + 1,
          updated_at = NOW()
      WHERE queue_id = (
        SELECT q.queue_id
        FROM blog.marketing_publish_queue q
        JOIN blog.marketing_platform_variants v ON v.variant_id = q.variant_id
        WHERE q.platform = $1
          AND q.status = 'queued'
          AND q.dry_run = $2
          AND q.scheduled_at <= NOW() + (($3::text || ' hours')::interval)
        ORDER BY q.scheduled_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        queue_id, variant_id, platform, scheduled_at,
        status, attempt_count, idempotency_key, dry_run
    `, [platform, dryRun, horizonHours]);

    if (!rows || rows.length === 0) return null;

    const job = rows[0];

    // variant 정보도 함께 로드
    const varRows = await pgPool.query('blog', `
      SELECT v.*, c.brand_axis, c.objective, c.source_signal
      FROM blog.marketing_platform_variants v
      JOIN blog.marketing_campaigns c ON c.campaign_id = v.campaign_id
      WHERE v.variant_id = $1
    `, [job.variant_id]);

    const variant = varRows?.[0] || null;
    return { ...job, variant };
  } catch (err) {
    console.warn(`[publish-queue] claimNextPublishJob 실패 platform=${platform}:`, err.message);
    throw new QueueUnavailableError(String(err?.message || err || 'claim_failed'));
  }
}

/**
 * 발행 성공 처리
 */
async function markPublishSuccess(queueId, { publishedAt = null } = {}) {
  await ensureMarketingOsSchema();
  await pgPool.query('blog', `
    UPDATE blog.marketing_publish_queue
    SET status = 'published',
        published_at = $2,
        updated_at = NOW()
    WHERE queue_id = $1
  `, [queueId, publishedAt || new Date().toISOString()]);
}

/**
 * 발행 실패 처리
 * @param {string} queueId
 * @param {object} opts
 * @param {string} opts.error
 * @param {string} [opts.failureKind]
 * @param {boolean} [opts.block] - true이면 status=blocked (재시도 안 함)
 */
async function markPublishFailure(queueId, { error, failureKind = 'unknown', block = false } = {}) {
  await ensureMarketingOsSchema();
  const newStatus = block ? 'blocked' : 'failed';
  await pgPool.query('blog', `
    UPDATE blog.marketing_publish_queue
    SET status = $2,
        last_error = $3,
        failure_kind = $4,
        updated_at = NOW()
    WHERE queue_id = $1
  `, [queueId, newStatus, String(error || '').slice(0, 2000), failureKind]);
}

/**
 * 오늘 플랫폼별 queued/preparing 건수
 */
async function getTodayQueuedCount(platform) {
  try {
    await ensureMarketingOsSchema();
    const rows = await pgPool.query('blog', `
      SELECT COUNT(*)::int AS cnt
      FROM blog.marketing_publish_queue
      WHERE platform = $1
        AND status IN ('queued', 'preparing')
        AND DATE(scheduled_at AT TIME ZONE 'Asia/Seoul') = CURRENT_DATE
    `, [platform]);
    return rows?.[0]?.cnt || 0;
  } catch {
    return 0;
  }
}

/**
 * 오늘 플랫폼별 published 건수
 */
async function getTodayPublishedCount(platform) {
  try {
    await ensureMarketingOsSchema();
    const rows = await pgPool.query('blog', `
      SELECT COUNT(*)::int AS cnt
      FROM blog.marketing_publish_queue
      WHERE platform = $1
        AND status = 'published'
        AND COALESCE(dry_run, false) = false
        AND DATE(published_at AT TIME ZONE 'Asia/Seoul') = CURRENT_DATE
    `, [platform]);
    return rows?.[0]?.cnt || 0;
  } catch {
    return 0;
  }
}

module.exports = {
  enqueueMarketingVariants,
  claimNextPublishJob,
  markPublishSuccess,
  markPublishFailure,
  getTodayQueuedCount,
  getTodayPublishedCount,
  buildIdempotencyKey,
  QueueUnavailableError,
};
