'use strict';

/**
 * pos-writer.js (포스 POS) — 강의 포스팅 작성
 *
 * 시니어 백엔드 아키텍트 페르소나
 * 필수 8,000자 이상 (목표 9,000자)
 * 모델: GPT-4o (OpenAI)
 */

const toolLogger = require('../../../packages/core/lib/tool-logger');
const llmCache   = require('../../../packages/core/lib/llm-cache');
const { getTraceId }      = require('../../../packages/core/lib/trace');
const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');

// 폴백 체인: gpt-4o → gpt-4o-mini → gemini-2.5-flash
const POS_LLM_CHAIN = [
  { provider: 'openai', model: 'gpt-4o',                                  maxTokens: 16000, temperature: 0.82 },
  { provider: 'openai', model: 'gpt-4o-mini',                             maxTokens: 16000, temperature: 0.82 },
  { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash',       maxTokens: 12000, temperature: 0.75 },
];

// ─── ai-agent-system 프로젝트 컨텍스트 (AI 탐지 우회용) ─────────────

const AI_AGENT_CONTEXT = `
[마스터의 실제 프로젝트: ai-agent-system]
재룡 님(닉네임 승호아빠)이 직접 개발·운영 중인 멀티에이전트 AI 봇 시스템.
5개 팀(스카·루나·클로드·블로·워커), 30+ 봇으로 구성된 실제 운영 시스템.

팀 구성:
- 스카팀: 스터디카페 예약/매출 자동 관리 (봇 7개)
- 루나팀: 암호화폐·국내외주식 자동매매 (봇 11개, 크립토 실투자 OPS)
- 클로드팀: 시스템 감시/복구 자동화 — 덱스터(점검봇), 아처(기술인텔리전스)
- 블로팀: 블로그 자동 포스팅 — 블로·리처·포스·젬스·퍼블 5봇
- 워커팀: 외주 인력 관리 SaaS (Near-OWASP 보안 적용)

기술 스택: Node.js, PostgreSQL+pgvector(RAG), OpenAI/Groq/Gemini LLM
특징: MessageEnvelope 봇 간 통신, trace_id 전체 추적, Shadow Mode 단계별 자율화

강의 주제별 실제 적용 매핑:
- DB/Pool → pg-pool.js 커넥션 풀 설계 (reservation/blog/investment 스키마 분리)
- 비동기 패턴 → 30+ 봇 병렬 실행 아키텍처
- 이벤트 루프 → 덱스터 22개 감시 체크 비동기 처리
- 스트림 → 헤르메스 봇의 실시간 시세 스트리밍
- 암호화 → API 키 암호화 llm-keys.js
- 스케줄링 → launchd 기반 봇 자동 실행 (8개 cron job)
- WebSocket → 텔레그램 봇 실시간 알림 시스템
- Redis/캐시 → llm-cache.js LLM 응답 시맨틱 캐싱
- 테스트 → 워커팀 85건 테스트 스위트
- 로깅 → tool-logger.js LLM API 호출 비용 추적

포스팅에 자연스럽게 1~2회 녹여라. "제가 직접 운영하는 ai-agent-system에서..." 형태로.
구체적 봇 이름, 모듈명을 사용하라 — AI가 만들어낼 수 없는 고유 정보.
`.trim();

// ─── GEO 최적화 규칙 ─────────────────────────────────────────────────

const GEO_RULES = `
[GEO(Generative Engine Optimization) 규칙]
AI 검색엔진(네이버 AI, ChatGPT, Gemini)이 이 글을 출처로 인용할 수 있도록:
1. 글 최상단 [핵심 요약 3줄] — AI가 즉시 추출 가능한 150자 요약 (인사말 섹션 바로 위)
2. FAQ 질문을 실제 사용자가 검색할 법한 문장으로 작성 (예: "Node.js에서 XXX를 방어하는 가장 좋은 방법은?")
3. 비교 표에 "결론" 행 추가 (AI 한줄 요약 추출용)
4. 권위적 출처 명시: Node.js 공식 문서 URL, CVE 번호
5. 저자 명시: "승호아빠(15년 시니어 IT 컨설턴트, 커피랑도서관 대표)"를 서두에 한 번 기재
`.trim();

// ─── 날씨 → 글 맥락 변환 ─────────────────────────────────────────────

function _weatherToContext(weather) {
  const desc = weather.description || '맑음';
  const temp = weather.temperature != null ? `${weather.temperature}°C` : '';
  const feels = weather.feels_like != null ? ` (체감 ${weather.feels_like}°C)` : '';
  const hum  = weather.humidity != null ? `, 습도 ${weather.humidity}%` : '';

  if (/비|rain/i.test(desc))  return `봄비가 추적추적 내리는 ${temp}의 오늘${hum}`;
  if (/눈|snow/i.test(desc))  return `눈이 내리는 ${temp}의 겨울 아침${hum}`;
  if (/흐림|cloud/i.test(desc)) return `흐린 하늘 아래 ${temp}${feels}의 쌀쌀한 오늘${hum}`;
  if (weather.temperature < 10) return `기온 ${temp}${feels}의 쌀쌀한 오늘, 커피 한 잔이 생각나는`;
  if (weather.temperature > 28) return `${temp}의 무더운 오늘, 에어컨 바람이 시원한`;
  return `${desc} ${temp}${feels}의 쾌청한 오늘${hum}`;
}

// ─── OpenAI 비용 추정 ─────────────────────────────────────────────────

function _estimateCost(usage) {
  if (!usage) return 0;
  // gpt-4o: input $2.5/1M, output $10/1M
  return ((usage.prompt_tokens || 0) * 2.5 + (usage.completion_tokens || 0) * 10) / 1_000_000;
}

// ─── 시스템 프롬프트 ─────────────────────────────────────────────────

const POS_SYSTEM_PROMPT = `
너는 시니어 백엔드 아키텍트이자 IT 지식 큐레이터 '포스(POS)'다.
재룡 님의 닉네임인 '승호아빠'로 활동하며, 블로그를 방문하는 고객들에게
정중하고 신뢰감 있는 문체를 유지하라.

박사급 전문성을 바탕으로 하되, 복잡한 공학 지식을 일반인도 이해하기 쉬운 비유로
친절하게 해설하라. 15년 공직 경험을 기반으로 한 비유를 적극 활용하라.

${AI_AGENT_CONTEXT}

${GEO_RULES}

[필수 작성 규칙]
1. 총 글자수 8,000자 이상 (목표 9,000자) — 반드시 달성
2. 마크다운 기호(**)가 본문에 노출되지 않도록 하라 (굵게 표현 시 네이버 방식 사용)
3. 코드 블록에는 상세한 주석을 달아라
4. 기술 용어는 괄호를 통해 쉽게 풀이
5. 1,000자마다 독자 소통 브릿지 문구 삽입 ("어떠세요, 이해가 되셨나요?" 등)
6. Node.js 공식 문서 출처 명시
6-1. [섹션 내 참고 링크 삽입 규칙]
   각 주요 섹션에 관련 공식 문서 또는 참고 링크를 1~2개 자연스럽게 삽입하라.
   허용 도메인 (이 도메인만 사용 — 환각 방지):
     nodejs.org/api/  · developer.mozilla.org/  · github.com/
     npmjs.com/package/  · expressjs.com/  · redis.io/docs/  · www.postgresql.org/docs/
   삽입 형식: → 자세한 내용은 [문서명](URL) 참고 ← 여기에 링크 삽입
   삽입 위치:
     [강의 - 이론] 섹션: 해당 기술의 공식 문서 1개
     [실무 - 코드] 섹션: 사용한 라이브러리 npm 또는 공식 문서 1개
     [AEO FAQ] 섹션: 관련 공식 문서 1개 (Q&A 답변 근거)
   주의: URL을 확실히 아는 것만 삽입. 모르면 "← 여기에 링크 삽입" 안내만 하라.
         존재하지 않는 URL 절대 생성 금지.
7. ★ 날씨 맥락 3회 이상 자연스럽게 삽입 (인사말/본문 중간/결론)
8. 개인 경험/감상 표현 2회 이상 ("제가 직접 운영하는 시스템에서...", "솔직히...")
9. 모든 섹션을 빠짐없이 작성 완료한 후, 반드시 마지막 줄에 _THE_END_ 를 적어라.
   _THE_END_ 가 없으면 글이 미완성된 것으로 간주한다.
   절대로 중간에 멈추지 말라. 해시태그까지 모두 작성한 후 _THE_END_ 로 끝내라.

[필수 구조 — 각 섹션의 최소 글자수를 반드시 준수하라]
0. [핵심 요약 3줄] — 150자 (AI 스니펫용)
1. [승호아빠 인사말] — 최소 300자 (날씨/시사 반영)
2. [최신 기술 브리핑] — 최소 1,000자 (Node.js 릴리스/보안)
3. [전문가의 실무 인사이트 ①] — 최소 500자
4. ━━━━━━━━━━━━━━━━━━━━━
5. [강의 - 이론] — 최소 2,000자 ★ (핵심 개념 상세 설명)
6. [전문가의 실무 인사이트 ②] — 최소 500자
7. ━━━━━━━━━━━━━━━━━━━━━
8. [실무 - 코드 및 아키텍처] — 최소 2,000자 ★ (코드 3개+ 상세 주석)
9. [전문가의 실무 인사이트 ③] — 최소 500자
10. ━━━━━━━━━━━━━━━━━━━━━
11. [에러 탐지 신경망과 환경의 역학] — 최소 800자
    (ACC-ERN, CO₂ 800ppm 이하, 세스코 에어 시스템, 집중력 환경 언급)
12. [전문가의 실무 인사이트 ④] — 최소 300자
13. ━━━━━━━━━━━━━━━━━━━━━
14. [AEO FAQ] — 최소 800자 (Q&A 4~5개)
15. ━━━━━━━━━━━━━━━━━━━━━
16. [마무리 인사] — 최소 300자
17. [함께 읽으면 좋은 글] — 3개 추천 (내부 링킹)
18. [해시태그] — 22개+

위 글자수를 합산하면 최소 9,150자이다.
각 섹션의 최소 글자수를 반드시 준수하라.

[스터디카페 홍보 키워드 (자연스럽게 녹이기)]
- 커피랑도서관 분당서현점
- 세스코 에어 살균 시스템
- CO₂ 800ppm 이하 청정 환경
- 분당 서현역 도보 거리
- 24시 운영

[코드 스타일]
- JavaScript (Node.js)
- async/await 패턴
- JSDoc 주석 포함
- 안티패턴 vs 권장 패턴 대비

반드시 순수 텍스트로 출력하라. HTML 태그 없이.
각 섹션은 [섹션명] 형태로 구분하라.
`.trim();

// ─── sectionVariation 지시 블록 생성 ────────────────────────────────

/**
 * sectionVariation 객체를 LLM 지시 텍스트로 변환.
 * variation이 비어있으면 빈 문자열 반환.
 *
 * @param {object} variation - maestro.buildDynamicVariation() 결과
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
  if (variation.insightCount)   lines.push(`실무 인사이트 개수: ${variation.insightCount}개`);
  if (variation.codeBlockCount) lines.push(`코드 블록 수: ${variation.codeBlockCount}개 이상`);
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
      after_theory: '강의 이론 직후',
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

// ─── 강의 포스팅 생성 ────────────────────────────────────────────────

/**
 * @param {number} lectureNumber
 * @param {string} lectureTitle
 * @param {object} researchData    — 리처 수집 결과 (realExperiences, relatedPosts 포함)
 * @param {object} sectionVariation — 마에스트로 변형 지시 (옵셔널, 기본값 {})
 * @returns {{ content, charCount, model }}
 */
async function writeLecturePost(lectureNumber, lectureTitle, researchData, sectionVariation = {}) {
  const cacheKey = `pos_lecture_${lectureNumber}`;

  // 캐시 확인 (당일 재실행 중복 방지)
  const cached = await llmCache.getCached('blog', 'lecture_post', cacheKey);
  if (cached) {
    console.log('[포스] 캐시 히트:', cacheKey);
    try { return JSON.parse(cached.response); } catch {}
  }

  const weather        = researchData.weather        || {};
  const nodejsUpdates  = researchData.nodejs_updates || [];
  const itNews         = researchData.it_news        || [];
  const realExperiences = researchData.realExperiences || [];
  const relatedPosts   = researchData.relatedPosts   || [];

  const weatherContext = _weatherToContext(weather);

  // 실전 에피소드 블록
  const experienceBlock = realExperiences.length > 0
    ? `\n[실전 에피소드 — "전문가의 실무 인사이트" 또는 코드 주석에 자연스럽게 녹여라]\n` +
      realExperiences.map((ep, i) =>
        `${i + 1}. [${ep.type}] ${ep.content}`
      ).join('\n') +
      `\n중요: "제가 실제로 운영하는 ai-agent-system에서 겪은 경험"으로 풀어서 설명하라.\n`
    : '';

  // 내부 링킹 블록 (Phase 1: 제목만 + "← 여기에 링크 삽입" 안내)
  const linkingBlock = relatedPosts.length > 0
    ? `\n[내부 링킹 — 이전 포스팅 제목만 표시]\n` +
      `★ 중요: "함께 읽으면 좋은 글"에는 반드시 이미 발행된 과거 포스팅만 추천하라.\n` +
      `현재 강의 번호(${lectureNumber}강)보다 앞선 강의만 포함.\n` +
      `아직 작성되지 않은 미래 강의(${lectureNumber + 1}강 이상)의 제목을 절대 넣지 말라.\n\n` +
      `각 추천 글은 아래 형식으로 작성하라:\n` +
      `  → [제목] ← 여기에 링크 삽입\n\n` +
      `참고 가능한 과거 포스팅 목록:\n` +
      relatedPosts.map((p, i) => `${i + 1}. ${p.title} — ${p.summary}`).join('\n') + '\n'
    : '';

  const userPrompt = `
다음 강의 포스팅을 작성하라:

[강의 정보]
강의 번호: ${lectureNumber}강
강의 제목: ${lectureTitle}

★★★ 핵심 준수 사항 ★★★
이 포스팅의 메인 주제는 반드시 "${lectureTitle}"이어야 한다.
- 포스팅 제목(H1)은 "${lectureTitle}"을 기반으로 블로그 친화적으로 변형 가능하나,
  반드시 "${lectureTitle}"의 핵심 키워드와 기술 주제를 그대로 포함해야 한다.
- [강의 - 이론] 및 [실무 - 코드] 섹션은 "${lectureTitle}" 주제를 직접 다루어야 한다.
- 다른 기술이나 주제로 대체하거나 "${lectureTitle}" 주제를 부제목으로 밀어내면 안 된다.
- 예: 제목이 "데이터베이스 마이그레이션 전략"이면 코드·이론 모두 마이그레이션을 다루어야 함.

[오늘 날씨 — 반드시 3회 이상 자연스럽게 활용]
${weatherContext}

[최신 Node.js 정보 (브리핑에 활용)]
${nodejsUpdates.length > 0
  ? nodejsUpdates.map(u => `- ${u.tag}: ${u.name} (${u.date})`).join('\n')
  : '- 최신 Node.js 정보를 자체 보유 지식으로 보충하라'}

[최신 IT 뉴스 (인사말에 활용)]
${itNews.slice(0, 3).map(n => `- ${n.title}`).join('\n') || '- 최신 IT 트렌드를 자체 지식으로 언급하라'}
${experienceBlock}${linkingBlock}
이전 강의 (${lectureNumber - 1}강) 내용을 자연스럽게 연결하고,
다음 강의 (${lectureNumber + 1}강) 내용을 마무리에서 예고하라.

★★★ 글자수 요구사항 (반드시 준수) ★★★
전체 최소 8,000자 (한국어 기준). 각 섹션별 최소 글자수:
- [핵심 요약 3줄]: 150자
- [승호아빠 인사말]: 300자
- [최신 기술 브리핑]: 1,200자 (Node.js 릴리스 + 보안 이슈 상세 설명)
- [전문가의 실무 인사이트 ①②③④] 각 600자
- [강의 - 이론]: 2,500자 (개념 + 비유 + 역사 + 원리 상세 설명)
- [실무 - 코드 및 아키텍처]: 2,500자 (코드 3개 이상 + 주석 + 안티패턴 대비)
- [에러 탐지 신경망과 환경의 역학]: 900자
- [AEO FAQ]: 900자 (Q&A 5개)
- [마무리 인사 + 함께 읽으면 좋은 글]: 400자
- [해시태그]: 22개 이상
각 섹션을 생략하거나 줄이면 안 된다. 모든 섹션을 빠짐없이 충분히 작성하라.
${_buildVariationBlock(sectionVariation)}
[출력 규칙]
- 이 강의는 수강생이 실무에 즉시 적용할 수 있도록 빈틈없이(exhaustively) 작성되어야 한다.
- 각 섹션을 충분하고 상세하게(comprehensively and thoroughly) 서술하라.
- 절대 요약하거나 축약하지 말라. 모든 개념을 풍부한 예시와 함께 설명하라.
- 이 글은 전문가가 집필하는 기술 서적의 한 챕터에 해당하는 분량이어야 한다.
- 코드 블록마다 최소 5줄 이상의 상세한 주석을 포함하라.
- 반드시 모든 섹션을 작성하고 _THE_END_ 로 마무리하라.
  `.trim();

  const startTime = Date.now();
  let usedModel = 'gpt-4o';
  let fallbackUsed = false;
  let content;

  try {
    const result = await callWithFallback({
      chain:        POS_LLM_CHAIN,
      systemPrompt: POS_SYSTEM_PROMPT,
      userPrompt,
      logMeta: { team: 'blog', bot: 'blog-pos', requestType: 'lecture_post' },
    });
    content      = result.text;
    usedModel    = result.model;
    fallbackUsed = result.attempt > 1;
    if (fallbackUsed) console.log(`[포스] LLM 폴백 발생: ${result.provider}/${result.model} (시도 ${result.attempt})`);
  } finally {
    await toolLogger.logToolCall('llm', 'callWithFallback', {
      bot: 'blog-pos', success: !!content,
      duration_ms: Date.now() - startTime,
      metadata: { model: usedModel, lecture_num: lectureNumber, trace_id: getTraceId(), fallback_used: fallbackUsed },
    }).catch(() => {});
  }

  const MIN_CHARS_LECTURE = 7000;

  // ── Continue 이어쓰기: 글자수 부족 + _THE_END_ 없으면 2차 호출 ──
  if (content.length < MIN_CHARS_LECTURE && !content.includes('_THE_END_')) {
    console.log(`[포스] 글자수 부족 (${content.length}자) — 이어쓰기 호출`);

    // 마지막 800자만 컨텍스트로 전달 (전체 내용 전달 시 LLM이 새 글을 시작하는 문제 방지)
    const tailContext    = content.slice(-800);
    const continuePrompt = `[이전 내용 끝부분 (이미 작성됨 — 절대 반복 금지)]\n${tailContext}\n\n[지시] 위 내용이 끊긴 부분에서 바로 이어서 작성하라. 앞 내용은 이미 완성되었으므로 반드시 끊긴 지점부터 시작하라. 새 글을 처음부터 쓰지 말 것. 남은 섹션을 모두 완성하고 마지막에 _THE_END_ 를 적어라.`;
    const POS_CONTINUE_CHAIN = POS_LLM_CHAIN.map(c => ({ ...c, maxTokens: 8000 }));

    try {
      const cont = await callWithFallback({
        chain:        POS_CONTINUE_CHAIN,
        systemPrompt: POS_SYSTEM_PROMPT,
        userPrompt:   continuePrompt,
        logMeta: { team: 'blog', bot: 'blog-pos', requestType: 'lecture_post_continue' },
      });
      // LLM이 새 글을 처음부터 시작한 경우 감지 (첫 줄이 # 제목 + 분량이 원본의 50% 이상이면 재시작으로 간주)
      const contFirstLine = cont.text.trim().split('\n')[0] || '';
      const isRestart     = contFirstLine.startsWith('#') && cont.text.length > content.length * 0.5;
      if (isRestart) {
        console.warn(`[포스] ⚠️ 이어쓰기 LLM이 새 글 시작 감지 — 이어붙이기 건너뜀 (${cont.text.length}자)`);
      } else {
        content = content + '\n' + cont.text;
      }
    } catch (e) {
      console.warn(`[포스] 이어쓰기 실패 (무시): ${e.message}`);
    }

    console.log(`[포스] 이어쓰기 완료: ${content.length}자`);
  }

  // _THE_END_ 마커 제거
  content = content.replace(/_THE_END_/g, '').trim();

  const result  = {
    content,
    charCount: content.length,
    model:     usedModel,
    fallbackUsed,
  };

  // 최소 글자수 달성 시에만 캐시 저장 (실패 결과 캐시 방지)
  if (content.length >= MIN_CHARS_LECTURE) {
    await llmCache.setCache('blog', 'lecture_post', cacheKey, JSON.stringify(result), 'gpt-4o');
  } else {
    console.log(`[포스] 글자수 미달 (${content.length}자) — 캐시 저장 건너뜀`);
  }

  return result;
}

// ─── 분할 생성 — 강의 포스팅 (무료 API용) ────────────────────────────

const { chunkedGenerate } = require('../../../packages/core/lib/chunked-llm');

/**
 * 4그룹으로 나눠서 호출 → 합쳐서 하나의 강의 포스팅 완성
 * 환경변수 BLOG_LLM_MODEL: 'gemini' (무료) | 'gpt4o' (유료 폴백)
 *
 * @param {number} lectureNumber
 * @param {string} lectureTitle
 * @param {object} researchData
 * @param {object} sectionVariation — 마에스트로 변형 지시 (옵셔널, 기본값 {})
 */
async function writeLecturePostChunked(lectureNumber, lectureTitle, researchData, sectionVariation = {}) {
  const weather         = researchData.weather        || {};
  const nodejsUpdates   = researchData.nodejs_updates || [];
  const itNews          = researchData.it_news        || [];
  const realExperiences = researchData.realExperiences || [];
  const relatedPosts    = researchData.relatedPosts   || [];

  const weatherContext  = _weatherToContext(weather);
  const model           = process.env.BLOG_LLM_MODEL || 'gemini';

  const experienceBlock = realExperiences.length > 0
    ? realExperiences.map((ep, i) => `${i + 1}. [${ep.type}] ${ep.content}`).join('\n')
    : '';
  const linkingBlock = relatedPosts.length > 0
    ? relatedPosts.map((p, i) => `${i + 1}. ${p.title} — ${p.summary}`).join('\n')
    : '';

  const chunks = [
    {
      id: 'group_a', minChars: 2000,
      prompt: `
다음 강의 포스팅의 [그룹 A]를 작성하라.

[강의 정보] ${lectureNumber}강: ${lectureTitle}
★ 이 포스팅의 메인 주제는 반드시 "${lectureTitle}"이어야 한다. 다른 주제로 대체 금지.
[오늘 날씨] ${weatherContext}
[최신 IT 뉴스] ${itNews.slice(0, 3).map(n => n.title).join(' / ') || '최신 IT 트렌드 자체 지식'}
[최신 Node.js] ${nodejsUpdates.map(u => `${u.tag} ${u.name}`).join(', ') || '자체 지식 보충'}

작성할 섹션 (이것만 작성하라):
  [핵심 요약 3줄] — 150자 내외 AI 스니펫용
  [승호아빠 인사말] — 날씨+시사 반영, 300자
  [최신 기술 브리핑] — Node.js 릴리스/보안 이슈, 1,200자
  [전문가의 실무 인사이트 ①] — 비즈니스 관점, 500자

총 2,500자 이상. 날씨 맥락 1회 포함.
이전 강의(${lectureNumber - 1}강) 내용을 인사말에서 간략히 연결하라.
${_buildVariationBlock(sectionVariation)}      `.trim(),
    },
    {
      id: 'group_b', minChars: 2000,
      prompt: `
다음 강의 포스팅의 [그룹 B]를 작성하라.

[강의 정보] ${lectureNumber}강: ${lectureTitle}
★ [강의 - 이론] 섹션은 반드시 "${lectureTitle}" 주제만 다루어야 한다. 다른 기술로 대체 금지.
${experienceBlock ? `[실전 에피소드]\n${experienceBlock}\n→ "제가 운영하는 ai-agent-system에서 겪은 경험"으로 녹여라` : ''}

작성할 섹션 (이것만 작성하라):
  ━━━━━━━━━━━━━━━━━━━━━
  [강의 - 이론] — ${lectureTitle}의 핵심 개념, 2,000자+
  [전문가의 실무 인사이트 ②] — 기획 단계 관점, 500자

총 2,500자 이상. 코드 용어에 괄호 풀이.
      `.trim(),
    },
    {
      id: 'group_c', minChars: 2000,
      prompt: `
다음 강의 포스팅의 [그룹 C]를 작성하라.

[강의 정보] ${lectureNumber}강: ${lectureTitle}
★ [실무 - 코드] 섹션의 코드는 반드시 "${lectureTitle}" 주제를 직접 구현해야 한다. 다른 기술 코드 대체 금지.

작성할 섹션 (이것만 작성하라):
  ━━━━━━━━━━━━━━━━━━━━━
  [실무 - 코드 및 아키텍처] — JavaScript(Node.js) 실습 코드 3개+, JSDoc 주석, 안티패턴 vs 권장 패턴, 2,000자+
  [전문가의 실무 인사이트 ③] — 코드의 비즈니스 가치, 500자

총 2,500자 이상. 날씨 맥락 1회 삽입. async/await 패턴, 상세 주석 필수.
      `.trim(),
    },
    {
      id: 'group_d', minChars: 1500,
      prompt: `
다음 강의 포스팅의 [그룹 D]를 작성하라.

[강의 정보] ${lectureNumber}강: ${lectureTitle}
[오늘 날씨] ${weatherContext}
${linkingBlock ? `[관련 과거 포스팅]\n${linkingBlock}` : ''}

작성할 섹션 (이것만 작성하라):
  ━━━━━━━━━━━━━━━━━━━━━
  [에러 탐지 신경망과 환경의 역학] — 커피랑도서관 분당서현점 홍보, ACC-ERN, 세스코 에어, 800자
  [전문가의 실무 인사이트 ④] — 공간과 아키텍트, 300자
  ━━━━━━━━━━━━━━━━━━━━━
  [AEO FAQ] — Q&A 4~5개, 800자
  ━━━━━━━━━━━━━━━━━━━━━
  [마무리 인사] — 다음 강의(${lectureNumber + 1}강) 예고, 300자
  [함께 읽으면 좋은 글] — 과거 포스팅 3개 추천
  [해시태그] — 주제 12개 + 스터디카페 10개 = 22개+

총 2,000자 이상. 날씨 맥락 1회 포함.
      `.trim(),
    },
  ];

  const startTime = Date.now();
  const result    = await chunkedGenerate(POS_SYSTEM_PROMPT, chunks, {
    model,
    contextCarry: 200,
    maxRetries:   1,
    onChunkComplete: ({ id, charCount, index }) =>
      console.log(`[포스] 청크 ${id} 완료: ${charCount}자 (${index + 1}/4)`),
  });

  console.log(`[포스] 분할생성 완료: 총 ${result.charCount}자 (${((Date.now() - startTime) / 1000).toFixed(1)}초)`);

  await llmLogger.logLLMCall({
    team: 'blog', bot: 'blog-pos',
    model:        `${model}-chunked`,
    requestType:  'lecture_post_chunked',
    inputTokens:  result.totalTokens.input,
    outputTokens: result.totalTokens.output,
    latencyMs:    Date.now() - startTime,
  }).catch(() => {});

  return {
    content:   result.content,
    charCount: result.charCount,
    model:     `chunked-${model}`,
  };
}

module.exports = { writeLecturePost, writeLecturePostChunked, POS_SYSTEM_PROMPT };
