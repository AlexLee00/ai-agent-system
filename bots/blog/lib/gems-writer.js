'use strict';
const kst = require('../../../packages/core/lib/kst');

/**
 * gems-writer.js (젬스 GEMS) — 일반 포스팅 작성
 *
 * IT 전략 컨설턴트 페르소나
 * 필수 7,000자 이상 (목표 8,000자)
 * 모델: GPT-4o (OpenAI) 또는 Gemini Flash (분할생성)
 */

const toolLogger          = require('../../../packages/core/lib/tool-logger');
const llmCache            = require('../../../packages/core/lib/llm-cache');
const { getTraceId }      = require('../../../packages/core/lib/trace');
const { chunkedGenerate } = require('../../../packages/core/lib/chunked-llm');
const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
const { getBlogGenerationRuntimeConfig } = require('./runtime-config');

const generationRuntimeConfig = getBlogGenerationRuntimeConfig();

// 폴백 체인: gpt-4o → gpt-4o-mini → gemini-2.5-flash
const GEMS_LLM_CHAIN = [
  { provider: 'openai', model: 'gpt-4o',                            maxTokens: 16000, temperature: 0.85 },
  { provider: 'openai', model: 'gpt-4o-mini',                       maxTokens: 16000, temperature: 0.85 },
  { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 12000, temperature: 0.75 },
];

// ─── ai-agent-system 프로젝트 컨텍스트 ──────────────────────────────

const AI_AGENT_CONTEXT = `
[마스터의 실제 프로젝트: ai-agent-system]
재룡 님(승호아빠)이 직접 개발·운영 중인 멀티에이전트 AI 봇 시스템.
5개 팀, 30+ 봇 — 스카(스터디카페 관리), 루나(자동매매), 클로드(시스템감시), 블로(블로그), 워커(SaaS)

카테고리별 자연스러운 연결:
- 자기계발 → "AI 에이전트 30개를 지휘하며 깨달은 성장의 법칙"
- 성장과성공 → "1일 1커밋 120일, 완강이 가르쳐준 복리 효과"
- 최신IT트렌드 → "직접 구축한 멀티에이전트 시스템으로 본 AI 트렌드"
- IT정보와분석 → "자동매매 봇 데이터로 분석한 시장 인사이트"
- 개발기획과컨설팅 → "30개 봇 아키텍처 설계 경험에서 배운 PM의 역할"
- 홈페이지와App → "SaaS 근로관리 시스템 개발기"
- 도서리뷰 → "이 책의 원리가 내 에이전트 시스템 설계에 어떻게 적용되었나"

샌드위치 화법의 "일상 에피소드" 부분에서 1~2회 자연스럽게 언급하라.
`.trim();

// ─── IT 카테고리 뉴스 분석 섹션 적용 대상 ────────────────────────────

const IT_NEWS_CATEGORIES = ['최신IT트렌드', 'IT정보와분석', '개발기획과컨설팅'];

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

// ─── 시스템 프롬프트 ─────────────────────────────────────────────────

const GEMS_SYSTEM_PROMPT = `
너는 IT 전략 컨설턴트 '젬스(GEMS)'다.
박사의 전문 지식을 일반인도 이해하기 쉬운 비유로 풀어내는
'지식의 저주를 푼 전문가의 언어'를 사용하라.

닉네임 '승호아빠'로 활동. 정중하면서도 친근한 어조 유지.

${AI_AGENT_CONTEXT}

${GEO_RULES}

[필수 작성 규칙]
1. 총 글자수 8,000자 이상 (목표 9,000자) — 반드시 달성
2. 샌드위치 화법:
   [일상 에피소드/흥미 유발] → [날카로운 공학적/뇌과학적 근거] → [실천 가능한 쉬운 결론]
3. 어려운 용어 뒤에 반드시 일상적 비유 덧붙이기 (예: 작업 메모리는 책상 크기)
4. 뇌과학 키워드 활용: 몰입, 인지 부하, 작업 메모리
5. 1,000자마다 독자 소통 브릿지 문구 삽입
5-1. [섹션 내 참고 링크 삽입 규칙]
   각 주요 섹션에 관련 참고 링크를 1~2개 자연스럽게 삽입하라.
   허용 도메인: developer.mozilla.org/ · github.com/ · 각 기술 공식 문서
   삽입 형식: → 참고: [문서명](URL) ← 여기에 링크 삽입
   URL을 확실히 아는 것만 삽입. 모르면 "← 여기에 링크 삽입" 안내만 하라.
   존재하지 않는 URL 절대 생성 금지.
6. 커피랑도서관 분당서현점이 성과를 높이는 이유를 논리적으로 증명
7. ★ 날씨 맥락 2회 이상 자연스럽게 삽입 (서론 + 스터디카페 홍보 섹션)
8. 개인 경험/감상 표현 2회 이상
9. 모든 섹션을 빠짐없이 작성 완료한 후, 반드시 마지막 줄에 _THE_END_ 를 적어라.
   _THE_END_ 가 없으면 글이 미완성된 것으로 간주한다.
10. ★ 본문 소제목(H2·H3)에는 반드시 내용에 어울리는 이모지 1개를 앞에 붙여라.
    숫자 리스트(1. 2. 3.)의 항목 제목에도 동일하게 적용.
    예) ✅ 핵심 원칙 세 가지 / 💡 실전 적용 방법 / 🔍 흔히 하는 실수 / 📌 요약 정리
    단, 섹션 구분자 [섹션명] 형식에는 이모지를 붙이지 말 것.

[필수 구조 — 각 섹션의 최소 글자수를 반드시 준수하라]
1. [AI 스니펫 요약] — 150자
2. ━━━━━━━━━━━━━━━━━━━━━
3. [이 글에서 배울 수 있는 것] — 200자 (3~5개 목차)
4. ━━━━━━━━━━━━━━━━━━━━━
5. [승호아빠 인사말] — 최소 300자 (날씨/시사 반영)
6. ━━━━━━━━━━━━━━━━━━━━━
7. [본론 섹션 1] — 최소 2,000자 ★ (주제 도입 + 번호 리스트 상세)
8. ━━━━━━━━━━━━━━━━━━━━━
9. [본론 섹션 2] — 최소 2,000자 ★ (핵심 분석 + 불릿 리스트 상세)
10. ━━━━━━━━━━━━━━━━━━━━━
11. [본론 섹션 3] — 최소 2,000자 ★ (실천 전략 3가지, 각 전략 400자 이상)
12. ━━━━━━━━━━━━━━━━━━━━━
13. [이번 주 IT 뉴스 분석] — 최소 700자 ★ (IT 카테고리 전용: 관련 뉴스 2~3개 분석)
    ※ IT 카테고리(최신IT트렌드/IT정보와분석/개발기획과컨설팅)에만 포함. 없으면 생략.
14. ━━━━━━━━━━━━━━━━━━━━━
15. [스터디카페 홍보 섹션] — 최소 800자 (작업 메모리/인지 부하 → 커피랑도서관)
16. ━━━━━━━━━━━━━━━━━━━━━
17. [마무리 제언] — 최소 500자 (명언형 인용 + 결론 + 감사 + 독려)
18. [함께 읽으면 좋은 글] — 3개 추천
19. [해시태그] — 27개+

위 글자수를 합산하면 최소 7,950자(IT 카테고리는 +700자 = 8,650자)이다.
각 섹션의 최소 글자수를 반드시 준수하라.

[카테고리별 작성 방향]
- 자기계발: 개인 성장 + AI 시대 역량
- 도서리뷰: IT 관련 도서 + 일반 베스트셀러 리뷰
- 성장과성공: 목표 달성 전략 + 복리 법칙
- 홈페이지와App: 웹/앱 기획 트렌드
- 최신IT트렌드: AI/클라우드/보안 최신 동향
- IT정보와분석: 산업 리포트/통계 분석
- 개발기획과컨설팅: PM/기획 실무 + 컨설팅 전략

[스터디카페 홍보 키워드]
- 커피랑도서관 분당서현점
- 세스코 에어 살균 시스템
- 작업 메모리 최적화 환경
- 인지 부하 해소 공간
- 분당 서현역 24시 운영

반드시 순수 텍스트로 출력하라. HTML 태그 없이.
각 섹션은 [섹션명] 형태로 구분하라.
`.trim();

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

  const userPrompt = `
다음 일반 포스팅을 작성하라:

[카테고리] ${category}
[발행일] ${today}
[오늘 날씨 — 서론 + 스터디카페 섹션에 각 1회 자연스럽게 활용]
${weatherContext}

[최신 IT 뉴스 (서론에 활용 — 상위 3개 선택)]
${itNews.slice(0, 5).map(n => `- ${n.title} (인기도: ${n.score})`).join('\n') || '- 최신 IT 트렌드를 자체 지식으로 언급하라'}

${bookReviewBlock}${newsAnalysisBlock}${experienceBlock}${linkingBlock}
카테고리 "${category}"에 맞는 주제를 자율 선정하여 작성하라.
글 첫 번째 줄에 제목을 [${category}] 형식으로 시작하라.

★★★ 글자수 요구사항 (반드시 준수) ★★★
전체 최소 8,000자 이상 (목표 9,000자, 한국어 기준). 각 섹션별 최소 글자수:
- [AI 스니펫 요약]: 150자
- [이 글에서 배울 수 있는 것]: 목차 3~5개
- [승호아빠 인사말]: 300자
- [본론 섹션 1]: 2,000자 (주제 도입 + 번호 리스트 상세 설명)
- [본론 섹션 2]: 2,000자 (핵심 분석 + 불릿 리스트 상세 설명)
- [본론 섹션 3]: 2,000자 (실천 전략 3가지 번호 리스트 + 각 전략 400자 이상)${IT_NEWS_CATEGORIES.includes(category) ? '\n- [이번 주 IT 뉴스 분석]: 700자 (관련 뉴스 2~3개 선별 분석)' : ''}
- [스터디카페 홍보 섹션]: 800자
- [마무리 제언]: 500자
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
      logMeta: { team: 'blog', bot: 'blog-gems', requestType: 'general_post' },
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

  const MIN_CHARS_GENERAL = Number(generationRuntimeConfig.gemsMinChars || 8000);

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
        logMeta: { team: 'blog', bot: 'blog-gems', requestType: 'general_post_continue' },
      });
      // LLM이 새 글을 처음부터 시작한 경우 감지 (첫 줄이 # 제목 + 분량이 원본의 50% 이상이면 재시작으로 간주)
      const contFirstLine = cont.text.trim().split('\n')[0] || '';
      const isRestart     = contFirstLine.startsWith('#') && cont.text.length > content.length * 0.5;
      if (isRestart) {
        console.warn(`[젬스] ⚠️ 이어쓰기 LLM이 새 글 시작 감지 — 이어붙이기 건너뜀 (${cont.text.length}자)`);
      } else {
        content = content + '\n' + cont.text;
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
3. 글자수가 부족하면 필요한 섹션만 확장하라. 이미 충분한 문단은 반복하지 말 것.
4. 새 글을 처음부터 다시 작성하지 말 것.
5. 마지막에는 전체 보정된 완성본만 출력하라. 설명문, 메모, 사족 금지.
6. 모든 보정이 끝난 뒤 마지막 줄에 _THE_END_ 를 적어라.
${_buildVariationBlock(sectionVariation)}

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
      logMeta: { team: 'blog', bot: 'blog-gems', requestType: 'general_post_repair' },
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
 * group_a: AI스니펫 + 목차 + 인사말 + 본론1  (~2,000자+)
 * group_b: 본론2 + 본론3                      (~3,000자+)
 * group_c: 스터디카페 홍보 + 마무리 + 링크 + 해시태그 (~1,500자+)
 *
 * @param {string} category
 * @param {object} researchData
 * @param {object} sectionVariation — 마에스트로 변형 지시 (옵셔널, 기본값 {})
 * @returns {{ content, charCount, model, title }}
 */
async function writeGeneralPostChunked(category, researchData, sectionVariation = {}) {
  const today    = new Date().toLocaleDateString('ko-KR');
  const model    = process.env.BLOG_LLM_MODEL || 'gemini';

  const weather         = researchData.weather || {};
  const itNews          = researchData.it_news || [];
  const realExperiences = researchData.realExperiences || [];
  const relatedPosts    = researchData.relatedPosts    || [];

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

  const baseCtx = `
[카테고리] ${category}
[발행일] ${today}
[오늘 날씨] ${weatherContext}
[최신 IT 뉴스] ${newsBlock}
${bookReviewBlock}${experienceBlock}`.trim();

  const chunks = [
    {
      id:       'group_a',
      minChars: 2000,
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
7. [본론 섹션 1] — 주제 도입 + 번호 리스트 상세 설명, 1,500자 이상

글자수 요구: 전체 2,000자 이상. 본론 섹션 1은 최소 1,500자.
${_buildVariationBlock(sectionVariation)}`,
    },
    {
      id:       'group_b',
      minChars: 2500,
      prompt: `${baseCtx}

카테고리 "${category}" 포스팅의 중반부를 작성하라.
이전 섹션([승호아빠 인사말], [본론 섹션 1])에 이어서 자연스럽게 연결하라.

작성할 섹션 (모두 포함, 생략 금지):
1. [본론 섹션 2] — 핵심 분석 + 불릿 리스트 상세 설명, 1,500자 이상
2. ━━━━━━━━━━━━━━━━━━━━━
3. [본론 섹션 3] — 실천 전략 3가지 (번호 리스트, 각 전략 300자 이상), 1,500자 이상

글자수 요구: 전체 3,000자 이상. 각 섹션 최소 1,500자.`,
    },
    {
      id:       'group_c',
      minChars: 1500,
      prompt: `${baseCtx}
${linkingBlock}
카테고리 "${category}" 포스팅의 마무리 섹션을 작성하라.
앞서 작성된 3개의 본론 섹션에 이어 자연스럽게 마무리하라.
날씨 맥락(${weatherContext})을 스터디카페 섹션에 자연스럽게 포함하라.

작성할 섹션 (모두 포함, 생략 금지):
1. [스터디카페 홍보 섹션] — 작업 메모리/인지 부하 → 커피랑도서관 자연 연결, 세스코 에어 + 날씨 환경 연결, 불릿 리스트, 800자 이상
2. ━━━━━━━━━━━━━━━━━━━━━
3. [마무리 제언] — 명언형 인용 + 결론 한줄 + 감사 인사 + 좋아요/댓글 독려, 500자 이상
4. [함께 읽으면 좋은 글] — 관련 포스팅 3개 추천
5. [해시태그] — 주제 관련 15개 + 스터디카페 홍보 12개 = 27개 이상 (질문형 키워드 포함)

글자수 요구: 전체 1,500자 이상. 스터디카페 섹션 최소 800자.`,
    },
  ];

  const result = await chunkedGenerate(GEMS_SYSTEM_PROMPT, chunks, {
    model,
    contextCarry: 200,
    maxRetries:   Number(generationRuntimeConfig.writerMaxRetries || 1),
    logMeta: { team: 'blog', bot: 'blog-gems', requestType: 'general_post_chunked' },
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
