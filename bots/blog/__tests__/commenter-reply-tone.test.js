const { sanitizeGeneratedReplyForComment } = require('../lib/commenter.ts');

describe('commenter reply tone sanitizer', () => {
  test('removes third-person evaluator phrasing and keeps operator tone', () => {
    const reply = [
      '90강 성능 최적화 이야기가 실제로 효과를 보신 분들께서는 뿌듯하실 것 같아요.',
      '저도 이번 주에 Node.js 성능 최적화에 대한 팁을 하나 더 찾았는데요, 자바스크립트 코드를 최적화하는 방법에 대해 자세히 공부해야겠습니다.',
      '일단 새로운 주를 시작하겠습니다!',
    ].join(' ');

    const sanitized = sanitizeGeneratedReplyForComment(
      reply,
      '이번 포스팅 잘 봤어요. TypeScript 도입 과정에서 의견 조율은 어떻게 하셨나요?',
    );

    expect(sanitized).not.toMatch(/효과를 보신 분들께서는|뿌듯하실 것 같아요|일단 새로운 주를 시작하겠습니다/);
    expect(sanitized).toMatch(/저도|이번 글도 적용 과정 중심으로 더 이어보겠습니다/);
  });

  test('removes visitor-side mirroring phrases from owner replies', () => {
    const sanitized = sanitizeGeneratedReplyForComment(
      '유익한 정보를 잘 보고 갑니다. 특히 선택 습관 이야기가 흥미로웠어요.',
      '안녕하세요 이웃님! 유익한 정보 잘 보고 갑니다 ~ 즐거운 하루 보내세요!!',
    );

    expect(sanitized).not.toMatch(/유익한 정보(?:를)? 잘 보고 갑니다|좋은 정보(?:를)? 잘 보고 갑니다|잘 보고 갑니다/);
    expect(sanitized).toMatch(/흥미로웠어요/);
  });
});
