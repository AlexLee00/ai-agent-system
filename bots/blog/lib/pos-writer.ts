// @ts-nocheck
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
const { callHubLlm } = require('../../../packages/core/lib/hub-client');
const { weatherToContext, estimateCost, loadPersonaGuide } = require('../../../packages/core/lib/blog-utils');
const env = require('../../../packages/core/lib/env');
const path = require('path');
const { buildBlogSkillBundle } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/skills/blog/skill-loader.js'));
const { buildAIBriefingSectionOrder, buildAIBriefingChecklist } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/ai-briefing.ts'));
const { getBlogGenerationRuntimeConfig, getBlogLLMSelectorOverrides } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/runtime-config.ts'));
const { calculateSectionChars, buildCharCountInstruction } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/section-ratio.ts'));
const { isAgentIntroLecture } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/agent-intro-curriculum.ts'));
const { buildBlogFormatInstruction } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/blog-format-rules.ts'));
const { buildWritingLearningsPromptBlock } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/writing-learnings.ts'));
const {
  resolveBlogWriterModel,
  writerModelCacheSuffix,
  buildWriterFamilyRequestOptions,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/writer-model-policy.ts'));
const { buildLifecyclePromptContext } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/agent-lifecycle.ts'));
const { AgentMemory } = require('../../../packages/core/lib/agent-memory');

const generationRuntimeConfig = getBlogGenerationRuntimeConfig();
const BLOG_WRITER_TIMEOUT_MS = Number(generationRuntimeConfig.writerTimeoutMs || 90000);
const BLOG_CONTINUE_TIMEOUT_MS = Number(generationRuntimeConfig.continueTimeoutMs || BLOG_WRITER_TIMEOUT_MS);
const BLOG_CHUNK_TIMEOUT_MS = Number(generationRuntimeConfig.chunkTimeoutMs || Math.max(BLOG_WRITER_TIMEOUT_MS, 120000));

function joinLifecycleTopic(parts = []) {
  return parts.map((item) => String(item || '').trim()).filter(Boolean).join(' | ');
}

async function buildBlogLifecyclePromptBlock({ topic = '', category = '', stage = 'writer' } = {}) {
  try {
    const context = await buildLifecyclePromptContext({
      team: 'blog',
      agent: 'pos',
      topic,
      enabled: process.env.BLOG_LIFECYCLE_INJECT_ENABLED === 'true',
      telemetry: { stage, category },
    });
    return context.promptBlock || '';
  } catch {
    return '';
  }
}

function isHubWriterTimeout(error) {
  const message = String(error?.message || error || '');
  return message.includes('hub_llm_call_failed:타임아웃')
    || message.includes('AbortError')
    || message.includes('timeout');
}

async function callPosWriterLlm({ systemPrompt, userPrompt, taskType, maxTokens = 16000, timeoutMs = BLOG_WRITER_TIMEOUT_MS, writerModel = resolveBlogWriterModel() }) {
  const selectorOverrides = getBlogLLMSelectorOverrides();
  return callHubLlm({
    callerTeam: 'blog',
    agent: 'pos',
    abstractModel: writerModel,
    ...buildWriterFamilyRequestOptions(writerModel),
    selectorKey: 'blog.pos.writer',
    policyOverride: selectorOverrides['blog.pos.writer'] || null,
    taskType,
    systemPrompt,
    prompt: userPrompt,
    maxTokens,
    timeoutMs,
  });
}

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

기술 스택: Node.js, PostgreSQL+pgvector(RAG), OpenAI/Groq/Claude LLM
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

const CAFE_FACT_GUARDRAILS = `
[커피랑도서관 분당서현점 사실 검증 규칙]
- 우리 스터디카페 이름은 "커피랑도서관 분당서현점"이다. "카페온"이라고 쓰지 말라.
- 현재 할인행사, 할인 이벤트, 쿠폰, 무료 체험, 프로모션을 진행한다고 쓰지 말라.
- 가격/할인/행사/예약 혜택은 검증된 입력이 없으면 절대 만들지 말라.
- 세스코 에어는 공기질 관리 기능으로만 설명하라. 과장된 효능이나 인증 표현을 만들지 말라.
`.trim();

// ─── GEO 최적화 규칙 ─────────────────────────────────────────────────

const GEO_RULES = `
[GEO(Generative Engine Optimization) 규칙]
AI 검색엔진(네이버 AI, ChatGPT 등)이 이 글을 출처로 인용할 수 있도록:
1. 글 최상단 [핵심 요약 3줄] — AI가 즉시 추출 가능한 150자 요약 (인사말 섹션 바로 위)
2. FAQ 질문을 실제 사용자가 검색할 법한 문장으로 작성 (예: "Node.js에서 XXX를 방어하는 가장 좋은 방법은?")
3. 비교 표에 "결론" 행 추가 (AI 한줄 요약 추출용)
4. 권위적 출처 명시: Node.js 공식 문서 URL, CVE 번호
5. 저자 명시: "승호아빠(15년 시니어 IT 컨설턴트, 커피랑도서관 대표)"를 서두에 한 번 기재
`.trim();

const BLOG_SKILL_BUNDLE = buildBlogSkillBundle([
  'naverSeo',
  'contentQuality',
  'imageGen',
  'shortformVideo',
  'blogRag',
]);

function _buildLectureSeriesGuidance(researchData = {}, lectureTitle = '') {
  const displayName = String(researchData.lectureSeriesDisplayName || '').trim();
  const seriesName = String(researchData.lectureSeriesName || '').trim();
  const isAgentIntro = isAgentIntroLecture(`${displayName} ${seriesName}`, lectureTitle);
  if (!isAgentIntro) {
    const nodejsUpdates = researchData.nodejs_updates || [];
    return {
      briefingTitle: '최신 Node.js 정보',
      briefingContent: nodejsUpdates.length > 0
        ? nodejsUpdates.map(u => `- ${u.tag}: ${u.name} (${u.date})`).join('\n')
        : '- 최신 Node.js 정보를 자체 보유 지식으로 보충하라',
      briefingRequirement: 'Node.js 릴리스 + 보안 이슈 상세 설명',
      codeRule: '코드 블록에서 require/import하는 패키지는 실제 npm 또는 Node.js 표준 라이브러리만 사용하라.',
      codeFallbackRule: '가상의 API나 메서드는 만들지 말고, 확실하지 않으면 표준 라이브러리로 해결하라.',
      chunkBriefingLine: `[최신 Node.js] ${nodejsUpdates.map(u => `${u.tag} ${u.name}`).join(', ') || '자체 지식 보충'}`,
      chunkBriefingRequirement: 'Node.js 릴리스/보안 이슈',
      practiceRequirement: 'JavaScript(Node.js) 실습 코드 3개+, JSDoc 주석, 안티패턴 vs 권장 패턴',
    };
  }

  const curriculumUpdates = Array.isArray(researchData.curriculum_updates)
    ? researchData.curriculum_updates
    : [];
  const weeklyNews = curriculumUpdates.length > 0
    ? curriculumUpdates.slice(0, 2).map((u) => `- ${u.title}${u.url ? ` (${u.url})` : ''}`).join('\n')
    : '';
  return {
    briefingTitle: '최신 AI 코딩 에이전트 정보',
    briefingContent: [
      weeklyNews ? `[이번 주 소식 후보]\n${weeklyNews}` : '',
      '- ChatGPT Codex와 Claude Code의 실제 사용 흐름, 장단점, 초보자 실습 관점을 중심으로 설명하라.',
      '- 검증되지 않은 가격, 기능 출시일, 프로모션, 특정 할인 정보는 만들지 말라.',
      '- 코딩을 모르는 일반인도 따라 할 수 있도록 도구 선택보다 작업 분해와 검증 절차를 우선하라.',
    ].filter(Boolean).join('\n'),
    briefingRequirement: 'AI 코딩 에이전트 활용 흐름 + 실습 준비 + 안전한 검증 관점 상세 설명',
    codeRule: '코드 예시는 복사해 따라 할 수 있는 HTML, JavaScript, shell 명령, 체크리스트 수준으로 제한하라.',
    codeFallbackRule: '검증되지 않은 SDK/API를 만들지 말고, 불확실하면 의사코드보다 체크리스트와 파일 구조 예시로 설명하라.',
    chunkBriefingLine: '[최신 AI 코딩 에이전트] ChatGPT Codex, Claude Code, 프롬프트 기반 구현, 작업 분해, 결과 검증 관점으로 보충',
    chunkBriefingRequirement: 'AI 코딩 에이전트 활용 흐름/실습 준비/검증 포인트',
    practiceRequirement: '일반인이 따라 할 수 있는 HTML/JavaScript/명령어/체크리스트 예시 3개+, 단계별 주석, 실패 시 수정 요청 예시',
  };
}

function _isAiImplementationLecture(researchData = {}, lectureTitle = '') {
  const displayName = String(researchData.lectureSeriesDisplayName || '').trim();
  const seriesName = String(researchData.lectureSeriesName || '').trim();
  return isAgentIntroLecture(`${displayName} ${seriesName}`, lectureTitle);
}

function _buildAgentIntroToolFactRules(lectureNumber, lectureTitle) {
  const title = String(lectureTitle || '').trim();
  const number = Number(lectureNumber || 0);
  const isCodexInstall = number === 6 || /Codex\s*설치|코덱스\s*설치/i.test(title);
  const isClaudeInstall = number === 5 || /Claude\s*Code\s*설치|클로드\s*코드\s*설치/i.test(title);

  const lines = [
    '[에이전트 입문 도구 사실 고정 규칙 — 반드시 우선 적용]',
    '- Codex는 OpenAI/ChatGPT 쪽 코딩 도구다.',
    '- Claude Code는 Anthropic/Claude 쪽 코딩 도구다.',
    '- Codex를 Claude Code라고 쓰거나, Claude Code를 Codex라고 쓰지 말라.',
    '- Codex를 Anthropic 도구라고 설명하지 말고, Claude Code를 OpenAI 도구라고 설명하지 말라.',
  ];

  if (isCodexInstall) {
    lines.push(
      '- 이번 강의의 설치 대상은 Codex다. Claude Code는 지난 5강 비교 대상으로만 언급하라.',
      '- 설치/실행 예시는 Codex 기준으로 작성하고, @anthropic-ai/claude-code, claude --version, claude --help 명령을 Codex 설치 절차로 제시하지 말라.',
      '- 계정/인증 설명은 OpenAI 또는 ChatGPT 계정 기준으로 작성하라. Anthropic 계정 준비를 Codex 설치 조건으로 쓰지 말라.',
      '- Node.js/npm을 Codex의 무조건 필수 준비물처럼 단정하지 말라. CLI/npm 경로를 선택한 경우에만 필요할 수 있다고 설명하라.',
    );
  } else if (isClaudeInstall) {
    lines.push(
      '- 이번 강의의 설치 대상은 Claude Code다. Codex는 OpenAI 쪽 비교 대상으로만 언급하라.',
      '- 설치/실행 예시는 Claude Code 기준으로 작성하고, Codex 명령을 Claude Code 설치 절차로 제시하지 말라.',
      '- 계정/인증 설명은 Claude 또는 Anthropic 계정/사용 환경 기준으로 작성하라.',
    );
  }

  return lines.join('\n');
}

function _buildLectureGeoRules(researchData = {}, lectureTitle = '') {
  if (!_isAiImplementationLecture(researchData, lectureTitle)) return GEO_RULES;

  return `
  [GEO(Generative Engine Optimization) 규칙 — 에이전트 입문용]
AI 검색엔진(네이버 AI, ChatGPT 등)이 이 글을 쉬운 입문 자료로 인용할 수 있도록:
1. 글 최상단 [핵심 요약 3줄] — IT를 잘 모르는 독자가 바로 이해할 수 있는 150자 요약
2. FAQ 질문은 실제 초보자가 검색할 법한 문장으로 작성 (예: "ChatGPT Codex에 처음 무엇을 입력하면 되나요?")
3. 비교 표에 "처음 시작하는 사람에게 추천" 행을 추가하고 결론을 한 줄로 명시
4. 검증 가능한 출처만 언급: 공식 도움말, 제품 문서, 실제 화면에서 확인 가능한 기능 기준
5. 저자 명시: "승호아빠(15년 시니어 IT 컨설턴트, 커피랑도서관 대표)"를 서두에 한 번 기재
`.trim();
}

function _buildBeginnerLectureRules(researchData = {}, lectureTitle = '', lectureNumber = 0) {
  if (!_isAiImplementationLecture(researchData, lectureTitle)) return '';

  return `
[완전 일반인 대상 강의 규칙 — 반드시 우선 적용]
${_buildAgentIntroToolFactRules(lectureNumber || researchData.lectureNumber, lectureTitle)}
- 독자는 코딩 경험이 거의 없고, IT 용어에 익숙하지 않은 일반인으로 가정하라.
- 어려운 용어는 처음 등장할 때마다 괄호로 풀어라. 예: "터미널(컴퓨터에 명령을 입력하는 창)".
- 전문가용 기술서 톤, 아키텍처 과시, 불필요한 코드 장문 설명을 피하라.
- 각 섹션은 "왜 필요한가 → 그대로 따라하기 → 확인할 결과 → 막히면 다시 물어볼 문장" 순서로 작성하라.
- 실제 Codex 또는 Claude Code 화면 이미지를 본문에 있다고 꾸미지 말라. 이미지가 없으면 글로 화면 위치와 버튼 이름만 설명하라.
- 중간중간 [그대로 복사할 프롬프트] 블록을 넣고, 독자가 바로 붙여넣을 수 있는 문장을 완성형으로 제공하라.
- [화면에서 확인할 것] 체크리스트를 넣어 독자가 결과를 스스로 확인하게 하라.
- [막힐 때 다시 물어볼 문장]을 넣어 실패 상황에서도 다음 질문을 그대로 따라 할 수 있게 하라.
- 코드는 꼭 필요할 때만 사용하고, 가능하면 "파일 만들기 요청 프롬프트", "수정 요청 프롬프트", "검증 요청 프롬프트"로 대체하라.
- 홍보성 과장, 가격/할인/행사, 확인되지 않은 도구 기능은 만들지 말라.
`.trim();
}

const AI_BRIEFING_RULES = `
[AI Briefing 구조 규칙]
1. [핵심 요약 3줄] 다음에 [이 글에서 배울 수 있는 것]을 불릿으로 제시한다.
2. 강의 글이라도 질문형 Q&A를 반드시 포함한다.
3. 각 본문 섹션은 한 줄 요약 또는 핵심 문장으로 시작한다.
4. 이론/코드/실전 인사이트가 분리돼 보여야 한다.
5. 결론에서 실무 적용 포인트를 한 줄로 다시 정리한다.
`.trim();

const LECTURE_AI_BRIEFING_ORDER = buildAIBriefingSectionOrder('lecture');
const LECTURE_AI_BRIEFING_CHECKLIST = buildAIBriefingChecklist('lecture');

// ─── 날씨 → 글 맥락 변환 ─────────────────────────────────────────────

// ─── 시스템 프롬프트 ─────────────────────────────────────────────────

const POS_PERSONA_GUIDE = loadPersonaGuide('POS_PERSONA.md');
const POS_SYSTEM_PROMPT = '너는 블로그팀 강의 작성자 포스다. 강의 제목과 번호를 고정하고, 지정된 섹션을 빠짐없이 채우며, 실전 경험과 검증 가능한 코드만 사용하라. 불확실한 라이브러리나 API는 만들지 말고 마지막 줄에 _THE_END_ 를 남겨라.';

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
      question: '독자에게 질문을 던지는 형식이지만 본문 전체는 반드시 존댓말로',
      story:    '오늘 아침 에피소드를 먼저 들려주는 스토리텔링이지만 본문 전체는 반드시 존댓말로',
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
  if (variation.writerPersona?.name) {
    lines.push(`작가 페르소나: ${variation.writerPersona.name} — ${variation.writerPersona.style}`);
    lines.push(`작가 문체: ${variation.writerPersona.tone}`);
    lines.push(`작가 지시: ${variation.writerPersona.promptPrefix}`);
  }
  if (variation.editorPersona?.name) {
    lines.push(`편집자 페르소나: ${variation.editorPersona.name} — ${variation.editorPersona.focus}`);
    lines.push(`편집자 지시: ${variation.editorPersona.instruction}`);
  }
  if (variation.marketingContext?.signalTypes?.length) {
    lines.push(`마케팅 신호: ${variation.marketingContext.signalTypes.join(', ')}`);
  }
  if (variation.marketingContext?.notes?.length) {
    lines.push(`마케팅 지시: ${variation.marketingContext.notes.join(' / ')}`);
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

function _defaultLectureLearningPointsSection(lectureTitle) {
  return [
    '[이 글에서 배울 수 있는 것]',
    `- ${lectureTitle}를 실무 관점에서 이해하는 핵심 포인트`,
    '- 구현 전에 먼저 점검해야 할 설계 기준',
    '- 오늘 코드 예제를 실제 운영 환경에 옮길 때 주의할 점',
  ].join('\n');
}

function _defaultLectureTechBriefingSection(lectureTitle) {
  return [
    '[최신 기술 브리핑]',
    `${lectureTitle}를 다룰 때 가장 먼저 볼 흐름은 도구 이름보다 작업 방식의 변화입니다. 최근 AI 코딩 도구는 단순히 답변을 생성하는 단계에서 벗어나, 파일을 읽고 수정하고 검증 결과까지 함께 확인하는 방향으로 발전하고 있습니다.`,
    '초보자 입장에서는 이 차이를 어렵게 외울 필요가 없습니다. 화면에 질문을 입력하는 도구인지, 실제 프로젝트 폴더 안에서 명령을 실행하고 결과를 고치는 도구인지부터 구분하면 충분합니다.',
    '따라서 이번 강의의 브리핑 기준은 최신 기능을 과장하는 것이 아니라, 처음 쓰는 사람이 안전하게 요청하고 결과를 검증하는 절차를 익히는 데 둡니다.',
  ].join('\n');
}

function _buildWeeklyNewsSection(researchData = {}) {
  const updates = Array.isArray(researchData.curriculum_updates)
    ? researchData.curriculum_updates
    : [];
  const lines = updates
    .slice(0, 2)
    .map((item) => {
      const title = String(item?.title || '').trim();
      if (!title) return '';
      const source = String(item?.source || '').trim();
      const url = String(item?.url || '').trim();
      return `- ${title}${source ? ` (${source})` : ''}${url ? ` — ${url}` : ''}`;
    })
    .filter(Boolean);
  if (!lines.length) return '';
  return ['[이번 주 소식]', ...lines].join('\n');
}

function _buildVaultLectureContextBlock(researchData = {}) {
  const rawBlock = String(researchData?.vaultLectureContext?.block || researchData?.vaultLectureContextBlock || '').trim();
  if (!rawBlock) return '';
  return rawBlock.includes('[지난 강의 연계]')
    ? rawBlock
    : `[지난 강의 연계]\n${rawBlock}`;
}

function _ensureWeeklyNewsSection(content, researchData = {}) {
  let next = String(content || '').trim();
  if (!next || next.includes('[이번 주 소식]')) return next;
  const section = _buildWeeklyNewsSection(researchData);
  if (!section) return next;

  const briefingIndex = next.indexOf('[최신 기술 브리핑]');
  if (briefingIndex >= 0) {
    return `${next.slice(0, briefingIndex).trimEnd()}\n\n${section}\n\n${next.slice(briefingIndex).trimStart()}`.trim();
  }
  return `${section}\n\n${next}`.trim();
}

function _defaultLectureQuestionSection(lectureTitle) {
  return [
    '[AEO FAQ]',
    `Q. ${lectureTitle}를 실무에서 먼저 이해해야 하는 이유는 무엇인가요?`,
    'A. 개념만 아는 것과 운영에서 판단할 수 있는 것은 다르기 때문입니다. 실무에서는 어디서 비용과 장애가 생기는지까지 같이 봐야 합니다.',
    `Q. ${lectureTitle}를 적용할 때 가장 많이 놓치는 부분은 무엇인가요?`,
    'A. 구현 자체보다 경계 조건과 운영 책임을 덜 보는 경우가 많습니다. 그래서 예외 처리와 관측 포인트를 먼저 설계하는 편이 안전합니다.',
    'Q. 예제를 그대로 복사하면 바로 실무에 쓸 수 있나요?',
    'A. 예제는 출발점일 뿐입니다. 실제 환경에서는 인증, 로깅, 재시도, 롤백, 모니터링까지 함께 붙여야 운영 가능한 코드가 됩니다.',
  ].join('\n');
}

function _ensureLectureBriefingFloor(content, lectureTitle) {
  let next = String(content || '').trim();
  if (!next) return next;

  if (!next.includes('이 글에서 배울 수 있는 것')) {
    const markerIndex = next.indexOf('[승호아빠 인사말]');
    if (markerIndex >= 0) {
      next = `${next.slice(0, markerIndex).trimEnd()}\n\n${_defaultLectureLearningPointsSection(lectureTitle)}\n\n${next.slice(markerIndex).trimStart()}`;
    } else {
      next = `${next}\n\n${_defaultLectureLearningPointsSection(lectureTitle)}`;
    }
  }

  if (!next.includes('[최신 기술 브리핑]')) {
    const theoryIndex = next.indexOf('[강의 - 이론]');
    const insertAfter = next.indexOf('[승호아빠 인사말]');
    const section = _defaultLectureTechBriefingSection(lectureTitle);
    if (theoryIndex >= 0) {
      next = `${next.slice(0, theoryIndex).trimEnd()}\n\n${section}\n\n${next.slice(theoryIndex).trimStart()}`;
    } else if (insertAfter >= 0) {
      const rest = next.slice(insertAfter);
      const nextSection = /\n\s*\[[^\]\n]+\]\s*(?:\n|$)/.exec(rest.slice(1));
      if (nextSection) {
        const splitAt = insertAfter + 1 + nextSection.index;
        next = `${next.slice(0, splitAt).trimEnd()}\n\n${section}\n\n${next.slice(splitAt).trimStart()}`;
      } else {
        next = `${next}\n\n${section}`;
      }
    } else {
      next = `${_defaultLectureTechBriefingSection(lectureTitle)}\n\n${next}`;
    }
  }

  const faqCount = (next.match(/(?:^|\n)\s*(?:\*\*)?Q[0-9]*[.):]|(?:^|\n)\s*Q\.\s|(?:^|\n)\s*질문\s*[0-9]*[.):]/g) || []).length;
  if (!next.includes('[AEO FAQ]') || faqCount < 3) {
    next = next.replace(/\[AEO FAQ\][\s\S]*?(?=\n\[|$)/, '').trim();
    next = `${next}\n\n${_defaultLectureQuestionSection(lectureTitle)}`;
  }

  return next.trim();
}

function _buildLectureTopicDirection(lectureNumber, lectureTitle) {
  const title = String(lectureTitle || '').trim();
  if (!title) return '';

  return [
    '[선택된 강의 방향]',
    `강의 핵심 주제: ${title}`,
    `강의 번호: ${lectureNumber}강`,
    `독자 문제: ${title}를 이름만 아는 수준에서 벗어나, 실제 설계와 운영 판단 기준까지 연결하고 싶은 수강생`,
    `서두 출발점: ${title}가 왜 지금 실무에서 다시 중요해졌는지, 어떤 상황에서 먼저 떠올려야 하는지부터 설명`,
    '이번 강의가 답해야 할 질문:',
    `1. ${title}를 실무에서 먼저 이해해야 하는 이유는 무엇인가`,
    `2. ${title}를 적용할 때 구현보다 먼저 설계해야 할 기준은 무엇인가`,
    `3. ${title}를 운영 단계로 가져갈 때 가장 자주 놓치는 부분은 무엇인가`,
    `마무리 방향: ${title}를 개념 설명으로 끝내지 말고, 다음 강의와 연결되는 실무 적용 포인트로 정리`,
    '제목과 본문은 위 강의 방향에서 벗어나지 말고, 특히 첫 요약과 이론 섹션에서 대표 질문을 바로 다뤄라.',
    isAgentIntroLecture('', title) ? _buildAgentIntroToolFactRules(lectureNumber, title) : '',
  ].join('\n');
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
  const writerModel = resolveBlogWriterModel();
  const cacheKey = `pos_lecture_${lectureNumber}_${writerModelCacheSuffix(writerModel)}`;

  // 캐시 확인 (당일 재실행 중복 방지)
  const cached = await llmCache.getCached('blog', 'lecture_post', cacheKey);
  if (cached) {
    console.log('[포스] 캐시 히트:', cacheKey);
    try {
      const parsed = JSON.parse(cached.response);
      return { ...parsed, writerModel: parsed.writerModel || writerModel };
    } catch {}
  }

  const weather        = researchData.weather        || {};
  const nodejsUpdates  = researchData.nodejs_updates || [];
  const itNews         = researchData.it_news        || [];
  const realExperiences = researchData.realExperiences || [];
  const relatedPosts   = researchData.relatedPosts   || [];
  const popularPatterns = researchData.lecturePopularPatterns || researchData.popularPatterns || [];
  const bonusInsights = sectionVariation.bonusInsights || [];
  const sectionPlan = calculateSectionChars('pos', bonusInsights);
  const charInstruction = buildCharCountInstruction(sectionPlan.charCounts, 'pos', bonusInsights);
  const lectureDirection = _buildLectureTopicDirection(lectureNumber, lectureTitle);
  const marketingNotes = Array.isArray(sectionVariation?.marketingContext?.notes)
    ? sectionVariation.marketingContext.notes.join(' / ')
    : '';
  const experimentWinnerSummary = String(researchData.strategy_experiment_winner || '').trim();
  const experimentWeakLaneSummary = String(researchData.strategy_experiment_weak_lane || '').trim();
  const masterStyleHint = String(sectionVariation?.masterStyleHint || '').trim();
  const writingLearningsBlock = await buildWritingLearningsPromptBlock({ category: researchData?.category || 'lecture' }).catch(() => '');
  const lifecyclePromptBlock = await buildBlogLifecyclePromptBlock({
    category: researchData?.category || 'lecture',
    stage: 'pos_writer_direct',
    topic: joinLifecycleTopic([researchData?.category || 'lecture', lectureTitle, experimentWinnerSummary, experimentWeakLaneSummary]),
  });

  const weatherContext = weatherToContext(weather);
  const seriesGuidance = _buildLectureSeriesGuidance(researchData, lectureTitle);
  const weeklyNewsSection = _buildWeeklyNewsSection(researchData);
  const vaultLectureContextBlock = _buildVaultLectureContextBlock(researchData);
  const geoRules = _buildLectureGeoRules(researchData, lectureTitle);
  const beginnerLectureRules = _buildBeginnerLectureRules(researchData, lectureTitle, lectureNumber);
  const lectureFormatInstruction = buildBlogFormatInstruction('lecture');

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
  const popularPatternBlock = popularPatterns.length > 0
    ? `\n[이전 인기 패턴 참고]\n` +
      popularPatterns.map((item, index) => {
        const meta = item.metadata || {};
        return `${index + 1}. ${item.content} | views=${meta.views || 0} | category=${meta.category || 'lecture'}`;
      }).join('\n') + '\n'
    : '';

  const userPrompt = `
${POS_PERSONA_GUIDE ? `[참조 페르소나]\n${POS_PERSONA_GUIDE}\n` : ''}
${AI_AGENT_CONTEXT}
${CAFE_FACT_GUARDRAILS}
${geoRules}
${AI_BRIEFING_RULES}
${LECTURE_AI_BRIEFING_ORDER}
${LECTURE_AI_BRIEFING_CHECKLIST}
${lectureFormatInstruction}
${beginnerLectureRules ? `${beginnerLectureRules}\n` : ''}
${lectureDirection}
${BLOG_SKILL_BUNDLE ? `${BLOG_SKILL_BUNDLE}\n` : ''}
다음 강의 포스팅을 작성하라:

[강의 정보]
강의 번호: ${lectureNumber}강
강의 제목: ${lectureTitle}
[문체 규칙]
본문 전체는 반드시 존댓말로 작성하라. 절대 반말을 쓰지 말라.

★★★ 핵심 준수 사항 ★★★
이 포스팅의 메인 주제는 반드시 "${lectureTitle}"이어야 한다.
- 포스팅 제목(H1)은 "${lectureTitle}"을 기반으로 블로그 친화적으로 변형 가능하나,
  반드시 "${lectureTitle}"의 핵심 키워드와 기술 주제를 그대로 포함해야 한다.
- [강의 - 이론] 및 [실무 - 코드] 섹션은 "${lectureTitle}" 주제를 직접 다루어야 한다.
- 다른 기술이나 주제로 대체하거나 "${lectureTitle}" 주제를 부제목으로 밀어내면 안 된다.
- 예: 제목이 "데이터베이스 마이그레이션 전략"이면 코드·이론 모두 마이그레이션을 다루어야 함.

[오늘 날씨 — 반드시 3회 이상 자연스럽게 활용]
${weatherContext}

[${seriesGuidance.briefingTitle} (브리핑에 활용)]
${seriesGuidance.briefingContent}
${weeklyNewsSection ? `\n[이번 주 소식 자료]\n${weeklyNewsSection}\n위 자료가 있을 때만 본문에 [이번 주 소식] 섹션을 만들고, 없으면 억지로 만들지 말라.` : ''}
${vaultLectureContextBlock ? `\n${vaultLectureContextBlock}\n위 자료는 과거 발행 맥락 연결에만 사용하고, 새 사실처럼 과장하지 말라.` : ''}

[최신 IT 뉴스 (인사말에 활용)]
${itNews.slice(0, 3).map(n => `- ${n.title}`).join('\n') || '- 최신 IT 트렌드를 자체 지식으로 언급하라'}
${experienceBlock}${linkingBlock}${popularPatternBlock}
${marketingNotes ? `[마케팅/운영 신호]\n${marketingNotes}\n` : ''}
${experimentWinnerSummary ? `[최근 실험 승자]\n${experimentWinnerSummary}\n` : ''}
${experimentWeakLaneSummary ? `[최근 실험 약세 레인]\n${experimentWeakLaneSummary}\n` : ''}
${masterStyleHint ? `[마스터 스타일 가이드]\n${masterStyleHint}\n` : ''}
${writingLearningsBlock ? `${writingLearningsBlock}\n` : ''}
${lifecyclePromptBlock ? `${lifecyclePromptBlock}\n` : ''}
${charInstruction}
이전 강의 (${lectureNumber - 1}강) 내용을 자연스럽게 연결하고,
다음 강의 (${lectureNumber + 1}강) 내용을 마무리에서 예고하라.

★★★ 글자수 요구사항 (반드시 준수) ★★★
전체 최소 8,000자 (한국어 기준). 각 섹션별 최소 글자수:
- [핵심 요약 3줄]: 150자
- [이 글에서 배울 수 있는 것]: 불릿 3개 이상
- [승호아빠 인사말]: 300자
- [최신 기술 브리핑]: 1,200자 (${seriesGuidance.briefingRequirement})
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
- ${beginnerLectureRules ? '이 글은 전문가용 기술서가 아니라, IT 비전공 일반인이 그대로 따라 하는 실습 교안이어야 한다.' : '이 글은 전문가가 집필하는 기술 서적의 한 챕터에 해당하는 분량이어야 한다.'}
- ${beginnerLectureRules ? '코드 블록이 꼭 필요할 때만 사용하고, 대신 복사 가능한 프롬프트 예시와 결과 확인 절차를 충분히 제공하라.' : '코드 블록마다 최소 5줄 이상의 상세한 주석을 포함하라.'}
- ${seriesGuidance.codeRule}
- ${seriesGuidance.codeFallbackRule}
- 최근 실험 승자 신호가 있으면 강의 제목·요약·실무 포인트를 더 자연스럽고 신뢰감 있게 정리하라.
- 최근 실험 약세 레인이 있으면 유행성/과장형 표현은 피하고 실전형 설명을 우선하라.
- 반드시 모든 섹션을 작성하고 _THE_END_ 로 마무리하라.
  `.trim();

  const startTime = Date.now();
  let usedModel = 'gpt-4o';
  let fallbackUsed = false;
  let usedChunkedFallback = false;
  let traceId = getTraceId();
  let content;

  try {
    const result = await callPosWriterLlm({
      systemPrompt: POS_SYSTEM_PROMPT,
      userPrompt,
      taskType: 'lecture_post',
      timeoutMs: BLOG_WRITER_TIMEOUT_MS,
      writerModel,
    });
    content      = result.text;
    usedModel    = result.selected_route || result.model || result.provider || 'hub';
    traceId      = result.traceId || result.trace_id || traceId;
    fallbackUsed = Number(result.fallbackCount || 0) > 0;
    if (fallbackUsed) console.log(`[포스] LLM 폴백 발생: ${usedModel} (${result.fallbackCount} fallback)`);
  } catch (error) {
    if (!isHubWriterTimeout(error)) throw error;
    console.warn(`[포스] 단일 writer 타임아웃 → chunked writer 폴백: ${error.message}`);
    const chunked = await writeLecturePostChunked(lectureNumber, lectureTitle, researchData, sectionVariation);
    content = chunked.content;
    usedModel = chunked.model || 'chunked-hub:blog.pos.writer';
    traceId = chunked.traceId || traceId;
    fallbackUsed = true;
    usedChunkedFallback = true;
  } finally {
    await toolLogger.logToolCall('llm', 'callHubLlm', {
      bot: 'blog-pos', success: !!content,
      duration_ms: Date.now() - startTime,
      metadata: { model: usedModel, writer_model: writerModel, lecture_num: lectureNumber, trace_id: traceId, fallback_used: fallbackUsed },
    }).catch(() => {});
  }

  const MIN_CHARS_LECTURE = Number(generationRuntimeConfig.posMinChars || 7000);

  // ── Continue 이어쓰기: 글자수 부족 + _THE_END_ 없으면 2차 호출 ──
  if (!usedChunkedFallback && content.length < MIN_CHARS_LECTURE && !content.includes('_THE_END_')) {
    console.log(`[포스] 글자수 부족 (${content.length}자) — 이어쓰기 호출`);

    // 마지막 800자만 컨텍스트로 전달 (전체 내용 전달 시 LLM이 새 글을 시작하는 문제 방지)
    const tailContext    = content.slice(-800);
    const continuePrompt = `[이전 내용 끝부분 (이미 작성됨 — 절대 반복 금지)]\n${tailContext}\n\n[지시] 위 내용이 끊긴 부분에서 바로 이어서 작성하라. 앞 내용은 이미 완성되었으므로 반드시 끊긴 지점부터 시작하라. 새 글을 처음부터 쓰지 말 것. 남은 섹션을 모두 완성하고 마지막에 _THE_END_ 를 적어라.`;
    try {
      const cont = await callPosWriterLlm({
        systemPrompt: POS_SYSTEM_PROMPT,
        userPrompt: continuePrompt,
        taskType: 'lecture_post_continue',
        maxTokens: Number(generationRuntimeConfig.continueMaxTokens || 8000),
        timeoutMs: BLOG_CONTINUE_TIMEOUT_MS,
        writerModel,
      });
      let acceptedContinuation = false;
      const contModel = cont.selected_route || cont.model || cont.provider || null;
      const contFallbackUsed = Number(cont.fallbackCount || 0) > 0;
      const contTraceId = cont.traceId || cont.trace_id || null;
      // LLM이 새 글을 처음부터 시작한 경우 감지 (첫 줄이 # 제목 + 분량이 원본의 50% 이상이면 재시작으로 간주)
      const contFirstLine = cont.text.trim().split('\n')[0] || '';
      const isRestart     = contFirstLine.startsWith('#') && cont.text.length > content.length * 0.5;
      if (isRestart) {
        console.warn(`[포스] ⚠️ 이어쓰기 LLM이 새 글 시작 감지 — 이어붙이기 건너뜀 (${cont.text.length}자)`);
      } else {
        content = content + '\n' + cont.text;
        acceptedContinuation = true;
      }
      if (acceptedContinuation) {
        if (contModel && contModel !== usedModel) usedModel = `${usedModel}+continue:${contModel}`;
        fallbackUsed = fallbackUsed || contFallbackUsed;
        traceId = contTraceId || traceId;
      }
    } catch (e) {
      console.warn(`[포스] 이어쓰기 실패 (무시): ${e.message}`);
    }

    console.log(`[포스] 이어쓰기 완료: ${content.length}자`);
  }

  // _THE_END_ 마커 제거
  content = content.replace(/_THE_END_/g, '').trim();
  content = _ensureLectureBriefingFloor(content, lectureTitle);
  content = _ensureWeeklyNewsSection(content, researchData);

  const result  = {
    content,
    charCount: content.length,
    model:     usedModel,
    usedModel,
    writerModel,
    fallbackUsed,
    traceId,
  };

  // 최소 글자수 달성 시에만 캐시 저장 (실패 결과 캐시 방지)
  if (content.length >= MIN_CHARS_LECTURE) {
    await llmCache.setCache('blog', 'lecture_post', cacheKey, JSON.stringify(result), 'gpt-4o');
  } else {
    console.log(`[포스] 글자수 미달 (${content.length}자) — 캐시 저장 건너뜀`);
  }

  try {
    const posMemory = new AgentMemory({ agentId: 'blog.pos', team: 'blog' });
    await posMemory.remember(
      `[포스 작성] 강의 #${lectureNumber} "${lectureTitle}" → ${content.length}자 (${usedModel})`,
      'episodic',
      {
        keywords: [lectureTitle, String(lectureNumber), 'lecture_post'].filter(Boolean),
        importance: Math.min(content.length / 12000, 1.0),
        metadata: { lectureNumber, lectureTitle, charCount: content.length, model: usedModel, writerModel, fallbackUsed },
      }
    );
  } catch { /* 메모리 저장 실패 무시 */ }

  return result;
}

// ─── 초안 보정 (전체 재작성 대체) ─────────────────────────────────────

async function repairLecturePostDraft(lectureNumber, lectureTitle, researchData, draft, quality, sectionVariation = {}) {
  const content = String(draft?.content || '').trim();
  if (!content) {
    throw new Error('repairLecturePostDraft: draft.content 비어 있음');
  }

  const weatherContext = weatherToContext(researchData.weather || {});
  const lectureDirection = _buildLectureTopicDirection(lectureNumber, lectureTitle);
  const beginnerLectureRules = _buildBeginnerLectureRules(researchData, lectureTitle, lectureNumber);
  const issueLines = (quality?.issues || [])
    .map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.msg}`)
    .join('\n') || '1. [warn] 품질 보정 필요';

  const repairPrompt = `
다음은 이미 작성된 강의 포스팅 초안이다.
이 글을 처음부터 다시 쓰지 말고, 기존 구조와 강의 주제를 유지한 채 부족한 부분만 보정하라.

[강의 정보]
강의 번호: ${lectureNumber}강
강의 제목: ${lectureTitle}
[오늘 날씨 맥락] ${weatherContext}
[선택된 강의 방향]
${lectureDirection}
${beginnerLectureRules ? `\n${beginnerLectureRules}\n` : ''}

[품질 이슈]
${issueLines}

[중요 지시]
1. 기존 강의 제목과 핵심 기술 주제를 유지하라.
1-1. 특히 [선택된 강의 방향]의 대표 질문과 마무리 방향을 흐리지 말 것.
2. 부족한 섹션, 코드 예시, FAQ, 해시태그, 날씨/경험 문맥만 보강하라.
3. 글자수가 부족하면 필요한 섹션만 확장하라. 이미 충분한 부분은 반복하지 말 것.
4. 새 강의를 처음부터 다시 작성하지 말 것.
5. 마지막에는 전체 보정된 완성본만 출력하라.
6. 모든 보정이 끝난 뒤 마지막 줄에 _THE_END_ 를 적어라.
${_buildVariationBlock(sectionVariation)}

[기존 초안 시작]
${content}
[기존 초안 끝]
  `.trim();

  const startTime = Date.now();
  const writerModel = resolveBlogWriterModel();
  let usedModel = 'gpt-4o';
  let fallbackUsed = false;
  let traceId = getTraceId();
  let repaired;

  try {
    const result = await callPosWriterLlm({
      systemPrompt: POS_SYSTEM_PROMPT,
      userPrompt: repairPrompt,
      taskType: 'lecture_post_repair',
      writerModel,
    });
    repaired     = result.text;
    usedModel    = result.selected_route || result.model || result.provider || 'hub';
    traceId      = result.traceId || result.trace_id || traceId;
    fallbackUsed = Number(result.fallbackCount || 0) > 0;
  } finally {
    await toolLogger.logToolCall('llm', 'callHubLlm', {
      bot: 'blog-pos',
      success: !!repaired,
      duration_ms: Date.now() - startTime,
      metadata: {
        model: usedModel,
        writer_model: writerModel,
        lecture_num: lectureNumber,
        trace_id: traceId,
        fallback_used: fallbackUsed,
        type: 'repair',
      },
    }).catch(() => {});
  }

  repaired = repaired.replace(/_THE_END_/g, '').trim();
  repaired = _ensureLectureBriefingFloor(repaired, lectureTitle);

  return {
    content: repaired,
    charCount: repaired.length,
    model: usedModel,
    usedModel,
    writerModel,
    fallbackUsed,
    traceId,
    repairedFromDraft: true,
  };
}

// ─── 분할 생성 — 강의 포스팅 (무료 API용) ────────────────────────────

const { chunkedGenerate } = require('../../../packages/core/lib/chunked-llm');

/**
 * 4그룹으로 나눠서 호출 → 합쳐서 하나의 강의 포스팅 완성
 * Hub selector blog.pos.writer를 사용해 청크별로 호출한다.
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
  const popularPatterns = researchData.lecturePopularPatterns || researchData.popularPatterns || [];
  const experimentWinnerSummary = String(researchData.strategy_experiment_winner || '').trim();
  const experimentWeakLaneSummary = String(researchData.strategy_experiment_weak_lane || '').trim();
  const masterStyleHint = String(sectionVariation?.masterStyleHint || '').trim();
  const writingLearningsBlock = await buildWritingLearningsPromptBlock({ category: researchData?.category || 'lecture' }).catch(() => '');
  const lifecyclePromptBlock = await buildBlogLifecyclePromptBlock({
    category: researchData?.category || 'lecture',
    stage: 'pos_writer_chunked',
    topic: joinLifecycleTopic([researchData?.category || 'lecture', lectureTitle, experimentWinnerSummary, experimentWeakLaneSummary]),
  });

  const weatherContext  = weatherToContext(weather);
  const model           = 'hub:blog.pos.writer';
  const writerModel     = resolveBlogWriterModel();
  const seriesGuidance  = _buildLectureSeriesGuidance(researchData, lectureTitle);
  const weeklyNewsSection = _buildWeeklyNewsSection(researchData);
  const vaultLectureContextBlock = _buildVaultLectureContextBlock(researchData);
  const beginnerLectureRules = _buildBeginnerLectureRules(researchData, lectureTitle, lectureNumber);
  const lectureFormatInstruction = buildBlogFormatInstruction('lecture');

  const experienceBlock = realExperiences.length > 0
    ? realExperiences.map((ep, i) => `${i + 1}. [${ep.type}] ${ep.content}`).join('\n')
    : '';
  const linkingBlock = relatedPosts.length > 0
    ? relatedPosts.map((p, i) => `${i + 1}. ${p.title} — ${p.summary}`).join('\n')
    : '';
  const popularPatternBlock = popularPatterns.length > 0
    ? `[이전 인기 패턴 참고]\n` +
      popularPatterns.map((item, index) => {
        const meta = item.metadata || {};
        return `${index + 1}. ${item.content} | views=${meta.views || 0} | category=${meta.category || 'lecture'}`;
      }).join('\n') + '\n'
    : '';
  const lectureDirection = _buildLectureTopicDirection(lectureNumber, lectureTitle);

  const chunks = [
    {
      id: 'group_a', minChars: 2000,
      prompt: `
${POS_PERSONA_GUIDE ? `[참조 페르소나]\n${POS_PERSONA_GUIDE}\n` : ''}
다음 강의 포스팅의 [그룹 A]를 작성하라.

[강의 정보] ${lectureNumber}강: ${lectureTitle}
★ 이 포스팅의 메인 주제는 반드시 "${lectureTitle}"이어야 한다. 다른 주제로 대체 금지.
[오늘 날씨] ${weatherContext}
[최신 IT 뉴스] ${itNews.slice(0, 3).map(n => n.title).join(' / ') || '최신 IT 트렌드 자체 지식'}
${seriesGuidance.chunkBriefingLine}
${weeklyNewsSection ? `[이번 주 소식 자료]\n${weeklyNewsSection}\n본문에 [이번 주 소식] 섹션을 만들고, 위 자료 1~2건만 반영하라.\n` : ''}
${vaultLectureContextBlock ? `${vaultLectureContextBlock}\n과거 발행 맥락과 자연스럽게 연결하되, 없는 링크나 수치를 만들지 말라.\n` : ''}
${beginnerLectureRules ? `${beginnerLectureRules}\n` : ''}
${popularPatternBlock}
${lectureFormatInstruction}
${LECTURE_AI_BRIEFING_ORDER}
${LECTURE_AI_BRIEFING_CHECKLIST}
${lectureDirection}
${experimentWinnerSummary ? `\n[최근 실험 승자]\n${experimentWinnerSummary}` : ''}
${experimentWeakLaneSummary ? `\n[최근 실험 약세 레인]\n${experimentWeakLaneSummary}` : ''}
${masterStyleHint ? `\n[마스터 스타일 가이드]\n${masterStyleHint}` : ''}
${writingLearningsBlock ? `\n${writingLearningsBlock}` : ''}
${lifecyclePromptBlock ? `\n${lifecyclePromptBlock}` : ''}

작성할 섹션 (이것만 작성하라):
  [핵심 요약 3줄] — 150자 내외 AI 스니펫용
  [이 글에서 배울 수 있는 것] — 불릿 3개 이상, 120자 이상
  [승호아빠 인사말] — 날씨+시사 반영, 300자
  [최신 기술 브리핑] — ${seriesGuidance.chunkBriefingRequirement}, 1,200자
  [전문가의 실무 인사이트 ①] — 비즈니스 관점, 500자
  ${beginnerLectureRules ? '[그대로 복사할 프롬프트] — 오늘 실습 시작용 문장 2개 이상\n  [화면에서 확인할 것] — 체크리스트 3개 이상' : ''}

총 2,700자 이상. 날씨 맥락 1회 포함.
이전 강의(${lectureNumber - 1}강) 내용을 인사말에서 간략히 연결하라.
${_buildVariationBlock(sectionVariation)}      `.trim(),
    },
    {
      id: 'group_b', minChars: 2000,
      prompt: `
${POS_PERSONA_GUIDE ? `[참조 페르소나]\n${POS_PERSONA_GUIDE}\n` : ''}
다음 강의 포스팅의 [그룹 B]를 작성하라.

[강의 정보] ${lectureNumber}강: ${lectureTitle}
★ [강의 - 이론] 섹션은 반드시 "${lectureTitle}" 주제만 다루어야 한다. 다른 기술로 대체 금지.
★★★ 중요 규칙 ★★★
- "승호아빠" 인사말, 저자 소개, 인사는 [그룹 A]에서 이미 작성 완료.
  이 그룹에서는 인사말/저자소개 없이 본론으로 바로 시작하라.
- 이전 섹션 '[최신 기술 브리핑]'과 '[전문가의 실무 인사이트 ①]'에 이어서 작성하라.
  흐름이 끊기지 않게 자연스럽게 연결하라.
${experienceBlock ? `[실전 에피소드]\n${experienceBlock}\n→ "제가 운영하는 ai-agent-system에서 겪은 경험"으로 녹여라` : ''}
${popularPatternBlock}
${lectureFormatInstruction}
${lectureDirection}
${beginnerLectureRules ? `${beginnerLectureRules}\n` : ''}
${experimentWinnerSummary ? `\n[최근 실험 승자]\n${experimentWinnerSummary}` : ''}
${experimentWeakLaneSummary ? `\n[최근 실험 약세 레인]\n${experimentWeakLaneSummary}` : ''}
${writingLearningsBlock ? `\n${writingLearningsBlock}` : ''}
${lifecyclePromptBlock ? `\n${lifecyclePromptBlock}` : ''}

작성할 섹션 (이것만 작성하라):
  ━━━━━━━━━━━━━━━━━━━━━
  [강의 - 이론] — ${lectureTitle}의 핵심 개념, 2,000자+
  [전문가의 실무 인사이트 ②] — 기획 단계 관점, 500자
  ${beginnerLectureRules ? '[처음 듣는 용어 풀이] — 초보자가 헷갈릴 단어 5개를 쉬운 말로 풀이' : ''}

총 2,500자 이상. 코드 용어에 괄호 풀이.
${seriesGuidance.codeRule}
      `.trim(),
    },
    {
      id: 'group_c', minChars: 2000,
      prompt: `
${POS_PERSONA_GUIDE ? `[참조 페르소나]\n${POS_PERSONA_GUIDE}\n` : ''}
다음 강의 포스팅의 [그룹 C]를 작성하라.

[강의 정보] ${lectureNumber}강: ${lectureTitle}
★ [실무 - 코드] 섹션의 코드는 반드시 "${lectureTitle}" 주제를 직접 구현해야 한다. 다른 기술 코드 대체 금지.
★★★ 중요 규칙 ★★★
- "승호아빠" 인사말, 저자 소개, 인사는 [그룹 A]에서 이미 작성 완료.
  이 그룹에서는 인사말/저자소개 없이 본론으로 바로 시작하라.
- 이전 섹션 '[강의 - 이론]'과 '[전문가의 실무 인사이트 ②]'에 이어서 작성하라.
${lectureDirection}
${lectureFormatInstruction}
${beginnerLectureRules ? `${beginnerLectureRules}\n` : ''}
${experimentWinnerSummary ? `\n[최근 실험 승자]\n${experimentWinnerSummary}` : ''}
${experimentWeakLaneSummary ? `\n[최근 실험 약세 레인]\n${experimentWeakLaneSummary}` : ''}
${writingLearningsBlock ? `\n${writingLearningsBlock}` : ''}
${lifecyclePromptBlock ? `\n${lifecyclePromptBlock}` : ''}

작성할 섹션 (이것만 작성하라):
  ━━━━━━━━━━━━━━━━━━━━━
  [실무 - 코드 및 아키텍처] — ${seriesGuidance.practiceRequirement}, 2,000자+
  [전문가의 실무 인사이트 ③] — 코드의 비즈니스 가치, 500자
  ${beginnerLectureRules ? '[따라하기 프롬프트 3종] — 만들기/수정하기/검증하기 요청 문구를 각각 완성형으로 제공\n  [막힐 때 다시 물어볼 문장] — 실패 상황별 재질문 문구 3개' : ''}

총 2,500자 이상. 날씨 맥락 1회 삽입. ${beginnerLectureRules ? '초보자용 프롬프트 예시와 결과 확인 절차 필수.' : 'async/await 패턴, 상세 주석 필수.'}
${seriesGuidance.codeFallbackRule}
      `.trim(),
    },
    {
      id: 'group_d', minChars: 1500,
      prompt: `
${POS_PERSONA_GUIDE ? `[참조 페르소나]\n${POS_PERSONA_GUIDE}\n` : ''}
다음 강의 포스팅의 [그룹 D]를 작성하라.

[강의 정보] ${lectureNumber}강: ${lectureTitle}
[오늘 날씨] ${weatherContext}
★★★ 중요 규칙 ★★★
- "승호아빠" 인사말, 저자 소개, 인사는 [그룹 A]에서 이미 작성 완료.
  이 그룹에서는 인사말/저자소개 없이 본론으로 바로 시작하라.
- 이전 섹션 '[실무 - 코드 및 아키텍처]'와 '[전문가의 실무 인사이트 ③]'에 이어서 작성하라.
- [마무리 인사]에서만 "승호아빠"를 한 번 언급하라.
${lectureDirection}
${lectureFormatInstruction}
${beginnerLectureRules ? `${beginnerLectureRules}\n` : ''}
${linkingBlock ? `[관련 과거 포스팅]\n${linkingBlock}` : ''}
${experimentWinnerSummary ? `\n[최근 실험 승자]\n${experimentWinnerSummary}` : ''}
${experimentWeakLaneSummary ? `\n[최근 실험 약세 레인]\n${experimentWeakLaneSummary}` : ''}
${writingLearningsBlock ? `\n${writingLearningsBlock}` : ''}
${lifecyclePromptBlock ? `\n${lifecyclePromptBlock}` : ''}

작성할 섹션 (이것만 작성하라):
  ━━━━━━━━━━━━━━━━━━━━━
  [에러 탐지 신경망과 환경의 역학] — 커피랑도서관 분당서현점 홍보, ACC-ERN, 세스코 에어는 공기질 관리 기능으로만 설명, 800자
  [전문가의 실무 인사이트 ④] — 공간과 아키텍트, 300자
  ━━━━━━━━━━━━━━━━━━━━━
  [AEO FAQ] — Q&A 4~5개, 800자
  ${beginnerLectureRules ? '[오늘의 10분 숙제] — 독자가 바로 실행할 작은 과제 1개\n  [다음 강의 전 준비물] — 계정/폴더/질문거리 체크리스트' : ''}
  ━━━━━━━━━━━━━━━━━━━━━
  [마무리 인사] — 다음 강의(${lectureNumber + 1}강) 예고, 300자
  [함께 읽으면 좋은 글] — 과거 포스팅 3개 추천
  [해시태그] — 주제 12개 + 스터디카페 10개 = 22개+

총 2,000자 이상. 날씨 맥락 1회 포함.
      `.trim(),
    },
  ];

  const startTime = Date.now();
  const selectorOverrides = getBlogLLMSelectorOverrides();
  const result    = await chunkedGenerate(POS_SYSTEM_PROMPT, chunks, {
    model,
    abstractModel: writerModel,
    ...buildWriterFamilyRequestOptions(writerModel),
    selectorKey: 'blog.pos.writer',
    policyOverride: selectorOverrides['blog.pos.writer'] || null,
    callerTeam: 'blog',
    agent: 'pos',
    taskType: 'lecture_post_chunked',
    contextCarry: 200,
    maxRetries:   Number(generationRuntimeConfig.writerMaxRetries || 1),
    timeoutMs: BLOG_CHUNK_TIMEOUT_MS,
    logMeta: { team: 'blog', purpose: 'writer', bot: 'blog-pos', requestType: 'lecture_post_chunked' },
    onChunkComplete: ({ id, charCount, index }) =>
      console.log(`[포스] 청크 ${id} 완료: ${charCount}자 (${index + 1}/4)`),
  });

  console.log(`[포스] 분할생성 완료: 총 ${result.charCount}자 (${((Date.now() - startTime) / 1000).toFixed(1)}초)`);

  let content = _ensureLectureBriefingFloor(String(result.content || '').trim(), lectureTitle);
  content = _ensureWeeklyNewsSection(content, researchData);

  const chunkModels = [...new Set((result.chunks || []).map((chunk) => chunk.model).filter(Boolean))];
  const chunkModel = chunkModels.length > 1 ? `chunked:${chunkModels.join('+')}` : (chunkModels[0] || `chunked-${model}`);
  return {
    content,
    charCount: content.length,
    model:     chunkModel,
    usedModel: chunkModel,
    writerModel,
    fallbackUsed: false,
    traceId: getTraceId(),
  };
}

module.exports = {
  writeLecturePost,
  writeLecturePostChunked,
  repairLecturePostDraft,
  POS_SYSTEM_PROMPT,
  _testOnly: {
    _buildLectureSeriesGuidance,
    _buildWeeklyNewsSection,
    _ensureWeeklyNewsSection,
    _buildVaultLectureContextBlock,
  },
};
