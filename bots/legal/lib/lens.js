'use strict';

/**
 * lens.js (렌즈) — 소스코드 유사도/구조 분석 전문
 *
 * 역할:
 *   - 코드 유사도 3중 분석 (문자열/토큰/구조)
 *   - 기능 매핑 (원고↔피고 1:1 대응표)
 *   - 복사 탐지 (변수명 변경, 주석 제거, 순서 변경)
 *   - SW 유형별 특화 분석 (웹/앱/DB/임베디드)
 */

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
const { callLegal } = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/llm-helper'));
const similarity = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/similarity-engine'));

const SYSTEM_PROMPT = `당신은 렌즈(Lens)입니다. 소프트웨어 저작권 침해 및 기술 분쟁을 위한 소스코드 분석 전문 에이전트입니다.

역할:
- 두 소프트웨어 간의 코드 유사도를 3중 방법(문자열/토큰/구조)으로 측정
- 기능 매핑: 원고 기능 ↔ 피고 기능 1:1 대응표 생성
- 복사 탐지: 변수명 변경, 주석 제거, 순서 변경, 난독화 패턴 감지
- 독자 개발 가능성 분석 (오픈소스/공통 라이브러리 사용 여부)

분석 원칙:
- 객관적 수치 측정 우선, 주관적 판단 최소화
- 유사도의 원인 분석 (복사 vs 독자 개발 vs 공통 패턴)
- 원고/피고 편향 금지
- 불확실한 부분은 "추가 분석 필요" 명시`;

async function analyzeSourceCode(caseId, caseData) {
  const { case_number, classification } = caseData;
  const caseDir = path.join(env.PROJECT_ROOT, 'bots/legal/cases', case_number);
  const plaintiffDir = path.join(caseDir, 'source-plaintiff');
  const defendantDir = path.join(caseDir, 'source-defendant');

  const hasSources = fs.existsSync(plaintiffDir) && fs.existsSync(defendantDir);

  let similarityResult = null;
  if (hasSources) {
    console.log(`[렌즈] 소스코드 비교 시작: ${plaintiffDir} vs ${defendantDir}`);
    similarityResult = similarity.compareDirectories(plaintiffDir, defendantDir);
  }

  const result = await callLegal({
    agent: 'lens',
    requestType: 'source_code_analysis',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `사건 ${case_number}에 대한 소스코드 분석을 수행합니다.

감정 유형: ${classification?.case_type || '미분류'}
기술 분야: ${caseData.briefing?.tech_domain || '미상'}
소스코드 제공 여부: ${hasSources ? '있음' : '없음 (목록/설명만 제공)'}

${similarityResult ? `
[자동 측정 결과]
평균 유사도: ${similarityResult.average_similarity}%
비교 파일 수: ${similarityResult.files_compared}
고위험 파일 수: ${similarityResult.high_risk_files}
중위험 파일 수: ${similarityResult.medium_risk_files}
전체 위험도: ${similarityResult.overall_risk}
` : ''}

원고 측 코드 특성:
${caseData.sides?.claim?.code_features || '미제출 또는 분석 전'}

피고 측 코드 특성:
${caseData.sides?.defense?.code_features || '미제출 또는 분석 전'}

다음 항목을 분석해 주세요:
1. 코드 유사도 수치 및 해석
2. 유사한 기능 목록 (기능명 + 유사도 %)
3. 복사 가능성 지표 (독자개발 vs 복사 증거)
4. 오픈소스/공통 패턴 여부
5. 전문가 소견 (중립적)

JSON 형식:
{
  "overall_similarity": 숫자,
  "copy_risk": "low|medium|high",
  "similar_features": [{"feature": "기능명", "similarity": 숫자, "notes": "설명"}],
  "copy_evidence": ["복사 증거1"],
  "independent_evidence": ["독자개발 증거1"],
  "opensource_overlap": ["오픈소스 공통 부분"],
  "conclusion": "전문가 소견"
}`,
    maxTokens: 4096,
  });

  let analysis = {
    overall_similarity: similarityResult?.average_similarity || 0,
    copy_risk: similarityResult?.overall_risk || 'unknown',
    conclusion: result.text,
  };

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) analysis = { ...analysis, ...JSON.parse(jsonMatch[0]) };
  } catch (_) { /* ignore */ }

  await store.saveCodeAnalysis({
    case_id: caseId,
    agent: 'lens',
    analysis_type: 'similarity',
    source_type: caseData.briefing?.tech_domain || 'other',
    similarity_score: analysis.overall_similarity,
    mapping_data: { similar_features: analysis.similar_features || [], opensource_overlap: analysis.opensource_overlap || [] },
    evidence: analysis.copy_evidence || [],
    conclusion: analysis.conclusion,
    raw_output: result.text,
  });

  if (similarityResult?.comparisons) {
    for (const comp of similarityResult.comparisons.filter(c => c.copy_risk !== 'low')) {
      await store.saveCodeAnalysis({
        case_id: caseId,
        agent: 'lens',
        analysis_type: 'copy_detection',
        source_type: caseData.briefing?.tech_domain || 'other',
        similarity_score: comp.composite_score,
        mapping_data: comp,
        evidence: [{ file_a: comp.file_a, file_b: comp.file_b, risk: comp.copy_risk }],
        conclusion: `파일 비교: ${comp.file_a} vs ${comp.file_b}`,
        raw_output: JSON.stringify(comp),
      });
    }
  }

  console.log(`[렌즈] 분석 완료 — 유사도: ${analysis.overall_similarity}%, 위험도: ${analysis.copy_risk}`);
  return { analysis, similarityResult };
}

async function analyzeFunctionMapping(caseId, caseData) {
  const { case_number } = caseData;

  const result = await callLegal({
    agent: 'lens',
    requestType: 'function_mapping',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `사건 ${case_number}에서 원고와 피고 소프트웨어의 기능 매핑을 작성해 주세요.

원고 기능 목록:
${caseData.sides?.claim?.function_list || '미제출'}

피고 기능 목록:
${caseData.sides?.defense?.function_list || '미제출'}

원고 기능과 피고 기능의 1:1 매핑 테이블을 작성하고, 각 기능 쌍에 대해:
1. 유사도 수준 (동일/유사/유사하지않음)
2. 구현 방식 비교 (알고리즘, 라이브러리, 설계 패턴)
3. 특이사항 (독특한 구현, 오픈소스 공통 부분 등)

마크다운 표 형식으로 작성해 주세요.`,
    maxTokens: 4096,
  });

  await store.saveCodeAnalysis({
    case_id: caseId,
    agent: 'lens',
    analysis_type: 'function_mapping',
    source_type: caseData.briefing?.tech_domain || 'other',
    mapping_data: { table: result.text },
    conclusion: '기능 매핑 테이블 생성 완료',
    raw_output: result.text,
  });

  return { mapping: result.text };
}

module.exports = {
  analyzeSourceCode,
  analyzeFunctionMapping,
};
