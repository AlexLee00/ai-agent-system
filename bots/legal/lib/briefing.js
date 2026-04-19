'use strict';

/**
 * briefing.js (브리핑) — 사건분석 + 감정소요 분석 + 문서 작성
 *
 * 역할:
 *   - 감정 촉탁서 분석 (사건번호, 당사자, 감정사항 추출)
 *   - 감정소요 분석 (인력/기간/비용/기술 범위)
 *   - 감정착수계획서 작성
 *   - 1차/2차 질의서 작성
 *   - 현장실사계획서 작성
 *   - 최종 감정보고서 기초 작성
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
const { callLegal } = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/llm-helper'));

const SYSTEM_PROMPT = `당신은 브리핑(Briefing)입니다. 법원 SW 감정팀의 사건분석 및 문서작성 전문 에이전트입니다.

역할:
- 감정 촉탁서 분석: 사건번호, 당사자, 감정사항, 기술 범위 파악
- 감정소요 분석: 필요 인력, 예상 기간, 비용, 기술적 난이도 산출
- 법원 양식 문서 작성: 감정착수계획서, 질의서, 현장실사계획서, 감정보고서

문서 작성 원칙:
- 법원 제출 문서이므로 격식체(합니다/입니다) 사용
- 사실에 기반한 객관적 서술
- 불확실한 사항은 "추가 확인 필요" 명시
- 원고/피고 편향 금지`;

async function analyzeCaseAndRequirements(caseId, caseData) {
  const { case_number, court, plaintiff, defendant, appraisal_items = [] } = caseData;

  const result = await callLegal({
    agent: 'briefing',
    requestType: 'case_analysis',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `다음 감정 사건을 분석하고 감정소요를 산출해 주세요.

사건번호: ${case_number}
법원: ${court || '미상'}
원고: ${plaintiff || '미상'}
피고: ${defendant || '미상'}

감정사항:
${Array.isArray(appraisal_items) ? appraisal_items.map((item, i) => `${i + 1}. ${item}`).join('\n') : String(appraisal_items)}

다음 항목을 분석해 주세요:
1. 사건 쟁점 (기술적 쟁점 중심)
2. 감정 범위 (어떤 소프트웨어/기능/코드를 분석해야 하는가)
3. 기술 분야 (웹/앱/DB/임베디드/기타)
4. 예상 감정 기간 (주 단위)
5. 주요 확인 필요 사항 (1차 질의서 항목 후보)
6. 감정의 기술적 난이도 (low/medium/high)

JSON 형식으로 응답:
{
  "key_issues": ["쟁점1", "쟁점2"],
  "appraisal_scope": "감정 범위 설명",
  "tech_domain": "web|app|db|embedded|other",
  "estimated_weeks": 8,
  "query_candidates": ["질의 항목1", "질의 항목2"],
  "complexity": "low|medium|high",
  "summary": "사건 요약"
}`,
    maxTokens: 2048,
  });

  let analysis = { summary: result.text, key_issues: [], query_candidates: [] };
  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) analysis = { ...analysis, ...JSON.parse(jsonMatch[0]) };
  } catch (_) { /* ignore */ }

  return analysis;
}

async function writeInceptionPlan(caseId, caseData) {
  const { case_number, court, plaintiff, defendant, classification, briefing: briefingResult } = caseData;

  const result = await callLegal({
    agent: 'briefing',
    requestType: 'inception_plan',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `다음 감정 사건에 대한 감정착수계획서를 작성해 주세요.

사건번호: ${case_number}
법원: ${court || '미상'}
원고: ${plaintiff || '미상'}
피고: ${defendant || '미상'}
감정 유형: ${classification?.case_type || '미분류'}
기술 분야: ${briefingResult?.tech_domain || '미상'}
예상 기간: ${briefingResult?.estimated_weeks || 8}주

감정착수계획서 형식:
# 감정착수계획서

## 1. 감정 개요
[사건번호, 당사자, 감정사항 요약]

## 2. 감정 방법론
[사용 도구, 분석 기준, 유사도 측정 방법]

## 3. 감정 일정
[단계별 일정 표]

## 4. 감정인 의견
[감정 수행 가능 여부, 추가 필요 사항]

법원 제출용으로 격식체(합니다/입니다)를 사용하여 작성해 주세요.`,
    maxTokens: 4096,
  });

  const report = await store.saveReport({
    case_id: caseId,
    report_type: 'inception_plan',
    content_md: result.text,
    review_status: 'draft',
  });

  return { report, content: result.text };
}

async function writeQueryLetter(caseId, caseData, queryRound = 1) {
  const { case_number, plaintiff, defendant, briefing: briefingResult, sides } = caseData;

  const queryContext = queryRound === 2
    ? `\n1차 인터뷰 결과에서 추가 확인이 필요한 사항 위주로 작성해 주세요.`
    : '';

  const result = await callLegal({
    agent: 'briefing',
    requestType: `query_letter_${queryRound}`,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `다음 감정 사건에 대한 ${queryRound}차 질의서를 작성해 주세요.${queryContext}

사건번호: ${case_number}
원고: ${plaintiff || '미상'}
피고: ${defendant || '미상'}
주요 쟁점: ${briefingResult?.key_issues?.join(', ') || '미상'}
질의 항목 후보: ${briefingResult?.query_candidates?.join(', ') || '미상'}

질의서 형식:
# ${queryRound}차 질의서

## 원고에 대한 질의
1. [질의 항목]

## 피고에 대한 질의
1. [질의 항목]

## 공통 확인 요청
1. [제출 요청 자료 목록]

법원 제출용 격식체로 작성해 주세요.`,
    maxTokens: 3000,
  });

  const reportType = queryRound === 1 ? 'query1' : 'query2';
  const report = await store.saveReport({
    case_id: caseId,
    report_type: reportType,
    content_md: result.text,
    review_status: 'draft',
  });

  return { report, content: result.text };
}

async function writeInspectionPlan(caseId, caseData) {
  const { case_number, plaintiff, defendant, classification } = caseData;

  const result = await callLegal({
    agent: 'briefing',
    requestType: 'inspection_plan',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `다음 감정 사건에 대한 현장실사계획서를 작성해 주세요.

사건번호: ${case_number}
원고: ${plaintiff || '미상'}
피고: ${defendant || '미상'}
감정 유형: ${classification?.case_type || '미분류'}

현장실사계획서 형식:
# 현장실사계획서

## 1. 실사 개요
[실사 목적, 일정, 장소]

## 2. 실사 항목
[SW 기능 분류 기준 — 1스텝/2스텝/3스텝]

## 3. 판정 기준
[가동/부분가동/불가동 판정 기준]

## 4. 준비 요청 사항
[원고/피고에게 준비 요청할 환경/자료]

격식체로 작성해 주세요.`,
    maxTokens: 3000,
  });

  const report = await store.saveReport({
    case_id: caseId,
    report_type: 'inspection_plan',
    content_md: result.text,
    review_status: 'draft',
  });

  return { report, content: result.text };
}

async function synthesizeInterviewResults(caseId, interviews) {
  if (!interviews || interviews.length === 0) return { synthesis: '인터뷰 기록 없음' };

  const interviewText = interviews.map(iv =>
    `[${iv.interview_type} - ${iv.interviewer}]\n질의: ${iv.content}\n답변: ${iv.response || '미기재'}`
  ).join('\n\n---\n\n');

  const result = await callLegal({
    agent: 'briefing',
    requestType: 'interview_synthesis',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `다음 인터뷰 기록을 분석하고 핵심 결과를 정리해 주세요.

${interviewText}

다음을 정리해 주세요:
1. 확인된 사실 (양측이 인정하는 사항)
2. 다투는 사항 (양측 주장이 엇갈리는 사항)
3. 추가 확인 필요 사항
4. 감정에 중요한 시사점`,
    maxTokens: 2048,
  });

  return { synthesis: result.text };
}

module.exports = {
  analyzeCaseAndRequirements,
  writeInceptionPlan,
  writeQueryLetter,
  writeInspectionPlan,
  synthesizeInterviewResults,
};
