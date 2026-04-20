'use strict';

/**
 * garam.js (가람) — 국내 판례 서칭 전문
 *
 * 이름 유래: 가람(강) — 한국 법률의 흐름을 읽는다
 * 역할:
 *   - 국내 유사 판례 검색 (대법원/하급심)
 *   - 법률 근거 정리
 *   - 선례 분석 및 시사점 도출
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
const { callLegal } = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/llm-helper'));
const koreaLawClient = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/korea-law-client'));

const SYSTEM_PROMPT = `당신은 가람(Garam)입니다. 한국 법률의 흐름을 읽는 국내 판례 분석 전문 에이전트입니다.

역할:
- 소프트웨어 관련 국내 판례 검색 및 분석
- 유사 사건 판결 요지 정리
- 현재 사건에 적용 가능한 법리 도출

주요 판례 출처:
- 대법원 종합법률정보 (https://glaw.scourt.go.kr)
- 대법원/고등법원/지방법원 SW 관련 판결
- 한국소프트웨어감정평가학회 자료
- 한국저작권위원회 DB

분석 원칙:
- 최신 판례 우선 (5년 이내)
- 대법원 → 고등법원 → 지방법원 순 신뢰도
- 판례 5건 이내, 각 판례별 핵심 정보 제공
- 편향 없는 객관적 분석`;

const APPLICABLE_LAWS = {
  copyright: ['저작권법 제2조(정의)', '저작권법 제4조(저작물의 예시)', '저작권법 제91조(침해죄)', '컴퓨터프로그램보호법'],
  defect: ['민법 제667조(수급인의 담보책임)', '민법 제580조(매도인의 하자담보책임)', '소프트웨어 진흥법'],
  contract: ['민법 제390조(채무불이행)', '민법 제393조(손해배상의 범위)', '민법 제750조(불법행위의 내용)'],
  trade_secret: ['부정경쟁방지 및 영업비밀보호에 관한 법률 제2조(정의)', '부정경쟁방지법 제10조(영업비밀 침해행위에 대한 금지청구권)'],
};

async function searchDomesticCases(caseId, caseData) {
  const { case_number, case_type, plaintiff, defendant } = caseData;
  const resolvedType = case_type || caseData.classification?.case_type || 'other';

  const relevantLaws = APPLICABLE_LAWS[resolvedType] || APPLICABLE_LAWS.copyright;
  const externalContext = await collectKoreaLawContext(caseData, resolvedType);

  const result = await callLegal({
    agent: 'garam',
    requestType: 'domestic_case_search',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `사건 ${case_number}과 유사한 국내 판례를 검색하고 분석해 주세요.

감정 유형: ${resolvedType} (${typeLabel(resolvedType)})
주요 쟁점: ${caseData.briefing?.key_issues?.join(', ') || '미상'}
기술 분야: ${caseData.briefing?.tech_domain || '미상'}

관련 법률 조항:
${relevantLaws.map(l => `- ${l}`).join('\n')}

국가법령정보 공동활용 API 기반 참고 결과:
${externalContext}

다음 형식으로 국내 판례 최대 5건을 분석해 주세요:

## 국내 판례 분석

### 판례 1
- **사건번호**: [사건번호]
- **법원**: [법원명]
- **판결일**: [YYYY-MM-DD]
- **판결 요지**: [핵심 판단 내용]
- **적용 법률**: [관련 법조항]
- **현재 사건 적용 시사점**: [이 판례가 현재 사건에 주는 교훈]
- **관련성 점수**: [0-10]

[판례 2~5 동일 형식]

## 법률 동향 요약
[SW 감정 관련 최근 법률 해석 동향]

## 현재 사건 적용 법리
[위 판례들을 종합했을 때 현재 사건에 적용할 수 있는 법리]`,
    maxTokens: 4096,
  });

  const precedents = parsePrecedents(result.text);
  const savedRefs = [];

  for (const p of precedents) {
    const ref = await store.saveCaseReference({
      case_id: caseId,
      agent: 'garam',
      ref_case_number: p.case_number,
      court: p.court,
      decision_date: p.decision_date,
      summary: p.summary,
      applicable_law: p.applicable_law,
      relevance_score: p.relevance_score || 5,
      jurisdiction: 'domestic',
      raw_output: result.text,
    });
    savedRefs.push(ref);
  }

  console.log(`[가람] 국내 판례 ${savedRefs.length}건 저장 완료`);
  return { raw: result.text, references: savedRefs };
}

async function collectKoreaLawContext(caseData, resolvedType) {
  const keywords = buildSearchKeywords(caseData, resolvedType);
  const sections = [];

  for (const keyword of keywords) {
    try {
      const precedents = await koreaLawClient.searchPrecedents(keyword, { display: 3, page: 1, timeoutMs: 12000 });
      if (precedents.items.length) {
        sections.push([
          `[판례 검색어] ${keyword}`,
          ...precedents.items.slice(0, 3).map((item) =>
            `- ${item.caseNumber} | ${item.caseName} | ${item.court} | ${item.decisionDate} | 일련번호=${item.id}`),
        ].join('\n'));
      }
    } catch (error) {
      sections.push(`[판례 검색어] ${keyword}\n- 검색 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const lawName of APPLICABLE_LAWS[resolvedType] || []) {
    const query = String(lawName).split(' 제')[0].trim();
    if (!query) continue;
    try {
      const laws = await koreaLawClient.searchLaws(query, { display: 2, page: 1, timeoutMs: 12000 });
      if (laws.items.length) {
        sections.push([
          `[법령 검색어] ${query}`,
          ...laws.items.slice(0, 2).map((item) =>
            `- ${item.nameKo} | ${item.kind} | ${item.ministry} | 시행일=${item.effectiveDate} | 법령ID=${item.id} MST=${item.mst}`),
        ].join('\n'));
      }
    } catch (error) {
      sections.push(`[법령 검색어] ${query}\n- 검색 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return sections.length ? sections.join('\n\n') : '참고 결과 없음';
}

function buildSearchKeywords(caseData, resolvedType) {
  const fromIssues = Array.isArray(caseData?.briefing?.key_issues) ? caseData.briefing.key_issues : [];
  const fromDomain = caseData?.briefing?.tech_domain ? [String(caseData.briefing.tech_domain)] : [];
  const fallbackByType = {
    copyright: ['저작권 침해', '프로그램 저작권'],
    defect: ['소프트웨어 하자', '시스템 구축 하자'],
    contract: ['소프트웨어 개발 계약', '용역 계약 해지'],
    trade_secret: ['영업비밀 침해', '소스코드 유출'],
    other: ['소프트웨어 분쟁'],
  };

  return Array.from(
    new Set([...fromIssues, ...fromDomain, ...(fallbackByType[resolvedType] || fallbackByType.other)])
  )
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

function typeLabel(type) {
  const labels = {
    copyright: '저작권 침해',
    defect: '소프트웨어 하자',
    contract: '계약 위반',
    trade_secret: '영업비밀 침해',
    other: '기타',
  };
  return labels[type] || type;
}

function parsePrecedents(text) {
  const precedents = [];
  const sections = text.split(/### 판례 \d+/);

  for (const section of sections.slice(1)) {
    const caseNumberMatch = section.match(/\*\*사건번호\*\*[:\s]+([^\n]+)/) || section.match(/사건번호[:\s]+([^\n]+)/);
    const courtMatch = section.match(/\*\*법원\*\*[:\s]+([^\n]+)/) || section.match(/법원[:\s]+([^\n]+)/);
    const dateMatch = section.match(/\*\*판결일\*\*[:\s]+([^\n]+)/) || section.match(/판결일[:\s]+([^\n]+)/);
    const summaryMatch =
      section.match(/\*\*판결 요지\*\*[:\s]*\n?([\s\S]*?)(?=\n-\s+\*\*(?:적용 법률|현재 사건 적용 시사점|관련성 점수)\*\*|$)/) ||
      section.match(/판결 요지[:\s]+([\s\S]*?)(?=\n- \*\*|$)/);
    const lawMatch = section.match(/\*\*적용 법률\*\*[:\s]+([^\n]+)/) || section.match(/적용 법률[:\s]+([^\n]+)/);
    const scoreMatch =
      section.match(/\*\*관련성 점수\*\*[:\s]*\**\s*([0-9.]+)/) ||
      section.match(/관련성 점수[:\s]+([0-9.]+)/);

    if (caseNumberMatch) {
      precedents.push({
        case_number: caseNumberMatch[1].trim().replace(/\*\*/g, ''),
        court: courtMatch?.[1].trim().replace(/\*\*/g, '') || '미상',
        decision_date: dateMatch?.[1].trim().replace(/\*\*/g, '') || null,
        summary: summaryMatch?.[1].trim() || section.slice(0, 300).trim(),
        applicable_law: lawMatch?.[1].trim().replace(/\*\*/g, '') || '',
        relevance_score: parseFloat(scoreMatch?.[1] || '5'),
      });
    }
  }

  return precedents;
}

module.exports = {
  searchDomesticCases,
};
