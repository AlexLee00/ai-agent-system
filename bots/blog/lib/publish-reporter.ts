'use strict';

/**
 * bots/blog/lib/publish-reporter.ts — 플랫폼별 발행 결과 Telegram 보고
 *
 * 네이버 블로그 / 인스타그램 / 페이스북 발행 성공/실패를 통합 보고.
 * 모든 플랫폼 발행 결과는 반드시 마스터에게 보고.
 */

const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

/**
 * 플랫폼 발행 성공 보고
 * @param {string} platform  - 'naver' | 'instagram' | 'facebook'
 * @param {string} title     - 포스팅 제목
 * @param {string} [url]     - 발행 URL (선택)
 */
async function reportPublishSuccess(platform, title, url) {
  const label = { naver: '네이버 블로그', instagram: '인스타그램', facebook: '페이스북' }[platform] || platform;
  const msg = [`✅ [블로팀] ${label} 발행 성공`, `제목: ${title}`, url ? `링크: ${url}` : ''].filter(Boolean).join('\n');
  await runIfOps(
    `blog-pub-ok-${platform}`,
    () => postAlarm({ message: msg, team: 'blog', bot: 'publish-reporter', level: 'info' }),
    () => console.log('[DEV]', msg)
  ).catch(() => {});
}

/**
 * 플랫폼 발행 실패 보고
 * @param {string} platform  - 'naver' | 'instagram' | 'facebook'
 * @param {string} title     - 포스팅 제목
 * @param {string} error     - 오류 메시지
 */
async function reportPublishFailure(platform, title, error) {
  const label = { naver: '네이버 블로그', instagram: '인스타그램', facebook: '페이스북' }[platform] || platform;
  const msg = `🔴 [블로팀] ${label} 발행 실패\n제목: ${title}\n원인: ${error}`;
  await runIfOps(
    `blog-pub-fail-${platform}`,
    () => postAlarm({ message: msg, team: 'blog', bot: 'publish-reporter', level: 'critical' }),
    () => console.error('[DEV]', msg)
  ).catch(() => {});
}

module.exports = {
  reportPublishSuccess,
  reportPublishFailure,
};
