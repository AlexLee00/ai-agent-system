// @ts-nocheck
'use strict';

/**
 * naver-seo-optimizer.ts — 네이버 SEO 알고리즘 통합 최적화
 *
 * 3대 알고리즘 통합:
 *   C-Rank  — 블로그 신뢰도 (Context/Content/Chain/Creator)
 *   D.I.A.+ — 문서 자체 품질 (Deep Intent Analysis Plus)
 *   GEO     — Generative Engine Optimization (AI 인용 친화, 2026!)
 */

// ─────────────────────────── C-Rank 점수 ─────────────────────────────────────

/**
 * C-Rank 4요소 점수 계산
 * Context(주제 일관성) + Content(정보 품질) + Chain(연결) + Creator(신뢰성)
 */
function calculateCRankScore(post) {
  const text   = String(post.content || '');
  const title  = String(post.title || '');
  const category = String(post.category || '');

  let context = 0;  // 주제 관심도/일관성
  let content = 0;  // 정보 품질
  let chain   = 0;  // 소비/생산 연쇄
  let creator = 0;  // 블로그 신뢰성

  // Context: 카테고리 일관성 + 카테고리 키워드 제목 포함
  if (category && title.includes(category.slice(0, 4))) context += 30;
  else if (category) context += 15;
  const categoryKeywords = {
    'Node.js': ['노드', 'Node', 'npm', '서버'],
    '도서리뷰': ['책', '독서', '리뷰', '읽'],
    '스터디카페': ['커피랑', '도서관', '분당', '서현'],
    'IT트렌드': ['AI', 'LLM', '클라우드', '자동화'],
    '일상': ['오늘', '날씨', '경험', '느낌'],
  };
  const kwList = categoryKeywords[category] || [];
  const kwHits = kwList.filter((kw) => text.includes(kw)).length;
  context += Math.min(kwHits * 10, 40);
  context += category ? 30 : 0;

  // Content: 글자수 + 개인 경험 표현 + 수치 명확성
  const charCount = text.length;
  if (charCount >= 9000) content = 100;
  else if (charCount >= 7000) content = 80;
  else if (charCount >= 5000) content = 60;
  else content = 30;

  const hasPersonal = /제가|저는|솔직히|느꼈|경험|직접.*해본|제 생각/.test(text);
  if (hasPersonal) content = Math.min(content + 10, 100);

  const hasNumbers = /\d+(?:\s*(?:분|개|원|%|개월|년|명|번))/g;
  const numCount = (text.match(hasNumbers) || []).length;
  content = Math.min(content + Math.min(numCount * 2, 15), 100);

  // Chain: 내부 링크 + 이전 포스팅 언급 + 시리즈 연결
  const internalLinks = (text.match(/https?:\/\/blog\.naver\.com/gi) || []).length;
  chain += Math.min(internalLinks * 20, 60);
  if (/이전 글|지난 포스팅|앞서 살펴본|이어서|연결하여/.test(text)) chain += 25;
  if (/강 시리즈|강의 시리즈|다음 편|완성편/.test(text)) chain += 15;
  chain = Math.min(chain, 100);

  // Creator: 페르소나 명시 + 출처 표시 + 작성자 표현
  if (/승호아빠|분당 직장인|IT 엔지니어/.test(text)) creator += 40;
  if (/출처|참고|reference|링크/i.test(text)) creator += 30;
  if (/제 경험으로는|저의 경우|제가 실제로/.test(text)) creator += 30;
  creator = Math.min(creator, 100);

  const total = Math.round((context * 0.25 + content * 0.35 + chain * 0.2 + creator * 0.2));

  return {
    total,
    level: total >= 75 ? 'good' : total >= 50 ? 'fair' : 'poor',
    detail: { context, content, chain, creator },
  };
}

// ─────────────────────────── D.I.A.+ 점수 ────────────────────────────────────

/**
 * D.I.A.+ 개별 문서 품질 평가
 * Intent(검색 의도) + Depth(정보 깊이) + Uniqueness(독창성)
 */
function calculateDIAScore(post) {
  const text  = String(post.content || '');
  const title = String(post.title || '');

  let intent = 0;
  let depth  = 0;
  let uniqueness = 0;

  // Intent: 검색 의도 타입 파악 + 즉시 답변 가능 여부
  const isInfoSearch = /방법|가이드|하는법|이유|차이|비교|추천|정리/.test(title);
  const isQuestion   = /[?？]/.test(title);
  const hasTLDR      = /TLDR|핵심 요약|AI 스니펫|요약/.test(text);
  const hasDirectAns = text.slice(0, 500).length > 200;  // 앞에 바로 내용

  if (isInfoSearch) intent += 30;
  if (isQuestion)   intent += 20;
  if (hasTLDR)      intent += 25;
  if (hasDirectAns) intent += 25;
  intent = Math.min(intent, 100);

  // Depth: FAQ + 섹션 수 + 코드블록/표
  const faqCount = (text.match(/Q\d*[.):]/g) || []).length;
  const h2Count  = (text.match(/<h2[^>]*>/gi) || []).length;
  const codeBlockCount = (text.match(/```[\s\S]*?```/g) || []).length;
  const tableCount = (text.match(/<table|^\|.*\|.*\|/gm) || []).length;

  depth  = Math.min(faqCount * 8, 30);
  depth += Math.min(h2Count * 6, 30);
  depth += Math.min(codeBlockCount * 5, 20);
  depth += Math.min(tableCount * 5, 20);
  depth  = Math.min(depth, 100);

  // Uniqueness: 개인 경험 + 날씨/장소 맥락 + 독자 의견
  const hasPersonal = /제가|저는|솔직히|느꼈|경험|해보니/.test(text);
  const hasContext  = /날씨|오늘 아침|분당|커피랑|창가|책상/.test(text);
  const hasOpinion  = /제 생각|개인적으로|솔직히 말하면|저는 이렇게/.test(text);
  const hasEmoji    = /[😊😂🎉👍✨💡🔥]/u.test(text);

  if (hasPersonal) uniqueness += 35;
  if (hasContext)  uniqueness += 30;
  if (hasOpinion)  uniqueness += 25;
  if (hasEmoji)    uniqueness += 10;
  uniqueness = Math.min(uniqueness, 100);

  const total = Math.round(intent * 0.35 + depth * 0.35 + uniqueness * 0.30);

  return {
    total,
    level: total >= 75 ? 'good' : total >= 50 ? 'fair' : 'poor',
    detail: { intent, depth, uniqueness },
  };
}

// ─────────────────────────── GEO 점수 (2026!) ────────────────────────────────

/**
 * GEO (Generative Engine Optimization) 점수
 * "AI가 먼저 해석!" — AI 검색 인용 친화 구조 평가
 */
function calculateGEOScore(post) {
  const text  = String(post.content || '');
  const title = String(post.title || '');

  let ai_friendliness = 0;  // AI 인용 친화 문체
  let structure       = 0;  // 구조화된 정보
  let citation        = 0;  // 출처/검증 가능성

  // AI-friendliness: 단락 길이 + 명사형 + 능동태 + 명확 수치
  const paras = text.split(/\n{2,}/).filter((p) => p.trim().length > 10);
  const shortParas = paras.filter((p) => p.split(/[.!?。]\s*/).length <= 5);
  if (paras.length > 0) {
    ai_friendliness += Math.min(Math.round((shortParas.length / paras.length) * 50), 50);
  }

  const preciseNumbers = (text.match(/\d+(?:\.\d+)?(?:\s*(?:분|개|원|%|ms|GB|년|월|일|초|시간))/g) || []).length;
  ai_friendliness += Math.min(preciseNumbers * 3, 30);

  const vagueExpressions = (text.match(/오래|많이|조금|약간|여러|몇몇|다양한/g) || []).length;
  if (vagueExpressions <= 3) ai_friendliness += 20;
  else if (vagueExpressions <= 7) ai_friendliness += 10;
  ai_friendliness = Math.min(ai_friendliness, 100);

  // Structure: 헤딩 + 리스트 + 표 + TLDR + Q&A
  const headingCount = (text.match(/<h[1-6][^>]*>|^#{1,3}\s/gm) || []).length;
  const listCount    = (text.match(/^[-*•]\s|\d+\.\s/gm) || []).length;
  const tableCount   = (text.match(/<table|^\|.*\|/gm) || []).length;
  const hasTLDR      = /TLDR|핵심 요약|AI 스니펫|요약/.test(text) ? 1 : 0;
  const hasQA        = (text.match(/Q\d*[.):]/g) || []).length;

  structure  = Math.min(headingCount * 8, 30);
  structure += Math.min(listCount * 2, 25);
  structure += Math.min(tableCount * 5, 15);
  structure += hasTLDR * 15;
  structure += Math.min(hasQA * 5, 15);
  structure  = Math.min(structure, 100);

  // Citation: 출처 표시 + 검증 가능한 수치 + 링크
  const sourceCount   = (text.match(/출처|참고|reference|\(https?/gi) || []).length;
  const verifiableNum = (text.match(/\d{4}년|\d+\.\d+%|\d+만?\s*원/g) || []).length;
  const externalLinks = (text.match(/https?:\/\/(?!blog\.naver\.com)/gi) || []).length;

  citation  = Math.min(sourceCount * 15, 40);
  citation += Math.min(verifiableNum * 5, 30);
  citation += Math.min(externalLinks * 5, 30);
  citation  = Math.min(citation, 100);

  const total = Math.round(ai_friendliness * 0.35 + structure * 0.40 + citation * 0.25);

  return {
    total,
    level: total >= 75 ? 'good' : total >= 50 ? 'fair' : 'poor',
    detail: { ai_friendliness, structure, citation },
  };
}

// ─────────────────────────── 통합 점수 + 개선 제안 ───────────────────────────

/**
 * 3개 알고리즘 통합 점수
 */
function calculateNaverSEOScore(post) {
  const crank = calculateCRankScore(post);
  const dia   = calculateDIAScore(post);
  const geo   = calculateGEOScore(post);

  const total = Math.round(crank.total * 0.35 + dia.total * 0.40 + geo.total * 0.25);

  return {
    total,
    level: total >= 75 ? 'good' : total >= 55 ? 'fair' : 'poor',
    crank,
    dia,
    geo,
  };
}

/**
 * 개선 제안 목록 생성
 */
function suggestImprovements(post) {
  const suggestions = [];
  const text    = String(post.content || '');
  const title   = String(post.title || '');
  const crank   = calculateCRankScore(post);
  const dia     = calculateDIAScore(post);
  const geo     = calculateGEOScore(post);

  // C-Rank 개선
  if (crank.detail.context < 50) {
    suggestions.push({ priority: 'high', area: 'C-Rank/Context', msg: '카테고리 키워드를 제목과 본문 앞부분에 자연스럽게 추가하세요' });
  }
  if (crank.detail.chain < 40) {
    suggestions.push({ priority: 'medium', area: 'C-Rank/Chain', msg: '이전 관련 포스팅 내부 링크 2~3개 추가로 연결성을 높이세요' });
  }
  if (crank.detail.creator < 40) {
    suggestions.push({ priority: 'medium', area: 'C-Rank/Creator', msg: '"승호아빠", "분당 직장인" 등 페르소나 표현을 포함하고 출처를 명시하세요' });
  }

  // D.I.A.+ 개선
  if (dia.detail.intent < 50) {
    suggestions.push({ priority: 'high', area: 'D.I.A./Intent', msg: '제목에 "방법", "가이드", "이유" 등 검색 의도 키워드를 포함하고 앞부분에 핵심 요약을 추가하세요' });
  }
  if (dia.detail.uniqueness < 50) {
    suggestions.push({ priority: 'high', area: 'D.I.A./Uniqueness', msg: '개인 경험, 날씨/장소 맥락, "제 생각에는" 등 독창적 관점을 추가하세요' });
  }

  // GEO 개선
  if (geo.detail.structure < 50) {
    suggestions.push({ priority: 'high', area: 'GEO/Structure', msg: 'TLDR 요약 섹션과 Q&A(3~5개)를 추가하여 AI 검색 인용 친화성을 높이세요' });
  }
  if (geo.detail.ai_friendliness < 50) {
    suggestions.push({ priority: 'medium', area: 'GEO/Clarity', msg: '"오래", "많이", "약간" 같은 모호한 표현을 구체적 수치로 교체하세요 (예: "10-15분", "약 30%")' });
  }
  if (geo.detail.citation < 30) {
    suggestions.push({ priority: 'medium', area: 'GEO/Citation', msg: '통계/연구 인용 시 출처를 명시하고 검증 가능한 연도/수치를 포함하세요' });
  }

  // 제목 개선
  const titleLen = title.length;
  if (titleLen < 15) {
    suggestions.push({ priority: 'high', area: 'Title', msg: `제목 너무 짧음 (${titleLen}자). 15~35자로 확장하세요` });
  } else if (titleLen > 40) {
    suggestions.push({ priority: 'low', area: 'Title', msg: `제목 너무 긺 (${titleLen}자). 35자 이하로 줄이세요` });
  }

  return suggestions.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return (order[a.priority] || 2) - (order[b.priority] || 2);
  });
}

/**
 * 네이버 SEO 최적화 가이드 텍스트 생성 (텔레그램 리포트용)
 */
function formatSEOReport(post) {
  const score = calculateNaverSEOScore(post);
  const suggestions = suggestImprovements(post);

  const lines = [
    `📊 네이버 SEO 점수: ${score.total}/100 (${score.level.toUpperCase()})`,
    `  C-Rank: ${score.crank.total} | D.I.A.+: ${score.dia.total} | GEO: ${score.geo.total}`,
  ];

  if (suggestions.length > 0) {
    lines.push('');
    lines.push('🔧 개선 제안:');
    for (const s of suggestions.slice(0, 3)) {
      const icon = s.priority === 'high' ? '🔴' : s.priority === 'medium' ? '🟡' : '🟢';
      lines.push(`  ${icon} [${s.area}] ${s.msg}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  calculateCRankScore,
  calculateDIAScore,
  calculateGEOScore,
  calculateNaverSEOScore,
  suggestImprovements,
  formatSEOReport,
};
