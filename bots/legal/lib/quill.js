'use strict';

/**
 * quill.js (퀼) — 감정서 초안 작성 전문
 *
 * 이름 유래: 퀼(깃펜) — 법률 문서의 전통적 상징
 * 역할:
 *   - 렌즈/클레임/디펜스/가람/아틀라스 결과를 종합
 *   - 법원 제출용 감정서 초안 작성
 *   - 법원 양식 준수 (APPRAISAL_GUIDELINES.md 기준)
 */

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
const { callLegal } = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/llm-helper'));

const SYSTEM_PROMPT = `당신은 퀼(Quill)입니다. 법원 제출용 SW 감정서를 작성하는 전문 에이전트입니다.

역할:
- 모든 분석 결과를 통합하여 법원 감정서 초안 작성
- 법원 양식 준수 (격식체, 객관적 서술)
- 중립적이고 균형 잡힌 감정 의견 도출

감정서 작성 원칙:
1. 격식체(합니다/입니다) 사용
2. 사실과 의견을 명확히 구분
3. 원고/피고 어느 쪽에도 편향하지 않음
4. 수치와 증거에 기반한 서술
5. "~으로 보인다" 대신 "측정되었다", "확인되었다" 사용
6. 불확실한 사항은 "추가 확인 필요" 명시`;

async function writeFinalReport(caseId, caseData) {
  const {
    case_number, court, plaintiff, defendant, case_type,
    classification, briefing: briefingResult, sides,
    lens: lensResult, precedents, input,
  } = caseData;

  const resolvedType = case_type || classification?.case_type || 'other';
  const typeLabel = { copyright: '저작권 침해', defect: '소프트웨어 하자', contract: '계약 위반', trade_secret: '영업비밀 침해', other: '기타' };

  const domesticRefs = (precedents?.domestic?.raw || '').slice(0, 2000);
  const foreignRefs = (precedents?.foreign?.raw || '').slice(0, 1000);
  const lensConclusion = lensResult?.analysis?.conclusion || '소스코드 분석 미수행';
  const lensScore = lensResult?.analysis?.overall_similarity || 0;
  const claimSummary = sides?.claim?.conclusion || sides?.claim?.structure_summary || '원고 분석 미수행';
  const defenseSummary = sides?.defense?.conclusion || sides?.defense?.structure_summary || '피고 분석 미수행';

  const result = await callLegal({
    agent: 'quill',
    requestType: 'final_report_draft',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `다음 감정 사건에 대한 감정보고서 초안을 법원 양식으로 작성해 주세요.

**사건 정보**
- 사건번호: ${case_number}
- 법원: ${court || '미상'}
- 원고: ${plaintiff || '미상'}
- 피고: ${defendant || '미상'}
- 감정 유형: ${typeLabel[resolvedType] || resolvedType}
- 감정사항: ${Array.isArray(input?.appraisal_items) ? input.appraisal_items.join('; ') : '미상'}

**분석 결과 요약**
코드 유사도: ${lensScore}%
원고 분석: ${claimSummary.slice(0, 500)}
피고 분석: ${defenseSummary.slice(0, 500)}
렌즈 소견: ${lensConclusion.slice(0, 500)}

**국내 판례 요약**:
${domesticRefs}

**해외 판례 요약**:
${foreignRefs}

감정보고서 전체를 다음 구조로 작성해 주세요:

# 감 정 서

## 1. 감정 개요
(사건번호, 당사자, 감정사항 요약)

## 2. 사건 및 감정소요 분석
(사건 경위, 쟁점, 분석 범위)

## 3. 분석 방법론
(사용 도구, 분석 기준, 유사도 측정 방법)

## 4. 분석 결과
### 4.1 소스코드 유사도 분석
### 4.2 기능 매핑 분석
### 4.3 원고 소프트웨어 분석
### 4.4 피고 소프트웨어 분석
### 4.5 양측 비교 분석

## 5. 판례 참조
### 5.1 국내 판례
### 5.2 해외 판례

## 6. 감정 의견
### 6.1 결론
### 6.2 근거

## 7. 첨부 자료 목록

[이 문서는 감정 초안입니다. 마스터(감정인)의 최종 검토 및 서명 후 법원에 제출됩니다.]`,
    maxTokens: 8192,
  });

  const report = await store.saveReport({
    case_id: caseId,
    report_type: 'final',
    content_md: result.text,
    review_status: 'draft',
  });

  console.log(`[퀼] 감정보고서 초안 작성 완료: 보고서 ID=${report.id}`);
  return { report, content: result.text };
}

module.exports = {
  writeFinalReport,
};
