// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { isExcludedReferenceFilename, isExcludedReferenceTitle } = require('./reference-exclusions.ts');

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
    { topic: '요구사항 정의 전에 먼저 정리할 전제', question: '일정이 밀리기 전에 무엇을 먼저 문서화해야 할까', diff: '기능 목록보다 전제와 범위 점검' },
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

const CATEGORY_SELECTION_GUIDES = {
  '홈페이지와App': {
    readerProblem: '기능은 있는데 사용자가 어디에서 멈추고 왜 신뢰를 잃는지 설명이 필요한 독자',
    openingAngle: '첫 화면, 탐색, 상태 설명처럼 사용자가 가장 먼저 체감하는 마찰에서 출발',
    keyQuestions: [
      '사용자는 어디에서 헷갈리거나 멈추는가',
      '무엇을 더 넣기보다 무엇을 먼저 설명해야 하는가',
      '속도보다 신뢰를 높이는 UX 장치는 무엇인가',
    ],
    closingAngle: '기능 추가보다 이해 가능한 흐름과 설명 가능한 상태를 먼저 정리하자는 결론으로 닫기',
  },
  '개발기획과컨설팅': {
    readerProblem: '일정, 요구사항, 기대치가 자꾸 어긋나는 실무 의사결정자',
    openingAngle: '개발 자체보다 전제와 문서화가 늦어질 때 생기는 비용에서 출발',
    keyQuestions: [
      '무엇이 아직 확정되지 않았는가',
      '어떤 문서를 먼저 합의해야 일정이 덜 흔들리는가',
      '기술보다 기대치 관리가 먼저 필요한 지점은 어디인가',
    ],
    closingAngle: '좋은 기획은 더 많은 요구를 담는 것이 아니라 범위와 전제를 먼저 선명하게 만드는 일이라고 정리',
  },
  '최신IT트렌드': {
    readerProblem: '새 기술 뉴스는 많이 보지만 실제 도입 기준은 잘 안 잡히는 독자',
    openingAngle: '화제성보다 운영 비용과 유지 책임을 먼저 보는 관점에서 출발',
    keyQuestions: [
      '이 기술은 왜 지금 다시 주목받는가',
      '도입보다 운영에서 더 큰 비용은 무엇인가',
      '실무자는 어떤 조건이 갖춰질 때만 따라가야 하는가',
    ],
    closingAngle: '트렌드는 빨리 읽되 도입은 늦고 신중하게 하자는 메시지로 마무리',
  },
  'IT정보와분석': {
    readerProblem: '정보는 많은데 무엇이 중요한 신호인지 구분하기 어려운 독자',
    openingAngle: '뉴스 나열보다 의미 해석과 우선순위 판단이 필요한 장면에서 출발',
    keyQuestions: [
      '지금 봐야 할 신호는 무엇인가',
      '겉으로 큰 뉴스와 실제 영향이 큰 뉴스는 어떻게 다른가',
      '실무자는 어떤 정보부터 행동으로 옮겨야 하는가',
    ],
    closingAngle: '정보 소비보다 해석 기준을 남기는 글로 닫기',
  },
  '성장과성공': {
    readerProblem: '열심히 하는데도 방향과 기준이 자꾸 흔들리는 독자',
    openingAngle: '실행력 부족보다 판단 기준의 부재에서 출발',
    keyQuestions: [
      '지금의 선택이 나를 바쁘게 만드는가, 나아가게 만드는가',
      '무엇을 더 할지가 아니라 무엇을 버릴지 먼저 정했는가',
      '오늘의 선택이 다음 기회를 넓히는가',
    ],
    closingAngle: '더 많이 하는 삶보다 더 분명하게 고르는 삶으로 정리',
  },
  '도서리뷰': {
    readerProblem: '책 소개보다 이 책이 지금 왜 읽을 가치가 있는지 알고 싶은 독자',
    openingAngle: '줄거리 요약보다 지금의 일과 삶에 어떤 질문을 남기는 책인지에서 출발',
    keyQuestions: [
      '이 책은 어떤 독자에게 지금 유효한가',
      '핵심 주장이나 장면을 실무와 삶의 판단 기준으로 어떻게 번역할 수 있는가',
      '비슷한 책과 달리 이 책이 남기는 결은 무엇인가',
    ],
    closingAngle: '책 내용을 요약하는 데서 멈추지 않고 독자의 다음 행동이나 질문으로 연결하며 마무리',
  },
};

const TITLE_FRAMES = [
  { pattern: 'checklist', template: '{topic} 체크리스트 3가지' },
  { pattern: 'warning', template: '{topic}, 지금 바꾸지 않으면 늦는 이유' },
  { pattern: 'experience', template: '직접 해보고 깨달은 {topic}의 진짜 핵심' },
  { pattern: 'experience', template: '3개월간 {topicObject} 운영하며 배운 것들' },
  { pattern: 'checklist', template: '{topic}에서 막힐 때 가장 먼저 확인할 포인트' },
  { pattern: 'checklist', template: '{count}가지 {topic} 실전 노하우' },
  { pattern: 'warning', template: '{topic}에서 초보자가 가장 먼저 실수하는 것' },
  { pattern: 'trend', template: '2026년 {topic} 트렌드: 달라진 것과 변하지 않는 것' },
];

const CATEGORY_PATTERN_PREFERENCES = {
  '홈페이지와App': ['checklist', 'experience'],
  '개발기획과컨설팅': ['checklist', 'warning'],
  '최신IT트렌드': ['trend', 'warning'],
  'IT정보와분석': ['trend', 'checklist'],
  '성장과성공': ['experience', 'checklist'],
  '도서리뷰': ['experience', 'checklist'],
};

function _hasSenseSignal(senseState = null, signalType = '') {
  const signals = Array.isArray(senseState?.signals) ? senseState.signals : [];
  return signals.some((signal) => String(signal?.type || '') === signalType);
}

function adjustCategoryWeightsBySense(baseWeights = {}, senseState = null, revenueCorrelation = null) {
  const next = {
    홈페이지와App: 1,
    개발기획과컨설팅: 1,
    최신IT트렌드: 1,
    IT정보와분석: 1,
    성장과성공: 1,
    도서리뷰: 1,
    ...baseWeights,
  };

  const revenueDown = _hasSenseSignal(senseState, 'revenue_anomaly') || _hasSenseSignal(senseState, 'revenue_decline');
  const examPeriod = _hasSenseSignal(senseState, 'exam_period') || Number(senseState?.skaEnvironment?.exam_score || 0) > 0;
  const holiday = _hasSenseSignal(senseState, 'holiday') || !!senseState?.skaEnvironment?.holiday_flag;
  const negativeRevenueImpact = Number(revenueCorrelation?.revenueImpactPct || 0) < 0;

  if (revenueDown || negativeRevenueImpact) {
    next['홈페이지와App'] += 3;
    next['개발기획과컨설팅'] += 2;
    next['성장과성공'] += 1;
  }

  if (examPeriod) {
    next['성장과성공'] += 3;
    next['도서리뷰'] += 2;
    next['홈페이지와App'] += 1;
  }

  if (holiday) {
    next['도서리뷰'] += 2;
    next['성장과성공'] += 1;
    next['홈페이지와App'] += 1;
  }

  return next;
}

function buildMarketingHints(category = '', senseState = null, revenueCorrelation = null) {
  const adjustedWeights = adjustCategoryWeightsBySense({}, senseState, revenueCorrelation);
  const signals = [];
  const recommendations = [];
  let ctaHint = '';

  if (_hasSenseSignal(senseState, 'revenue_anomaly') || _hasSenseSignal(senseState, 'revenue_decline')) {
    signals.push('매출 하락 또는 이상 징후 감지');
    if (['홈페이지와App', '개발기획과컨설팅', '성장과성공'].includes(category)) {
      recommendations.push('예약, 문의, 체험 전환으로 이어지는 CTA를 과장 없이 자연스럽게 넣어라.');
      ctaHint = '체험 예약, 상담 문의, 방문 유도 중 하나를 본문 후반에 자연스럽게 연결';
    }
  }

  if (_hasSenseSignal(senseState, 'exam_period') || Number(senseState?.skaEnvironment?.exam_score || 0) > 0) {
    signals.push('시험기간/학습 수요 감지');
    recommendations.push('학습 효율, 몰입 환경, 루틴 유지 포인트를 최소 1회 이상 본문에 포함하라.');
    if (!ctaHint && ['성장과성공', '도서리뷰', '홈페이지와App'].includes(category)) {
      ctaHint = '시험기간 독자가 바로 적용할 학습 루틴이나 집중 환경 팁을 결론부에 연결';
    }
  }

  if (_hasSenseSignal(senseState, 'holiday') || !!senseState?.skaEnvironment?.holiday_flag) {
    signals.push('공휴일/가벼운 소비 맥락 감지');
    recommendations.push('무겁게 밀어붙이기보다 체크리스트형, 가볍게 읽히는 톤으로 정리하라.');
  }

  if (Number(revenueCorrelation?.revenueImpactPct || 0) < 0) {
    signals.push(`최근 마케팅-매출 상관 약세 (${(Number(revenueCorrelation.revenueImpactPct) * 100).toFixed(1)}%)`);
  }

  return {
    categoryWeight: Number(adjustedWeights[category] || 1),
    signalSummary: signals.join(' / ') || '특이 마케팅 신호 없음',
    recommendations,
    ctaHint,
  };
}

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

function normalizeTokens(text = '') {
  return normalizeTitle(text)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
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

function tokenOverlapRatio(a = '', b = '') {
  const first = new Set(normalizeTokens(a));
  const second = new Set(normalizeTokens(b));
  if (!first.size || !second.size) return 0;
  let intersection = 0;
  for (const token of first) {
    if (second.has(token)) intersection += 1;
  }
  return intersection / Math.max(first.size, second.size);
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

function scoreCandidate(candidate, category = '', strategyPlan = null) {
  let score = 0;
  const guide = getCategorySelectionGuide(category);
  const preferredPatterns = CATEGORY_PATTERN_PREFERENCES[category] || [];
  const candidateTokens = new Set([
    ...normalizeTokens(candidate.title),
    ...normalizeTokens(candidate.topic),
    ...normalizeTokens(candidate.question),
    ...normalizeTokens(candidate.diff),
  ]);

  if (preferredPatterns.includes(candidate.pattern)) {
    score += 3;
  }

  const guideTexts = [
    guide.readerProblem,
    guide.openingAngle,
    guide.closingAngle,
    ...(Array.isArray(guide.keyQuestions) ? guide.keyQuestions : []),
  ];
  const guideTokens = new Set(guideTexts.flatMap((text) => normalizeTokens(text)));
  let guideOverlap = 0;
  for (const token of guideTokens) {
    if (candidateTokens.has(token)) guideOverlap += 1;
  }
  score += Math.min(guideOverlap, 4);

  if (!strategyPlan) return score;
  if (strategyPlan.preferredTitlePattern && candidate.pattern === strategyPlan.preferredTitlePattern) score += 4;
  if (strategyPlan.suppressedTitlePattern && candidate.pattern === strategyPlan.suppressedTitlePattern) {
    score -= strategyPlan.hardSuppressTitlePattern ? 7 : 3;
  }
  if (Array.isArray(strategyPlan.focus) && strategyPlan.focus.some((item) => String(item || '').includes('제목 패턴'))) {
    if (candidate.pattern !== strategyPlan.suppressedTitlePattern) score += 1;
  }
  return score;
}

function getCategorySelectionGuide(category = '') {
  return CATEGORY_SELECTION_GUIDES[category] || {
    readerProblem: `${category} 독자가 지금 먼저 풀고 싶은 실제 문제`,
    openingAngle: `${category}를 개념 설명보다 실전 장면에서 시작`,
    keyQuestions: [
      `${category}에서 지금 가장 먼저 살펴봐야 할 것은 무엇인가`,
      `${category} 독자가 바로 적용할 수 있는 기준은 무엇인가`,
      `${category}를 정보 나열이 아니라 판단 기준으로 바꾸려면 무엇이 필요한가`,
    ],
    closingAngle: `${category}에 대한 지식을 행동 기준으로 정리하며 마무리`,
  };
}

function enrichTopicSelection(candidate, category, recentTitles = []) {
  const guide = getCategorySelectionGuide(category);
  const title = String(candidate?.title || '').trim();

  return {
    ...candidate,
    category,
    title,
    readerProblem: guide.readerProblem,
    openingAngle: guide.openingAngle,
    keyQuestions: guide.keyQuestions,
    closingAngle: guide.closingAngle,
    marketingSignalSummary: candidate.marketingSignalSummary || '',
    marketingRecommendations: Array.isArray(candidate.marketingRecommendations) ? candidate.marketingRecommendations : [],
    marketingCtaHint: candidate.marketingCtaHint || '',
    marketingWeight: Number(candidate.marketingWeight || 1),
    freshnessSummary: recentTitles.length
      ? `최근 ${recentTitles.length}개 제목과 중복을 피하도록 조정`
      : '최근 제목 이력이 적어 카테고리 기본 문제의식 중심으로 선택',
  };
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
    .filter((post) => !isExcludedReferenceFilename(post.filename))
    .filter((post) => !isExcludedReferenceTitle(post.title))
    .filter((post) => post.category === category)
    .sort((a, b) => String(b.dateString).localeCompare(String(a.dateString)))
    .slice(0, limit);
}

function selectAndValidateTopic(category, recentPosts = [], strategyPlan = null, senseState = null, revenueCorrelation = null) {
  const recentTitles = recentPosts.map((post) => post.title).filter(Boolean);
  const topicPool = pickTopicPool(category);
  const marketingHints = buildMarketingHints(category, senseState, revenueCorrelation);
  const latestRecentTitle = recentTitles[0] || '';

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
        marketingSignalSummary: marketingHints.signalSummary,
        marketingRecommendations: marketingHints.recommendations,
        marketingCtaHint: marketingHints.ctaHint,
        marketingWeight: marketingHints.categoryWeight,
        score: scoreCandidate({
          pattern: frame.pattern,
          topic: topicPool[i].topic,
          title,
          question: topicPool[i].question,
          diff: topicPool[i].diff,
        }, category, strategyPlan) + Number(marketingHints.categoryWeight || 1) - 1,
      });
    }
  }

  const selected = candidates
    .sort((a, b) => b.score - a.score)
    .find((candidate) => {
      if (isBannedTitle(candidate.title)) return false;
      if (
        strategyPlan?.hardSuppressTitlePattern &&
        strategyPlan?.suppressedTitlePattern &&
        candidate.pattern === strategyPlan.suppressedTitlePattern
      ) {
        return false;
      }
      if (recentTitles.some((recentTitle) => similarity(recentTitle, candidate.title) > SIMILARITY_THRESHOLD)) {
        return false;
      }
      if (latestRecentTitle) {
        const latestSimilarity = similarity(latestRecentTitle, candidate.title);
        const latestTokenOverlap = tokenOverlapRatio(latestRecentTitle, candidate.title);
        const topicOverlap = tokenOverlapRatio(latestRecentTitle, candidate.topic);
        if (latestSimilarity >= 0.28) return false;
        if (latestTokenOverlap >= 0.45) return false;
        if (topicOverlap >= 0.5) return false;
      }
      return true;
    });

  if (selected) {
    return enrichTopicSelection({
      ...selected,
      recentTitleCount: recentTitles.length,
      forced: false,
    }, category, recentTitles);
  }

  const fallback = topicPool[0] || { topic: `${category} 실전 가이드`, question: `${category}에서 무엇을 먼저 살펴봐야 할까`, diff: '강제 기본 주제' };
  return enrichTopicSelection({
    title: `${fallback.topic} 실전 가이드`,
    topic: fallback.topic,
    question: fallback.question,
    diff: fallback.diff,
    marketingSignalSummary: marketingHints.signalSummary,
    marketingRecommendations: marketingHints.recommendations,
    marketingCtaHint: marketingHints.ctaHint,
    marketingWeight: marketingHints.categoryWeight,
    pattern: strategyPlan?.preferredTitlePattern || (strategyPlan?.hardSuppressTitlePattern ? 'checklist' : 'default'),
    recentTitleCount: recentTitles.length,
    forced: true,
  }, category, recentTitles);
}

module.exports = {
  getRecentPosts,
  getCategorySelectionGuide,
  adjustCategoryWeightsBySense,
  buildMarketingHints,
  selectAndValidateTopic,
  similarity,
};
