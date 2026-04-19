'use strict';

/**
 * defense.js (디펜스) — 피고 자료 분석 전문
 *
 * 역할:
 *   - 피고 소스코드 구조/기능/특징 분석
 *   - 피고 주장(독자개발 등)의 기술적 타당성 검증
 *   - 피고 제출 증거 분석 및 증거력 평가
 *   원칙: 객관적 분석, 피고 편향 금지
 */

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
const { callLegal } = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/llm-helper'));

const SYSTEM_PROMPT = `당신은 디펜스(Defense)입니다. 피고 측 자료를 분석하는 전문 에이전트입니다.

역할:
- 피고 소스코드의 구조, 기능, 기술적 특징 분석
- 피고의 독자 개발 주장 검증
- 오픈소스/공통 라이브러리 사용 여부 확인
- 피고 제출 증거의 증거력 평가

분석 원칙:
- 객관적 분석: 피고 편향 절대 금지
- 피고 주장의 강점과 약점을 모두 기술
- 독자 개발 증거 특히 주의 깊게 검토 (git 이력, 개발 환경, 설계 문서)
- 기술적 사실에 근거한 서술만`;

async function analyzeDefendant(caseId, caseData) {
  const { case_number } = caseData;
  const caseDir = path.join(env.PROJECT_ROOT, 'bots/legal/cases', case_number);
  const defendantDir = path.join(caseDir, 'source-defendant');
  const hasCode = fs.existsSync(defendantDir);

  let codeInfo = '';
  if (hasCode) {
    const files = collectCodeFiles(defendantDir);
    codeInfo = `\n소스코드 파일 목록 (${files.length}개):\n${files.slice(0, 30).join('\n')}`;
  }

  const result = await callLegal({
    agent: 'defense',
    requestType: 'defendant_analysis',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `사건 ${case_number}에서 피고 측 자료를 분석해 주세요.

감정 유형: ${caseData.case_type || caseData.classification?.case_type || '미분류'}
피고: ${caseData.defendant || '미상'}
주요 쟁점: ${caseData.briefing?.key_issues?.join(', ') || '미상'}
${codeInfo}

다음 항목을 분석해 주세요:
1. 피고 소프트웨어 구조 분석 (아키텍처, 모듈, 주요 기능)
2. 핵심 기능 목록
3. 독자 개발 가능성 (개발 이력, 타임라인, 설계 방법론)
4. 오픈소스/공통 라이브러리 활용 여부
5. 피고 주장의 기술적 타당성 (강점/약점)
6. 제출 증거 평가 (증거력 등급: 직접/간접/추정)

JSON 형식:
{
  "structure_summary": "코드 구조 요약",
  "function_list": ["기능1", "기능2"],
  "code_features": "기술적 특징",
  "independent_dev_evidence": ["독자개발 증거1"],
  "opensource_usage": ["오픈소스 라이브러리 목록"],
  "defense_validity": { "strengths": ["강점1"], "weaknesses": ["약점1"] },
  "evidence_evaluation": [{"evidence": "증거명", "level": "direct|indirect|presumed", "notes": "평가"}],
  "key_issues_defendant": ["쟁점1"],
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
    agent: 'defense',
    analysis_type: 'defendant_analysis',
    source_type: caseData.briefing?.tech_domain || 'other',
    mapping_data: {
      function_list: analysis.function_list,
      independent_dev_evidence: analysis.independent_dev_evidence,
      opensource_usage: analysis.opensource_usage,
      defense_validity: analysis.defense_validity,
    },
    evidence: analysis.evidence_evaluation || [],
    conclusion: analysis.conclusion,
    raw_output: result.text,
  });

  console.log(`[디펜스] 피고 자료 분석 완료`);
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
  analyzeDefendant,
};
