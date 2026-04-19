'use strict';

/**
 * bots/blog/lib/publish-reporter.ts — 플랫폼별 발행 결과 Telegram + DB 보고
 *
 * 네이버 블로그 / 인스타그램 / 페이스북 발행 성공/실패를 통합 보고.
 * 모든 플랫폼 발행 결과는 반드시 마스터에게 보고 + DB 기록.
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

const PLATFORM_LABELS = { naver: '네이버 블로그', instagram: '인스타그램', facebook: '페이스북' };

async function _saveToDb(platform, status, title, url, error, durationMs, postId) {
  try {
    await pgPool.query('blog', `
      INSERT INTO blog.publish_log (platform, status, title, url, error, duration_ms, post_id, dry_run)
      VALUES ($1, $2, $3, $4, $5, $6, $7, false)
    `, [platform, status, title, url || null, error || null, durationMs || null, postId || null]);
  } catch (e) {
    console.warn('[publish-reporter] DB 저장 실패 (무시):', e.message);
  }
}

/**
 * 통합 발행 보고 (E2E/내부 호출용)
 * @param {object} report - { platform, status, title, url?, error?, duration_ms?, post_id? }
 */
async function reportPublish(report) {
  const { platform, status, title, url, error, duration_ms, post_id } = report;
  const label = PLATFORM_LABELS[platform] || platform;

  const msg = status === 'success'
    ? [`✅ [블로팀] ${label} 발행 성공`, `제목: ${title}`, url ? `링크: ${url}` : ''].filter(Boolean).join('\n')
    : `🔴 [블로팀] ${label} 발행 실패\n제목: ${title}\n원인: ${error}`;

  await Promise.all([
    _saveToDb(platform, status, title, url, error, duration_ms, post_id),
    runIfOps(
      `blog-pub-${status}-${platform}`,
      () => postAlarm(msg),
      () => (status === 'success' ? console.log('[DEV]', msg) : console.error('[DEV]', msg))
    ).catch(() => {}),
  ]);
}

/**
 * 플랫폼 발행 성공 보고 (레거시 호환)
 */
async function reportPublishSuccess(platform, title, url, opts = {}) {
  return reportPublish({
    platform,
    status: 'success',
    title,
    url,
    duration_ms: opts.durationMs,
    post_id: opts.postId,
  });
}

/**
 * 플랫폼 발행 실패 보고 (레거시 호환)
 */
async function reportPublishFailure(platform, title, error, opts = {}) {
  return reportPublish({
    platform,
    status: 'failed',
    title,
    error,
    duration_ms: opts.durationMs,
    post_id: opts.postId,
  });
}

/**
 * 일일 3 플랫폼 발행 요약 보고
 */
async function reportDailySummary(date = null) {
  const targetDate = date || new Date().toISOString().split('T')[0];
  try {
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
    const byPlatform = {};
    for (const r of list) {
      if (!byPlatform[r.platform]) byPlatform[r.platform] = { success: 0, failed: 0 };
      byPlatform[r.platform][r.status] = Number(r.cnt);
    }
    for (const [plat, counts] of Object.entries(byPlatform)) {
      const label = PLATFORM_LABELS[plat] || plat;
      lines.push(`${label}: ✅${counts.success || 0} ❌${counts.failed || 0}`);
    }

    const msg = lines.join('\n');
    await runIfOps(
      `blog-daily-summary-${targetDate}`,
      () => postAlarm(msg),
      () => console.log('[DEV]', msg)
    ).catch(() => {});

    return byPlatform;
  } catch (e) {
    console.warn('[publish-reporter] 일일 요약 실패:', e.message);
    return null;
  }
}

module.exports = {
  reportPublish,
  reportPublishSuccess,
  reportPublishFailure,
  reportDailySummary,
};
