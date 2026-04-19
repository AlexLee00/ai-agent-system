'use strict';

/**
 * contro.js (컨트로) — 계약서 검토 전문
 *
 * 역할:
 *   - SW 개발 계약서, 유지보수 계약서, SLA 분석
 *   - 계약 위반 여부 판단
 *   - SLA/KPI 충족 여부 분석
 *   - 계약 해석 쟁점 도출
 *   - 손해배상 산정 근거
 */

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
const { callLegal } = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/llm-helper'));

const SYSTEM_PROMPT = `당신은 컨트로(Contro)입니다. 소프트웨어 개발 계약서 분석 전문 에이전트입니다.

역할:
- SW 개발/유지보수 계약서 조항별 분석
- 계약 위반 여부 및 정도 판단
- SLA/KPI 충족 여부 분석
- 손해배상 산정 근거 제공

분석 원칙:
- 계약서 원문에 근거한 객관적 분석
- 양측 해석의 가능성을 모두 검토
- 모호한 조항은 "해석 여지 있음" 명시
- 손해배상 산정은 계약서 조항 + 실제 손해 기반`;

async function analyzeContract(caseId, caseData, contractText) {
  const { case_number, case_type, briefing: briefingResult } = caseData;

  if (!contractText) {
    console.log(`[컨트로] 계약서 미제출 — 분석 건너뜀`);
    return { skipped: true, reason: '계약서 미제출' };
  }

  const result = await callLegal({
    agent: 'contro',
    requestType: 'contract_analysis',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `사건 ${case_number}에서 제출된 계약서를 분석해 주세요.

감정 유형: ${case_type || caseData.classification?.case_type || '미분류'}
주요 쟁점: ${briefingResult?.key_issues?.join(', ') || '미상'}

--- 계약서 내용 ---
${contractText.slice(0, 5000)}
--- 계약서 끝 ---

다음 항목을 분석해 주세요:

1. **계약 의무 분석**
   - 개발 범위 (계약상 납품 범위)
   - 납기/일정 조건
   - 검수/인수 기준
   - 하자담보 조항

2. **이행 여부 판단**
   - 이행된 의무
   - 미이행/지연 의무
   - 하자 해당 여부

3. **SLA/KPI 분석** (해당 시)
   - 가용성 기준
   - 응답시간 기준
   - 장애복구 기준

4. **계약 해석 쟁점**
   - 모호한 조항
   - 양측 해석 차이
   - 법원 판단 필요 사항

5. **손해배상 산정 근거**
   - 지체상금 계산 방법
   - 손해배상 조항
   - 실손해 산정 기준

JSON 형식:
{
  "contract_obligations": ["의무1", "의무2"],
  "fulfilled_obligations": ["이행1"],
  "unfulfilled_obligations": ["미이행1"],
  "sla_compliance": { "compliant": true|false, "details": "설명" },
  "interpretation_issues": ["쟁점1"],
  "damages_basis": { "penalty_clause": "설명", "calculation_method": "설명" },
  "conclusion": "계약서 분석 결론"
}`,
    maxTokens: 4096,
  });

  let analysis = { conclusion: result.text };
  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) analysis = { ...analysis, ...JSON.parse(jsonMatch[0]) };
  } catch (_) { /* ignore */ }

  await store.saveCodeAnalysis({
    case_id: caseId,
    agent: 'contro',
    analysis_type: 'structure',
    source_type: 'other',
    mapping_data: {
      contract_obligations: analysis.contract_obligations,
      fulfilled_obligations: analysis.fulfilled_obligations,
      unfulfilled_obligations: analysis.unfulfilled_obligations,
      sla_compliance: analysis.sla_compliance,
      damages_basis: analysis.damages_basis,
    },
    evidence: analysis.interpretation_issues || [],
    conclusion: analysis.conclusion,
    raw_output: result.text,
  });

  console.log(`[컨트로] 계약서 분석 완료`);
  return analysis;
}

async function analyzeContractFromFile(caseId, caseData) {
  const contractPath = path.join(
    env.PROJECT_ROOT, 'bots/legal/cases', caseData.case_number, 'contract.txt'
  );
  const contractText = fs.existsSync(contractPath)
    ? fs.readFileSync(contractPath, 'utf8')
    : null;
  return analyzeContract(caseId, caseData, contractText);
}

module.exports = {
  analyzeContract,
  analyzeContractFromFile,
};
