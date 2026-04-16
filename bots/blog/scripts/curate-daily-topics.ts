/**
 * curate-daily-topics.ts — D-1 주제 후보 큐레이션
 *
 * 매일 22:00 KST (TopicCurator.ex 호출):
 *   1. GitHub Trending + HN Top Stories 수집
 *   2. 6개 카테고리 매칭
 *   3. LLM으로 카테고리별 후보 3건 생성
 *   4. JSON 출력 → DB 저장 (Elixir 담당)
 *
 * 사용법:
 *   tsx scripts/curate-daily-topics.ts --date=2026-04-17 --count=3 --json
 */
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');
const { callLocalLlm } = require('../../../packages/core/lib/local-llm-client');

const CATEGORIES = [
  '자기계발',
  '성장과성공',
  '홈페이지와APP',
  '최신IT트렌드',
  'IT정보와분석',
  '개발기획과컨설팅',
];

const CATEGORY_KEYWORDS = {
  '자기계발':       ['생산성', '습관', '독서', '시간관리', '집중력', '루틴', '목표'],
  '성장과성공':     ['커리어', '리더십', '스타트업', '취업', '이직', '성장', '목표달성'],
  '홈페이지와APP':  ['UX', '앱', '웹', '설계', '사용자', '온보딩', '전환율', 'UI'],
  '최신IT트렌드':   ['AI', 'LLM', 'SaaS', '클라우드', '자동화', '트렌드', '기술'],
  'IT정보와분석':   ['데이터', '분석', '보안', '아키텍처', 'API', '성능', '인프라'],
  '개발기획과컨설팅': ['기획', '개발', '컨설팅', '프로젝트', '요구사항', '협업', '명세'],
};

function parseArgs() {
  const args = { date: null, count: 3, json: false };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--date=')) args.date = arg.split('=')[1];
    else if (arg.startsWith('--count=')) args.count = parseInt(arg.split('=')[1], 10) || 3;
    else if (arg === '--json') args.json = true;
  }
  if (!args.date) {
    const todayKst = kst.today(); // 'YYYY-MM-DD' in KST
    const [y, m, d] = todayKst.split('-').map(Number);
    const tomorrowUtc = new Date(Date.UTC(y, m - 1, d + 1));
    args.date = tomorrowUtc.toISOString().slice(0, 10);
  }
  return args;
}

async function fetchGithubTrending() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://api.github.com/search/repositories?q=created:>2026-04-10&sort=stars&order=desc&per_page=10', {
      headers: { 'User-Agent': 'TeamJay-Blog-Bot' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map(r => ({
      title: r.full_name,
      description: r.description || '',
      url: r.html_url,
      stars: r.stargazers_count,
    }));
  } catch {
    return [];
  }
}

async function fetchHNTop() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const ids = await res.json();
    const top5 = ids.slice(0, 5);
    const stories = await Promise.allSettled(
      top5.map(id =>
        fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)
          .then(r => r.json())
          .catch(() => null)
      )
    );
    return stories
      .filter(s => s.status === 'fulfilled' && s.value?.title)
      .map(s => ({ title: s.value.title, url: s.value.url || '', points: s.value.score || 0 }));
  } catch {
    return [];
  }
}

function matchCategory(text) {
  const lower = text.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k.toLowerCase()))) return cat;
  }
  return null;
}

async function generateCandidatesWithLlm(issues, targetDate, count) {
  const issuesSummary = issues.slice(0, 15)
    .map((i, idx) => `${idx + 1}. ${i.title}`)
    .join('\n');

  const prompt = `다음은 오늘 수집된 GitHub 트렌딩 + Hacker News 상위 이슈입니다:

${issuesSummary}

위 이슈를 참고하여 아래 6개 카테고리 각각에 맞는 한국 IT 블로그 포스팅 주제를 1개씩 제안해주세요.
카테고리: ${CATEGORIES.join(', ')}

발행 예정일: ${targetDate}
독자층: 한국 직장인, IT 종사자, 스터디카페 이용자

각 카테고리별로 다음 JSON 배열 형식으로 출력해주세요 (마크다운 없이):
[
  {
    "category": "카테고리명",
    "title": "블로그 제목 (한국어, 30자 이내)",
    "question": "독자가 품는 핵심 질문 (한 문장)",
    "diff": "기존 글과의 차별점 (한 문장)",
    "keywords": ["키워드1", "키워드2", "키워드3"],
    "score": 0.7
  }
]`;

  try {
    const result = await callLocalLlm({
      prompt,
      model: 'qwen2.5:7b',
      maxTokens: 1200,
      temperature: 0.7,
    });

    const text = result?.content || result?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed) ? parsed.slice(0, CATEGORIES.length) : [];
  } catch (e) {
    console.warn('[curate] LLM 생성 실패, 폴백 사용:', e.message);
    return generateFallbackCandidates(targetDate);
  }
}

function generateFallbackCandidates(targetDate) {
  return CATEGORIES.map(cat => ({
    category: cat,
    title: `${cat} 관련 실용 가이드`,
    question: '어떻게 하면 실제 변화를 만들 수 있을까',
    diff: '이론보다 실행 중심',
    keywords: CATEGORY_KEYWORDS[cat]?.slice(0, 3) || [],
    score: 0.5,
  }));
}

async function main() {
  const args = parseArgs();

  // 이슈 수집 (병렬)
  const [githubItems, hnItems] = await Promise.allSettled([
    fetchGithubTrending(),
    fetchHNTop(),
  ]);

  const issues = [
    ...(githubItems.status === 'fulfilled' ? githubItems.value : []),
    ...(hnItems.status === 'fulfilled' ? hnItems.value : []),
  ];

  // 후보 생성
  const candidates = await generateCandidatesWithLlm(issues, args.date, args.count);

  const output = {
    ok: true,
    date: args.date,
    candidates,
    sources: {
      github: githubItems.status === 'fulfilled' ? githubItems.value.length : 0,
      hn: hnItems.status === 'fulfilled' ? hnItems.value.length : 0,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`[curate] ${args.date} 후보 ${candidates.length}건 생성`);
    candidates.forEach((c, i) => {
      console.log(`  [${i + 1}] [${c.category}] ${c.title}`);
    });
  }

  return output;
}

main().catch(e => {
  console.error('[curate] 오류:', e.message);
  process.exit(1);
});
