'use strict';

/**
 * gems-writer.js (젬스 GEMS) — 일반 포스팅 작성
 *
 * IT 전략 컨설턴트 페르소나
 * 필수 7,000자 이상 (목표 9,000자)
 * 모델: GPT-4o (OpenAI) 또는 Gemini Flash (분할생성)
 */

const OpenAI            = require('openai');
const toolLogger        = require('../../../packages/core/lib/tool-logger');
const llmLogger         = require('../../../packages/core/lib/llm-logger');
const llmCache          = require('../../../packages/core/lib/llm-cache');
const { getTraceId }    = require('../../../packages/core/lib/trace');
const { chunkedGenerate } = require('../../../packages/core/lib/chunked-llm');

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
1. 총 글자수 6,000자 이상 (목표 8,000자) — 반드시 달성
2. 샌드위치 화법:
   [일상 에피소드/흥미 유발] → [날카로운 공학적/뇌과학적 근거] → [실천 가능한 쉬운 결론]
3. 어려운 용어 뒤에 반드시 일상적 비유 덧붙이기 (예: 작업 메모리는 책상 크기)
4. 뇌과학 키워드 활용: 몰입, 인지 부하, 작업 메모리
5. 1,000자마다 독자 소통 브릿지 문구 삽입
6. 커피랑도서관 분당서현점이 성과를 높이는 이유를 논리적으로 증명
7. ★ 날씨 맥락 2회 이상 자연스럽게 삽입 (서론 + 스터디카페 홍보 섹션)
8. 개인 경험/감상 표현 2회 이상

[필수 구조]
1. [AI 스니펫 요약] — 150자 내외, 검색 노출용
2. ━━━━━━━━━━━━━━━━━━━━━
3. [이 글에서 배울 수 있는 것] — 3~5개 목차 (GEO용)
4. ━━━━━━━━━━━━━━━━━━━━━
5. [승호아빠 인사말] — 날씨/시사 반영, 친근한 인사, 300자
6. ━━━━━━━━━━━━━━━━━━━━━
7. [본론 섹션 1] — 주제 도입 + 번호 리스트, 1,500자
8. ━━━━━━━━━━━━━━━━━━━━━
9. [본론 섹션 2] — 핵심 분석 + 불릿 리스트, 1,500자
10. ━━━━━━━━━━━━━━━━━━━━━
11. [본론 섹션 3] — 실천 전략 3가지 (번호 리스트), 1,500자
12. ━━━━━━━━━━━━━━━━━━━━━
13. [스터디카페 홍보 섹션] — 작업 메모리/인지 부하 → 커피랑도서관 자연 연결
    세스코 에어 + 날씨와 공간 환경 연결, 불릿 리스트, 800자
14. ━━━━━━━━━━━━━━━━━━━━━
15. [마무리 제언] — 명언형 인용 + 결론 한줄 + 감사 인사 + 좋아요/댓글 독려, 500자
16. [함께 읽으면 좋은 글] — 관련 과거 포스팅 3개 추천
17. [해시태그] — 주제 관련 15개 + 스터디카페 홍보 12개 = 27개+ (질문형 키워드 포함)

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

// ─── 일반 포스팅 생성 ────────────────────────────────────────────────

/**
 * @param {string} category
 * @param {object} researchData — 리처 수집 결과 (realExperiences, relatedPosts 포함)
 * @returns {{ content, charCount, model, title }}
 */
async function writeGeneralPost(category, researchData) {
  const today    = new Date().toLocaleDateString('ko-KR');
  const cacheKey = `gems_general_${category}_${new Date().toISOString().slice(0, 10)}`;

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

  const linkingBlock = relatedPosts.length > 0
    ? `\n[내부 링킹 — 결론 하단 "함께 읽으면 좋은 글" 3개 추천]\n` +
      relatedPosts.map((p, i) => `${i + 1}. ${p.title} — ${p.summary}`).join('\n') + '\n'
    : '';

  const userPrompt = `
다음 일반 포스팅을 작성하라:

[카테고리] ${category}
[발행일] ${today}
[오늘 날씨 — 서론 + 스터디카페 섹션에 각 1회 자연스럽게 활용]
${weatherContext}

[최신 IT 뉴스 (서론에 활용 — 상위 3개 선택)]
${itNews.slice(0, 5).map(n => `- ${n.title} (인기도: ${n.score})`).join('\n') || '- 최신 IT 트렌드를 자체 지식으로 언급하라'}

${researchData.book_info ? `[도서 정보]\n${JSON.stringify(researchData.book_info)}` : ''}
${experienceBlock}${linkingBlock}
카테고리 "${category}"에 맞는 주제를 자율 선정하여 작성하라.
글 첫 번째 줄에 제목을 [${category}] 형식으로 시작하라.

★★★ 글자수 요구사항 (반드시 준수) ★★★
전체 최소 8,000자 (한국어 기준). 각 섹션별 최소 글자수:
- [AI 스니펫 요약]: 150자
- [이 글에서 배울 수 있는 것]: 목차 3~5개
- [승호아빠 인사말]: 300자
- [본론 섹션 1]: 1,500자 (주제 도입 + 번호 리스트 상세 설명)
- [본론 섹션 2]: 1,500자 (핵심 분석 + 불릿 리스트 상세 설명)
- [본론 섹션 3]: 1,500자 (실천 전략 3가지 번호 리스트 + 각 전략 300자 이상)
- [스터디카페 홍보 섹션]: 800자
- [마무리 제언]: 500자
- [함께 읽으면 좋은 글]: 관련 포스팅 3개
- [해시태그]: 27개 이상
각 섹션을 생략하거나 줄이면 안 된다. 모든 섹션을 빠짐없이 충분히 작성하라.
  `.trim();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY 환경변수 없음');

  const openai    = new OpenAI({ apiKey });
  const startTime = Date.now();
  let response;
  try {
    response = await openai.chat.completions.create({
      model:      'gpt-4o',
      messages:   [
        { role: 'system', content: GEMS_SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
      max_tokens:  16000,
      temperature: 0.8,
    });
  } finally {
    const latencyMs = Date.now() - startTime;
    await toolLogger.logToolCall('openai', 'chat.completions.create', {
      bot:         'blog-gems',
      success:     !!response,
      duration_ms: latencyMs,
      metadata: {
        model:         'gpt-4o',
        input_tokens:  response?.usage?.prompt_tokens,
        output_tokens: response?.usage?.completion_tokens,
        cost_usd:      _estimateCost(response?.usage),
        category,
        trace_id:      getTraceId(),
      },
    });
    // llm-logger: LLM 비용 추적
    await llmLogger.logLLMCall({
      team:         'blog',
      bot:          'blog-gems',
      model:        response?.model || 'gpt-4o',
      requestType:  'general_post',
      inputTokens:  response?.usage?.prompt_tokens    || 0,
      outputTokens: response?.usage?.completion_tokens || 0,
      latencyMs,
      success:      !!response,
    });
  }

  const content   = response.choices[0]?.message?.content || '';
  const firstLine = content.split('\n').find(l => l.trim().length > 0) || '';
  const title     = firstLine.slice(0, 80).trim();

  const result = { content, charCount: content.length, model: response.model || 'gpt-4o', title };

  await llmCache.setCache('blog', 'general_post', cacheKey, JSON.stringify(result), 'gpt-4o');

  return result;
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
 * @returns {{ content, charCount, model, title }}
 */
async function writeGeneralPostChunked(category, researchData) {
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

  const linkingBlock = relatedPosts.length > 0
    ? `\n[내부 링킹 — 결론 하단 "함께 읽으면 좋은 글" 3개 추천]\n` +
      relatedPosts.map((p, i) => `${i + 1}. ${p.title} — ${p.summary}`).join('\n') + '\n'
    : '';

  const newsBlock = itNews.slice(0, 5).map(n => `- ${n.title} (인기도: ${n.score})`).join('\n')
    || '- 최신 IT 트렌드를 자체 지식으로 언급하라';

  const baseCtx = `
[카테고리] ${category}
[발행일] ${today}
[오늘 날씨] ${weatherContext}
[최신 IT 뉴스] ${newsBlock}
${researchData.book_info ? `[도서 정보]\n${JSON.stringify(researchData.book_info)}` : ''}
${experienceBlock}`.trim();

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

글자수 요구: 전체 2,000자 이상. 본론 섹션 1은 최소 1,500자.`,
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

  const startTime = Date.now();
  let result;
  try {
    result = await chunkedGenerate(GEMS_SYSTEM_PROMPT, chunks, {
      model,
      contextCarry: 200,
      maxRetries:   1,
      onChunkComplete: ({ id, charCount, index }) =>
        console.log(`[젬스청크] ${id} (${index + 1}/${chunks.length}): ${charCount}자`),
    });
  } finally {
    const latencyMs = Date.now() - startTime;
    await llmLogger.logLLMCall({
      team:         'blog',
      bot:          'blog-gems',
      model:        `${model}-chunked`,
      requestType:  'general_post_chunked',
      inputTokens:  result?.totalTokens?.input  || 0,
      outputTokens: result?.totalTokens?.output || 0,
      latencyMs,
      success:      !!result,
    });
  }

  const content   = result.content;
  const firstLine = content.split('\n').find(l => l.trim().length > 0) || '';
  const title     = firstLine.slice(0, 80).trim();

  console.log(`[젬스청크] 전체 ${result.charCount}자 (${chunks.length}청크)`);

  return { content, charCount: result.charCount, model: `chunked-${model}`, title };
}

module.exports = { writeGeneralPost, writeGeneralPostChunked, GEMS_SYSTEM_PROMPT };
