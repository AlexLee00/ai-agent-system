/**
 * topic-planner.ts — D-1 주제 사전 선정 (품질 크리틱 + 후보 3건 + 단일 최우선 주제)
 *
 * 매일 21:00 KST (TopicPlanner.ex 호출):
 *   1. 카테고리 로테이션으로 내일 카테고리 결정
 *   2. GitHub Trending + HN 이슈 수집
 *   3. LLM으로 해당 카테고리 후보 5건 생성
 *   4. 품질 검토: 30일 중복 체크 + LLM 크리틱 점수화
 *   5. 상위 3건 → blog.topic_candidates 저장
 *   6. 최고 점수 1건 → blog.topic_queue 저장
 *   7. JSON 출력 (Elixir → 텔레그램 알림)
 *
 * 사용법:
 *   tsx scripts/topic-planner.ts --date=2026-04-18 --json
 */
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { callLocalLlm } = require('../../../packages/core/lib/local-llm-client');
const { ensureBlogCoreSchema } = require('../lib/schema.ts');
const { ensureSchedule, getScheduleByDate } = require('../lib/schedule.ts');
const {
  normalizeTitle,
  similarity,
  isTooCloseToRecentTitle,
} = require('../lib/topic-title-guard.ts');

// ─── 상수 ──────────────────────────────────────────────────────────────────

const CATEGORIES = [
  '자기계발',
  '성장과성공',
  '홈페이지와App',
  '최신IT트렌드',
  'IT정보와분석',
  '개발기획과컨설팅',
];

const CATEGORY_KEYWORDS = {
  '자기계발':         ['생산성', '습관', '독서', '시간관리', '집중력', '루틴', '목표'],
  '성장과성공':       ['커리어', '리더십', '스타트업', '취업', '이직', '성장', '목표달성'],
  '홈페이지와App':    ['UX', '앱', '웹', '설계', '사용자', '온보딩', '전환율', 'UI'],
  '최신IT트렌드':     ['AI', 'LLM', 'SaaS', '클라우드', '자동화', '트렌드', '기술'],
  'IT정보와분석':     ['데이터', '분석', '보안', '아키텍처', 'API', '성능', '인프라'],
  '개발기획과컨설팅': ['기획', '개발', '컨설팅', '프로젝트', '요구사항', '협업', '명세'],
};

const CATEGORY_GUIDES = {
  '자기계발': {
    readerProblem: '하루를 열심히 사는데도 방향이 잘 안 잡히는 독자',
    openingAngle: '동기부여보다 지속 가능한 구조 설계에서 출발',
    closingAngle: '의지보다 시스템이 사람을 바꾼다는 메시지로 마무리',
  },
  '성장과성공': {
    readerProblem: '열심히 하는데도 커리어 방향이 자꾸 흔들리는 독자',
    openingAngle: '실행력 부족보다 판단 기준의 부재에서 출발',
    closingAngle: '더 많이 하는 삶보다 더 분명하게 고르는 삶으로 정리',
  },
  '홈페이지와App': {
    readerProblem: '기능은 있는데 사용자가 어디에서 멈추고 왜 신뢰를 잃는지 모르는 독자',
    openingAngle: '첫 화면, 탐색, 상태 설명처럼 사용자가 가장 먼저 체감하는 마찰에서 출발',
    closingAngle: '기능 추가보다 이해 가능한 흐름과 설명 가능한 상태를 먼저 정리하자는 결론으로 닫기',
  },
  '최신IT트렌드': {
    readerProblem: '새 기술 뉴스는 많이 보지만 실제 도입 기준은 잘 안 잡히는 독자',
    openingAngle: '화제성보다 운영 비용과 유지 책임을 먼저 보는 관점에서 출발',
    closingAngle: '트렌드는 빨리 읽되 도입은 늦고 신중하게 하자는 메시지로 마무리',
  },
  'IT정보와분석': {
    readerProblem: '정보는 많은데 무엇이 중요한 신호인지 구분하기 어려운 독자',
    openingAngle: '뉴스 나열보다 의미 해석과 우선순위 판단이 필요한 장면에서 출발',
    closingAngle: '정보 소비보다 해석 기준을 남기는 글로 닫기',
  },
  '개발기획과컨설팅': {
    readerProblem: '일정, 요구사항, 기대치가 자꾸 어긋나는 실무 의사결정자',
    openingAngle: '개발 자체보다 전제와 문서화가 늦어질 때 생기는 비용에서 출발',
    closingAngle: '좋은 기획은 더 많은 요구를 담는 것이 아니라 범위와 전제를 먼저 선명하게 만드는 일이라고 정리',
  },
};

const PREPLANNED_CANDIDATE_COUNT = 3;

const CATEGORY_TOPIC_LANES = {
  '자기계발': [
    { key: 'habit', terms: ['습관', '루틴', '꾸준', '실천', '반복'] },
    { key: 'focus', terms: ['집중', '몰입', '방해', '주의', '시간관리'] },
    { key: 'reading', terms: ['독서', '책', '기록', '메모', '학습'] },
    { key: 'goal', terms: ['목표', '계획', '분기', '성과', '점검'] },
  ],
  '성장과성공': [
    { key: 'career', terms: ['커리어', '이직', '취업', '포지션', '역량'] },
    { key: 'leadership', terms: ['리더', '리더십', '팀', '조직', '매니저'] },
    { key: 'decision', terms: ['판단', '선택', '우선순위', '방향', '기준'] },
    { key: 'execution', terms: ['실행', '행동', '루틴', '습관', '추진'] },
  ],
  '홈페이지와App': [
    { key: 'ux', terms: ['ux', 'ui', '경험', '인터페이스', '탐색'] },
    { key: 'conversion', terms: ['전환', '가입', '온보딩', '이탈', '완료율'] },
    { key: 'trust', terms: ['신뢰', '상태', '설명', '안내', '오해'] },
    { key: 'flow', terms: ['흐름', '구조', '정보구조', '동선', '설계'] },
  ],
  '최신IT트렌드': [
    { key: 'ai', terms: ['ai', 'llm', 'agent', '생성형', '모델'] },
    { key: 'cloud', terms: ['클라우드', 'infra', '인프라', '쿠버네티스', '서버리스'] },
    { key: 'saas', terms: ['saas', '구독', '제품', '플랫폼', '워크플로우'] },
    { key: 'automation', terms: ['자동화', 'ops', '생산성', '도구', '연결'] },
  ],
  'IT정보와분석': [
    { key: 'security', terms: ['보안', '위협', '취약점', '인증', '공격'] },
    { key: 'data', terms: ['데이터', '지표', '분석', '통계', '리포트'] },
    { key: 'architecture', terms: ['아키텍처', '구조', 'api', '성능', '병목'] },
    { key: 'operations', terms: ['운영', '장애', '헬스', '모니터링', '복구'] },
  ],
  '개발기획과컨설팅': [
    { key: 'requirements', terms: ['요구사항', '명세', '범위', 'scope', '전제'] },
    { key: 'handoff', terms: ['handoff', '인수인계', '정렬', '전달', '커뮤니케이션'] },
    { key: 'roadmap', terms: ['로드맵', '일정', '우선순위', '계획', '마일스톤'] },
    { key: 'feedback', terms: ['피드백', '고객', '요청', '해석', 'rework'] },
  ],
};

const CATEGORY_FALLBACK_CANDIDATES = {
  '자기계발': [
    { title: '아침 루틴보다 먼저 점검할 에너지 설계 기준 3가지', question: '루틴을 오래 유지하려면 무엇을 먼저 설계해야 하나', diff: '의지보다 지속 가능성에 초점', trend_relevance: 0.54 },
    { title: '독서 메모가 쌓이기만 할 때 다시 연결하는 질문 3가지', question: '읽은 내용을 실행으로 바꾸려면 어떤 질문이 필요할까', diff: '지식 축적보다 연결과 적용 중심', trend_relevance: 0.5 },
    { title: '계획이 자주 밀릴 때 일정표보다 먼저 고쳐야 할 기준', question: '계획이 무너질 때 가장 먼저 의심해야 할 전제는 무엇인가', diff: '시간관리보다 기준 재설계 관점', trend_relevance: 0.48 },
  ],
  '성장과성공': [
    { title: '열심히 하는데 성장감이 약할 때 먼저 점검할 기준 3가지', question: '노력과 성장이 어긋날 때 무엇부터 다시 봐야 할까', diff: '실행량보다 성장 기준의 선명도에 초점', trend_relevance: 0.56 },
    { title: '커리어 방향이 흔들릴 때 이직보다 먼저 정리할 질문', question: '지금의 흔들림이 환경 문제인지 방향 문제인지 어떻게 구분할까', diff: '결정 전에 기준을 세우는 관점', trend_relevance: 0.53 },
    { title: '성과 압박이 커질수록 더 자주 놓치는 우선순위 설계', question: '성과를 내야 할수록 무엇을 덜어내야 할까', diff: '성과 압박 속 선택 기준 재정렬', trend_relevance: 0.51 },
  ],
  '홈페이지와App': [
    { title: '서비스 신뢰를 만드는 상태 설명 UX 체크리스트 3가지', question: '사용자가 불안해하지 않으려면 어떤 상태 설명이 필요할까', diff: '기능보다 설명 가능한 상태 중심', trend_relevance: 0.55 },
    { title: '회원가입을 망치는 첫 화면에서 먼저 줄여야 할 마찰', question: '전환을 높이려면 첫 화면에서 무엇을 덜어내야 할까', diff: 'UI 미세조정보다 흐름의 마찰 제거에 초점', trend_relevance: 0.53 },
    { title: '사용자가 길을 잃는 정보구조에서 바로 드러나는 신호 3가지', question: '탐색이 어려운 구조는 어떤 신호로 보일까', diff: '메뉴 개수보다 정보구조 해석 중심', trend_relevance: 0.5 },
  ],
  '최신IT트렌드': [
    { title: 'AI 도입 논의가 많아질수록 먼저 확인할 운영 비용 기준', question: '기술 화제와 실제 도입 기준을 어떻게 분리할까', diff: '트렌드 소개보다 운영 현실 점검', trend_relevance: 0.57 },
    { title: '자동화 툴이 늘어날수록 오히려 복잡도가 커지는 이유', question: '연결이 많아질수록 무엇이 병목이 될까', diff: '생산성 홍보보다 운영 복잡도 해석', trend_relevance: 0.54 },
    { title: '요즘 SaaS 비교에서 기능표보다 먼저 봐야 할 차이', question: '도입 전 어떤 관점으로 SaaS를 비교해야 할까', diff: '기능 나열보다 운영 적합성 중심', trend_relevance: 0.5 },
  ],
  'IT정보와분석': [
    { title: '장애가 반복될 때 로그보다 먼저 정리할 운영 질문 3가지', question: '문제 해결 속도를 높이려면 어떤 질문을 먼저 세워야 할까', diff: '로그 해석보다 운영 가설 수립 중심', trend_relevance: 0.55 },
    { title: '보안 이슈를 뉴스로만 보면 놓치기 쉬운 영향 판단 기준', question: '보안 뉴스를 우리 시스템 언어로 번역하려면 무엇이 필요할까', diff: '사건 소개보다 영향도 해석 중심', trend_relevance: 0.53 },
    { title: '지표가 많을수록 더 헷갈릴 때 남겨야 할 핵심 숫자 3개', question: '운영 판단을 위해 최소한 어떤 지표를 봐야 할까', diff: '대시보드 나열보다 기준 축소 관점', trend_relevance: 0.5 },
  ],
  '개발기획과컨설팅': [
    { title: '요구사항 정의 전에 먼저 정리할 전제 체크리스트 3가지', question: '요구사항 회의 전에 무엇을 먼저 합의해야 할까', diff: '명세 작성 전 전제 정렬 중심', trend_relevance: 0.56 },
    { title: '고객 피드백을 기능 요청으로만 받으면 생기는 비용', question: '피드백을 어떤 기준으로 다시 해석해야 할까', diff: '요청 수집보다 해석 체계에 초점', trend_relevance: 0.53 },
    { title: '개발 handoff가 자꾸 흔들릴 때 문서보다 먼저 맞출 것', question: 'handoff 실패는 어떤 전제 불일치에서 시작될까', diff: '문서 양보다 전달 기준 정렬 관점', trend_relevance: 0.5 },
  ],
};

// ─── 인수 파싱 ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = { date: null, json: false };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--date=')) args.date = arg.split('=')[1];
    else if (arg === '--json') args.json = true;
  }
  if (!args.date) {
    const todayKst = kst.today();
    const [y, m, d] = todayKst.split('-').map(Number);
    const tomorrowUtc = new Date(Date.UTC(y, m - 1, d + 1));
    args.date = tomorrowUtc.toISOString().slice(0, 10);
  }
  return args;
}

// ─── 카테고리 로테이션 ──────────────────────────────────────────────────────

async function pickTomorrowCategory(tomorrowDate) {
  try {
    await ensureSchedule(tomorrowDate);
    const scheduled = await getScheduleByDate(tomorrowDate);
    const generalRow = (scheduled || []).find(row => row.post_type === 'general' && row.category);
    if (generalRow?.category) return generalRow.category;

    const row = await pgPool.get('blog',
      `SELECT category
       FROM blog.publish_schedule
       WHERE post_type = 'general'
         AND publish_date < $1
         AND category IS NOT NULL
       ORDER BY publish_date DESC, id DESC
       LIMIT 1`,
      [tomorrowDate]
    );
    const lastCategory = row?.category || null;
    const lastIndex = lastCategory ? CATEGORIES.indexOf(lastCategory) : -1;
    return CATEGORIES[(lastIndex + 1 + CATEGORIES.length) % CATEGORIES.length];
  } catch {
    return CATEGORIES[0];
  }
}

// ─── 이슈 수집 ─────────────────────────────────────────────────────────────

async function fetchGithubTrending() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const cutoff = kst.daysAgoStr(7);
    const res = await fetch(
      `https://api.github.com/search/repositories?q=created:>${cutoff}&sort=stars&order=desc&per_page=10`,
      { headers: { 'User-Agent': 'TeamJay-Blog-Bot' }, signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map(r => ({
      title: r.full_name,
      description: r.description || '',
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
    const top8 = ids.slice(0, 8);
    const stories = await Promise.allSettled(
      top8.map(id =>
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

// ─── 후보 생성 ─────────────────────────────────────────────────────────────

async function generateCandidates(category, issues, tomorrowDate) {
  const guide = CATEGORY_GUIDES[category] || {};
  const keywords = CATEGORY_KEYWORDS[category] || [];
  const issuesSummary = issues.slice(0, 12)
    .map((i, idx) => `${idx + 1}. ${i.title}`)
    .join('\n');

  const prompt = `다음은 오늘 수집된 GitHub + HN 이슈입니다:

${issuesSummary || '(이슈 없음)'}

위 이슈를 참고하여 한국 IT 블로그 카테고리 "[${category}]"에 맞는 내일(${tomorrowDate}) 포스팅 주제 후보 5개를 제안하세요.

카테고리 독자: ${guide.readerProblem || ''}
키워드 참고: ${keywords.join(', ')}

다음 JSON 배열 형식으로 출력 (마크다운 없이):
[
  {
    "title": "한국어 제목 (30자 이내)",
    "question": "독자 핵심 질문 (한 문장)",
    "diff": "기존 글과 차별점 (한 문장)",
    "trend_relevance": 0.8
  }
]`;

  try {
    const result = await callLocalLlm({
      prompt,
      model: 'qwen2.5:7b',
      maxTokens: 1000,
      temperature: 0.75,
    });
    const text = result?.content || result?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return generateFallbackCandidates(category);
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed) ? parsed.slice(0, 5) : generateFallbackCandidates(category);
  } catch {
    return generateFallbackCandidates(category);
  }
}

function generateFallbackCandidates(category) {
  return CATEGORY_FALLBACK_CANDIDATES[category]
    || [
      { title: `${category} 실전 체크리스트`, question: '지금 먼저 확인해야 할 것은 무엇인가', diff: '이론보다 실행 중심', trend_relevance: 0.5 },
      { title: `${category}에서 놓치기 쉬운 판단 기준`, question: '실수를 줄이려면 무엇을 먼저 확인해야 하나', diff: '개념보다 의사결정 관점', trend_relevance: 0.4 },
      { title: `2026년 ${category} 변화 핵심 정리`, question: '달라진 것과 변하지 않은 것은 무엇인가', diff: '트렌드 나열보다 맥락 해석', trend_relevance: 0.45 },
    ];
}

// ─── 30일 중복 체크 ────────────────────────────────────────────────────────

async function getRecentTitles30d(tomorrowDate) {
  try {
    const cutoffDate = new Date(tomorrowDate);
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);
    const rows = await pgPool.query('blog',
      `SELECT title FROM blog.posts
       WHERE type IN ('general', 'lecture')
         AND DATE(publish_date) >= $1
         AND DATE(publish_date) <= $2
         AND COALESCE(status, '') NOT IN ('failed', 'error', 'archived')
       ORDER BY publish_date DESC, id DESC`,
      [cutoffStr, tomorrowDate]
    );
    return (rows || []).map(r => String(r.title || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function isDuplicate(title, recentTitles) {
  return isTooCloseToRecentTitle({ title }, recentTitles);
}

function inferCandidateLane(category, candidate) {
  const lanes = CATEGORY_TOPIC_LANES[category] || [];
  const text = normalizeTitle([
    candidate?.title || '',
    candidate?.question || '',
    candidate?.diff || '',
  ].join(' '));

  for (const lane of lanes) {
    if (lane.terms.some(term => text.includes(normalizeTitle(term)))) {
      return lane.key;
    }
  }

  return 'generic';
}

function selectDiverseCandidates(candidates, category, limit = PREPLANNED_CANDIDATE_COUNT) {
  const sorted = Array.isArray(candidates)
    ? [...candidates].sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0))
    : [];
  const selected = [];
  const usedLanes = new Set();

  for (const candidate of sorted) {
    if (selected.length >= limit) break;
    const lane = inferCandidateLane(category, candidate);
    const tooSimilar = selected.some(existing => similarity(existing.title, candidate.title) > 0.24);
    if (usedLanes.has(lane) || tooSimilar) continue;
    selected.push({ ...candidate, lane });
    usedLanes.add(lane);
  }

  for (const candidate of sorted) {
    if (selected.length >= limit) break;
    const exists = selected.some(existing => existing.title === candidate.title);
    const tooSimilar = selected.some(existing => similarity(existing.title, candidate.title) > 0.32);
    if (exists || tooSimilar) continue;
    selected.push({ ...candidate, lane: inferCandidateLane(category, candidate) });
  }

  return selected.slice(0, limit);
}

// ─── 품질 점수화 ────────────────────────────────────────────────────────────

async function scoreCandidateWithCritic(candidate, category, recentTitles) {
  let score = 50;

  // 30일 중복 패널티
  const dup = isDuplicate(candidate.title, recentTitles);
  if (dup) return { ...candidate, quality_score: 0, duplicate_check: false, skip: true };

  // 트렌드 관련도
  score += (Number(candidate.trend_relevance) || 0.5) * 20;

  // 제목 길이 (15~30자 적정)
  const titleLen = String(candidate.title || '').length;
  if (titleLen >= 15 && titleLen <= 30) score += 10;
  else if (titleLen < 10 || titleLen > 40) score -= 10;

  // 질문/차별점 있으면 보너스
  if (candidate.question && String(candidate.question).length > 10) score += 5;
  if (candidate.diff && String(candidate.diff).length > 10) score += 5;

  // LLM 크리틱 (간단 평가)
  try {
    const guide = CATEGORY_GUIDES[category] || {};
    const criticPrompt = `블로그 포스팅 주제를 평가해주세요.

카테고리: ${category}
독자 문제: ${guide.readerProblem || ''}
주제 제목: "${candidate.title}"
핵심 질문: "${candidate.question || ''}"

이 주제가 독자에게 실용적 가치가 있는지 0~10점으로 평가하고 숫자만 출력하세요.`;

    const result = await callLocalLlm({
      prompt: criticPrompt,
      model: 'qwen2.5:7b',
      maxTokens: 10,
      temperature: 0.2,
    });
    const text = result?.content || result?.text || '';
    const numMatch = text.match(/\d+(\.\d+)?/);
    if (numMatch) {
      const criticScore = Math.min(10, Math.max(0, parseFloat(numMatch[0])));
      score += criticScore * 3;  // 최대 30점 추가
    }
  } catch {
    // LLM 크리틱 실패 시 무시
  }

  return {
    ...candidate,
    quality_score: Math.round(score),
    duplicate_check: true,
    skip: false,
  };
}

// ─── DB 저장 ───────────────────────────────────────────────────────────────

async function replacePendingTopicPlan(_category, tomorrowDate) {
  await pgPool.query('blog',
    `DELETE FROM blog.topic_candidates
     WHERE target_date = $1
       AND status = 'pending'`,
    [tomorrowDate]
  );

  await pgPool.query('blog',
    `DELETE FROM blog.topic_queue
     WHERE scheduled_date = $1
       AND status = 'pending'`,
    [tomorrowDate]
  );
}

async function saveToTopicCandidates(category, candidates, tomorrowDate, issues) {
  const topCandidates = selectDiverseCandidates(candidates, category, PREPLANNED_CANDIDATE_COUNT);

  if (!topCandidates.length) return [];

  const sourceIssues = JSON.stringify(
    (issues || []).slice(0, 12).map(issue => ({
      title: issue?.title || '',
      description: issue?.description || '',
      url: issue?.url || '',
      stars: issue?.stars || 0,
      points: issue?.points || 0,
    }))
  );

  const saved = [];

  for (const candidate of topCandidates) {
    const row = await pgPool.get('blog',
      `INSERT INTO blog.topic_candidates
         (category, title, question, diff, keywords, source_issues, score, status, target_date)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'pending', $8)
       RETURNING id`,
      [
        category,
        candidate.title,
        candidate.question || null,
        candidate.diff || null,
        candidate.keywords || [],
        sourceIssues,
        candidate.quality_score || candidate.score || 0.5,
        tomorrowDate,
      ]
    );

    saved.push({
      ...candidate,
      id: row?.id || null,
    });
  }

  return saved;
}

async function saveToTopicQueue(category, best, tomorrowDate, trendSource) {
  const guide = CATEGORY_GUIDES[category] || {};

  const row = await pgPool.get('blog',
    `INSERT INTO blog.topic_queue
       (category, title, question, diff, reader_problem, opening_angle, closing_angle,
        trend_source, trend_summary, quality_score, duplicate_check, status, scheduled_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)
     RETURNING id`,
    [
      category,
      best.title,
      best.question || null,
      best.diff || null,
      guide.readerProblem || null,
      guide.openingAngle || null,
      guide.closingAngle || null,
      trendSource,
      best.trend_summary || null,
      best.quality_score,
      best.duplicate_check,
      tomorrowDate,
    ]
  );
  return row?.id;
}

// ─── 메인 ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const tomorrowDate = args.date;
  await ensureBlogCoreSchema();

  // 1. 카테고리 결정
  const category = await pickTomorrowCategory(tomorrowDate);
  console.log(`[topic-planner] 내일 카테고리: ${category} (${tomorrowDate})`);

  // 2. 이슈 수집 (병렬)
  const [githubResult, hnResult] = await Promise.allSettled([
    fetchGithubTrending(),
    fetchHNTop(),
  ]);
  const githubItems = githubResult.status === 'fulfilled' ? githubResult.value : [];
  const hnItems = hnResult.status === 'fulfilled' ? hnResult.value : [];
  const issues = [...githubItems, ...hnItems];
  const trendSource = githubItems.length > 0 && hnItems.length > 0 ? 'mixed'
    : githubItems.length > 0 ? 'github'
    : hnItems.length > 0 ? 'hn'
    : 'llm_only';

  // 3. 후보 생성
  const rawCandidates = await generateCandidates(category, issues, tomorrowDate);

  // 4. 30일 최근 제목 로드
  const recentTitles = await getRecentTitles30d(tomorrowDate);

  // 5. 품질 점수화 (순차 — LLM 호출 포함)
  const scored = [];
  for (const c of rawCandidates) {
    const result = await scoreCandidateWithCritic(c, category, recentTitles);
    if (!result.skip) scored.push(result);
  }

  // 6. 최고 점수 선택
  scored.sort((a, b) => b.quality_score - a.quality_score);
  const best = scored[0] || {
    title: `${category} 실전 가이드`,
    question: `${category} 독자가 지금 먼저 해결해야 할 것은?`,
    diff: '기본 폴백 주제',
    quality_score: 30,
    duplicate_check: false,
    trend_relevance: 0.3,
  };

  // 7. DB 저장
  await replacePendingTopicPlan(category, tomorrowDate);
  const savedCandidates = await saveToTopicCandidates(category, scored, tomorrowDate, issues);
  const savedId = await saveToTopicQueue(category, best, tomorrowDate, trendSource);

  const output = {
    ok: true,
    date: tomorrowDate,
    category,
    title: best.title,
    question: best.question || '',
    quality_score: best.quality_score,
    duplicate_check: best.duplicate_check,
    trend_source: trendSource,
    candidates_count: savedCandidates.length,
    passed_candidates: scored.length,
    saved_id: savedId || null,
    candidates: savedCandidates.map(candidate => ({
      id: candidate.id,
      title: candidate.title,
      question: candidate.question || '',
      quality_score: candidate.quality_score || candidate.score || 0,
    })),
    sources: { github: githubItems.length, hn: hnItems.length },
  };

  if (args.json) {
    console.log(JSON.stringify(output));
  } else {
    console.log(`[topic-planner] ✅ 내일 주제 확정: [${category}] ${best.title}`);
    console.log(`  품질 점수: ${best.quality_score} / 중복 통과: ${best.duplicate_check}`);
    console.log(`  후보 ${rawCandidates.length}건 → 통과 ${scored.length}건 → 저장 ${savedCandidates.length}건`);
  }

  return output;
}

main().catch(e => {
  console.error('[topic-planner] 오류:', e.message);
  process.exit(1);
});
