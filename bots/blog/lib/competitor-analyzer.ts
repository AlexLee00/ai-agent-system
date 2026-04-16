'use strict';

/**
 * bots/blog/lib/competitor-analyzer.ts — Phase 3: 경쟁사 블로그 키워드 분석
 *
 * 네이버 블로그 검색 API로 동일 카테고리 상위 블로그 수집
 * TF-IDF 기반 키워드 추출 → 우리 블로그와 비교 → 차별화 추천
 */

const https = require('https');
const pgPool = require('../../../packages/core/lib/pg-pool');
const env = require('../../../packages/core/lib/env');
const { resolveNaverCredentials } = require('../../../packages/core/lib/news-credentials');

// 경쟁사 분석 대상 카테고리 → 네이버 검색 쿼리 매핑
const CATEGORY_QUERIES: Record<string, string[]> = {
  'Node.js강의': ['Node.js 강의', 'Node.js 튜토리얼', 'Node.js 개발'],
  '개발기획과컨설팅': ['IT 기획 컨설팅', '개발 컨설팅', 'IT 프로젝트 기획'],
  '홈페이지와App': ['홈페이지 제작', '앱 개발 비용', '웹앱 개발'],
  '성장과성공': ['성장 마인드셋', '성공 습관', '자기계발'],
  '도서리뷰': ['IT 도서 리뷰', '개발 도서 추천', '프로그래밍 책'],
  '투자와경제': ['주식 투자 블로그', '경제 공부', '재테크'],
};

const STOPWORDS = new Set([
  '이', '가', '을', '를', '은', '는', '에', '의', '과', '와', '로', '으로',
  '에서', '까지', '부터', '한', '하다', '이다', '있다', '없다', '되다', '하는',
  'a', 'an', 'the', 'is', 'in', 'of', 'to', 'and', 'or', 'for',
  '합니다', '합니다.', '있습니다', '있습니다.', '됩니다', '됩니다.',
  '것', '수', '때', '더', '만', '도', '같은', '방법', '위한', '대한',
]);

interface NaverBlogItem {
  title: string;
  description: string;
  bloggerName: string;
  link: string;
  postdate: string;
}

interface KeywordCount {
  word: string;
  count: number;
  tfidf: number;
  sources: string[];
}

interface CompetitorReport {
  category: string;
  analyzedAt: string;
  totalCompetitorPosts: number;
  topCompetitorKeywords: KeywordCount[];
  ourTopKeywords: string[];
  missingKeywords: string[];
  recommendedTopics: string[];
  differentiationHints: string[];
}

/**
 * HTML 태그 제거 + 텍스트 정규화
 */
function cleanText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^\w\s가-힣]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 텍스트에서 2~6글자 단어 추출 (한국어 + 영문 기술어)
 */
function tokenize(text: string): string[] {
  const clean = cleanText(text);
  const words: string[] = [];

  // 한국어 명사구 (2~6글자)
  const koreanMatches = clean.match(/[가-힣]{2,6}/g) || [];
  words.push(...koreanMatches);

  // 영문 기술어 (2~20자)
  const englishMatches = clean.match(/[A-Za-z][A-Za-z0-9\-.]{1,19}/g) || [];
  words.push(...englishMatches);

  return words.filter(w => !STOPWORDS.has(w.toLowerCase()));
}

/**
 * TF-IDF 점수 계산
 * TF = 단어 빈도 / 문서 총 단어 수
 * IDF = log(전체 문서 수 / 해당 단어 포함 문서 수)
 */
function computeTfIdf(docs: string[][]): Map<string, KeywordCount> {
  const N = docs.length;
  if (N === 0) return new Map();

  // DF: 각 단어가 등장한 문서 수
  const df = new Map<string, number>();
  for (const tokens of docs) {
    const unique = new Set(tokens);
    for (const word of unique) {
      df.set(word, (df.get(word) || 0) + 1);
    }
  }

  // TF-IDF 합산
  const scores = new Map<string, KeywordCount>();
  docs.forEach((tokens, docIdx) => {
    const tf = new Map<string, number>();
    for (const word of tokens) {
      tf.set(word, (tf.get(word) || 0) + 1);
    }
    for (const [word, count] of tf) {
      const tfScore = count / tokens.length;
      const idf = Math.log(N / (df.get(word) || 1));
      const tfidf = tfScore * idf;
      const existing = scores.get(word);
      if (existing) {
        existing.count += count;
        existing.tfidf += tfidf;
        if (!existing.sources.includes(String(docIdx))) {
          existing.sources.push(String(docIdx));
        }
      } else {
        scores.set(word, { word, count, tfidf, sources: [String(docIdx)] });
      }
    }
  });

  return scores;
}

/**
 * 네이버 블로그 검색 API 호출
 */
async function searchNaverBlogs(query: string, display = 20): Promise<NaverBlogItem[]> {
  try {
    const { clientId, clientSecret } = await resolveNaverCredentials();
    if (!clientId || !clientSecret) {
      console.warn('[경쟁사분석] 네이버 API 키 없음');
      return [];
    }

    const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=${display}&sort=date`;

    const data = await new Promise<any>((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'ai-agent-blog/1.0',
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      });
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    });

    return Array.isArray(data?.items) ? data.items : [];
  } catch (e) {
    console.warn('[경쟁사분석] 네이버 블로그 검색 실패:', e.message);
    return [];
  }
}

/**
 * 우리 블로그의 최근 키워드 수집 (최근 30일 게시물)
 */
async function getOurBlogKeywords(category: string): Promise<string[]> {
  try {
    const rows = await pgPool.query('blog', `
      SELECT title, COALESCE(content_summary, '') as content_summary
      FROM blog.posts
      WHERE category = $1
        AND status = 'published'
        AND published_at >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY published_at DESC
      LIMIT 30
    `, [category]);

    if (!rows?.length) return [];

    const allTokens: string[] = [];
    for (const row of rows) {
      const text = `${row.title} ${row.content_summary}`;
      allTokens.push(...tokenize(text));
    }

    // 빈도 기반 상위 30개
    const freq = new Map<string, number>();
    for (const t of allTokens) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([w]) => w);
  } catch (e) {
    console.warn('[경쟁사분석] 우리 블로그 키워드 조회 실패:', e.message);
    return [];
  }
}

/**
 * 키워드 차별화 갭 분석
 * 경쟁사는 많이 쓰는데 우리가 안 쓴 키워드 → 추가 기회
 */
function findKeywordGaps(
  competitorKeywords: KeywordCount[],
  ourKeywords: string[]
): string[] {
  const ourSet = new Set(ourKeywords.map(k => k.toLowerCase()));
  return competitorKeywords
    .filter(k => !ourSet.has(k.word.toLowerCase()) && k.sources.length >= 3)
    .slice(0, 15)
    .map(k => k.word);
}

/**
 * 키워드 갭 기반 주제 추천
 */
function generateTopicSuggestions(category: string, gaps: string[]): string[] {
  if (gaps.length === 0) return [];
  const suggestions: string[] = [];

  for (const keyword of gaps.slice(0, 5)) {
    suggestions.push(`${category}: '${keyword}' 주제 포스트 — 경쟁사 다수 사용 키워드`);
  }

  return suggestions;
}

/**
 * 차별화 힌트 생성
 */
function buildDifferentiationHints(
  ourKeywords: string[],
  gaps: string[]
): string[] {
  const hints: string[] = [];

  if (gaps.length >= 5) {
    hints.push(`경쟁사 대비 ${gaps.length}개 키워드 미커버 — 콘텐츠 확장 기회`);
  }
  if (ourKeywords.length > 0) {
    hints.push(`우리 강점 키워드: ${ourKeywords.slice(0, 5).join(', ')}`);
  }
  if (gaps.length > 0) {
    hints.push(`추천 신규 키워드: ${gaps.slice(0, 5).join(', ')}`);
  }

  return hints;
}

/**
 * 분석 결과 DB 저장
 */
async function saveCompetitorReport(report: CompetitorReport): Promise<void> {
  try {
    await pgPool.run('blog', `
      INSERT INTO blog.competitor_keywords
        (category, analyzed_at, top_keywords, our_keywords, missing_keywords, recommendations, raw_json)
      VALUES ($1, NOW(), $2, $3, $4, $5, $6)
      ON CONFLICT (category, DATE(analyzed_at))
      DO UPDATE SET
        top_keywords = EXCLUDED.top_keywords,
        our_keywords = EXCLUDED.our_keywords,
        missing_keywords = EXCLUDED.missing_keywords,
        recommendations = EXCLUDED.recommendations,
        raw_json = EXCLUDED.raw_json,
        analyzed_at = NOW()
    `, [
      report.category,
      JSON.stringify(report.topCompetitorKeywords.slice(0, 20)),
      JSON.stringify(report.ourTopKeywords),
      JSON.stringify(report.missingKeywords),
      JSON.stringify(report.recommendedTopics),
      JSON.stringify(report),
    ]);
  } catch (e) {
    // 테이블 없으면 무시 (마이그레이션 선행 필요)
    console.warn('[경쟁사분석] DB 저장 실패 (테이블 없을 수 있음):', e.message);
  }
}

/**
 * 메인: 특정 카테고리 경쟁사 분석
 */
export async function analyzeCompetitors(category: string): Promise<CompetitorReport | null> {
  try {
    console.log(`[경쟁사분석] 카테고리 분석 시작: ${category}`);

    const queries = CATEGORY_QUERIES[category];
    if (!queries) {
      console.warn(`[경쟁사분석] 지원하지 않는 카테고리: ${category}`);
      return null;
    }

    // 1. 네이버 블로그 검색 (여러 쿼리 병렬)
    const searchResults = await Promise.allSettled(
      queries.map(q => searchNaverBlogs(q, 20))
    );
    const allItems: NaverBlogItem[] = [];
    for (const r of searchResults) {
      if (r.status === 'fulfilled') allItems.push(...r.value);
    }
    const uniqueItems = allItems.filter(
      (item, i, arr) => arr.findIndex(x => x.link === item.link) === i
    );

    console.log(`[경쟁사분석] 수집된 경쟁 포스트: ${uniqueItems.length}개`);

    if (uniqueItems.length === 0) {
      return null;
    }

    // 2. TF-IDF 키워드 추출
    const docs = uniqueItems.map(item =>
      tokenize(`${cleanText(item.title)} ${cleanText(item.description)}`)
    );
    const tfidfScores = computeTfIdf(docs);
    const topKeywords = Array.from(tfidfScores.values())
      .filter(k => k.word.length >= 2 && k.sources.length >= 2)
      .sort((a, b) => b.tfidf - a.tfidf)
      .slice(0, 30);

    // 3. 우리 블로그 키워드
    const ourKeywords = await getOurBlogKeywords(category);

    // 4. 갭 분석
    const gaps = findKeywordGaps(topKeywords, ourKeywords);

    // 5. 추천 생성
    const recommendations = generateTopicSuggestions(category, gaps);
    const hints = buildDifferentiationHints(ourKeywords, gaps);

    const report: CompetitorReport = {
      category,
      analyzedAt: new Date().toISOString(),
      totalCompetitorPosts: uniqueItems.length,
      topCompetitorKeywords: topKeywords,
      ourTopKeywords: ourKeywords,
      missingKeywords: gaps,
      recommendedTopics: recommendations,
      differentiationHints: hints,
    };

    // 6. DB 저장
    await saveCompetitorReport(report);

    console.log(`[경쟁사분석] 완료 — 갭 키워드 ${gaps.length}개, 추천 ${recommendations.length}개`);
    return report;
  } catch (e) {
    console.error('[경쟁사분석] 오류:', e.message);
    return null;
  }
}

/**
 * 전체 카테고리 순차 분석
 */
export async function analyzeAllCompetitors(): Promise<CompetitorReport[]> {
  const categories = Object.keys(CATEGORY_QUERIES);
  const results: CompetitorReport[] = [];

  for (const category of categories) {
    const report = await analyzeCompetitors(category);
    if (report) results.push(report);
    // API rate limit 준수 (1초 대기)
    await new Promise(r => setTimeout(r, 1000));
  }

  return results;
}

/**
 * 최근 분석 결과 조회 (topic-selector에서 활용 가능)
 */
export async function getLatestCompetitorInsights(category: string): Promise<{
  missingKeywords: string[];
  recommendedTopics: string[];
} | null> {
  try {
    const rows = await pgPool.query('blog', `
      SELECT missing_keywords, recommendations
      FROM blog.competitor_keywords
      WHERE category = $1
        AND analyzed_at >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY analyzed_at DESC
      LIMIT 1
    `, [category]);

    if (!rows?.length) return null;
    return {
      missingKeywords: rows[0].missing_keywords || [],
      recommendedTopics: rows[0].recommendations || [],
    };
  } catch {
    return null;
  }
}

module.exports = { analyzeCompetitors, analyzeAllCompetitors, getLatestCompetitorInsights };
