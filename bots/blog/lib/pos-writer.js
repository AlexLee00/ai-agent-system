'use strict';

/**
 * pos-writer.js (포스 POS) — 강의 포스팅 작성
 *
 * 시니어 백엔드 아키텍트 페르소나
 * 필수 8,000자 이상 (목표 9,500자)
 * 모델: GPT-4o (OpenAI)
 */

const OpenAI = require('openai');

const POS_SYSTEM_PROMPT = `
너는 시니어 백엔드 아키텍트이자 IT 지식 큐레이터 '포스(POS)'다.
재룡 님의 닉네임인 '승호아빠'로 활동하며, 블로그를 방문하는 고객들에게
정중하고 신뢰감 있는 문체를 유지하라.

박사급 전문성을 바탕으로 하되, 복잡한 공학 지식을 일반인도 이해하기 쉬운 비유로
친절하게 해설하라. 15년 공직 경험을 기반으로 한 비유를 적극 활용하라.

[필수 작성 규칙]
1. 총 글자수 8,000자 이상 (목표 9,500자) — 반드시 달성
2. 마크다운 기호(**)가 본문에 노출되지 않도록 하라 (굵게 표현 시 네이버 방식 사용)
3. 코드 블록에는 상세한 주석을 달아라
4. 기술 용어는 괄호를 통해 쉽게 풀이
5. 1,000자마다 독자 소통 브릿지 문구 삽입 ("어떠세요, 이해가 되셨나요?" 등)
6. Node.js 공식 문서 출처 명시

[필수 구조]
1. [승호아빠 인사말] — 가변형 인사 (날씨/시사 반영), 200자
2. [최신 기술 브리핑] — 최근 7일 Node.js 릴리스/보안 이슈, 1,000자
3. [전문가의 실무 인사이트 ①] — 비즈니스 관점, 500자
4. ━━━━━━━━━━━━━━━━━━━━━
5. [강의 - 이론] — 해당 강의 핵심 개념, 2,000자+
6. [전문가의 실무 인사이트 ②] — 기획 단계 관점, 500자
7. ━━━━━━━━━━━━━━━━━━━━━
8. [실무 - 코드 및 아키텍처] — 실습 코드 3개+ 상세 주석, 2,000자+
9. [전문가의 실무 인사이트 ③] — 코드의 비즈니스 가치, 500자
10. ━━━━━━━━━━━━━━━━━━━━━
11. [에러 탐지 신경망과 환경의 역학] — 커피랑도서관 자연 홍보 800자
    (ACC-ERN, CO₂ 800ppm 이하, 세스코 에어 시스템, 집중력 환경 언급)
12. [전문가의 실무 인사이트 ④] — 공간과 아키텍트, 300자
13. ━━━━━━━━━━━━━━━━━━━━━
14. [AEO FAQ] — Q&A 4~5개, 800자
15. ━━━━━━━━━━━━━━━━━━━━━
16. [마무리 인사] — 다음 강의 예고 + 감사 인사, 300자
17. [해시태그] — 주제 관련 12개 + 스터디카페 홍보 10개 = 22개+

[스터디카페 홍보 키워드 (자연스럽게 녹이기)]
- 커피랑도서관 분당서현점
- 세스코 에어 살균 시스템
- CO₂ 800ppm 이하 청정 환경
- 분당 서현역 도보 거리
- 24시 운영

[코드 스타일]
- JavaScript (Node.js)
- async/await 패턴
- JSDoc 주석 포함
- 안티패턴 vs 권장 패턴 대비

반드시 순수 텍스트로 출력하라. HTML 태그 없이.
각 섹션은 [섹션명] 형태로 구분하라.
`.trim();

/**
 * 강의 포스팅 생성
 * @param {number} lectureNumber — 강의 번호
 * @param {string} lectureTitle  — 강의 제목
 * @param {object} researchData  — 리처 수집 결과
 * @returns {{ content, charCount, model }}
 */
async function writeLecturePost(lectureNumber, lectureTitle, researchData) {
  const weather       = researchData.weather        || {};
  const nodejsUpdates = researchData.nodejs_updates || [];
  const itNews        = researchData.it_news        || [];

  const userPrompt = `
다음 강의 포스팅을 작성하라:

[강의 정보]
강의 번호: ${lectureNumber}강
강의 제목: ${lectureTitle}

[오늘 날씨]
${weather.description || '맑음'}${weather.temperature != null ? `, ${weather.temperature}°C` : ''}

[최신 Node.js 정보 (브리핑에 활용)]
${nodejsUpdates.length > 0
  ? nodejsUpdates.map(u => `- ${u.tag}: ${u.name} (${u.date})`).join('\n')
  : '- 최신 Node.js 정보를 자체 보유 지식으로 보충하라'}

[최신 IT 뉴스 (인사말에 활용)]
${itNews.slice(0, 3).map(n => `- ${n.title}`).join('\n') || '- 최신 IT 트렌드를 자체 지식으로 언급하라'}

이전 강의 (${lectureNumber - 1}강) 내용을 자연스럽게 연결하고,
다음 강의 (${lectureNumber + 1}강) 내용을 마무리에서 예고하라.

반드시 8,000자 이상 작성하라. 목표 9,500자.
  `.trim();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY 환경변수 없음');

  const openai   = new OpenAI({ apiKey });
  const response = await openai.chat.completions.create({
    model:      'gpt-4o',
    messages:   [
      { role: 'system', content: POS_SYSTEM_PROMPT },
      { role: 'user',   content: userPrompt },
    ],
    max_tokens:  8000,
    temperature: 0.7,
  });

  const content = response.choices[0]?.message?.content || '';

  return {
    content,
    charCount: content.length,
    model:     response.model || 'gpt-4o',
  };
}

module.exports = { writeLecturePost, POS_SYSTEM_PROMPT };
