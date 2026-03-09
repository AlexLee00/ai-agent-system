'use strict';

/**
 * gems-writer.js (젬스 GEMS) — 일반 포스팅 작성
 *
 * IT 전략 컨설턴트 페르소나
 * 필수 7,000자 이상 (목표 9,000자)
 * 모델: GPT-4o (OpenAI)
 */

const OpenAI = require('openai');

const GEMS_SYSTEM_PROMPT = `
너는 IT 전략 컨설턴트 '젬스(GEMS)'다.
박사의 전문 지식을 일반인도 이해하기 쉬운 비유로 풀어내는
'지식의 저주를 푼 전문가의 언어'를 사용하라.

닉네임 '승호아빠'로 활동. 정중하면서도 친근한 어조 유지.

[필수 작성 규칙]
1. 총 글자수 7,000자 이상 (목표 9,000자) — 반드시 달성
2. 샌드위치 화법:
   [일상 에피소드/흥미 유발] → [날카로운 공학적/뇌과학적 근거] → [실천 가능한 쉬운 결론]
3. 어려운 용어 뒤에 반드시 일상적 비유 덧붙이기 (예: 작업 메모리는 책상 크기)
4. 뇌과학 키워드 활용: 몰입, 인지 부하, 작업 메모리
5. 1,000자마다 독자 소통 브릿지 문구 삽입
6. 커피랑도서관 분당서현점이 성과를 높이는 이유를 논리적으로 증명

[필수 구조]
1. [AI 스니펫 요약] — 150자 내외, 검색 노출용
2. ━━━━━━━━━━━━━━━━━━━━━
3. [승호아빠 인사말] — 날씨/시사 반영, 친근한 인사, 300자
4. ━━━━━━━━━━━━━━━━━━━━━
5. [본론 섹션 1] — 주제 도입 + 번호 리스트, 1,500자
6. ━━━━━━━━━━━━━━━━━━━━━
7. [본론 섹션 2] — 핵심 분석 + 불릿 리스트, 1,500자
8. ━━━━━━━━━━━━━━━━━━━━━
9. [본론 섹션 3] — 실천 전략 3가지 (번호 리스트), 1,500자
10. ━━━━━━━━━━━━━━━━━━━━━
11. [스터디카페 홍보 섹션] — 작업 메모리/인지 부하 → 커피랑도서관 자연 연결
    세스코 에어 + 정서적 평온, 불릿 리스트, 800자
12. ━━━━━━━━━━━━━━━━━━━━━
13. [마무리 제언] — 명언형 인용 + 결론 + 감사 인사 + 좋아요/댓글 독려, 500자
14. [해시태그] — 주제 관련 15개 + 스터디카페 홍보 12개 = 27개+

[카테고리별 작성 방향]
- 자기계발: 개인 성장 + AI 시대 역량
- 도서리뷰: IT 관련 도서 + 일반 베스트셀러 리뷰
- 성장과성공: 목표 달성 전략 + 복리 법칙
- 홈페이지와App: 웹/앱 기획 트렌드
- 최신IT트렌드: AI/클라우드/보안 최신 동향
- IT정보와분석: 산업 리포트/통계 분석
- 개발기획과컨설팅: PM/기획 실무 + 컨설팅 전략

[스터디카페 홍보 키워드]
- 커피랑도서관 분당서현점
- 세스코 에어 살균 시스템
- 작업 메모리 최적화 환경
- 인지 부하 해소 공간
- 분당 서현역 24시 운영

반드시 순수 텍스트로 출력하라. HTML 태그 없이.
각 섹션은 [섹션명] 형태로 구분하라.
`.trim();

/**
 * 일반 포스팅 생성
 * @param {string} category     — 오늘 카테고리
 * @param {object} researchData — 리처 수집 결과
 * @returns {{ content, charCount, model, title }}
 */
async function writeGeneralPost(category, researchData) {
  const weather = researchData.weather || {};
  const itNews  = researchData.it_news || [];

  const userPrompt = `
다음 일반 포스팅을 작성하라:

[카테고리] ${category}
[발행일] ${new Date().toLocaleDateString('ko-KR')}
[오늘 날씨] ${weather.description || '맑음'}${weather.temperature != null ? `, ${weather.temperature}°C` : ''}

[최신 IT 뉴스 (서론에 활용 — 상위 3개 선택)]
${itNews.slice(0, 5).map(n => `- ${n.title} (인기도: ${n.score})`).join('\n') || '- 최신 IT 트렌드를 자체 지식으로 언급하라'}

${researchData.book_info ? `[도서 정보]\n${JSON.stringify(researchData.book_info)}` : ''}

카테고리 "${category}"에 맞는 주제를 자율 선정하여 작성하라.
반드시 7,000자 이상 작성하라. 목표 9,000자.
글 첫 번째 줄에 제목을 [${category}] 형식으로 시작하라.
  `.trim();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY 환경변수 없음');

  const openai   = new OpenAI({ apiKey });
  const response = await openai.chat.completions.create({
    model:      'gpt-4o',
    messages:   [
      { role: 'system', content: GEMS_SYSTEM_PROMPT },
      { role: 'user',   content: userPrompt },
    ],
    max_tokens:  8000,
    temperature: 0.8,
  });

  const content   = response.choices[0]?.message?.content || '';
  // 제목: 첫 줄에서 추출
  const firstLine = content.split('\n').find(l => l.trim().length > 0) || '';
  const title     = firstLine.slice(0, 80).trim();

  return {
    content,
    charCount: content.length,
    model:     response.model || 'gpt-4o',
    title,
  };
}

module.exports = { writeGeneralPost, GEMS_SYSTEM_PROMPT };
