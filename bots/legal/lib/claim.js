'use strict';

/**
 * claim.js (클레임) — 원고 자료 분석 전문
 *
 * 역할:
 *   - 원고 소스코드 구조/기능/특징 분석
 *   - 원고 주장의 기술적 타당성 검증
 *   - 원고 제출 증거 분석 및 증거력 평가
 *   원칙: 객관적 분석, 원고 편향 금지
 */

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
const { callLegal } = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/llm-helper'));

const SYSTEM_PROMPT = `당신은 클레임(Claim)입니다. 원고 측 자료를 분석하는 전문 에이전트입니다.

역할:
- 원고 소스코드의 구조, 기능, 기술적 특징 분석
- 원고 주장의 기술적 타당성 검증
- 원고 제출 증거의 증거력 평가

분석 원칙:
- 객관적 분석: 원고 편향 절대 금지
- 원고 주장의 강점과 약점을 모두 기술
- 과장/불일치 사항 명시
- 기술적 사실에 근거한 서술만`;

async function analyzePlaintiff(caseId, caseData) {
  const { case_number } = caseData;
  const caseDir = path.join(env.PROJECT_ROOT, 'bots/legal/cases', case_number);
  const plaintiffDir = path.join(caseDir, 'source-plaintiff');
  const hasCode = fs.existsSync(plaintiffDir);

  let codeInfo = '';
  if (hasCode) {
    const files = collectCodeFiles(plaintiffDir);
    codeInfo = `\n소스코드 파일 목록 (${files.length}개):\n${files.slice(0, 30).join('\n')}`;
  }

  const result = await callLegal({
    agent: 'claim',
    requestType: 'plaintiff_analysis',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `사건 ${case_number}에서 원고 측 자료를 분석해 주세요.

감정 유형: ${caseData.case_type || caseData.classification?.case_type || '미분류'}
원고: ${caseData.plaintiff || '미상'}
주요 쟁점: ${caseData.briefing?.key_issues?.join(', ') || '미상'}
${codeInfo}

다음 항목을 분석해 주세요:
1. 원고 소프트웨어 구조 분석 (아키텍처, 모듈, 주요 기능)
2. 핵심 기능 목록 (창작성 있는 표현 포함)
3. 원고 주장의 기술적 타당성 (강점/약점)
4. 제출 증거 평가 (증거력 등급: 직접/간접/추정)
5. 핵심 쟁점 (원고 관점)

JSON 형식:
{
  "structure_summary": "코드 구조 요약",
  "function_list": ["기능1", "기능2"],
  "code_features": "기술적 특징",
  "claim_validity": { "strengths": ["강점1"], "weaknesses": ["약점1"] },
  "evidence_evaluation": [{"evidence": "증거명", "level": "direct|indirect|presumed", "notes": "평가"}],
  "key_issues_plaintiff": ["쟁점1"],
  "conclusion": "분석 결론"
}`,
    maxTokens: 4096,
  });

  let analysis = { conclusion: result.text, function_list: [], code_features: '' };
  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) analysis = { ...analysis, ...JSON.parse(jsonMatch[0]) };
  } catch (_) { /* ignore */ }

  await store.saveCodeAnalysis({
    case_id: caseId,
    agent: 'claim',
    analysis_type: 'plaintiff_analysis',
    source_type: caseData.briefing?.tech_domain || 'other',
    mapping_data: {
      function_list: analysis.function_list,
      claim_validity: analysis.claim_validity,
      evidence_evaluation: analysis.evidence_evaluation,
    },
    evidence: analysis.evidence_evaluation || [],
    conclusion: analysis.conclusion,
    raw_output: result.text,
  });

  console.log(`[클레임] 원고 자료 분석 완료`);
  return analysis;
}

function collectCodeFiles(dir, base = '') {
  const exts = new Set(['.js', '.ts', '.py', '.java', '.cs', '.cpp', '.c', '.php', '.go', '.rb', '.swift', '.kt']);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) files.push(...collectCodeFiles(path.join(dir, entry.name), rel));
    else if (exts.has(path.extname(entry.name))) files.push(rel);
  }
  return files;
}

module.exports = {
  analyzePlaintiff,
};
