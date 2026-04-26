/**
 * bots/blog/scripts/compute-attribution.ts
 * 매일 새벽 포스팅-매출 attribution 계산 + ROI 주간 리포트
 *
 * Phase 2: 발행된 포스팅의 스카팀 매출 기여도 자동 산출
 * Kill Switch: BLOG_REVENUE_CORRELATION_ENABLED=true
 *
 * 실행: node bots/blog/scripts/compute-attribution.ts
 */

const { initHubConfig } = require('../../../packages/core/lib/llm-keys');
const { runIfOps } = require('../../../packages/core/lib/mode-guard');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const skaRevenueBridge = require('../lib/ska-revenue-bridge');
const pgPool = require('../../../packages/core/lib/pg-pool');

async function refreshRoiMview(): Promise<void> {
  try {
    await pgPool.query('blog', 'REFRESH MATERIALIZED VIEW CONCURRENTLY blog.roi_daily_summary');
    console.log('[compute-attribution] roi_daily_summary MView 갱신 완료');
  } catch (err: any) {
    // CONCURRENTLY 옵션 미지원 시 일반 REFRESH로 폴백
    try {
      await pgPool.query('blog', 'REFRESH MATERIALIZED VIEW blog.roi_daily_summary');
    } catch {
      console.warn('[compute-attribution] MView 갱신 실패:', err.message);
    }
  }
}

function getWeekday(date: Date): number {
  return date.getDay(); // 0=일, 1=월
}

async function sendWeeklyRoiReport(): Promise<void> {
  const today = new Date();
  if (getWeekday(today) !== 1) return; // 월요일에만 실행

  try {
    const summary = await skaRevenueBridge.getRoiSummary(30);
    if (!summary.enabled) return;

    const platformLines = (summary.by_platform || []).map((p: any) => {
      const platformLabel: Record<string, string> = {
        naver: '네이버 블로그', instagram: '인스타그램', facebook: '페이스북',
      };
      const label = platformLabel[p.platform] || p.platform;
      const upliftStr = p.avg_uplift_krw >= 0
        ? `+${p.avg_uplift_krw.toLocaleString()}원`
        : `${p.avg_uplift_krw.toLocaleString()}원`;
      return `  ${label}: ${p.posts_count}건, 평균 ${upliftStr}/포스팅`;
    }).join('\n');

    const topCategory = (summary.by_category || [])[0];
    const categoryLine = topCategory
      ? `\n📌 매출 기여 상위 카테고리: ${topCategory.category} (+${Math.round(topCategory.avg_uplift_krw).toLocaleString()}원)`
      : '';

    const msg = `📊 [블로팀] 주간 ROI 리포트 (최근 30일)\n${platformLines}${categoryLine}`;

    await runIfOps(
      'blog-roi-weekly',
      () => postAlarm({ message: msg, team: 'blog', bot: 'compute-attribution', level: 'info' }),
      () => console.log('[DEV]', msg),
    );
  } catch (err: any) {
    console.warn('[compute-attribution] 주간 리포트 실패:', err.message);
  }
}

async function main(): Promise<void> {
  console.log('[compute-attribution] 시작');

  if (!skaRevenueBridge.isEnabled()) {
    console.log('[compute-attribution] BLOG_REVENUE_CORRELATION_ENABLED=false — 건너뜀');
    process.exit(0);
  }

  try {
    await initHubConfig();
  } catch {
    // Hub 연결 실패해도 계속 진행
  }

  // 1. 미계산 포스팅 attribution 계산
  const processed = await skaRevenueBridge.computePendingAttributions(7);

  // 2. 카테고리별 성과 업데이트
  await skaRevenueBridge.updateCategoryRevenuePerformance(30);

  // 3. MView 갱신
  await refreshRoiMview();

  // 4. 주간 ROI 리포트 (월요일만)
  await sendWeeklyRoiReport();

  console.log(`[compute-attribution] 완료 — attribution ${processed}건 처리`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[compute-attribution] 치명적 오류:', err.message);
  process.exit(1);
});
