'use strict';

/**
 * justin.js (저스틴) — 감정팀장 오케스트레이션
 *
 * 역할:
 *   1. 감정 촉탁 수신 → 사건 DB 등록
 *   2. 사건 유형 분류 → 에이전트 배정
 *   3. 전체 워크플로우 단계 관리
 *   4. 최종 감정서 초안 검토 (밸런스 통과 후)
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
const { callLegal } = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/llm-helper'));
const briefing = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/briefing'));
const lens = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/lens'));
const garam = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/garam'));
const atlas = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/atlas'));
const claim = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/claim'));
const defense = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/defense'));
const quill = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/quill'));
const balance = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/balance'));

const SYSTEM_PROMPT = `당신은 저스틴(Justin)입니다. Team Jay 감정팀의 팀장으로, 법원 SW 감정 자동화를 총괄합니다.

역할:
- 감정 촉탁 분석 및 사건 유형 분류
- 에이전트별 작업 배정 및 오케스트레이션
- 감정 초안의 최종 검토

핵심 원칙:
1. 중립성: 원고/피고 어느 쪽에도 편향하지 않음
2. 정확성: 법률 용어와 기술 용어를 정확히 사용
3. 투명성: 모든 판단 근거를 명확히 제시
4. 겸손: 초안 작성 역할, 최종 판단은 마스터(인간 감정인)가 함

감정 유형: copyright(저작권침해), defect(소프트웨어하자), contract(계약위반), trade_secret(영업비밀), other(기타)`;

// ─── 감정 촉탁 접수 ───────────────────────────────────────────

async function receiveCase(input) {
  const {
    case_number,
    court,
    plaintiff,
    defendant,
    appraisal_items = [],
    deadline,
    document_text = '',
    notes,
  } = input;

  console.log(`[저스틴] 감정 촉탁 접수: ${case_number}`);

  const classification = await classifyCase(document_text, appraisal_items);

  const caseRecord = await store.createCase({
    case_number,
    court,
    case_type: classification.case_type,
    plaintiff,
    defendant,
    appraisal_items,
    deadline,
    notes,
  });

  console.log(`[저스틴] 사건 등록 완료: ID=${caseRecord.id}, 유형=${classification.case_type}`);
  return { caseRecord, classification };
}

async function classifyCase(documentText, appraisalItems) {
  const itemsText = Array.isArray(appraisalItems)
    ? appraisalItems.map((item, i) => `${i + 1}. ${item}`).join('\n')
    : String(appraisalItems);

  const result = await callLegal({
    agent: 'justin',
    requestType: 'case_classification',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `다음 감정 사건을 분류해 주세요.

감정사항:
${itemsText}

관련 문서 내용:
${documentText ? documentText.slice(0, 3000) : '(문서 없음)'}

다음 형식으로 JSON 응답:
{
  "case_type": "copyright|defect|contract|trade_secret|other",
  "analysis_needed": ["lens", "garam", "atlas", "claim", "defense", "contro"],
  "complexity": "low|medium|high",
  "key_issues": ["쟁점1", "쟁점2"],
  "reasoning": "분류 근거"
}`,
    maxTokens: 1024,
  });

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (_) { /* ignore */ }

  return {
    case_type: 'other',
    analysis_needed: ['lens', 'garam'],
    complexity: 'medium',
    key_issues: [],
    reasoning: result.text,
  };
}

// ─── 단계별 오케스트레이션 ────────────────────────────────────

async function runPhase2(caseId, caseData) {
  console.log(`[저스틴] Phase 2: 사건/감정소요 분석 시작`);
  await store.updateCaseStatus(caseId, 'analyzing');
  const result = await briefing.analyzeCaseAndRequirements(caseId, caseData);
  return result;
}

async function runPhase2_5(caseId, caseData) {
  console.log(`[저스틴] Phase 2.5: 원고/피고 자료 분석 (병렬)`);
  const [claimResult, defenseResult] = await Promise.allSettled([
    claim.analyzePlaintiff(caseId, caseData),
    defense.analyzeDefendant(caseId, caseData),
  ]);

  return {
    claim: claimResult.status === 'fulfilled' ? claimResult.value : { error: claimResult.reason?.message },
    defense: defenseResult.status === 'fulfilled' ? defenseResult.value : { error: defenseResult.reason?.message },
  };
}

async function runPhase3(caseId, caseData) {
  console.log(`[저스틴] Phase 3: 판례 분석 (병렬)`);
  const [garamResult, atlasResult] = await Promise.allSettled([
    garam.searchDomesticCases(caseId, caseData),
    atlas.searchForeignCases(caseId, caseData),
  ]);

  return {
    domestic: garamResult.status === 'fulfilled' ? garamResult.value : { error: garamResult.reason?.message },
    foreign: atlasResult.status === 'fulfilled' ? atlasResult.value : { error: atlasResult.reason?.message },
  };
}

async function runPhase4_LensAnalysis(caseId, caseData) {
  console.log(`[저스틴] Phase 4: 소스코드 분석`);
  return lens.analyzeSourceCode(caseId, caseData);
}

async function runPhase12(caseId, caseData) {
  console.log(`[저스틴] Phase 12: 감정보고서 작성 + 검증`);
  await store.updateCaseStatus(caseId, 'drafting');

  const draft = await quill.writeFinalReport(caseId, caseData);

  console.log(`[저스틴] 밸런스 검증 시작`);
  const review = await balance.reviewReport(caseId, draft);

  if (review.passed) {
    console.log(`[저스틴] 밸런스 통과 — 저스틴 최종 검토 진행`);
    await store.updateCaseStatus(caseId, 'reviewing');
  } else {
    console.log(`[저스틴] 밸런스 미통과 — 수정 필요: ${review.issues?.join(', ')}`);
  }

  return { draft, review };
}

// ─── 전체 워크플로우 실행 ─────────────────────────────────────

async function runFullWorkflow(input) {
  const { caseRecord, classification } = await receiveCase(input);
  const caseId = caseRecord.id;
  const caseData = { ...caseRecord, classification, input };

  const results = {};

  results.briefing = await runPhase2(caseId, caseData);
  results.sides = await runPhase2_5(caseId, caseData);

  if (classification.analysis_needed?.includes('lens') || input.has_source_code) {
    results.lens = await runPhase4_LensAnalysis(caseId, { ...caseData, ...results });
  }

  results.precedents = await runPhase3(caseId, caseData);

  const allData = { ...caseData, ...results };
  results.report = await runPhase12(caseId, allData);

  console.log(`[저스틴] 전체 워크플로우 완료: 사건 ${caseRecord.case_number}`);
  return { caseId, caseNumber: caseRecord.case_number, ...results };
}

// ─── 감정착수계획서 작성 ──────────────────────────────────────

async function writeInceptionPlan(caseId, caseData) {
  console.log(`[저스틴] 감정착수계획서 작성 요청`);
  await store.updateCaseStatus(caseId, 'planning');
  return briefing.writeInceptionPlan(caseId, caseData);
}

// ─── 질의서 작성 ──────────────────────────────────────────────

async function writeQueryLetter(caseId, caseData, queryRound = 1) {
  console.log(`[저스틴] ${queryRound}차 질의서 작성 요청`);
  const newStatus = queryRound === 1 ? 'questioning1' : 'questioning2';
  await store.updateCaseStatus(caseId, newStatus);
  return briefing.writeQueryLetter(caseId, caseData, queryRound);
}

// ─── 상태 조회 ────────────────────────────────────────────────

async function getStatus() {
  const active = await store.listCases();
  return {
    active_cases: active.length,
    cases: active.map(c => ({
      id: c.id,
      case_number: c.case_number,
      case_type: c.case_type,
      status: c.status,
      deadline: c.deadline,
    })),
  };
}

module.exports = {
  receiveCase,
  classifyCase,
  runPhase2,
  runPhase2_5,
  runPhase3,
  runPhase4_LensAnalysis,
  runPhase12,
  runFullWorkflow,
  writeInceptionPlan,
  writeQueryLetter,
  getStatus,
};
