'use strict';

function buildAIBriefingSectionOrder(type = 'general') {
  if (type === 'lecture') {
    return [
      '[AI Briefing 권장 섹션 순서]',
      '1. [핵심 요약 3줄]',
      '2. [이 글에서 배울 수 있는 것]',
      '3. [승호아빠 인사말]',
      '4. [최신 기술 브리핑]',
      '5. [강의 - 이론]',
      '6. [실무 - 코드 및 아키텍처]',
      '7. [전문가의 실무 인사이트 ①②③④]',
      '8. [에러 탐지 신경망과 환경의 역학]',
      '9. [AEO FAQ]',
      '10. [마무리 인사]',
      '11. [함께 읽으면 좋은 글]',
      '12. [해시태그]',
    ].join('\n');
  }

  return [
    '[AI Briefing 권장 섹션 순서]',
    '1. [AI 스니펫 요약]',
    '2. [이 글에서 배울 수 있는 것]',
    '3. [승호아빠 인사말]',
    '4. [본론 섹션 1]',
    '5. [본론 섹션 2]',
    '6. [본론 섹션 3]',
    '7. [질문형 Q&A]',
    '8. [스터디카페 홍보 섹션]',
    '9. [마무리 제언]',
    '10. [함께 읽으면 좋은 글]',
    '11. [해시태그]',
  ].join('\n');
}

function buildAIBriefingChecklist(type = 'general') {
  const common = [
    '[AI Briefing 체크리스트]',
    '- 요약 섹션은 본문보다 먼저 나온다.',
    '- 학습 포인트 섹션은 불릿 3개 이상이다.',
    '- 질문형 Q&A는 실제 검색형 문장으로 3개 이상이다.',
    '- 결론에는 핵심 메시지 한 줄이 드러난다.',
  ];

  if (type === 'lecture') {
    common.push('- 기술 개념, 코드, 운영 포인트가 분리되어 보인다.');
  } else {
    common.push('- 문제 정의 → 판단 기준 → 실전 사례 흐름이 분명하다.');
  }

  return common.join('\n');
}

module.exports = {
  buildAIBriefingSectionOrder,
  buildAIBriefingChecklist,
};
