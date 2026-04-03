'use strict';
const fs = require('fs');
const path = require('path');
const kst = require('../../../packages/core/lib/kst');

/**
 * gems-writer.js (젬스 GEMS) — 일반 포스팅 작성
 *
 * IT 전략 컨설턴트 페르소나
 * 필수 6,000자 이상 (목표 6,500~7,000자)
 * 모델: GPT-4o (OpenAI) 또는 Gemini Flash (분할생성)
 */

const toolLogger          = require('../../../packages/core/lib/tool-logger');
const llmCache            = require('../../../packages/core/lib/llm-cache');
const { getTraceId }      = require('../../../packages/core/lib/trace');
const { chunkedGenerate } = require('../../../packages/core/lib/chunked-llm');
const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector');
const { getBlogGenerationRuntimeConfig, getBlogLLMSelectorOverrides } = require('./runtime-config');

const generationRuntimeConfig = getBlogGenerationRuntimeConfig();
const BLOG_WRITER_TIMEOUT_MS = Number(generationRuntimeConfig.writerTimeoutMs || 90000);
const BLOG_CONTINUE_TIMEOUT_MS = Number(generationRuntimeConfig.continueTimeoutMs || BLOG_WRITER_TIMEOUT_MS);
const BLOG_CHUNK_TIMEOUT_MS = Number(generationRuntimeConfig.chunkTimeoutMs || Math.max(BLOG_WRITER_TIMEOUT_MS, 120000));

function loadPersonaGuide(filename) {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'context', filename), 'utf8').trim();
  } catch {
    return '';
  }
}

// 폴백 체인: gpt-4o → gpt-4o-mini → gemini-2.5-flash
const GEMS_LLM_CHAIN = selectLLMChain('blog.gems.writer', {
  policyOverride: getBlogLLMSelectorOverrides()['blog.gems.writer'],
});

// ─── ai-agent-system 프로젝트 컨텍스트 ──────────────────────────────

const AI_AGENT_CONTEXT = `
[마스터의 실제 프로젝트: ai-agent-system]
재룡 님(승호아빠)이 직접 개발·운영 중인 멀티에이전트 AI 봇 시스템.
5개 팀, 30+ 봇 — 스카(스터디카페 관리), 루나(자동매매), 클로드(시스템감시), 블로(블로그), 워커(SaaS)

카테고리 연결 문구는 "가능한 참고 예시"일 뿐이며, 최근 발행 글과 주제 축이 겹치면 사용하지 마라.
같은 원천 경험(AI 에이전트 운영, 멀티에이전트 설계, 자동매매 운영 경험)을 여러 카테고리에서 반복 재포장하지 말고,
카테고리별로 완전히 다른 문제의식과 독자 효용을 세워라.

샌드위치 화법의 "일상 에피소드" 부분에서 1~2회 자연스럽게 언급하라.
`.trim();

// ─── IT 카테고리 뉴스 분석 섹션 적용 대상 ────────────────────────────

const IT_NEWS_CATEGORIES = ['최신IT트렌드', 'IT정보와분석', '개발기획과컨설팅'];
const BLOG_OUTPUT_DIR = path.join(__dirname, '..', 'output');
const RECENT_GENERAL_THEME_WINDOW_DAYS = 14;
const RECENT_GENERAL_THEME_LIMIT = 12;
const THEME_SIGNAL_MAP = [
  { label: 'AI 시대 프레임', patterns: [/AI 시대/gi] },
  { label: '멀티에이전트 운영 프레임', patterns: [/멀티에이전트/gi, /멀티 에이전트/gi] },
  { label: 'AI 에이전트 운영 인사이트', patterns: [/AI 에이전트/gi, /30개 .*에이전트/gi, /30개 AI 에이전트/gi] },
  { label: '성장/자기계발 전략', patterns: [/성장 전략/gi, /성장의 법칙/gi, /자기계발/gi] },
  { label: '운영/개발 전략', patterns: [/운영 전략/gi, /개발 전략/gi, /설계 경험/gi] },
  { label: '시장/투자 인사이트', patterns: [/시장 인사이트/gi, /전략적 투자/gi] },
];
const TITLE_FORBIDDEN_PHRASES = [
  'AI 시대',
  '멀티에이전트',
  '멀티 에이전트',
  'AI 에이전트',
  '30개 에이전트',
  '30개 AI 에이전트',
  '성장 전략',
  '성장의 법칙',
  '운영 전략',
  '시장 인사이트',
];

// ─── GEO 최적화 규칙 ─────────────────────────────────────────────────

const GEO_RULES = `
[GEO(Generative Engine Optimization) 규칙]
1. [이 글에서 배울 수 있는 것] 목차를 서론 직후 배치 (AI가 글 구조 즉시 파악)
2. 각 섹션 시작에 한줄 요약 기재 (AI가 섹션별 핵심 추출 가능)
3. 해시태그에 질문형 키워드 추가 (#AI시대자기계발방법 #스터디카페추천이유)
4. 결론에 "핵심 메시지 한줄" 명확히 (AI가 이 글의 결론을 한 문장으로 인용 가능)
`.trim();

// ─── 날씨 → 글 맥락 변환 ─────────────────────────────────────────────

function _weatherToContext(weather) {
  const desc = weather.description || '맑음';
  const temp = weather.temperature != null ? `${weather.temperature}°C` : '';

  if (/비|rain/i.test(desc))   return `봄비가 내리는 ${temp}의 오늘`;
  if (/눈|snow/i.test(desc))   return `눈 내리는 겨울 ${temp}의 아침`;
  if (/흐림|cloud/i.test(desc)) return `흐린 ${temp}의 오늘`;
  if (weather.temperature < 10) return `쌀쌀한 ${temp}의 오늘`;
  if (weather.temperature > 28) return `무더운 ${temp}의 오늘`;
  return `쾌청한 ${desc} ${temp}의 오늘`;
}

function _estimateCost(usage) {
  if (!usage) return 0;
  return ((usage.prompt_tokens || 0) * 2.5 + (usage.completion_tokens || 0) * 10) / 1_000_000;
}

function _safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function _parseRecentGeneralPostMeta(filename) {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})_general_([^ ]+)\s+(.+)\.html$/);
  if (!match) return null;

  const [, dateString, category, title] = match;
  const publishedAt = new Date(`${dateString}T00:00:00+09:00`);
  if (Number.isNaN(publishedAt.getTime())) return null;

  return {
    filename,
    dateString,
    category,
    title: title.trim(),
    publishedAt,
  };
}

function _loadRecentGeneralThemes(category, days = RECENT_GENERAL_THEME_WINDOW_DAYS) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const recentPosts = _safeReadDir(BLOG_OUTPUT_DIR)
    .map(_parseRecentGeneralPostMeta)
    .filter(Boolean)
    .filter(post => post.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, RECENT_GENERAL_THEME_LIMIT);

  const detectedThemeLabels = new Set();
  const blockedPhrases = new Set();

  for (const post of recentPosts) {
    for (const signal of THEME_SIGNAL_MAP) {
      if (signal.patterns.some(pattern => pattern.test(post.title))) {
        detectedThemeLabels.add(signal.label);
      }
    }

    for (const phrase of TITLE_FORBIDDEN_PHRASES) {
      if (post.title.includes(phrase)) {
        blockedPhrases.add(phrase);
      }
    }
  }

  return {
    recentPosts,
    detectedThemeLabels: Array.from(detectedThemeLabels),
    blockedPhrases: Array.from(blockedPhrases),
  };
}

function _buildRecentThemeDedupeBlock(category) {
  const themeContext = _loadRecentGeneralThemes(category);
  if (!themeContext.recentPosts.length) return '';

  const recentTitleLines = themeContext.recentPosts
    .map((post, index) => `${index + 1}. [${post.dateString}][${post.category}] ${post.title}`)
    .join('\n');

  const blockedThemeLines = themeContext.detectedThemeLabels.length
    ? themeContext.detectedThemeLabels.map((label, index) => `${index + 1}. ${label}`).join('\n')
    : '1. 최근 상위 서사와 겹치는 AI 운영 경험 반복';

  const blockedPhraseLines = themeContext.blockedPhrases.length
    ? themeContext.blockedPhrases.map((phrase, index) => `${index + 1}. ${phrase}`).join('\n')
    : '1. 최근 제목 핵심 표현 반복 금지';

  return `
[최근 발행 일반 글 — 주제 중복 금지]
아래 글들과 같은 상위 서사, 같은 문제의식, 같은 제목 프레임을 반복하지 마라.
특히 "같은 운영 경험을 카테고리만 바꿔 재포장"하는 방식은 금지한다.

최근 발행 글:
${recentTitleLines}

이번 글에서 피해야 할 상위 주제 축:
${blockedThemeLines}

이번 글 제목/소제목에서 피해야 할 표현:
${blockedPhraseLines}

[중복 방지 규칙 — 반드시 준수]
1. 위 최근 글과 다른 질문에서 출발하라.
2. 같은 시스템 경험을 쓰더라도 전혀 다른 문제 정의, 다른 독자 효용, 다른 실전 상황으로 전개하라.
3. 제목 첫 문장에 위 금지 표현을 재사용하지 말 것.
4. "AI 시대 / 멀티에이전트 / 30개 AI 에이전트 / 성장 전략 / 운영 전략 / 시장 인사이트" 프레임을 기본 주제로 삼지 말 것.
5. 이번 글은 카테고리(${category}) 자체의 독자 고민을 먼저 세우고, AI 운영 경험은 필요할 때 보조 사례로만 제한적으로 사용하라.
`.trim();
}

function _defaultGeneralSnippet(title, category) {
  return [
    '[AI 스니펫 요약]',
    `${category} 관점에서 "${title || '이번 주제'}"를 실전적으로 풀어낸 글이다. 핵심 개념을 정리하고, 바로 적용할 수 있는 판단 기준과 실행 포인트를 함께 제시한다. 바쁜 일정 속에서도 무엇부터 우선순위를 잡아야 하는지 빠르게 이해할 수 있도록 정리했다.`,
  ].join('\n');
}

function _defaultCafeSection(weatherContext) {
  return [
    '[스터디카페 홍보 섹션]',
    `${weatherContext}처럼 집중력이 쉽게 흔들리는 날에는 작업 공간의 질이 생각보다 큰 차이를 만든다. 커피랑도서관 분당서현점은 조용한 좌석 환경과 안정적인 작업 동선을 갖춰서 글쓰기, 기획, 개발 문서 정리 같은 깊은 집중 작업을 이어가기 좋다. 특히 장시간 앉아 있어도 답답하지 않도록 세스코 에어 시스템으로 공기 질을 관리하고 있어, 머리가 무거워지기 쉬운 오후 시간대에도 작업 리듬을 비교적 안정적으로 유지할 수 있다. 실제로 복잡한 기획서를 다듬거나 긴 글을 마무리해야 할 때는 주변 소음보다도 ‘얼마나 바로 다시 몰입할 수 있는가’가 중요한데, 이런 점에서 커피랑도서관은 공부뿐 아니라 실무 작업 공간으로도 충분히 설득력이 있다.`,
  ].join('\n');
}

function _defaultChecklistSection(category) {
  return [
    '[실전 적용 체크리스트]',
    `${category} 주제를 읽고 끝내지 않으려면 바로 적용 가능한 체크리스트가 필요하다. 먼저 오늘 글에서 배운 핵심 개념을 한 문장으로 다시 적어 보고, 지금 하고 있는 일에 그대로 붙일 수 있는지 판단해야 한다. 다음으로는 이번 주 안에 시도할 수 있는 행동을 세 가지로 쪼개는 것이 좋다. 너무 큰 계획보다 바로 실행 가능한 작은 단위가 실제 변화를 만든다. 마지막으로 실행 후 무엇이 달라졌는지 기록해야 한다. 기록이 남아야 다음 판단의 기준이 생기고, 같은 시행착오를 줄일 수 있다. 결국 좋은 인사이트는 많이 읽는 것보다, 실행하고 돌아보는 루프를 만드는 데서 진짜 가치가 생긴다.`,
  ].join('\n');
}

function _defaultLinkingSection(relatedPosts = []) {
  const picks = relatedPosts.slice(0, 3);
  if (!picks.length) return '';
  return [
    '[함께 읽으면 좋은 글]',
    ...picks.map((post) => `→ [${post.title}] ← 여기에 링크 삽입`),
  ].join('\n');
}

function _defaultHashtags(category) {
  return [
    '[해시태그]',
    `#${category.replace(/\s+/g, '')} #실전인사이트 #업무생산성 #문제해결 #기획력 #실행전략 #집중력 #학습루틴 #커피랑도서관 #분당서현 #스터디카페 #작업공간 #몰입환경 #세스코에어 #실무팁 #성장기록 #인사이트정리 #실행체크리스트 #하루루틴 #지식정리 #콘텐츠기획 #실전적용 #생산성향상 #집중습관 #업무루틴 #질문형학습 #꾸준한성장`,
  ].join('\n');
}

function _ensureGeneralQualityFloor(content, { category, weatherContext, relatedPosts, minChars }) {
  let next = String(content || '').trim();
  if (!next) return next;

  const lines = next.split('\n');
  const titleLine = lines.find((line) => line.trim().length > 0) || `[${category}]`;

  if (!next.includes('AI 스니펫 요약')) {
    next = [titleLine, _defaultGeneralSnippet(titleLine.replace(/^\[[^\]]+\]\s*/, ''), category), next.slice(titleLine.length).trim()].filter(Boolean).join('\n\n');
  }

  if (!next.includes('커피랑도서관') && !next.includes('분당서현')) {
    next = `${next}\n\n${_defaultCafeSection(weatherContext)}`;
  }

  if (!next.includes('함께 읽으면 좋은 글')) {
    const linking = _defaultLinkingSection(relatedPosts);
    if (linking) next = `${next}\n\n${linking}`;
  }

  const hashtagCount = (next.match(/#[^\s#\n]+/g) || []).length;
  if (hashtagCount < 15) {
    next = `${next}\n\n${_defaultHashtags(category)}`;
  }

  if (next.length < minChars) {
    next = `${next}\n\n${_defaultChecklistSection(category)}`;
  }

  return next.trim();
}

const GENERAL_SECTION_MARKERS = [
  'AI 스니펫 요약',
  '이 글에서 배울 수 있는 것',
  '승호아빠 인사말',
  '본론 섹션 1',
  '본론 섹션 2',
  '본론 섹션 3',
  '이번 주 IT 뉴스 분석',
  '스터디카페 홍보 섹션',
  '마무리 제언',
  '함께 읽으면 좋은 글',
  '해시태그',
];

const GENERAL_SECTION_TARGETS = {
  'AI 스니펫 요약': 120,
  '이 글에서 배울 수 있는 것': 120,
  '승호아빠 인사말': 280,
  '본론 섹션 1': 1400,
  '본론 섹션 2': 1400,
  '본론 섹션 3': 1400,
  '이번 주 IT 뉴스 분석': 450,
  '스터디카페 홍보 섹션': 520,
  '마무리 제언': 320,
  '함께 읽으면 좋은 글': 120,
  '해시태그': 80,
};

function _findMarkerIndex(text, marker) {
  if (!text) return -1;
  const candidates = [
    `[${marker}]`,
    marker,
  ];
  let found = -1;
  for (const candidate of candidates) {
    const idx = text.indexOf(candidate);
    if (idx === -1) continue;
    if (found === -1 || idx < found) found = idx;
  }
  return found;
}

function _getDetectedMarkers(text) {
  return GENERAL_SECTION_MARKERS
    .map(marker => ({ marker, index: _findMarkerIndex(text, marker) }))
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index);
}

function _getMissingMarkers(text) {
  const detected = new Set(_getDetectedMarkers(text).map(item => item.marker));
  return GENERAL_SECTION_MARKERS.filter(marker => !detected.has(marker));
}

function _extractSectionBodies(text) {
  const detected = _getDetectedMarkers(text);
  if (!detected.length) return {};

  const sections = {};
  for (let i = 0; i < detected.length; i += 1) {
    const current = detected[i];
    const next = detected[i + 1];
    const start = current.index;
    const end = next ? next.index : text.length;
    sections[current.marker] = text.slice(start, end).trim();
  }
  return sections;
}

function _getShortSections(text, category) {
  const sections = _extractSectionBodies(text);
  const targets = Object.entries(GENERAL_SECTION_TARGETS)
    .filter(([marker]) => category !== '도서리뷰' || marker !== '이번 주 IT 뉴스 분석')
    .filter(([marker]) => IT_NEWS_CATEGORIES.includes(category) || marker !== '이번 주 IT 뉴스 분석');

  return targets
    .map(([marker, minChars]) => {
      const body = sections[marker] || '';
      return {
        marker,
        currentChars: body.length,
        minChars,
        missing: !body,
      };
    })
    .filter(section => section.missing || section.currentChars < section.minChars);
}

async function _runGeneralPostRepairPasses(category, researchData, content, sectionVariation, usedModel, fallbackUsed, minCharsGeneral) {
  let repairedContent = String(content || '').trim();
  let nextUsedModel = usedModel;
  let nextFallbackUsed = fallbackUsed;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const missingMarkers = _getMissingMarkers(repairedContent);
    const shortSections = _getShortSections(repairedContent, category);
    const needsRepair = repairedContent.length < minCharsGeneral || missingMarkers.length > 0 || shortSections.length > 0;

    if (!needsRepair) break;

    const issues = [];
    if (repairedContent.length < minCharsGeneral) {
      issues.push({
        severity: 'warn',
        msg: `현재 글자수 ${repairedContent.length}자로 최소 기준 ${minCharsGeneral}자에 미달함. 부족한 섹션을 확장해 ${minCharsGeneral}자 이상으로 보강할 것.`,
      });
    }
    if (missingMarkers.length > 0) {
      issues.push({
        severity: 'warn',
        msg: `누락된 섹션: ${missingMarkers.join(', ')}. 빠진 섹션을 추가하고 기존 구조를 유지할 것.`,
      });
    }
    if (shortSections.length > 0) {
      issues.push({
        severity: 'warn',
        msg: `부족한 섹션 길이: ${shortSections.map(section => `${section.marker}(${section.currentChars}/${section.minChars}자)`).join(', ')}. 부족한 섹션만 우선 확장하고 다른 섹션은 줄이지 말 것.`,
      });
    }
    if (attempt === 2) {
      issues.push({
        severity: 'warn',
        msg: '2차 보정 단계다. 이미 충분한 섹션은 건드리지 말고, 부족한 섹션에만 사례, 설명, 체크리스트, 실천 포인트를 덧붙여 분량을 채울 것.',
      });
    }

    try {
      console.log(`[젬스] repair 호출 #${attempt} — chars=${repairedContent.length}, missing=${missingMarkers.length}, short=${shortSections.length}`);
      const repaired = await repairGeneralPostDraft(
        category,
        researchData,
        { content: repairedContent },
        { issues },
        sectionVariation
      );
      repairedContent = String(repaired.content || repairedContent).trim();
      if (repaired.model) nextUsedModel = repaired.model;
      nextFallbackUsed = nextFallbackUsed || !!repaired.fallbackUsed;
      console.log(`[젬스] repair 완료 #${attempt}: ${repairedContent.length}자`);
    } catch (e) {
      console.warn(`[젬스] repair 실패 #${attempt} (무시): ${e.message}`);
      break;
    }
  }

  return {
    content: repairedContent,
    model: nextUsedModel,
    fallbackUsed: nextFallbackUsed,
  };
}

function _sanitizeContinuation(baseContent, continuationText) {
  const continuation = String(continuationText || '').trim();
  if (!continuation) {
    return { mode: 'empty', text: '' };
  }

  const baseMarkers = new Set(_getDetectedMarkers(baseContent).map(item => item.marker));
  const continuationMarkers = _getDetectedMarkers(continuation);

  if (!continuationMarkers.length) {
    return { mode: 'append', text: continuation };
  }

  const firstMarker = continuationMarkers[0];
  const firstMissing = continuationMarkers.find(item => !baseMarkers.has(item.marker));

  if (baseMarkers.has(firstMarker.marker)) {
    if (firstMissing) {
      return {
        mode: 'trimmed_to_missing_section',
        text: continuation.slice(firstMissing.index).trim(),
        marker: firstMissing.marker,
      };
    }
    return {
      mode: 'discarded_restart',
      text: '',
      marker: firstMarker.marker,
    };
  }

  return { mode: 'append', text: continuation };
}

// ─── 시스템 프롬프트 ─────────────────────────────────────────────────

const GEMS_PERSONA_GUIDE = loadPersonaGuide('GEMS_PERSONA.md');
const GEMS_SYSTEM_PROMPT = '너는 블로그팀 일반 글 작성자 젬스다. 카테고리 독자 문제를 먼저 세우고, 실전 경험은 보조 사례로만 사용하라. 구조를 지키고 반복 서사를 피하며, 마지막 줄에 _THE_END_ 를 남겨라.';

// ─── IT 뉴스 분석 섹션 블록 ──────────────────────────────────────────

/**
 * IT 카테고리 전용 뉴스 분석 섹션 지시 블록
 * [최신IT트렌드 / IT정보와분석 / 개발기획과컨설팅] 카테고리에만 추가
 *
 * @param {Array}  itNews    — researchData.it_news (richer.js 수집)
 * @param {string} category
 * @returns {string}
 */
function _buildNewsAnalysisBlock(itNews, category) {
  if (!itNews?.length) return '';

  const newsList = itNews.slice(0, 5)
    .map(n => `- ${n.title} (score: ${n.score || 0})`)
    .join('\n');

  return `
[IT 뉴스 분석 섹션 — 반드시 포함]
[본론 섹션 3] 직후, [스터디카페 홍보 섹션] 직전에 아래 섹션을 추가하라.

섹션명: [이번 주 IT 뉴스 분석]
목표 글자수: 700자 이상
작성 방식:
  1. 아래 뉴스 중 이 글의 주제(${category})와 연관성 높은 2~3개 선택
  2. 각 뉴스를 1~2문장으로 소개 (너무 기술적인 설명보다 의미 중심)
  3. "이 뉴스가 ${category} 독자에게 의미하는 바" 분석 (각 200자 이상)
  4. 전체를 관통하는 인사이트 한 문단으로 마무리

참고 뉴스 (관련성 높은 것 2~3개 선택):
${newsList}
`.trim();
}

// ─── 도서리뷰 특별 프롬프트 블록 ─────────────────────────────────────

/**
 * 도서리뷰 카테고리 전용 추가 지시 블록
 * @param {object} bookInfo — researchBook() 결과
 * @returns {string}
 */
function _buildBookReviewBlock(bookInfo) {
  if (!bookInfo?.title) return '';

  return `
[도서리뷰 전용 지시 — 반드시 준수]
리뷰할 도서:
- 제목: ${bookInfo.title}
- 저자: ${bookInfo.author || ''}
- 출판사: ${bookInfo.publisher || ''}
- 출판일: ${bookInfo.pubDate || ''}
- ISBN: ${bookInfo.isbn || ''}
${bookInfo.description ? `- 소개: ${bookInfo.description.slice(0, 300)}` : ''}

도서리뷰 작성 규칙:
1. 위 도서를 실제로 읽은 독자(승호아빠) 입장에서 리뷰하라.
2. [본론 섹션 1]: 책 소개 + 저자 소개 + 읽게 된 계기 (1,500자 이상)
3. [본론 섹션 2]: 핵심 내용 3가지 챕터 요약 + 인상 깊은 구절 직접 인용 (1,500자 이상)
4. [본론 섹션 3]: ai-agent-system 개발에 어떻게 적용했는지 실전 연결 (1,500자 이상)
5. 평점: 별점(★★★★☆ 형식) + 200자 총평 포함
6. "이런 분께 추천": 독자 대상 3가지 구체적으로 명시
7. 표지 이미지는 별도 삽입 예정이므로 "[도서 표지 이미지]" 텍스트 자리표시자 삽입
`.trim();
}

// ─── sectionVariation 지시 블록 생성 ────────────────────────────────

/**
 * sectionVariation 객체를 LLM 지시 텍스트로 변환.
 * pos-writer.js와 동일한 로직 (공통화 후보 — 현재는 각 writer 자립).
 *
 * @param {object} variation
 * @returns {string}
 */
function _buildVariationBlock(variation = {}) {
  if (!Object.keys(variation).length) return '';

  const lines = ['[이번 포스팅 변형 지시 — 반드시 준수]'];

  if (variation.greetingStyle) {
    const styles = {
      formal:   '격식체 존댓말로 정중하게',
      casual:   '편안한 반말체로 친근하게',
      question: '독자에게 질문을 던지는 형식으로',
      story:    '오늘 아침 에피소드를 먼저 들려주는 스토리텔링으로',
    };
    lines.push(`인사말 스타일: ${styles[variation.greetingStyle] || '자유롭게'}`);
  }
  if (variation.bodyCount)      lines.push(`본론 섹션 수: ${variation.bodyCount}개`);
  if (variation.faqCount)       lines.push(`FAQ 개수: ${variation.faqCount}개`);
  if (variation.listStyle) {
    const lStyles = {
      number: '번호 리스트(1. 2. 3.)',
      bullet: '불릿 리스트(•)',
      mixed:  '번호와 불릿 혼용',
    };
    lines.push(`리스트 스타일: ${lStyles[variation.listStyle] || '자유'}`);
  }
  if (variation.bridgeInterval) {
    lines.push(`독자 소통 브릿지: ${variation.bridgeInterval}자마다 삽입`);
  }
  if (variation.cafePosition) {
    const cPos = {
      after_theory: '본론 이론 섹션 직후',
      after_code:   '코드 섹션 직후',
      before_faq:   'FAQ 바로 앞',
      last:         '마무리 직전',
    };
    lines.push(`카페 홍보 위치: ${cPos[variation.cafePosition] || '기본 위치'}`);
  }

  // ★ 보너스 인사이트 지시
  if (variation.bonusInsights?.length > 0) {
    lines.push('');
    lines.push(`★ 보너스 인사이트 ${variation.bonusInsights.length}개 추가 작성 (총 인사이트 ${variation.totalInsights || 4 + variation.bonusInsights.length}개):`);
    variation.bonusInsights.forEach((bonus, i) => {
      lines.push(`  ${i + 1}. ${bonus.title} — ${bonus.instruction}`);
      lines.push(`     삽입 위치: ${bonus.insertAfter} 뒤에 배치`);
    });
    lines.push('  위 보너스 섹션을 기존 인사이트 사이에 자연스럽게 삽입하라.');
    lines.push('  기존 인사이트 ①②③④의 글자수는 줄이지 말 것 — 보너스는 순수 추가분이다.');
  }

  return '\n' + lines.join('\n') + '\n';
}

// ─── 일반 포스팅 생성 ────────────────────────────────────────────────

/**
 * @param {string} category
 * @param {object} researchData    — 리처 수집 결과 (realExperiences, relatedPosts 포함)
 * @param {object} sectionVariation — 마에스트로 변형 지시 (옵셔널, 기본값 {})
 * @returns {{ content, charCount, model, title }}
 */
async function writeGeneralPost(category, researchData, sectionVariation = {}) {
  const today    = new Date().toLocaleDateString('ko-KR');
  const cacheKey = `gems_general_${category}_${kst.today()}`;

  // 캐시 확인
  const cached = await llmCache.getCached('blog', 'general_post', cacheKey);
  if (cached) {
    console.log('[젬스] 캐시 히트:', cacheKey);
    try { return JSON.parse(cached.response); } catch {}
  }

  const weather         = researchData.weather || {};
  const itNews          = researchData.it_news || [];
  const realExperiences = researchData.realExperiences || [];
  const relatedPosts    = researchData.relatedPosts    || [];
  const popularPatterns = researchData.popularPatterns || [];

  const weatherContext = _weatherToContext(weather);

  const experienceBlock = realExperiences.length > 0
    ? `\n[실전 에피소드 — 샌드위치 화법의 "일상 에피소드" 부분에 녹여라]\n` +
      realExperiences.map((ep, i) => `${i + 1}. [${ep.type}] ${ep.content}`).join('\n') +
      `\n예) "얼마 전 제가 운영하는 시스템에서 예상치 못한 오류가 발생했습니다..."\n`
    : '';

  // 내부 링킹 블록 (Phase 1: 제목만 + "← 여기에 링크 삽입" 안내)
  const linkingBlock = relatedPosts.length > 0
    ? `\n[내부 링킹 — 이전 포스팅 제목만 표시]\n` +
      `★ 이미 발행된 과거 포스팅만 추천. 미래 포스팅 절대 금지.\n` +
      `각 추천 글 형식: → [제목] ← 여기에 링크 삽입\n\n` +
      `참고 가능한 과거 포스팅 목록:\n` +
      relatedPosts.map((p, i) => `${i + 1}. ${p.title} — ${p.summary}`).join('\n') + '\n'
    : '';

  // 도서리뷰 특별 블록
  const bookReviewBlock = category === '도서리뷰'
    ? '\n' + _buildBookReviewBlock(researchData.book_info) + '\n'
    : (researchData.book_info ? `[도서 정보]\n${JSON.stringify(researchData.book_info)}\n` : '');

  // IT 카테고리 뉴스 분석 섹션 블록
  const newsAnalysisBlock = IT_NEWS_CATEGORIES.includes(category)
    ? '\n' + _buildNewsAnalysisBlock(itNews, category) + '\n'
    : '';
  const recentThemeBlock = '\n' + _buildRecentThemeDedupeBlock(category) + '\n';
  const popularPatternBlock = popularPatterns.length > 0
    ? '\n[이전 인기 패턴 참고]\n' +
      popularPatterns.map((item, index) => {
        const meta = item.metadata || {};
        return `${index + 1}. ${item.content} | views=${meta.views || 0} | category=${meta.category || category}`;
      }).join('\n') + '\n'
    : '';

  const userPrompt = `
${GEMS_PERSONA_GUIDE ? `[참조 페르소나]\n${GEMS_PERSONA_GUIDE}\n` : ''}
${AI_AGENT_CONTEXT}
${GEO_RULES}
다음 일반 포스팅을 작성하라:

[카테고리] ${category}
[발행일] ${today}
[오늘 날씨 — 서론 + 스터디카페 섹션에 각 1회 자연스럽게 활용]
${weatherContext}

[최신 IT 뉴스 (서론에 활용 — 상위 3개 선택)]
${itNews.slice(0, 5).map(n => `- ${n.title} (인기도: ${n.score})`).join('\n') || '- 최신 IT 트렌드를 자체 지식으로 언급하라'}

${bookReviewBlock}${newsAnalysisBlock}${experienceBlock}${linkingBlock}${recentThemeBlock}${popularPatternBlock}
카테고리 "${category}"에 맞는 주제를 자율 선정하여 작성하라.
단, 최근 발행 일반 글과 같은 상위 서사를 반복하면 안 된다.
글 첫 번째 줄에 제목을 [${category}] 형식으로 시작하라.

★★★ 글자수 요구사항 (반드시 준수) ★★★
전체 최소 6,000자 이상 (목표 6,500~7,000자, 한국어 기준). 각 섹션별 최소 글자수:
- [AI 스니펫 요약]: 150자
- [이 글에서 배울 수 있는 것]: 목차 3~5개
- [승호아빠 인사말]: 300자
- [본론 섹션 1]: 1,500자 (주제 도입 + 번호 리스트 상세 설명)
- [본론 섹션 2]: 1,500자 (핵심 분석 + 불릿 리스트 상세 설명)
- [본론 섹션 3]: 1,500자 (실천 전략 3가지 번호 리스트 + 각 전략 300자 이상)${IT_NEWS_CATEGORIES.includes(category) ? '\n- [이번 주 IT 뉴스 분석]: 500자 (관련 뉴스 2~3개 선별 분석)' : ''}
- [스터디카페 홍보 섹션]: 600자
- [마무리 제언]: 400자
- [함께 읽으면 좋은 글]: 관련 포스팅 3개
- [해시태그]: 27개 이상
각 섹션을 생략하거나 줄이면 안 된다. 모든 섹션을 빠짐없이 충분히 작성하라.
${_buildVariationBlock(sectionVariation)}
[출력 규칙]
- 독자가 이 글 하나로 해당 주제를 완전히 이해할 수 있도록 포괄적으로(comprehensively) 작성하라.
- 각 본론 섹션을 깊이 있고 상세하게(in-depth and detailed) 서술하라.
- 절대 요약하거나 축약하지 말라. 모든 주장에 근거와 사례를 제시하라.
- 반드시 모든 섹션을 작성하고 _THE_END_ 로 마무리하라.
  `.trim();

  const startTime = Date.now();
  let usedModel = 'gpt-4o';
  let fallbackUsed = false;
  let content;

  try {
    const result = await callWithFallback({
      chain:        GEMS_LLM_CHAIN,
      systemPrompt: GEMS_SYSTEM_PROMPT,
      userPrompt,
      timeoutMs: BLOG_WRITER_TIMEOUT_MS,
      logMeta: { team: 'blog', purpose: 'writer', bot: 'blog-gems', requestType: 'general_post' },
    });
    content      = result.text;
    usedModel    = result.model;
    fallbackUsed = result.attempt > 1;
    if (fallbackUsed) console.log(`[젬스] LLM 폴백 발생: ${result.provider}/${result.model} (시도 ${result.attempt})`);
  } finally {
    await toolLogger.logToolCall('llm', 'callWithFallback', {
      bot: 'blog-gems', success: !!content,
      duration_ms: Date.now() - startTime,
      metadata: { model: usedModel, category, trace_id: getTraceId(), fallback_used: fallbackUsed },
    }).catch(() => {});
  }

  const MIN_CHARS_GENERAL = Number(generationRuntimeConfig.gemsMinChars || 6000);

  // ── Continue 이어쓰기: 글자수 부족 시 2차 호출 (_THE_END_ 여부 무관) ──
  if (content.length < MIN_CHARS_GENERAL) {
    console.log(`[젬스] 글자수 부족 (${content.length}자) — 이어쓰기 호출`);

    // 마지막 800자만 컨텍스트로 전달 (전체 내용 전달 시 LLM이 새 글을 시작하는 문제 방지)
    const tailContext    = content.slice(-800);
    const continuePrompt = `[이전 내용 끝부분 (이미 작성됨 — 절대 반복 금지)]\n${tailContext}\n\n[지시] 위 내용이 끊긴 부분에서 바로 이어서 작성하라. 앞 내용은 이미 완성되었으므로 반드시 끊긴 지점부터 시작하라. 새 글을 처음부터 쓰지 말 것. 남은 섹션을 모두 완성하고 마지막에 _THE_END_ 를 적어라.`;
    const GEMS_CONTINUE_CHAIN = GEMS_LLM_CHAIN.map(c => ({ ...c, maxTokens: Number(generationRuntimeConfig.continueMaxTokens || 8000) }));
    try {
      const cont = await callWithFallback({
        chain:        GEMS_CONTINUE_CHAIN,
        systemPrompt: GEMS_SYSTEM_PROMPT,
        userPrompt:   continuePrompt,
        timeoutMs: BLOG_CONTINUE_TIMEOUT_MS,
        logMeta: { team: 'blog', purpose: 'writer', bot: 'blog-gems', requestType: 'general_post_continue' },
      });
      // LLM이 새 글을 처음부터 시작한 경우 감지 (첫 줄이 # 제목 + 분량이 원본의 50% 이상이면 재시작으로 간주)
      const contFirstLine = cont.text.trim().split('\n')[0] || '';
      const isRestart     = contFirstLine.startsWith('#') && cont.text.length > content.length * 0.5;
      if (isRestart) {
        console.warn(`[젬스] ⚠️ 이어쓰기 LLM이 새 글 시작 감지 — 이어붙이기 건너뜀 (${cont.text.length}자)`);
      } else {
        const continuation = _sanitizeContinuation(content, cont.text);
        if (continuation.mode === 'discarded_restart') {
          console.warn(`[젬스] ⚠️ 이어쓰기 응답이 완성본 재시작으로 보여 건너뜀 (${continuation.marker})`);
        } else if (continuation.mode === 'trimmed_to_missing_section') {
          console.log(`[젬스] 이어쓰기 중복 섹션 정리 후 이어붙임 (${continuation.marker}부터)`);
          content = content + '\n' + continuation.text;
        } else if (continuation.text) {
          content = content + '\n' + continuation.text;
        }
      }
    } catch (e) {
      console.warn(`[젬스] 이어쓰기 실패 (무시): ${e.message}`);
    }

    await toolLogger.logToolCall('llm', 'callWithFallback', {
      bot: 'blog-gems', success: true,
      duration_ms: Date.now() - startTime,
      metadata: { model: usedModel, type: 'continue', category, trace_id: getTraceId() },
    }).catch(() => {});

    console.log(`[젬스] 이어쓰기 완료: ${content.length}자`);
  }

  // _THE_END_ 마커 제거
  content = content.replace(/_THE_END_/g, '').trim();

  const repairResult = await _runGeneralPostRepairPasses(
    category,
    researchData,
    content,
    sectionVariation,
    usedModel,
    fallbackUsed,
    MIN_CHARS_GENERAL
  );
  content = repairResult.content;
  usedModel = repairResult.model;
  fallbackUsed = repairResult.fallbackUsed;

  content = _ensureGeneralQualityFloor(content, {
    category,
    weatherContext,
    relatedPosts,
    minChars: MIN_CHARS_GENERAL,
  });

  if (content.length < MIN_CHARS_GENERAL) {
    console.log(`[젬스] repair 이후에도 글자수 미달: ${content.length}자`);
  }

  const firstLine = content.split('\n').find(l => l.trim().length > 0) || '';
  const title     = firstLine.slice(0, 80).trim();

  const result = { content, charCount: content.length, model: usedModel, title, fallbackUsed };

  // 최소 글자수 달성 시에만 캐시 저장 (실패 결과 캐시 방지)
  if (content.length >= MIN_CHARS_GENERAL) {
    await llmCache.setCache('blog', 'general_post', cacheKey, JSON.stringify(result), 'gpt-4o');
  } else {
    console.log(`[젬스] 글자수 미달 (${content.length}자) — 캐시 저장 건너뜀`);
  }

  return result;
}

// ─── 초안 보정 (전체 재작성 대체) ─────────────────────────────────────

/**
 * 품질 미달 초안을 "처음부터 다시 쓰기" 대신 필요한 부분만 보정한다.
 * 젬스가 동일 포스팅을 두 번 새로 생성하는 현상을 줄이기 위한 경량 후처리 경로.
 *
 * @param {string} category
 * @param {object} researchData
 * @param {{ content:string, title?:string, charCount?:number }} draft
 * @param {{ issues?:Array<{severity:string,msg:string}>, aiRisk?:object }} quality
 * @param {object} sectionVariation
 * @returns {Promise<{ content, charCount, model, title, fallbackUsed, repairedFromDraft: true }>}
 */
async function repairGeneralPostDraft(category, researchData, draft, quality, sectionVariation = {}) {
  const content = String(draft?.content || '').trim();
  if (!content) {
    throw new Error('repairGeneralPostDraft: draft.content 비어 있음');
  }

  const weatherContext = _weatherToContext(researchData.weather || {});
  const issueLines = (quality?.issues || [])
    .map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.msg}`)
    .join('\n') || '1. [warn] 품질 보정 필요';
  const missingMarkerLines = _getMissingMarkers(content)
    .map((marker, index) => `${index + 1}. ${marker}`)
    .join('\n');
  const shortSectionLines = _getShortSections(content, category)
    .map((section, index) => `${index + 1}. ${section.marker} — 현재 ${section.currentChars}자 / 목표 ${section.minChars}자`)
    .join('\n');

  const bookReviewBlock = category === '도서리뷰'
    ? '\n' + _buildBookReviewBlock(researchData.book_info) + '\n'
    : '';

  const newsAnalysisBlock = IT_NEWS_CATEGORIES.includes(category)
    ? '\n' + _buildNewsAnalysisBlock(researchData.it_news || [], category) + '\n'
    : '';

  const repairPrompt = `
다음은 이미 작성된 일반 포스팅 초안이다.
이 글을 처음부터 다시 쓰지 말고, 기존 구조와 주제를 유지한 채 부족한 부분만 보정하라.

[카테고리] ${category}
[오늘 날씨 맥락] ${weatherContext}
${bookReviewBlock}${newsAnalysisBlock}
[품질 이슈]
${issueLines}

[중요 지시]
1. 기존 글의 제목, 핵심 주장, 전개 순서를 최대한 유지하라.
2. 부족한 섹션/해시태그/스터디카페 문단/개인 경험만 보강하라.
3. 글자수가 부족하면 필요한 섹션만 확장하라. 이미 충분한 문단은 반복하거나 축약하지 말 것.
4. 새 글을 처음부터 다시 작성하지 말 것.
5. 마지막에는 전체 보정된 완성본만 출력하라. 설명문, 메모, 사족 금지.
6. 모든 보정이 끝난 뒤 마지막 줄에 _THE_END_ 를 적어라.
7. 아래 [부족 섹션] 목록이 있으면 그 섹션을 우선 보강하고, 목록에 없는 섹션은 가능한 한 그대로 유지하라.
8. [누락 섹션] 목록이 있으면 반드시 해당 섹션명을 그대로 사용해 새 섹션을 추가하라.
9. "AI 스니펫 요약", "스터디카페 홍보 섹션", "해시태그"가 누락되었으면 반드시 정확한 섹션명으로 다시 작성하라.
${_buildVariationBlock(sectionVariation)}

[누락 섹션]
${missingMarkerLines || '1. 없음'}

[부족 섹션]
${shortSectionLines || '1. 별도 부족 섹션 없음'}

[기존 초안 시작]
${content}
[기존 초안 끝]
  `.trim();

  const startTime = Date.now();
  let usedModel = 'gpt-4o';
  let fallbackUsed = false;
  let repaired;

  try {
    const result = await callWithFallback({
      chain:        GEMS_LLM_CHAIN,
      systemPrompt: GEMS_SYSTEM_PROMPT,
      userPrompt:   repairPrompt,
      timeoutMs: BLOG_WRITER_TIMEOUT_MS,
      logMeta: { team: 'blog', purpose: 'writer', bot: 'blog-gems', requestType: 'general_post_repair' },
    });
    repaired     = result.text;
    usedModel    = result.model;
    fallbackUsed = result.attempt > 1;
  } finally {
    await toolLogger.logToolCall('llm', 'callWithFallback', {
      bot: 'blog-gems',
      success: !!repaired,
      duration_ms: Date.now() - startTime,
      metadata: {
        model: usedModel,
        category,
        trace_id: getTraceId(),
        fallback_used: fallbackUsed,
        type: 'repair',
      },
    }).catch(() => {});
  }

  repaired = repaired.replace(/_THE_END_/g, '').trim();
  const firstLine = repaired.split('\n').find(line => line.trim().length > 0) || '';
  const title = firstLine.slice(0, 80).trim();

  return {
    content: repaired,
    charCount: repaired.length,
    model: usedModel,
    title,
    fallbackUsed,
    repairedFromDraft: true,
  };
}

// ─── 분할 생성 (Gemini Flash 무료) ──────────────────────────────────────

/**
 * 3그룹 분할 생성 — Gemini Flash (무료) 기본
 * group_a: AI스니펫 + 목차 + 인사말 + 본론1  (~1,900자+)
 * group_b: 본론2 + 본론3                      (~2,700자+)
 * group_c: 스터디카페 홍보 + 마무리 (~1,250자+)
 * group_d: 링크 + 해시태그 (~250자+)
 *
 * @param {string} category
 * @param {object} researchData
 * @param {object} sectionVariation — 마에스트로 변형 지시 (옵셔널, 기본값 {})
 * @returns {{ content, charCount, model, title }}
 */
async function writeGeneralPostChunked(category, researchData, sectionVariation = {}) {
  const today    = new Date().toLocaleDateString('ko-KR');
  const model    = process.env.BLOG_LLM_MODEL || GEMS_LLM_CHAIN;

  const weather         = researchData.weather || {};
  const itNews          = researchData.it_news || [];
  const realExperiences = researchData.realExperiences || [];
  const relatedPosts    = researchData.relatedPosts    || [];
  const popularPatterns = researchData.popularPatterns || [];

  const weatherContext = _weatherToContext(weather);

  const experienceBlock = realExperiences.length > 0
    ? `\n[실전 에피소드 — 샌드위치 화법의 "일상 에피소드" 부분에 녹여라]\n` +
      realExperiences.map((ep, i) => `${i + 1}. [${ep.type}] ${ep.content}`).join('\n') +
      `\n예) "얼마 전 제가 운영하는 시스템에서 예상치 못한 오류가 발생했습니다..."\n`
    : '';

  // 내부 링킹 블록 (Phase 1: 제목만 + "← 여기에 링크 삽입" 안내)
  const linkingBlock = relatedPosts.length > 0
    ? `\n[내부 링킹 — 이전 포스팅 제목만 표시]\n` +
      `★ 이미 발행된 과거 포스팅만 추천. 미래 포스팅 절대 금지.\n` +
      `각 추천 글 형식: → [제목] ← 여기에 링크 삽입\n\n` +
      `참고 가능한 과거 포스팅 목록:\n` +
      relatedPosts.map((p, i) => `${i + 1}. ${p.title} — ${p.summary}`).join('\n') + '\n'
    : '';

  const newsBlock = itNews.slice(0, 5).map(n => `- ${n.title} (인기도: ${n.score})`).join('\n')
    || '- 최신 IT 트렌드를 자체 지식으로 언급하라';

  // 도서리뷰 특별 블록 (청크 버전)
  const bookReviewBlock = category === '도서리뷰'
    ? '\n' + _buildBookReviewBlock(researchData.book_info) + '\n'
    : (researchData.book_info ? `[도서 정보]\n${JSON.stringify(researchData.book_info)}\n` : '');
  const recentThemeBlock = _buildRecentThemeDedupeBlock(category);
  const popularPatternBlock = popularPatterns.length > 0
    ? `\n[이전 인기 패턴 참고]\n` +
      popularPatterns.map((item, index) => {
        const meta = item.metadata || {};
        return `${index + 1}. ${item.content} | views=${meta.views || 0} | category=${meta.category || category}`;
      }).join('\n') + '\n'
    : '';

  const baseCtx = `
${GEMS_PERSONA_GUIDE ? `[참조 페르소나]\n${GEMS_PERSONA_GUIDE}\n` : ''}
[카테고리] ${category}
[발행일] ${today}
[오늘 날씨] ${weatherContext}
[최신 IT 뉴스] ${newsBlock}
${bookReviewBlock}${experienceBlock}
${recentThemeBlock}
${popularPatternBlock}`.trim();

  const chunks = [
    {
      id:       'group_a',
      minChars: 1900,
      prompt: `${baseCtx}

카테고리 "${category}"에 맞는 주제를 선정하여 아래 섹션을 작성하라.
글 첫 번째 줄에 제목을 [${category}] 형식으로 시작하라.

작성할 섹션 (모두 포함, 생략 금지):
1. [AI 스니펫 요약] — 150자, 검색 노출용
2. ━━━━━━━━━━━━━━━━━━━━━
3. [이 글에서 배울 수 있는 것] — 3~5개 목차 항목
4. ━━━━━━━━━━━━━━━━━━━━━
5. [승호아빠 인사말] — 날씨/시사 반영, 친근한 인사, 300자
6. ━━━━━━━━━━━━━━━━━━━━━
7. [본론 섹션 1] — 주제 도입 + 번호 리스트 상세 설명, 1,400자 이상

글자수 요구: 전체 1,900자 이상. 본론 섹션 1은 최소 1,400자.
${_buildVariationBlock(sectionVariation)}`,
    },
    {
      id:       'group_b',
      minChars: 2700,
      prompt: `${baseCtx}

카테고리 "${category}" 포스팅의 중반부를 작성하라.
이전 섹션([승호아빠 인사말], [본론 섹션 1])에 이어서 자연스럽게 연결하라.

작성할 섹션 (모두 포함, 생략 금지):
1. [본론 섹션 2] — 핵심 분석 + 불릿 리스트 상세 설명, 1,350자 이상
2. ━━━━━━━━━━━━━━━━━━━━━
3. [본론 섹션 3] — 실천 전략 3가지 (번호 리스트, 각 전략 280자 이상), 1,350자 이상

글자수 요구: 전체 2,700자 이상. 각 섹션 최소 1,350자.`,
    },
    {
      id:       'group_c',
      minChars: 1250,
      prompt: `${baseCtx}
카테고리 "${category}" 포스팅의 마무리 섹션을 작성하라.
앞서 작성된 3개의 본론 섹션에 이어 자연스럽게 마무리하라.
날씨 맥락(${weatherContext})을 스터디카페 섹션에 자연스럽게 포함하라.

작성할 섹션 (모두 포함, 생략 금지):
1. [스터디카페 홍보 섹션] — 작업 메모리/인지 부하 → 커피랑도서관 자연 연결, 세스코 에어 + 날씨 환경 연결, 불릿 리스트, 600자 이상
2. ━━━━━━━━━━━━━━━━━━━━━
3. [마무리 제언] — 명언형 인용 + 결론 한줄 + 감사 인사 + 좋아요/댓글 독려, 400자 이상

글자수 요구: 전체 1,250자 이상. 스터디카페 섹션 최소 600자.`,
    },
    {
      id:       'group_d',
      minChars: 220,
      prompt: `${baseCtx}
${linkingBlock}
카테고리 "${category}" 포스팅의 마감 메타 정보를 작성하라.
이미 본론과 마무리 제언은 작성되었다. 아래 두 섹션만 작성하라.

작성할 섹션 (모두 포함, 생략 금지):
1. [함께 읽으면 좋은 글] — 관련 포스팅 3개 추천
2. [해시태그] — 주제 관련 15개 + 스터디카페 홍보 12개 = 27개 이상 (질문형 키워드 포함)

글자수 요구: 전체 220자 이상.`,
    },
  ];

  const result = await chunkedGenerate(GEMS_SYSTEM_PROMPT, chunks, {
    model,
    contextCarry: 200,
    maxRetries:   Number(generationRuntimeConfig.writerMaxRetries || 1),
    timeoutMs: BLOG_CHUNK_TIMEOUT_MS,
    logMeta: { team: 'blog', purpose: 'writer', bot: 'blog-gems', requestType: 'general_post_chunked' },
    onChunkComplete: ({ id, charCount, index }) =>
      console.log(`[젬스청크] ${id} (${index + 1}/${chunks.length}): ${charCount}자`),
  });

  const content   = result.content;
  const firstLine = content.split('\n').find(l => l.trim().length > 0) || '';
  const title     = firstLine.slice(0, 80).trim();

  console.log(`[젬스청크] 전체 ${result.charCount}자 (${chunks.length}청크)`);

  return { content, charCount: result.charCount, model: `chunked-${model}`, title };
}

module.exports = {
  writeGeneralPost,
  writeGeneralPostChunked,
  repairGeneralPostDraft,
  GEMS_SYSTEM_PROMPT,
};
