'use strict';

const EDITOR_PERSONAS = {
  hooker: {
    focus: '제목과 도입부의 클릭 유도력',
    instruction: '첫 문단에서 독자가 왜 이 글을 끝까지 읽어야 하는지 분명히 드러내라.',
  },
  styler: {
    focus: '문체 통일과 SEO 친화성',
    instruction: '문장 길이를 너무 들쭉날쭉하게 만들지 말고, 핵심 키워드를 자연스럽게 반복하라.',
  },
  polish: {
    focus: '최종 완성도와 흐름',
    instruction: '섹션 연결이 어색하지 않게 다듬고, 결론에서 핵심 메시지를 한 줄로 남겨라.',
  },
};

function pickEditorPersona(postType = 'general') {
  if (postType === 'lecture') {
    return { name: 'polish', ...EDITOR_PERSONAS.polish };
  }
  return { name: 'hooker', ...EDITOR_PERSONAS.hooker };
}

module.exports = {
  EDITOR_PERSONAS,
  pickEditorPersona,
};
