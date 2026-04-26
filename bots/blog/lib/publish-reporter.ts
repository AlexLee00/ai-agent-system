'use strict';

/**
 * bots/blog/lib/publish-reporter.ts — 플랫폼별 발행 결과 Telegram + DB 보고
 *
 * 네이버 블로그 / 인스타그램 / 페이스북 발행 성공/실패를 통합 보고.
 * 모든 플랫폼 발행 결과는 운영 telemetry + DB 기록으로 남긴다.
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const { writeBlogEvalCase } = require('./eval-case-telemetry.ts');

const PLATFORM_LABELS = { naver: '네이버 블로그', instagram: '인스타그램', facebook: '페이스북' };
let _publishLogEnsured = false;

async function ensurePublishLogSchema() {
  if (_publishLogEnsured) return;

  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.publish_log (
      id BIGSERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      post_id TEXT,
      error TEXT,
      duration_ms INTEGER,
      source_mode TEXT DEFAULT 'naver_post',
      metadata JSONB DEFAULT '{}'::jsonb,
      dry_run BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgPool.run('blog', `
    ALTER TABLE blog.publish_log
    ADD COLUMN IF NOT EXISTS source_mode TEXT DEFAULT 'naver_post'
  `);
  await pgPool.run('blog', `
    ALTER TABLE blog.publish_log
    ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb
  `);
  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_blog_publish_log_platform
    ON blog.publish_log(platform, created_at DESC)
  `);
  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_blog_publish_log_status
    ON blog.publish_log(status, created_at DESC)
  `);
  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_blog_publish_log_date
    ON blog.publish_log(created_at DESC)
  `);
  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_blog_publish_log_source_mode
    ON blog.publish_log(source_mode, created_at DESC)
  `);

  _publishLogEnsured = true;
}

/**
 * @typedef {{
 *   platform: string,
 *   status: string,
 *   title: string,
 *   url?: string,
 *   error?: string,
 *   duration_ms?: number,
 *   post_id?: string | number | null,
 *   source_mode?: string | null,
 *   metadata?: any
 * }} PublishReport
 */

/**
 * @typedef {{
 *   durationMs?: number,
 *   postId?: string | number | null
 *   previewBundle?: string | null
 *   sourceMode?: string | null
 *   metadata?: any
 * }} PublishReportOptions
 */

async function _saveToDb(platform, status, title, url, error, durationMs, postId, sourceMode, metadata) {
  try {
    await ensurePublishLogSchema();
    await pgPool.query('blog', `
      INSERT INTO blog.publish_log (platform, status, title, url, error, duration_ms, post_id, source_mode, metadata, dry_run)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, false)
    `, [
      platform,
      status,
      title,
      url || null,
      error || null,
      durationMs || null,
      postId || null,
      sourceMode || 'naver_post',
      JSON.stringify(metadata || {}),
    ]);
  } catch (e) {
    console.warn('[publish-reporter] DB 저장 실패 (무시):', e.message);
  }
}

/**
 * 통합 발행 보고 (E2E/내부 호출용)
 * @param {PublishReport} report
 */
async function reportPublish(report) {
  const {
    platform,
    status,
    title,
    url,
    error,
    duration_ms,
    post_id,
    preview_bundle,
    source_mode,
    metadata,
  } = report;
  const label = PLATFORM_LABELS[platform] || platform;

  const msg = status === 'success'
    ? [
        `✅ [블로팀] ${label} 발행 성공`,
        `제목: ${title}`,
        url ? `링크: ${url}` : '',
        source_mode ? `source: ${source_mode}` : '',
        preview_bundle ? `preview: ${preview_bundle}` : '',
      ].filter(Boolean).join('\n')
    : [
        `🔴 [블로팀] ${label} 발행 실패`,
        `제목: ${title}`,
        `원인: ${error}`,
        source_mode ? `source: ${source_mode}` : '',
        preview_bundle ? `preview: ${preview_bundle}` : '',
      ].filter(Boolean).join('\n');

  await Promise.allSettled([
    _saveToDb(platform, status, title, url, error, duration_ms, post_id, source_mode, metadata),
    status === 'failed'
      ? Promise.resolve().then(() => writeBlogEvalCase({
          area: 'publish',
          subtype: String(platform || 'unknown'),
          code: String(error || 'publish_failed'),
          title,
          summary: `${label} 발행 실패: ${String(error || 'unknown')}`.slice(0, 240),
          status: 'failed',
          source: 'publish-reporter',
          meta: {
            platform,
            url: url || '',
            postId: post_id || null,
            sourceMode: source_mode || 'naver_post',
            previewBundle: preview_bundle || null,
            durationMs: duration_ms || null,
            metadata: metadata || {},
          },
        }))
      : Promise.resolve(null),
    postAlarm(msg, { team: 'blog', bot: 'publish-reporter', level: status === 'success' ? 'info' : 'critical' }).catch(() => {}),
  ]);
}

/**
 * 플랫폼 발행 성공 보고 (레거시 호환)
 */
/**
 * @param {string} platform
 * @param {string} title
 * @param {string} [url]
 * @param {PublishReportOptions} [opts]
 */
async function reportPublishSuccess(platform, title, url, opts = {}) {
  return reportPublish({
    platform,
    status: 'success',
    title,
    url,
    // @ts-ignore JS checkJs default-param inference is too narrow here
    preview_bundle: opts.previewBundle || null,
    // @ts-ignore JS checkJs default-param inference is too narrow here
    duration_ms: opts.durationMs,
    // @ts-ignore JS checkJs default-param inference is too narrow here
    post_id: opts.postId,
    // @ts-ignore JS checkJs default-param inference is too narrow here
    source_mode: opts.sourceMode || 'naver_post',
    // @ts-ignore JS checkJs default-param inference is too narrow here
    metadata: opts.metadata || {},
  });
}

/**
 * 플랫폼 발행 실패 보고 (레거시 호환)
 */
/**
 * @param {string} platform
 * @param {string} title
 * @param {string} error
 * @param {PublishReportOptions} [opts]
 */
async function reportPublishFailure(platform, title, error, opts = {}) {
  return reportPublish({
    platform,
    status: 'failed',
    title,
    error,
    // @ts-ignore JS checkJs default-param inference is too narrow here
    preview_bundle: opts.previewBundle || null,
    // @ts-ignore JS checkJs default-param inference is too narrow here
    duration_ms: opts.durationMs,
    // @ts-ignore JS checkJs default-param inference is too narrow here
    post_id: opts.postId,
    // @ts-ignore JS checkJs default-param inference is too narrow here
    source_mode: opts.sourceMode || 'naver_post',
    // @ts-ignore JS checkJs default-param inference is too narrow here
    metadata: opts.metadata || {},
  });
}

/**
 * 일일 3 플랫폼 발행 요약 보고
 */
async function reportDailySummary(date = null) {
  const targetDate = date || new Date().toISOString().split('T')[0];
  try {
    await ensurePublishLogSchema();
    const rows = await pgPool.query('blog', `
      SELECT platform, status, COUNT(*) AS cnt
      FROM blog.publish_log
      WHERE DATE(created_at AT TIME ZONE 'Asia/Seoul') = $1
      GROUP BY platform, status
      ORDER BY platform, status
    `, [targetDate]);

    const list = Array.isArray(rows) ? rows : (rows?.rows || []);
    if (!list.length) return null;

    const lines = ['📊 [블로팀] 오늘 발행 요약', `날짜: ${targetDate}`];
    /** @type {Record<string, { success: number, failed: number }>} */
    const byPlatform = {};
    for (const r of list) {
      if (!byPlatform[r.platform]) byPlatform[r.platform] = { success: 0, failed: 0 };
      byPlatform[r.platform][r.status] = Number(r.cnt);
    }
    for (const [plat, counts] of /** @type {Array<[string, any]>} */ (Object.entries(byPlatform))) {
      const label = PLATFORM_LABELS[plat] || plat;
      const typedCounts = /** @type {any} */ (counts);
      // @ts-ignore Object.entries over Record still narrows counts to unknown in checkJs
      lines.push(`${label}: ✅${typedCounts.success || 0} ❌${typedCounts.failed || 0}`);
    }

    const msg = lines.join('\n');
    await postAlarm(msg, { team: 'blog', bot: 'publish-reporter', level: 'info' }).catch(() => {});

    return byPlatform;
  } catch (e) {
    console.warn('[publish-reporter] 일일 요약 실패:', e.message);
    return null;
  }
}

module.exports = {
  ensurePublishLogSchema,
  reportPublish,
  reportPublishSuccess,
  reportPublishFailure,
  reportDailySummary,
};
