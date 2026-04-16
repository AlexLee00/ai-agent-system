'use strict';

/**
 * bots/blog/scripts/run-competitor-analysis.ts
 * Phase 3: 경쟁사 분석 + 해시태그 트렌드 주간 실행 스크립트
 *
 * 실행: npx ts-node bots/blog/scripts/run-competitor-analysis.ts [--category 카테고리]
 * Elixir: BlogSupervisor :blog_competitor_analysis (weekly_at [1] 05:00)
 */

const { analyzeAllCompetitors, analyzeCompetitors } = require('../lib/competitor-analyzer.ts');
const { analyzeHashtagsForCategory } = require('../lib/hashtag-analyzer.ts');

const args = process.argv.slice(2);
const categoryFlag = args.indexOf('--category');
const targetCategory = categoryFlag >= 0 ? args[categoryFlag + 1] : null;

async function main() {
  console.log('[경쟁사분석] 주간 분석 시작:', new Date().toISOString());

  const CATEGORIES = targetCategory
    ? [targetCategory]
    : ['Node.js강의', '개발기획과컨설팅', '홈페이지와App', '성장과성공', '도서리뷰'];

  let competitorDone = 0;
  let hashtagDone = 0;

  for (const category of CATEGORIES) {
    console.log(`\n── ${category} 분석 중...`);

    // 경쟁사 키워드 분석
    const competitorReport = await analyzeCompetitors(category);
    if (competitorReport) {
      competitorDone++;
      console.log(`  경쟁사 키워드: ${competitorReport.topCompetitorKeywords.length}개 수집`);
      console.log(`  갭 키워드: ${competitorReport.missingKeywords.join(', ') || '없음'}`);
    }

    // 해시태그 트렌드 분석
    const hashtagReport = await analyzeHashtagsForCategory(category);
    if (hashtagReport) {
      hashtagDone++;
      console.log(`  인기 해시태그: ${hashtagReport.topHashtags.join(', ')}`);
    }

    // 카테고리 간 딜레이 (API rate limit)
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n[경쟁사분석] 완료 — 경쟁사:${competitorDone}개, 해시태그:${hashtagDone}개 카테고리 분석`);
  process.exit(0);
}

main().catch(e => {
  console.error('[경쟁사분석] 오류:', e);
  process.exit(1);
});
