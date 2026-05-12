// @ts-nocheck
'use strict';

/**
 * quality-agents.ts — 7-Agent G-E-RG 품질평가 시스템
 *
 * G-E-RG (Generation → Evaluation → ReGeneration) 패턴 구현
 * arXiv 2505.04869 + LLM Blind Peer Review (arXiv 2601.08003) 기반
 *
 * 7 에이전트:
 *   ① SEO Agent — C-Rank + D.I.A.+ + GEO 점수
 *   ② Style Agent — 페르소나/톤 일관성
 *   ③ FactCheck Agent — 수치/통계/날짜 검증
 *   ④ Readability Agent — 가독성 + AI 친화도
 *   ⑤ Coherence Agent — 섹션 간 흐름/연결 ★ (마스터 핵심 요청)
 *   ⑥ FinalQuality Agent — 통합 PASS/REVISE/REJECT
 *   (Writer Agent는 pos-writer.ts / gems-writer.ts 별도)
 */

let callLocalLlm;
try {
  callLocalLlm = require('../../../packages/core/lib/local-llm-client').callLocalLlm;
} catch {
  callLocalLlm = null;
}

const LLM_MODEL = 'qwen2.5:7b';
const LLM_TEMP  = 0.2;
const MAX_TOKENS_SHORT = 80;
const MAX_TOKENS_MED   = 200;
const SNIPPET_LEN = 2000;

// ─────────────────────────── 공통 헬퍼 ────────────────────────────────────────

function safeNum(text, fallback = 5) {
  const m = String(text || '').match(/\d+(?:\.\d+)?/);
  return m ? Math.min(10, Math.max(0, parseFloat(m[0]))) : fallback;
}

async function askLlm(prompt, maxTokens = MAX_TOKENS_SHORT) {
  if (!callLocalLlm) return { content: '' };
  try {
    return await callLocalLlm({ prompt, model: LLM_MODEL, maxTokens, temperature: LLM_TEMP });
  } catch {
    return { content: '' };
  }
}

// ─────────────────────────── ① SEO Agent ────────────────────────────────────

/**
 * 네이버 C-Rank + D.I.A.+ + GEO 점수 통합 평가
 * naver-seo-optimizer.ts와 함께 사용 가능
 */
async function runSEOAgent(content, title = '', options = {}) {
  const text = String(content || '');
  const titleStr = String(title || '').trim();
  const snippet = text.slice(0, SNIPPET_LEN);

  const prompt = `네이버 블로그 SEO 품질 평가 (C-Rank + D.I.A.+ + GEO 기준)

제목: ${titleStr}
본문 앞부분:
---
${snippet}
---

다음 3개 항목을 각각 0~10점으로 평가하고 JSON만 출력하라:
{
  "crank": <0-10>,
  "dia": <0-10>,
  "geo": <0-10>,
  "issues": ["(개선점 1~3개)"]
}

평가 기준:
- C-Rank: 주제 일관성, 전문성, 신뢰성
- D.I.A.: 검색 의도 매칭, 정보 깊이, 독창성
- GEO: AI 인용 친화 구조 (Q&A/요약/헤딩/수치/출처)`;

  const res = await askLlm(prompt, MAX_TOKENS_MED);
  let parsed = { crank: 5, dia: 5, geo: 5, issues: [] };
  try {
    const jsonMatch = String(res?.content || '').match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = { ...parsed, ...JSON.parse(jsonMatch[0]) };
  } catch {
    // fallback to defaults
  }

  const avg = (parsed.crank + parsed.dia + parsed.geo) / 3;
  return {
    agent: 'seo',
    score: Math.round(avg * 10),
    detail: { crank: parsed.crank, dia: parsed.dia, geo: parsed.geo },
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    passed: avg >= 6,
  };
}

// ─────────────────────────── ② Style Agent ──────────────────────────────────

async function runStyleAgent(content, options = {}) {
  const text = String(content || '');
  const snippet = text.slice(0, SNIPPET_LEN);
  const persona = String(options.persona || '승호아빠').slice(0, 30);

  const prompt = `블로그 스타일 일관성 평가

페르소나: ${persona}
본문 앞부분:
---
${snippet}
---

다음 항목을 0~10점으로 평가하고 JSON만 출력하라:
{
  "persona_match": <0-10>,
  "tone_consistency": <0-10>,
  "personal_touch": <0-10>,
  "issues": ["(개선점 1~2개)"]
}

평가 기준:
- persona_match: 페르소나 특성(IT 전문가, 분당 거주, 직장인 아빠) 반영
- tone_consistency: 말투 일관성 (딱딱 ↔ 친근)
- personal_touch: 개인 경험/감정 표현 충분도`;

  const res = await askLlm(prompt, MAX_TOKENS_MED);
  let parsed = { persona_match: 5, tone_consistency: 5, personal_touch: 5, issues: [] };
  try {
    const jsonMatch = String(res?.content || '').match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = { ...parsed, ...JSON.parse(jsonMatch[0]) };
  } catch {
    // fallback
  }

  const avg = (parsed.persona_match + parsed.tone_consistency + parsed.personal_touch) / 3;
  return {
    agent: 'style',
    score: Math.round(avg * 10),
    detail: {
      persona_match: parsed.persona_match,
      tone_consistency: parsed.tone_consistency,
      personal_touch: parsed.personal_touch,
    },
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    passed: avg >= 6,
  };
}

// ─────────────────────────── ③ FactCheck Agent ──────────────────────────────

async function runFactCheckAgent(content, options = {}) {
  const text = String(content || '');

  // 규칙 기반 사전 검사 (LLM 전 빠른 체크)
  const ruleIssues = [];

  // 숫자 뒤 단위 없는 경우
  const bareNumbers = text.match(/(?<!\d)\d{4,}(?!\s*[원%개ms억만GB년월일kg초분시])/g) || [];
  if (bareNumbers.length > 3) {
    ruleIssues.push(`단위 없는 큰 숫자 ${bareNumbers.length}개 (수치 불명확 위험)`);
  }

  // 출처 없는 통계 표현
  const statPatterns = text.match(/(?:통계|연구|조사|보고서)에\s*따르면|(?:따르면|에 의하면)/g) || [];
  const sourcePatterns = text.match(/출처|참고|reference|\[.*\]/gi) || [];
  if (statPatterns.length > 2 && sourcePatterns.length === 0) {
    ruleIssues.push('통계/연구 인용 시 출처 미명시');
  }

  const snippet = text.slice(0, SNIPPET_LEN);
  const prompt = `블로그 사실 검증 평가

본문 앞부분:
---
${snippet}
---

다음 항목을 0~10점으로 평가하고 JSON만 출력하라:
{
  "accuracy": <0-10>,
  "citation": <0-10>,
  "clarity": <0-10>,
  "issues": ["(개선점 1~2개)"]
}

평가 기준:
- accuracy: 수치/날짜/통계 정확성
- citation: 출처/근거 명시 여부
- clarity: 모호한 표현 없이 명확한 수치 사용`;

  const res = await askLlm(prompt, MAX_TOKENS_MED);
  let parsed = { accuracy: 5, citation: 5, clarity: 5, issues: [] };
  try {
    const jsonMatch = String(res?.content || '').match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = { ...parsed, ...JSON.parse(jsonMatch[0]) };
  } catch {
    // fallback
  }

  const allIssues = [...ruleIssues, ...(Array.isArray(parsed.issues) ? parsed.issues : [])];
  const avg = (parsed.accuracy + parsed.citation + parsed.clarity) / 3;
  return {
    agent: 'factcheck',
    score: Math.round(avg * 10),
    detail: { accuracy: parsed.accuracy, citation: parsed.citation, clarity: parsed.clarity },
    issues: allIssues,
    passed: avg >= 5,
  };
}

// ─────────────────────────── ④ Readability Agent ────────────────────────────

async function runReadabilityAgent(content, options = {}) {
  const text = String(content || '');

  // 규칙 기반 체크
  const ruleIssues = [];
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const longParas = paragraphs.filter((p) => p.split(/[.!?。]\s*/).length > 8);
  if (longParas.length > 3) {
    ruleIssues.push(`단락이 너무 긺 (8문장 초과 단락 ${longParas.length}개)`);
  }

  // Q&A 구조 확인 (GEO 친화)
  const hasQA = /Q\d*[.):]\s*|질문\s*\d*[.):]/i.test(text);
  const hasTLDR = /TLDR|요약|핵심\s*정리|TL;DR/i.test(text);
  if (!hasQA) ruleIssues.push('Q&A 섹션 없음 (GEO 친화성 부족)');
  if (!hasTLDR) ruleIssues.push('TLDR/요약 섹션 없음 (AI 인용 친화성 부족)');

  const snippet = text.slice(0, SNIPPET_LEN);
  const prompt = `블로그 가독성 + AI 친화도 평가 (GEO 기준)

본문 앞부분:
---
${snippet}
---

다음 항목을 0~10점으로 평가하고 JSON만 출력하라:
{
  "readability": <0-10>,
  "geo_friendly": <0-10>,
  "structure": <0-10>,
  "issues": ["(개선점 1~2개)"]
}

평가 기준:
- readability: 문장 길이, 단락 길이, 어휘 난이도
- geo_friendly: Q&A/요약/헤딩/수치 구조 (AI가 인용하기 좋은가)
- structure: 헤더/리스트/표 활용도`;

  const res = await askLlm(prompt, MAX_TOKENS_MED);
  let parsed = { readability: 5, geo_friendly: 5, structure: 5, issues: [] };
  try {
    const jsonMatch = String(res?.content || '').match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = { ...parsed, ...JSON.parse(jsonMatch[0]) };
  } catch {
    // fallback
  }

  const allIssues = [...ruleIssues, ...(Array.isArray(parsed.issues) ? parsed.issues : [])];
  const avg = (parsed.readability + parsed.geo_friendly + parsed.structure) / 3;
  return {
    agent: 'readability',
    score: Math.round(avg * 10),
    detail: {
      readability: parsed.readability,
      geo_friendly: parsed.geo_friendly,
      structure: parsed.structure,
    },
    issues: allIssues,
    passed: avg >= 6,
  };
}

// ─────────────────────────── ⑤ Coherence Agent ★ ────────────────────────────

/**
 * 섹션 간 흐름 연결 평가 — 마스터 핵심 요청
 * 전체 본문을 섹션으로 분할하여 논리적 흐름 검증
 */
async function runCoherenceAgent(content, options = {}) {
  const text = String(content || '');

  // 섹션 추출 (h2 태그 또는 [섹션명] 패턴)
  const sectionMarkers = [];
  for (const m of text.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)) {
    sectionMarkers.push(m[1].replace(/<[^>]+>/g, '').trim());
  }
  // 마크다운 스타일 섹션도 추출
  if (sectionMarkers.length === 0) {
    for (const m of text.matchAll(/^\[([^\]]{2,40})\]/gm)) {
      sectionMarkers.push(m[1].trim());
    }
  }

  const sectionList = sectionMarkers.slice(0, 12).join(' → ');

  // 규칙 기반: 섹션 수 확인
  const ruleIssues = [];
  if (sectionMarkers.length < 5) {
    ruleIssues.push(`섹션이 너무 적음 (${sectionMarkers.length}개, 권장 최소 7개)`);
  }

  // 반복 섹션 제목 감지
  const dupSections = sectionMarkers.filter((s, i) => sectionMarkers.indexOf(s) !== i);
  if (dupSections.length > 0) {
    ruleIssues.push(`중복 섹션 제목: ${dupSections.join(', ')}`);
  }

  const snippet = text.slice(0, SNIPPET_LEN);
  const prompt = `블로그 섹션 연결성/흐름 평가

섹션 구조: ${sectionList || '섹션 미감지'}

본문 앞부분:
---
${snippet}
---

다음 항목을 0~10점으로 평가하고 JSON만 출력하라:
{
  "flow": <0-10>,
  "logic": <0-10>,
  "transitions": <0-10>,
  "issues": ["(개선점 1~2개)"]
}

평가 기준:
- flow: 섹션 간 자연스러운 흐름
- logic: 논리적 전개 (문제→원인→해결→결론)
- transitions: 연결어/전환 표현 적절성`;

  const res = await askLlm(prompt, MAX_TOKENS_MED);
  let parsed = { flow: 5, logic: 5, transitions: 5, issues: [] };
  try {
    const jsonMatch = String(res?.content || '').match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = { ...parsed, ...JSON.parse(jsonMatch[0]) };
  } catch {
    // fallback
  }

  const allIssues = [...ruleIssues, ...(Array.isArray(parsed.issues) ? parsed.issues : [])];
  const avg = (parsed.flow + parsed.logic + parsed.transitions) / 3;
  return {
    agent: 'coherence',
    score: Math.round(avg * 10),
    detail: { flow: parsed.flow, logic: parsed.logic, transitions: parsed.transitions },
    sectionCount: sectionMarkers.length,
    sectionList,
    issues: allIssues,
    passed: avg >= 6,
  };
}

// ─────────────────────────── ⑥ Final Quality Agent ─────────────────────────

/**
 * 모든 에이전트 결과를 통합하여 PASS/REVISE/REJECT 결정
 */
function runFinalQualityAgent(agentResults, options = {}) {
  const results = Array.isArray(agentResults) ? agentResults : [];

  if (results.length === 0) {
    return {
      agent: 'final',
      decision: 'REVISE',
      score: 0,
      summary: '평가 결과 없음',
      failedAgents: [],
      allPassed: false,
    };
  }

  const failedAgents = results.filter((r) => !r.passed).map((r) => r.agent);
  const avgScore = results.reduce((sum, r) => sum + (r.score || 0), 0) / results.length;

  // 모든 이슈 수집
  const allIssues = results.flatMap((r) => (r.issues || []).map((issue) => `[${r.agent}] ${issue}`));

  let decision;
  if (failedAgents.length === 0 && avgScore >= 65) {
    decision = 'PASS';
  } else if (failedAgents.length <= 1 && avgScore >= 50) {
    decision = 'REVISE';
  } else {
    decision = 'REJECT';
  }

  // 중요 에이전트 가중치 (coherence + seo 더 중요)
  const weightedScores = results.map((r) => {
    const weight = ['coherence', 'seo'].includes(r.agent) ? 1.3 : 1.0;
    return (r.score || 0) * weight;
  });
  const weightedAvg = weightedScores.reduce((a, b) => a + b, 0) /
    results.reduce((sum, r) => sum + (['coherence', 'seo'].includes(r.agent) ? 1.3 : 1.0), 0);

  return {
    agent: 'final',
    decision,
    score: Math.round(weightedAvg),
    avgScore: Math.round(avgScore),
    failedAgents,
    allPassed: failedAgents.length === 0,
    topIssues: allIssues.slice(0, 5),
    summary: `${decision}: ${failedAgents.length > 0 ? `${failedAgents.join(', ')} 미달` : '전체 통과'} (가중평균 ${Math.round(weightedAvg)}점)`,
  };
}

// ─────────────────────────── G-E-RG 메인 흐름 ────────────────────────────────

/**
 * G-E-RG 통합 평가 실행
 *
 * @param {string} content - 포스팅 전체 내용
 * @param {object} options - { title, persona, type, skipLlm }
 * @returns {object} - { agents: [...], final: {...}, decision, score }
 */
async function runGERGEvaluation(content, options = {}) {
  const text = String(content || '');
  const title = String(options.title || '');

  // 병렬로 5개 에이전트 실행 (Coherence는 전체 분석 필요)
  const [seo, style, factcheck, readability, coherence] = await Promise.allSettled([
    runSEOAgent(text, title, options),
    runStyleAgent(text, options),
    runFactCheckAgent(text, options),
    runReadabilityAgent(text, options),
    runCoherenceAgent(text, options),
  ]);

  const agentResults = [
    seo.status === 'fulfilled' ? seo.value : { agent: 'seo', score: 50, issues: [], passed: true },
    style.status === 'fulfilled' ? style.value : { agent: 'style', score: 50, issues: [], passed: true },
    factcheck.status === 'fulfilled' ? factcheck.value : { agent: 'factcheck', score: 50, issues: [], passed: true },
    readability.status === 'fulfilled' ? readability.value : { agent: 'readability', score: 50, issues: [], passed: true },
    coherence.status === 'fulfilled' ? coherence.value : { agent: 'coherence', score: 50, issues: [], passed: true },
  ];

  const finalResult = runFinalQualityAgent(agentResults, options);

  return {
    agents: agentResults,
    final: finalResult,
    decision: finalResult.decision,
    score: finalResult.score,
    topIssues: finalResult.topIssues,
  };
}

/**
 * 섹션별 중간 평가 (작성 중간에 호출 가능)
 * G-E-RG의 "E" 단계 — 섹션 단위 즉시 피드백
 */
async function evaluateSection(sectionContent, sectionName, options = {}) {
  const text = String(sectionContent || '');
  const name = String(sectionName || '섹션');

  const prompt = `블로그 섹션 품질 평가: "${name}"

섹션 내용:
---
${text.slice(0, 800)}
---

다음 항목을 0~10점으로 평가하고 JSON만 출력하라:
{
  "quality": <0-10>,
  "seo": <0-10>,
  "rewrite_needed": <true|false>,
  "feedback": "(한 문장 피드백)"
}`;

  const res = await askLlm(prompt, MAX_TOKENS_MED);
  let parsed = { quality: 5, seo: 5, rewrite_needed: false, feedback: '' };
  try {
    const jsonMatch = String(res?.content || '').match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = { ...parsed, ...JSON.parse(jsonMatch[0]) };
  } catch {
    // fallback
  }

  return {
    section: name,
    quality: parsed.quality,
    seo: parsed.seo,
    rewrite_needed: Boolean(parsed.rewrite_needed),
    feedback: String(parsed.feedback || ''),
    passed: parsed.quality >= 6 && !parsed.rewrite_needed,
  };
}

module.exports = {
  runSEOAgent,
  runStyleAgent,
  runFactCheckAgent,
  runReadabilityAgent,
  runCoherenceAgent,
  runFinalQualityAgent,
  runGERGEvaluation,
  evaluateSection,
};
