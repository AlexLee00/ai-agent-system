// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const BLOG_OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output');
const RECENT_POST_LIMIT = 10;
const SIMILARITY_THRESHOLD = 0.4;
const BANNED_PATTERNS = [
  /^왜\s/,
  /보다.*더.*(중요|먼저)/i,
  /[일할될겠]까\s*$/i,
  /^성공적인 .*전략$/i,
];

const CATEGORY_TOPIC_POOL = {
  '홈페이지와App': [
    { topic: '회원가입 완료율을 높이는 온보딩 설계', question: '가입 시작 직후 어떤 마찰을 먼저 줄여야 할까', diff: '기능 소개보다 첫 30초 경험에 집중' },
    { topic: '결제 직전 이탈을 줄이는 설계', question: '사람들은 마지막 단계에서 왜 멈출까', diff: '결제 성공률과 설명 UX 관점' },
    { topic: '모바일 로딩 체감 성능 개선', question: '속도보다 먼저 손봐야 할 체감 포인트는 무엇일까', diff: '수치 최적화보다 사용자 체감 중심' },
    { topic: '서비스 신뢰를 만드는 상태 설명 UX', question: '오류가 없을 때도 왜 상태 설명이 중요할까', diff: '장애 대응이 아닌 평시 신뢰 설계' },
  ],
  '최신IT트렌드': [
    { topic: 'AI 도구를 실제 업무에 남기는 기준', question: '많은 도구 중 무엇을 끝까지 남겨야 할까', diff: '유행 소개가 아닌 운영 기준 정리' },
    { topic: 'SaaS 구독 피로 이후의 도구 선택', question: '새 도구를 늘리기 전에 무엇부터 끊어야 할까', diff: '도입보다 정리와 유지비 관점' },
    { topic: 'AI 코딩 도구의 팀 적용 조건', question: '개인 생산성이 팀 생산성으로 이어지려면 무엇이 필요할까', diff: '개인 사용기보다 팀 운영 관점' },
    { topic: '요즘 기술 선택에서 안정성이 다시 중요한 이유', question: '성능보다 먼저 따져야 할 기준은 무엇일까', diff: '트렌드 소개가 아닌 선택 원칙 정리' },
  ],
  '개발기획과컨설팅': [
    { topic: '요구사항 정의 전 꼭 확인할 전제', question: '일정이 밀리기 전에 무엇을 먼저 문서화해야 할까', diff: '기능 목록보다 전제와 범위 점검' },
    { topic: '개발 일정 산정을 망치는 커뮤니케이션', question: '왜 같은 요구사항을 두고 서로 다른 일정을 말하게 될까', diff: '기술 난이도보다 의사소통 관점' },
    { topic: '기획 문서가 실제 구현으로 이어지는 조건', question: '좋아 보이는 문서가 왜 실행 단계에서 무너질까', diff: '문서 형식보다 전달력과 결정 구조' },
  ],
  '자기계발': [
    { topic: '하루 30분 루틴을 무너지지 않게 만드는 기준', question: '의욕보다 먼저 설계해야 할 습관 장치는 무엇일까', diff: '동기부여보다 유지 가능한 구조' },
    { topic: '번아웃 직전 우선순위를 다시 세우는 법', question: '열심히 하는데도 자꾸 지칠 때 무엇을 줄여야 할까', diff: '열정이 아닌 에너지 관리 관점' },
    { topic: '꾸준함을 만드는 기록 습관', question: '왜 기록은 자주 시작만 하고 끝날까', diff: '의지보다 기록 구조와 피드백 루프' },
  ],
  '도서리뷰': [],
};

const TITLE_FRAMES = [
  { pattern: 'checklist', template: '{topicObject} 시작하기 전에 반드시 점검해야 할 3가지' },
  { pattern: 'warning', template: '{topic}, 지금 바꾸지 않으면 늦는 이유' },
  { pattern: 'experience', template: '직접 해보고 깨달은 {topic}의 진짜 핵심' },
  { pattern: 'experience', template: '3개월간 {topicObject} 운영하며 배운 것들' },
  { pattern: 'checklist', template: '{topic}에서 막힐 때 가장 먼저 확인할 포인트' },
  { pattern: 'checklist', template: '{count}가지 {topic} 실전 노하우' },
  { pattern: 'warning', template: '{topic}에서 초보자가 가장 먼저 실수하는 것' },
  { pattern: 'trend', template: '2026년 {topic} 트렌드: 달라진 것과 변하지 않는 것' },
];

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function parseRecentGeneralPost(filename) {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})_general_([^ ]+)\s+(.+)\.html$/);
  if (!match) return null;
  const [, dateString, category, title] = match;
  return {
    dateString,
    category,
    title: String(title || '').trim(),
    filename,
  };
}

function normalizeTitle(text = '') {
  return String(text || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function toBigrams(text = '') {
  const normalized = normalizeTitle(text).replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    set.add(normalized.slice(i, i + 2));
  }
  return set;
}

function similarity(a, b) {
  const first = toBigrams(a);
  const second = toBigrams(b);
  if (!first.size || !second.size) return 0;
  let intersection = 0;
  for (const item of first) {
    if (second.has(item)) intersection += 1;
  }
  const union = new Set([...first, ...second]).size;
  return union ? intersection / union : 0;
}

function isBannedTitle(title = '') {
  const text = String(title || '').trim();
  if (!text || text.length > 50) return true;
  return BANNED_PATTERNS.some((pattern) => pattern.test(text));
}

function hasFinalConsonant(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  const lastChar = text.charCodeAt(text.length - 1);
  if (lastChar < 0xac00 || lastChar > 0xd7a3) return false;
  return (lastChar - 0xac00) % 28 !== 0;
}

function withObjectParticle(value = '') {
  const text = String(value || '').trim();
  if (!text) return text;
  return `${text}${hasFinalConsonant(text) ? '을' : '를'}`;
}

function buildTitle(frame, candidate, index) {
  return frame
    .replace('{topic}', candidate.topic)
    .replace('{topicObject}', withObjectParticle(candidate.topic))
    .replace('{count}', String((index % 5) + 3));
}

function scoreCandidate(candidate, strategyPlan = null) {
  let score = 0;
  if (!strategyPlan) return score;
  if (strategyPlan.preferredTitlePattern && candidate.pattern === strategyPlan.preferredTitlePattern) score += 4;
  if (strategyPlan.suppressedTitlePattern && candidate.pattern === strategyPlan.suppressedTitlePattern) score -= 3;
  if (Array.isArray(strategyPlan.focus) && strategyPlan.focus.some((item) => String(item || '').includes('제목 패턴'))) {
    if (candidate.pattern !== strategyPlan.suppressedTitlePattern) score += 1;
  }
  return score;
}

function pickTopicPool(category) {
  return CATEGORY_TOPIC_POOL[category] || [
    { topic: `${category}에서 먼저 점검해야 할 기준`, question: `${category} 독자가 가장 먼저 부딪히는 문제는 무엇일까`, diff: '카테고리 독자 관점의 실전 문제 정의' },
    { topic: `${category} 실무 적용 체크리스트`, question: `${category}를 바로 실행으로 옮기려면 무엇부터 확인해야 할까`, diff: '추상적 개념보다 실전 체크리스트 중심' },
    { topic: `${category} 우선순위 재정렬`, question: `${category}에서 지금 가장 늦기 전에 바꿔야 할 것은 무엇일까`, diff: '정보 나열보다 판단 기준 정리' },
  ];
}

function getRecentPosts(category, limit = RECENT_POST_LIMIT) {
  return safeReadDir(BLOG_OUTPUT_DIR)
    .map(parseRecentGeneralPost)
    .filter(Boolean)
    .filter((post) => post.category === category)
    .sort((a, b) => String(b.dateString).localeCompare(String(a.dateString)))
    .slice(0, limit);
}

function selectAndValidateTopic(category, recentPosts = [], strategyPlan = null) {
  const recentTitles = recentPosts.map((post) => post.title).filter(Boolean);
  const topicPool = pickTopicPool(category);

  const candidates = [];
  for (let i = 0; i < topicPool.length; i += 1) {
    for (let j = 0; j < TITLE_FRAMES.length; j += 1) {
      const frame = TITLE_FRAMES[j];
      const title = buildTitle(frame.template, topicPool[i], j);
      candidates.push({
        title,
        pattern: frame.pattern,
        topic: topicPool[i].topic,
        question: topicPool[i].question,
        diff: topicPool[i].diff,
        score: scoreCandidate({ pattern: frame.pattern, topic: topicPool[i].topic, title }, strategyPlan),
      });
    }
  }

  const selected = candidates
    .sort((a, b) => b.score - a.score)
    .find((candidate) => {
      if (isBannedTitle(candidate.title)) return false;
      return !recentTitles.some((recentTitle) => similarity(recentTitle, candidate.title) > SIMILARITY_THRESHOLD);
    });

  if (selected) {
    return {
      ...selected,
      recentTitleCount: recentTitles.length,
      forced: false,
    };
  }

  const fallback = topicPool[0] || { topic: `${category} 실전 가이드`, question: `${category}에서 무엇을 먼저 살펴봐야 할까`, diff: '강제 기본 주제' };
  return {
    title: `${fallback.topic} 실전 가이드`,
    topic: fallback.topic,
    question: fallback.question,
    diff: fallback.diff,
    pattern: strategyPlan?.preferredTitlePattern || 'default',
    recentTitleCount: recentTitles.length,
    forced: true,
  };
}

module.exports = {
  getRecentPosts,
  selectAndValidateTopic,
  similarity,
};
