'use strict';

/**
 * balance.js (밸런스) — 감정서 품질 검증
 *
 * 이름 유래: 밸런스(저울) — 양측 균형 잡힌 공정한 검증
 * 역할:
 *   - 논리 일관성 검증
 *   - 법률 정확성 검증
 *   - 증거 충분성 검증
 *   - 중립성 검증
 *   - 형식 준수 검증
 *   원칙: 퀼과 독립적 판단 (작성자 ≠ 검증자)
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
const { callLegal } = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/llm-helper'));

const SYSTEM_PROMPT = `당신은 밸런스(Balance)입니다. 법원 SW 감정서의 품질을 검증하는 독립적인 검증 에이전트입니다.

역할:
- 감정서 초안의 품질을 5개 기준으로 검증
- 퀼(작성자)과 완전히 독립된 시각으로 비판적 검토

검증 기준:
1. 논리 일관성: 분석 결과와 결론이 논리적으로 일치하는가
2. 법률 정확성: 법률 용어, 조항 인용이 정확한가
3. 증거 충분성: 결론을 뒷받침하는 증거가 충분한가
4. 중립성: 원고/피고 편향 없이 객관적으로 서술되었는가
5. 형식 준수: 법원 감정서 양식에 맞는가

검증 원칙:
- 비판적 시각으로 검토
- 발견된 모든 문제 명시
- 개선 방향 구체적으로 제시
- 통과 기준: 5개 항목 모두 70점 이상`;

async function reviewReport(caseId, draftData) {
  const { report, content } = draftData;

  const result = await callLegal({
    agent: 'balance',
    requestType: 'report_review',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `다음 감정서 초안을 5개 기준으로 검증해 주세요.

--- 감정서 초안 시작 ---
${content ? content.slice(0, 6000) : '(내용 없음)'}
--- 감정서 초안 끝 ---

다음 형식으로 검증 결과를 JSON으로 제공해 주세요:
{
  "scores": {
    "logic_consistency": 숫자(0-100),
    "legal_accuracy": 숫자(0-100),
    "evidence_sufficiency": 숫자(0-100),
    "neutrality": 숫자(0-100),
    "format_compliance": 숫자(0-100)
  },
  "overall_score": 숫자(0-100),
  "passed": true|false,
  "issues": ["문제점1", "문제점2"],
  "suggestions": ["개선제안1", "개선제안2"],
  "critical_issues": ["치명적 문제 (즉시 수정 필요)"],
  "detailed_review": "상세 검토 내용"
}

통과 기준: 5개 항목 모두 70점 이상, overall_score 75점 이상`,
    maxTokens: 3000,
  });

  let reviewResult = {
    scores: { logic_consistency: 0, legal_accuracy: 0, evidence_sufficiency: 0, neutrality: 0, format_compliance: 0 },
    overall_score: 0,
    passed: false,
    issues: [],
    suggestions: [],
    critical_issues: [],
    detailed_review: result.text,
  };

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) reviewResult = { ...reviewResult, ...JSON.parse(jsonMatch[0]) };
  } catch (_) { /* ignore */ }

  if (report?.id) {
    const reviewStatus = reviewResult.passed ? 'balance_reviewed' : 'draft';
    await store.updateReportStatus(
      report.id,
      reviewStatus,
      `밸런스 검증: ${reviewResult.issues.join('; ')}`,
      reviewResult.scores
    );
  }

  const scoreStr = Object.entries(reviewResult.scores)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  console.log(`[밸런스] 검증 완료 — 통과: ${reviewResult.passed}, 점수: ${scoreStr}`);

  return reviewResult;
}

async function checkNeutrality(text) {
  const biasPatterns = [
    { pattern: /원고.*(?:주장|진술).*옳|원고.*유리|피고.*틀|피고.*억지/g, side: 'plaintiff_bias' },
    { pattern: /피고.*주장.*옳|피고.*유리|원고.*틀|원고.*억지/g, side: 'defendant_bias' },
    { pattern: /명백히.*(?:침해|위반)|의심할.*여지.*없|확실히.*(?:복사|도용)/g, side: 'overclaim' },
  ];

  const findings = [];
  for (const { pattern, side } of biasPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      findings.push({ type: side, examples: matches.slice(0, 3) });
    }
  }

  return {
    neutral: findings.length === 0,
    findings,
  };
}

module.exports = {
  reviewReport,
  checkNeutrality,
};
