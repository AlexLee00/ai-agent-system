'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { queryOpsDb } = require('../../../packages/core/lib/hub-client');
const { normalizeExecutionDirectives } = require('./strategy-loader.ts');
const { readExperimentPlaybook } = require('./experiment-os.ts');
const { isExcludedReferenceFilename, isExcludedReferenceTitle } = require('./reference-exclusions.ts');
const {
  normalizeTitle,
  normalizeTokens,
  similarity,
  tokenOverlapRatio,
  isTooCloseToRecentTitle,
  mergeRecentTitles,
} = require('./topic-title-guard.ts');

// DPO 힌트 (lazy load — BLOG_DPO_ENABLED=true일 때만 활성)
let _dpoCached = null;
let _experimentPlaybookCached = null;

async function _loadDpoHints() {
  if (process.env.BLOG_DPO_ENABLED !== 'true') return { patterns: [], failures: [] };
  if (_dpoCached && Date.now() - _dpoCached.loadedAt < 3_600_000) {
    return { patterns: _dpoCached.patterns, failures: _dpoCached.failures };
  }
  try {
    const dpo = require('./self-rewarding/marketing-dpo.ts');
    const [patterns, failures] = await Promise.all([
      dpo.fetchSuccessPatterns(30),
      dpo.fetchFailureTaxonomy(20),
    ]);
    _dpoCached = { patterns, failures, loadedAt: Date.now() };
    return { patterns, failures };
  } catch {
    return { patterns: [], failures: [] };
  }
}

function _applyDpoScore(candidates, patterns, failures) {
  if (patterns.length === 0 && failures.length === 0) return candidates;
  const dpo = require('./self-rewarding/marketing-dpo.ts');
  return candidates.map((c) => ({
    ...c,
    score: (Number(c.score) || 0.5) + dpo.calculateDpoScore(
      { topic: c.topic || c.title || '', category: c.category },
      patterns,
      failures,
    ) / 200,
  }));
}

const BLOG_OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output');
const RECENT_POST_LIMIT = 10;
const BANNED_PATTERNS = [
  /^왜\s/,
  /보다.*더.*(중요|먼저)/i,
  /[일할될겠]까\s*$/i,
  /^성공적인 .*전략$/i,
  /^#/,
  /실행 기준으로 다시 정리/,
  /맥락에서.*다시 읽는 법/,
  /에서 막힐 때 가장 먼저 확인할 포인트/,
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
    { topic: '우선순위 회의가 길어질 때 다시 세워야 할 기준', question: '회의 시간이 늘어날수록 무엇을 먼저 버려야 할까', diff: '일정 산정이 아닌 의사결정 구조 관점' },
    { topic: '담당자 handoff에서 빠지기 쉬운 핵심 정보', question: '인수인계 문서가 있어도 왜 실행 품질이 흔들릴까', diff: '요구사항 정의가 아닌 handoff 품질 관점' },
    { topic: '고객 피드백을 기능 요청으로만 받으면 생기는 비용', question: '요청을 바로 기능화하기 전에 무엇을 다시 물어야 할까', diff: '기능 목록보다 문제 재정의 관점' },
    { topic: '범위 확장을 멈추게 하는 scope freeze 타이밍', question: '좋은 아이디어가 많은데도 언제 멈춰야 프로젝트가 산으로 가지 않을까', diff: '커뮤니케이션이 아닌 범위 통제 관점' },
    { topic: '실행 전에 리스크 리뷰를 짧게 끝내는 질문', question: '긴 위험 회의 없이도 꼭 확인해야 할 항목은 무엇일까', diff: '사전 점검이지만 일정/요구사항이 아닌 리스크 검토 관점' },
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
  { pattern: 'checklist', template: '{topicObject} 시작하기 전 먼저 볼 3가지' },
  { pattern: 'warning', template: '{topic}, 지금 바꾸지 않으면 늦는 이유' },
  { pattern: 'experience', template: '직접 해보고 깨달은 {topic}의 진짜 핵심' },
  { pattern: 'experience', template: '3개월간 {topicObject} 운영하며 배운 것들' },
  { pattern: 'checklist', template: '{topic}에서 헷갈리기 쉬운 지점 3가지' },
  { pattern: 'checklist', template: '{topicObject} 바로 적용할 때 확인할 {count}가지' },
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

function adjustCategoryWeightsBySense(baseWeights = {}, senseState = null, revenueCorrelation = null, attributionWeights = {}) {
  const next = {
    홈페이지와App: 1,
    개발기획과컨설팅: 1,
    최신IT트렌드: 1,
    IT정보와분석: 1,
    성장과성공: 1,
    도서리뷰: 1,
    ...baseWeights,
  };

  // Phase 2: Revenue-Driven 가중치 적용 (attribution 기반 상위 카테고리 부스팅)
  for (const [cat, boost] of Object.entries(attributionWeights)) {
    if (next[cat] !== undefined) next[cat] += boost;
  }

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

function isBannedTitle(title = '') {
  const text = String(title || '').trim();
  if (!text || text.length > 50) return true;
  return BANNED_PATTERNS.some((pattern) => pattern.test(text));
}

const GENERIC_STRATEGY_SEED_TERMS = new Set([
  '예약',
  '문의',
  '저장',
  '공유',
  '도서리뷰',
  '책리뷰',
  '일반포스팅',
  '일반 포스팅',
  '블로그',
  '인스타',
  '인스타그램',
  '페이스북',
  '숏폼',
  '릴스',
]);

function _knownCategoryLabels() {
  return Object.keys(CATEGORY_TOPIC_POOL);
}

function _stripCategoryPrefix(title = '') {
  return String(title || '').replace(/^\[[^\]]+\]\s*/, '').trim();
}

function _escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _categoryTokenCount(text = '', category = '') {
  if (!category) return 0;
  const pattern = new RegExp(_escapeRegExp(category), 'g');
  return (String(text || '').match(pattern) || []).length;
}

function _sanitizeStrategySeedText(raw = '', category = '') {
  const text = String(raw || '').replace(/^#/, '').trim();
  if (!text || text.length < 4) return null;
  if (GENERIC_STRATEGY_SEED_TERMS.has(text)) return null;
  if (_knownCategoryLabels().includes(text)) return null;
  if (text === category || text.includes(`${category} `) || text.includes(`${category}를`) || text.includes(`${category}을`)) return null;
  return text;
}

function isReaderFriendlyTitle(title = '', category = '') {
  const text = String(title || '').trim();
  if (isBannedTitle(text)) return false;
  const cleanTitle = _stripCategoryPrefix(text);
  if (!cleanTitle || cleanTitle.length > 60) return false;
  if (/^#/.test(cleanTitle)) return false;
  if (/\[[^\]]+\]/.test(cleanTitle)) return false;
  if (/실행 기준으로 다시 정리|맥락에서.*다시 읽는 법|에서 막힐 때 가장 먼저 확인할 포인트/.test(cleanTitle)) {
    return false;
  }

  for (const label of _knownCategoryLabels()) {
    if (!label) continue;
    if (label === category) {
      if (_categoryTokenCount(cleanTitle, label) > 0) return false;
      continue;
    }
    if (cleanTitle.includes(label)) return false;
  }
  return true;
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
  const strategy = arguments[3] || null;
  const directives = normalizeExecutionDirectives(strategy);
  const titleTone = directives.titlePolicy.tone;
  const countBase = titleTone === 'conversion' ? 3 : titleTone === 'amplify' ? 5 : 4;
  return frame
    .replace('{topic}', candidate.topic)
    .replace('{topicObject}', withObjectParticle(candidate.topic))
    .replace('{count}', String((index % 3) + countBase));
}

function _loadExperimentPlaybook() {
  if (_experimentPlaybookCached && Date.now() - _experimentPlaybookCached.loadedAt < 300_000) {
    return _experimentPlaybookCached.payload;
  }
  try {
    const payload = readExperimentPlaybook();
    _experimentPlaybookCached = {
      payload,
      loadedAt: Date.now(),
    };
    return payload;
  } catch {
    _experimentPlaybookCached = {
      payload: null,
      loadedAt: Date.now(),
    };
    return null;
  }
}

function _resolveExperimentSelectionHints(strategyPlan = null) {
  const playbook = _loadExperimentPlaybook();
  const topWinner = playbook?.topWinner || null;
  const titlePatternDimension = playbook?.dimensions?.titlePattern || null;
  const categoryDimension = playbook?.dimensions?.category || null;

  return {
    topWinner,
    winnerCategory:
      topWinner?.dimension === 'category'
        ? String(topWinner.variant || '').trim()
        : String(strategyPlan?.preferredCategory || '').trim(),
    winnerPattern:
      topWinner?.dimension === 'title_pattern'
        ? String(topWinner.variant || '').trim()
        : String(strategyPlan?.preferredTitlePattern || '').trim(),
    loserCategory:
      String(categoryDimension?.loser?.variant || strategyPlan?.suppressedCategory || '').trim(),
    loserPattern:
      String(titlePatternDimension?.loser?.variant || strategyPlan?.suppressedTitlePattern || '').trim(),
    winnerLiftPct: Number(topWinner?.liftPct || 0),
    loserCategoryLiftPct: Number(categoryDimension?.loser?.liftPct || 0),
    loserPatternLiftPct: Number(titlePatternDimension?.loser?.liftPct || 0),
  };
}

function scoreCandidate(candidate, category = '', strategyPlan = null) {
  let score = 0;
  const guide = getCategorySelectionGuide(category);
  const preferredPatterns = CATEGORY_PATTERN_PREFERENCES[category] || [];
  const directives = normalizeExecutionDirectives(strategyPlan);
  const experimentHints = _resolveExperimentSelectionHints(strategyPlan);
  const dailyMix = strategyPlan?.dailyMixPolicy && typeof strategyPlan.dailyMixPolicy === 'object'
    ? strategyPlan.dailyMixPolicy
    : {};
  const evalLearning = strategyPlan?.evalLearning && typeof strategyPlan.evalLearning === 'object'
    ? strategyPlan.evalLearning
    : {};
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
  if (experimentHints.winnerCategory && category === experimentHints.winnerCategory) {
    score += experimentHints.winnerLiftPct >= 0.15 ? 5 : 3;
  }
  if (experimentHints.loserCategory && category === experimentHints.loserCategory && experimentHints.loserCategoryLiftPct <= -0.05) {
    score -= experimentHints.loserCategoryLiftPct <= -0.15 ? 5 : 3;
  }
  if (experimentHints.winnerPattern && candidate.pattern === experimentHints.winnerPattern) {
    score += experimentHints.winnerLiftPct >= 0.15 ? 4 : 2;
  }
  if (experimentHints.loserPattern && candidate.pattern === experimentHints.loserPattern && experimentHints.loserPatternLiftPct <= -0.05) {
    score -= experimentHints.loserPatternLiftPct <= -0.15 ? 5 : 3;
  }
  if (dailyMix.primaryCategory && category === dailyMix.primaryCategory) score += 3;
  if (dailyMix.secondaryCategory && category === dailyMix.secondaryCategory) score += 1;
  if (dailyMix.suppressedCategory && category === dailyMix.suppressedCategory) score -= 4;
  if (dailyMix.titlePatternFocus && candidate.pattern === dailyMix.titlePatternFocus) score += 3;
  if (dailyMix.weakTitlePattern && candidate.pattern === dailyMix.weakTitlePattern) score -= 3;
  if (dailyMix.stabilityMode) {
    if (['checklist', 'experience'].includes(candidate.pattern)) score += 2;
    if (['warning', 'trend'].includes(candidate.pattern)) score -= 3;
  }
  if (Number(evalLearning.engagementFailureCount || 0) >= 2 && ['warning', 'trend'].includes(candidate.pattern)) {
    score -= 2;
  }
  if (Array.isArray(strategyPlan.focus) && strategyPlan.focus.some((item) => String(item || '').includes('제목 패턴'))) {
    if (candidate.pattern !== strategyPlan.suppressedTitlePattern) score += 1;
  }
  const keywordBias = Array.isArray(directives.titlePolicy.keywordBias) ? directives.titlePolicy.keywordBias : [];
  for (const keyword of keywordBias) {
    const token = String(keyword || '').trim().toLowerCase();
    if (!token) continue;
    if (String(candidate.title || '').toLowerCase().includes(token)) score += 2;
    if (String(candidate.topic || '').toLowerCase().includes(token)) score += 2;
    if (String(candidate.question || '').toLowerCase().includes(token)) score += 1;
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

function buildStrategyTopicPool(category, strategyPlan = null, marketingHints = null) {
  if (!strategyPlan) return [];
  const directives = normalizeExecutionDirectives(strategyPlan);
  const keywordBias = Array.isArray(directives.titlePolicy.keywordBias) ? directives.titlePolicy.keywordBias : [];
  const focusTags = Array.isArray(directives.hashtagPolicy.focusTags) ? directives.hashtagPolicy.focusTags : [];
  const channelPriority = directives.channelPriority || {};
  const strategySeeds = [];

  for (const keyword of keywordBias.slice(0, 4)) {
    const text = _sanitizeStrategySeedText(keyword, category);
    if (!text) continue;
    strategySeeds.push({
      topic: `${text}을 독자가 바로 이해하게 만드는 설명 방식`,
      question: `${text} 흐름을 정보성 글에서 어떻게 쉽게 풀어야 할까`,
      diff: '전략 키워드를 제목 주제가 아니라 독자 이해 장치로 반영',
    });
  }

  if (directives.creativePolicy.ctaStyle === 'conversion') {
    strategySeeds.push({
      topic: `${category}에서 예약과 문의로 이어지는 콘텐츠 설계`,
      question: `${category} 독자가 읽고 바로 행동하게 하려면 무엇이 먼저 보여야 할까`,
      diff: '조회보다 전환 중심 콘텐츠 설계',
    });
  }

  if (channelPriority.instagram === 'primary') {
    strategySeeds.push({
      topic: `${category} 핵심만 짧게 전달되는 숏폼형 정보 설계`,
      question: `${category} 주제를 짧고 강하게 전달하려면 무엇을 먼저 줄여야 할까`,
      diff: '블로그 원문보다 숏폼 확산성을 먼저 고려',
    });
  }

  if (channelPriority.facebook === 'primary' || channelPriority.facebook === 'secondary') {
    strategySeeds.push({
      topic: `${category}에서 공유와 저장을 부르는 한 줄 기준`,
      question: `${category} 글이 공유되려면 독자가 어떤 한 줄을 바로 기억해야 할까`,
      diff: '검색보다 공유와 전파 관점',
    });
  }

  for (const tag of focusTags.slice(0, 3)) {
    const text = _sanitizeStrategySeedText(tag, category);
    if (!text) continue;
    strategySeeds.push({
      topic: `${text} 흐름을 독자에게 부담 없이 연결하는 방법`,
      question: `${text} 신호를 글 안에서 과하지 않게 설명하려면 무엇을 먼저 줄여야 할까`,
      diff: '플랫폼 신호는 보조 맥락으로만 사용',
    });
  }

  if (marketingHints?.signalSummary && marketingHints.signalSummary !== '특이 마케팅 신호 없음') {
    strategySeeds.push({
      topic: `${category}에서 지금 바로 반응이 오는 신호 읽기`,
      question: `${category} 글에서 지금 독자 반응을 끌어내는 핵심 신호는 무엇일까`,
      diff: '일반론보다 현재 마케팅 신호와 연결',
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const seed of strategySeeds) {
    const key = `${seed.topic}::${seed.question}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(seed);
  }
  return deduped;
}

function pickTopicPool(category, strategyPlan = null, marketingHints = null) {
  const basePool = CATEGORY_TOPIC_POOL[category] || [
    { topic: `${category}에서 먼저 점검해야 할 기준`, question: `${category} 독자가 가장 먼저 부딪히는 문제는 무엇일까`, diff: '카테고리 독자 관점의 실전 문제 정의' },
    { topic: `${category} 실무 적용 체크리스트`, question: `${category}를 바로 실행으로 옮기려면 무엇부터 확인해야 할까`, diff: '추상적 개념보다 실전 체크리스트 중심' },
    { topic: `${category} 우선순위 재정렬`, question: `${category}에서 지금 가장 늦기 전에 바꿔야 할 것은 무엇일까`, diff: '정보 나열보다 판단 기준 정리' },
  ];
  return [
    ...basePool,
    ...buildStrategyTopicPool(category, strategyPlan, marketingHints),
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

function selectAndValidateTopic(category, recentPosts = [], strategyPlan = null, senseState = null, revenueCorrelation = null, recentTitleCorpus = null) {
  const recentTitles = Array.isArray(recentTitleCorpus) && recentTitleCorpus.length
    ? recentTitleCorpus
    : recentPosts.map((post) => post.title).filter(Boolean);
  const marketingHints = buildMarketingHints(category, senseState, revenueCorrelation);
  const topicPool = pickTopicPool(category, strategyPlan, marketingHints);

  const candidates = [];
  for (let i = 0; i < topicPool.length; i += 1) {
    for (let j = 0; j < TITLE_FRAMES.length; j += 1) {
      const frame = TITLE_FRAMES[j];
      const title = buildTitle(frame.template, topicPool[i], j, strategyPlan);
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
      if (!isReaderFriendlyTitle(candidate.title, category)) return false;
      if (
        strategyPlan?.hardSuppressTitlePattern &&
        strategyPlan?.suppressedTitlePattern &&
        candidate.pattern === strategyPlan.suppressedTitlePattern
      ) {
        return false;
      }
      return !isTooCloseToRecentTitle(candidate, recentTitles);
    });

  if (selected) {
    return enrichTopicSelection({
      ...selected,
      recentTitleCount: recentTitles.length,
      forced: false,
    }, category, recentTitles);
  }

  const fallback = topicPool.find((item) => isReaderFriendlyTitle(`${item.topic}을 시작하기 전 먼저 볼 3가지`, category))
    || { topic: `${category} 실전 가이드`, question: `${category}에서 무엇을 먼저 살펴봐야 할까`, diff: '강제 기본 주제' };
  return enrichTopicSelection({
    title: `${fallback.topic}을 시작하기 전 먼저 볼 3가지`,
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

/**
 * topic_planner.ts가 사전 선정한 단일 최우선 주제 조회.
 * blog.topic_queue에서 scheduled_date + status='pending' 조회.
 * 있으면 바로 반환, 없으면 null 반환 → 호출자가 topic_candidates → 풀 폴백.
 *
 * @param {string} targetDate - 'YYYY-MM-DD'
 * @param {string} [category]  - 카테고리 필터 (있으면 일치 확인)
 * @returns {Promise<object|null>}
 */
async function selectPrePlannedTopic(targetDate, category = null) {
  try {
    const whereCategory = category ? `AND category = $2` : '';
    const params = category ? [targetDate, category] : [targetDate];
    const sql = `
      SELECT id, category, title, question, diff, reader_problem, opening_angle, closing_angle,
             quality_score, trend_source
      FROM blog.topic_queue
      WHERE scheduled_date = $1
        AND status = 'pending'
        ${whereCategory}
      ORDER BY quality_score DESC
      LIMIT 1
    `;
    const result = await queryOpsDb(sql, 'blog', params);
    if (!result || !result.rows || result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      category: row.category,
      title: row.title,
      topic: row.title,
      question: row.question || '',
      diff: row.diff || '',
      readerProblem: row.reader_problem || '',
      openingAngle: row.opening_angle || '',
      closingAngle: row.closing_angle || '',
      quality_score: row.quality_score || 0,
      source: 'topic_queue',
    };
  } catch {
    return null;
  }
}

/**
 * D-1 큐레이션 DB에서 날짜별 후보 조회.
 * topic_curator.ex가 미리 저장한 blog.topic_candidates를 우선 사용.
 * 없으면 null 반환 → 호출자가 기존 풀 폴백 처리.
 *
 * @param {string} targetDate - 'YYYY-MM-DD'
 * @param {string} [category]  - 카테고리 필터 (생략 시 전체)
 * @returns {Promise<Array|null>}
 */
async function queryDailyCandidates(targetDate, category = null) {
  try {
    const whereCategory = category ? `AND category = $2` : '';
    const params = category ? [targetDate, category] : [targetDate];
    const sql = `
      SELECT id, category, title, question, diff, keywords, score
      FROM blog.topic_candidates
      WHERE target_date = $1
        AND status = 'pending'
        ${whereCategory}
      ORDER BY score DESC, id ASC
    `;
    const result = await queryOpsDb(sql, 'blog', params);
    if (!result || !result.rows || result.rows.length === 0) return null;
    return result.rows.map(row => ({
      id: row.id,
      category: row.category,
      title: row.title,
      question: row.question || '',
      diff: row.diff || '',
      keywords: row.keywords || [],
      score: row.score || 0.5,
      source: 'db_curated',
    }));
  } catch {
    return null;
  }
}

async function getRecentPublishedTitles(targetDate, days = 45, limit = 40) {
  try {
    const result = await queryOpsDb(
      `SELECT title
       FROM blog.posts
       WHERE DATE(publish_date) <= $1::date
         AND DATE(publish_date) >= ($1::date - ($2::text || ' days')::interval)
         AND COALESCE(status, '') NOT IN ('failed', 'error', 'archived')
       ORDER BY publish_date DESC, id DESC
       LIMIT $3`,
      'blog',
      [targetDate, String(days), Number(limit)]
    );
    return (result?.rows || []).map((row) => String(row?.title || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 카테고리별 주제 선택 — D-1 후보 우선, 없으면 기존 풀 폴백.
 *
 * @param {string} category
 * @param {string} targetDate - 'YYYY-MM-DD'
 * @param {Array}  recentPosts
 * @param {object} strategyPlan
 * @param {object} senseState
 * @param {object} revenueCorrelation
 */
async function selectTopicWithCandidateFallback(category, targetDate, recentPosts = [], strategyPlan = null, senseState = null, revenueCorrelation = null) {
  const recentTitles = mergeRecentTitles(
    recentPosts.map(post => post.title).filter(Boolean),
    await getRecentPublishedTitles(targetDate)
  );
  const marketingHints = buildMarketingHints(category, senseState, revenueCorrelation);

  // 1순위: topic_queue (topic-planner.ts가 21:00 KST에 사전 선정한 최우선 주제)
  const prePlanned = await selectPrePlannedTopic(targetDate, category);
  if (prePlanned && isReaderFriendlyTitle(prePlanned.title, category)) {
    if (!isTooCloseToRecentTitle(prePlanned, recentTitles)) {
      return enrichTopicSelection({
        ...prePlanned,
        pattern: 'pre_planned',
        marketingSignalSummary: marketingHints.signalSummary,
        marketingRecommendations: marketingHints.recommendations,
        marketingCtaHint: marketingHints.ctaHint,
        marketingWeight: marketingHints.categoryWeight,
        recentTitleCount: recentTitles.length,
        forced: false,
      }, category, recentTitles);
    }
  }

  // 2순위: topic_candidates (topic_curator.ex가 22:00 KST에 저장한 후보 목록)
  let dbCandidates = await queryDailyCandidates(targetDate, category);

  // DPO 힌트 적용 (Kill Switch: BLOG_DPO_ENABLED=true)
  if (dbCandidates && dbCandidates.length > 0) {
    const { patterns, failures } = await _loadDpoHints();
    dbCandidates = _applyDpoScore(dbCandidates, patterns, failures)
      .sort((a, b) => b.score - a.score);
  }

  if (dbCandidates && dbCandidates.length > 0) {
    // 중복 제목 필터링 후 최고 점수 선택
    const selected = dbCandidates.find(c => {
      if (!isReaderFriendlyTitle(c.title, category)) return false;
      if (isTooCloseToRecentTitle(c, recentTitles)) return false;
      return true;
    });

    if (selected) {
      return enrichTopicSelection({
        ...selected,
        topic: selected.title,
        pattern: 'db_curated',
        marketingSignalSummary: marketingHints.signalSummary,
        marketingRecommendations: marketingHints.recommendations,
        marketingCtaHint: marketingHints.ctaHint,
        marketingWeight: marketingHints.categoryWeight,
        recentTitleCount: recentTitles.length,
        forced: false,
      }, category, recentTitles);
    }
  }

  // 폴백: 기존 풀 기반 선택
  return selectAndValidateTopic(category, recentPosts, strategyPlan, senseState, revenueCorrelation, recentTitles);
}

// ─── 루나 투자 앵글 합성 템플릿 ──────────────────────────────────────────

const LUNA_ANGLE_TEMPLATES = {
  '자기계발': {
    bear:     { topic: '하락장에서 흔들리지 않는 투자 마인드 루틴',    question: '시장이 내려갈 때 심리적으로 버티는 방법은 무엇일까', diff: '재테크 기술보다 감정 관리 관점' },
    volatile: { topic: '변동성 장세에서 집중력을 지키는 일상 루틴',    question: '시장 불안이 일상에 침투할 때 어떻게 루틴을 유지할까', diff: '투자 전략보다 일상 루틴 관점' },
    bull:     { topic: '상승장 기회 앞에서 흔들리지 않는 의사결정법',  question: '좋은 기회가 왔을 때 왜 자꾸 망설이게 될까', diff: '낙관주의보다 실행 기준 관점' },
    crisis:   { topic: '위기 상황에서도 무너지지 않는 멘탈 관리 루틴', question: '예상치 못한 충격이 왔을 때 어떻게 빠르게 회복할까', diff: '위기 대응보다 회복력 설계 관점' },
  },
  '최신IT트렌드': {
    bear:     { topic: 'AI 트레이딩 시스템이 하락장에서 배운 것',       question: '자동화 시스템은 하락장에서 어떻게 반응하는가', diff: '트레이딩 기법보다 AI 시스템 설계 관점' },
    volatile: { topic: '변동성 장세에서 AI 자동매매가 보여주는 패턴',  question: '시장 불안정성이 AI 모델의 예측력에 어떤 영향을 줄까', diff: 'AI 정확성보다 불확실성 처리 방식' },
    bull:     { topic: '상승장에서 AI 투자 보조 도구의 진짜 한계',      question: '좋은 장세에서도 알고리즘이 틀릴 수 있는 이유는', diff: '성능 자랑보다 한계 인식 관점' },
    crisis:   { topic: '시장 위기 때 AI 알림 시스템이 실제로 유용한가', question: 'AI가 위기를 먼저 감지하려면 어떤 데이터가 필요할까', diff: '기술 소개보다 실용성 판단 관점' },
  },
  '개발기획과컨설팅': {
    bear:     { topic: '시장 하락 시 서비스 운영 계획 재수립하는 법',   question: '비용 절감이 필요할 때 어떤 기능부터 줄여야 할까', diff: '위기 대응보다 우선순위 재정렬 관점' },
    volatile: { topic: '불확실한 시장에서 프로덕트 로드맵 유지하는 법', question: '시장이 자주 바뀔 때 기획 문서를 어떻게 관리해야 할까', diff: '완벽한 계획보다 빠른 재조정 구조' },
    bull:     { topic: '성장 국면에서 개발 우선순위를 다시 세우는 법',  question: '기회가 많을 때 왜 더 선택이 어려워질까', diff: '기능 추가보다 집중 범위 정리' },
    crisis:   { topic: '위기 때 최소 운영 체계로 서비스를 유지하는 법', question: '인프라가 흔들릴 때 어떤 것을 끝까지 살려야 할까', diff: '복구 계획보다 생존 우선순위 관점' },
  },
  '홈페이지와App': {
    bear:     { topic: '수익 전환이 잘 되는 투자 대시보드 UX',          question: '투자 정보를 보여줄 때 어떤 화면 구성이 신뢰를 만들까', diff: '데이터 표시보다 의사결정 지원 UX' },
    volatile: { topic: '실시간 데이터 표시 화면에서 불안감 줄이는 법',  question: '숫자가 자주 바뀔 때 사용자에게 어떻게 안정감을 줄까', diff: '정보 밀도보다 감정 반응 관점' },
    bull:     { topic: '성과 지표 대시보드가 오히려 판단을 흐리는 이유', question: '좋은 숫자가 가득할 때 왜 오히려 결정이 늦어질까', diff: '데이터 시각화보다 인지 부하 관점' },
    crisis:   { topic: '위기 상황 앱 UX — 사용자를 어떻게 붙잡을까',   question: '서비스가 흔들릴 때 사용자 신뢰를 지키는 화면 요소는', diff: '기능 추가보다 위기 커뮤니케이션 UX' },
  },
  'IT정보와분석': {
    bear:     { topic: '코인 하락장에서 시장 분석가들이 놓치는 신호',   question: '하락 국면에서 어떤 지표가 실제 바닥을 알려줄까', diff: '뉴스 나열보다 판단 기준 정리' },
    volatile: { topic: '가상화폐 변동성 지표를 제대로 읽는 법',          question: '공포-탐욕 지수 외에 어떤 신호를 봐야 할까', diff: '숫자 소개보다 해석 기준 중심' },
    bull:     { topic: '상승장 과열 신호를 먼저 읽는 법',                question: '모두가 낙관적일 때 어떤 지표가 경고를 보낼까', diff: '호황 분석보다 리스크 인식 관점' },
    crisis:   { topic: '시장 위기 신호 — 뉴스보다 데이터가 먼저 말한다', question: '패닉 이전에 어떤 데이터 패턴이 나타나는가', diff: '사후 분석보다 선행 지표 관점' },
  },
  '성장과성공': {
    bear:     { topic: '하락장에서도 흔들리지 않는 재테크 마인드셋',    question: '손실이 반복될 때 어떻게 판단 기준을 유지할까', diff: '투자 기술보다 심리 회복력 관점' },
    volatile: { topic: '불확실성 속에서도 기준을 지키는 원칙 설계법',   question: '상황이 자주 바뀔 때 나만의 원칙을 어떻게 세울까', diff: '성공 공식보다 원칙 수립 과정' },
    bull:     { topic: '상승장 심리가 판단력을 망치는 이유',             question: '수익이 날수록 왜 욕심이 커지고 실수가 늘어날까', diff: '전략 소개보다 행동 심리학 관점' },
    crisis:   { topic: '위기를 성장 기회로 바꾼 사람들의 공통점',        question: '모두가 멈출 때 오히려 앞으로 나아갈 수 있는 조건은', diff: '위기 회고보다 전환점 심리 관점' },
  },
};

/**
 * 루나 요청 + 오늘 카테고리를 합성해 하이브리드 주제를 만든다.
 * 동기 함수 — DB 호출 없음. 품질 게이트 통과 실패 시 null 반환.
 */
function synthesizeHybridTopic(category, lunaRequest, recentPosts = [], strategyPlan = null) {
  if (!lunaRequest) return null;
  const templates = LUNA_ANGLE_TEMPLATES[category];
  if (!templates) return null;

  const rawRegime = String(lunaRequest?.regime || 'volatile');
  const regime = Object.prototype.hasOwnProperty.call(templates, rawRegime) ? rawRegime : 'volatile';
  const template = templates[regime];
  if (!template) return null;

  const recentTitles = recentPosts.map(p => p.title).filter(Boolean);

  const preferredPatterns = CATEGORY_PATTERN_PREFERENCES[category] || [];
  const preferredFrame = TITLE_FRAMES.find(f => preferredPatterns.includes(f.pattern)) || TITLE_FRAMES[0];
  const title = buildTitle(preferredFrame.template, template, 0);

  if (isBannedTitle(title)) return null;
  if (isTooCloseToRecentTitle({ title, topic: template.topic, question: template.question, diff: template.diff }, recentTitles)) return null;

  const guide = getCategorySelectionGuide(category);
  return enrichTopicSelection({
    title,
    topic: template.topic,
    question: template.question,
    diff: template.diff,
    pattern: preferredFrame.pattern,
    source: 'luna_hybrid',
    lunaRequestId: lunaRequest?.id || null,
    lunaRegime: rawRegime,
    recentTitleCount: recentTitles.length,
    forced: false,
    marketingSignalSummary: `루나 시장 이벤트: ${lunaRequest?.regime || 'volatile'} (${lunaRequest?.mood || ''})`,
    marketingRecommendations: [
      '투자/금융 맥락을 자연스럽게 카테고리 내에 녹여 독자 공감을 유도',
      ...(guide.keyQuestions?.slice(0, 1) || []),
    ],
    marketingCtaHint: '',
    marketingWeight: 1,
  }, category, recentTitles);
}

/**
 * DB에서 pending 루나 콘텐츠 요청 1건 조회 (urgency DESC, requested_at ASC).
 * 24시간 내 만료되지 않은 요청만 대상.
 */
async function getPendingLunaRequest() {
  try {
    const result = await queryOpsDb(`
      SELECT id, regime, mood, angle_hint, keyword_hints, urgency, requested_at, metadata
      FROM blog.content_requests
      WHERE status = 'pending'
        AND expires_at > NOW()
        AND source_team = 'luna'
      ORDER BY urgency DESC, requested_at ASC
      LIMIT 1
    `, 'blog', []);
    if (!result?.rows?.length) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      regime: row.regime || 'volatile',
      mood: row.mood || '',
      angleHint: row.angle_hint || '',
      keywordHints: row.keyword_hints || '',
      urgency: row.urgency || 5,
      requestedAt: row.requested_at,
      metadata: row.metadata || {},
    };
  } catch {
    return null;
  }
}

/**
 * Revenue-Driven 카테고리 가중치 조회 (Phase 2)
 * blog.category_revenue_performance 기반으로 상위 카테고리 부스팅
 * Kill Switch: BLOG_REVENUE_CORRELATION_ENABLED=true 일 때만 반환값 있음
 */
async function fetchRevenueAttributionWeights() {
  if (process.env.BLOG_REVENUE_CORRELATION_ENABLED !== 'true') return {};
  try {
    const bridge = require('./ska-revenue-bridge');
    const topCategories = await bridge.getTopRevenueCategories(30);
    if (!topCategories || topCategories.length === 0) return {};

    const weights = {};
    // 1위: +2, 2위: +1.5, 3위+: +1 부스팅
    topCategories.forEach((cat, idx) => {
      if (!cat.category || Number(cat.avg_uplift_krw || 0) <= 0) return;
      weights[cat.category] = idx === 0 ? 2 : idx === 1 ? 1.5 : 1;
    });
    return weights;
  } catch {
    return {};
  }
}

/**
 * DPO 학습 기반 주제 선택 힌트 조회 (Phase 6)
 * blog.dpo_preference_pairs + blog.success_pattern_library 기반
 * Kill Switch: BLOG_DPO_ENABLED=true 일 때만 반환값 있음
 *
 * @returns { categoryBoosts: {카테고리: 가중치}, bestHookByCategory: {카테고리: hook_style} }
 */
async function fetchDpoHints() {
  if (process.env.BLOG_DPO_ENABLED !== 'true') return { categoryBoosts: {}, bestHookByCategory: {} };
  try {
    const dpo = require('./self-rewarding/marketing-dpo');
    const [successPatterns, failureTaxonomy] = await Promise.all([
      dpo.fetchSuccessPatterns(20),
      dpo.fetchFailureTaxonomy(10),
    ]);

    // 성공 패턴에서 카테고리별 가중치 추출
    const categoryBoosts = {};
    for (const pattern of successPatterns) {
      if (pattern.pattern_type === 'hook' && pattern.avg_performance > 60) {
        // 성과 높은 후킹 패턴이 많이 사용된 카테고리 부스팅 (추후 category 컬럼 추가 시 확장)
      }
    }

    // 카테고리별 최고 후킹 스타일 조회
    const bestHookByCategory = {};
    const categories = ['홈페이지와App', '최신IT트렌드', '개발기획과컨설팅', '자기계발', 'IT정보와분석'];
    await Promise.all(
      categories.map(async (cat) => {
        const hook = await dpo.getBestHookStyleByCategory(cat);
        if (hook) bestHookByCategory[cat] = hook;
      })
    );

    return { categoryBoosts, bestHookByCategory, successPatterns, failureTaxonomy };
  } catch {
    return { categoryBoosts: {}, bestHookByCategory: {} };
  }
}

module.exports = {
  getRecentPosts,
  getCategorySelectionGuide,
  adjustCategoryWeightsBySense,
  buildMarketingHints,
  isReaderFriendlyTitle,
  selectAndValidateTopic,
  selectTopicWithCandidateFallback,
  selectPrePlannedTopic,
  queryDailyCandidates,
  similarity,
  synthesizeHybridTopic,
  getPendingLunaRequest,
  fetchRevenueAttributionWeights,
  fetchDpoHints,
};
