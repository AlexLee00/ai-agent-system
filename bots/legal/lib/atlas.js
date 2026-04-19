'use strict';

/**
 * atlas.js (아틀라스) — 해외 판례 서칭 전문
 *
 * 이름 유래: 아틀라스 — 세계를 아우르는 법률 지식
 * 역할:
 *   - 해외 유사 판례 검색 (US/EU/WIPO)
 *   - 국제 법률 동향 분석
 *   - 비교법적 시사점 도출
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
const { callLegal } = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/llm-helper'));

const SYSTEM_PROMPT = `당신은 아틀라스(Atlas)입니다. 세계를 아우르는 해외 법률 동향 분석 전문 에이전트입니다.

역할:
- 소프트웨어 관련 해외 판례 검색 및 분석
- 국제 법률 동향 및 비교법적 시사점 도출
- 한국 법률과의 차이점 및 참고 가능성 분석

주요 판례 출처:
- US: Copyright Office, USPTO, Federal District/Circuit Courts
- EU: Court of Justice of the EU (CURIA), European Patent Office (EPO)
- International: WIPO 중재/조정, ICC
- Academic: IEEE/ACM 학술 논문 (SW 감정 방법론)
- GitHub DMCA 사례 (실무 참고)

분석 원칙:
- 해외 판례 3건 이내
- 한국법과의 비교법적 시사점 명시
- 직접 적용 불가능하나 참고 가능한 법리 설명
- 영문 판례는 한국어로 번역하여 제공`;

async function searchForeignCases(caseId, caseData) {
  const { case_number, case_type } = caseData;
  const resolvedType = case_type || caseData.classification?.case_type || 'other';

  const result = await callLegal({
    agent: 'atlas',
    requestType: 'foreign_case_search',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `사건 ${case_number}과 유사한 해외 판례를 검색하고 비교법적 분석을 해주세요.

감정 유형: ${resolvedType}
주요 쟁점: ${caseData.briefing?.key_issues?.join(', ') || '미상'}
기술 분야: ${caseData.briefing?.tech_domain || '미상'}

해외 판례 최대 3건 및 비교법적 분석:

## 해외 판례 분석

### 판례 1
- **사건번호/이름**: [사건 식별자]
- **관할**: [미국/EU/WIPO 등]
- **법원**: [법원/기관명]
- **판결일**: [YYYY-MM-DD]
- **판결 요지** (한국어 번역): [핵심 판단]
- **한국 사건 시사점**: [국내 적용 가능한 법리 또는 참고 사항]
- **관련성 점수**: [0-10]

[판례 2~3 동일 형식]

## 국제 법률 동향
[SW 감정/저작권/하자 관련 최근 국제 동향]

## 비교법적 분석
[한국법과의 비교: 유사점, 차이점, 시사점]`,
    maxTokens: 4096,
  });

  const precedents = parseForeignPrecedents(result.text);
  const savedRefs = [];

  for (const p of precedents) {
    const ref = await store.saveCaseReference({
      case_id: caseId,
      agent: 'atlas',
      ref_case_number: p.case_number,
      court: p.court,
      decision_date: p.decision_date,
      summary: p.summary,
      applicable_law: p.applicable_law || '',
      relevance_score: p.relevance_score || 4,
      jurisdiction: 'foreign',
      raw_output: result.text,
    });
    savedRefs.push(ref);
  }

  console.log(`[아틀라스] 해외 판례 ${savedRefs.length}건 저장 완료`);
  return { raw: result.text, references: savedRefs };
}

function parseForeignPrecedents(text) {
  const precedents = [];
  const sections = text.split(/### 판례 \d+/);

  for (const section of sections.slice(1)) {
    const idMatch = section.match(/사건번호\/이름[:\s]+([^\n]+)/);
    const jurisdictionMatch = section.match(/관할[:\s]+([^\n]+)/);
    const courtMatch = section.match(/법원[:\s]+([^\n]+)/);
    const dateMatch = section.match(/판결일[:\s]+([^\n]+)/);
    const summaryMatch = section.match(/판결 요지.*?[:\s]+([\s\S]*?)(?=\n- \*\*|$)/);
    const scoreMatch = section.match(/관련성 점수[:\s]+([0-9.]+)/);

    if (idMatch) {
      precedents.push({
        case_number: idMatch[1].trim().replace(/\*\*/g, ''),
        court: [jurisdictionMatch?.[1], courtMatch?.[1]].filter(Boolean).join(' / ').replace(/\*\*/g, '') || '미상',
        decision_date: dateMatch?.[1].trim().replace(/\*\*/g, '') || null,
        summary: summaryMatch?.[1].trim() || section.slice(0, 300).trim(),
        applicable_law: '',
        relevance_score: parseFloat(scoreMatch?.[1] || '4'),
      });
    }
  }

  return precedents;
}

module.exports = {
  searchForeignCases,
};
