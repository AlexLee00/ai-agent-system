// @ts-nocheck
'use strict';

const ABSTRACT_TITLE_TERMS = [
  '성공적인',
  '효과적인',
  '혁신적인',
  '완벽한',
  '최고의',
  '필수적인',
  '최적의',
  '궁극의',
];

const CONCRETE_TITLE_RE = /(?:\d|법|방법|기준|체크리스트|실제|결과|과정|가이드|실습|자동화|Claude|Codex|ChatGPT|AI|에이전트|터미널|엑셀|회의록|분당|서현|도구|명령어|프로젝트|사례)/i;
const EXPERIENCE_RE = /(?:제가|저는|직접|실제로|해보니|써보니|운영하는|운영 중인|겪은|실수|수치|일주일|ai-agent-system)/i;
const ACTION_RE = /(?:지금|오늘|먼저|바로|해보세요|적어보세요|확인해보세요|시작해보세요|실행|체크|정리해보면|다음 행동|할 일)/i;
const SUMMARY_RE = /(?:3줄 요약|세 줄 요약|요약|정리하면|핵심은|마지막으로|결론은)/i;
const KNOWN_SECTION_TITLES = [
  'AI 스니펫 요약',
  '핵심 요약',
  '핵심 요약 3줄',
  '이 글에서 배울 수 있는 것',
  '승호아빠 인사말',
  '최신 기술 브리핑',
  '강의 - 이론',
  '실무 - 코드',
  '실무 - 코드 및 아키텍처',
  '전문가의 실무 인사이트 ①',
  '전문가의 실무 인사이트 ②',
  '전문가의 실무 인사이트 ③',
  '전문가의 실무 인사이트 ④',
  '에러 탐지 신경망과 환경의 역학',
  'AEO FAQ',
  '본론 섹션 1',
  '본론 섹션 2',
  '본론 섹션 3',
  '이번 주 IT 뉴스 분석',
  '스터디카페 홍보 섹션',
  '질문형 Q&A',
  '마무리 제언',
  '마무리 인사',
  '함께 읽으면 좋은 글',
  '해시태그',
];

const BLOG_FORMAT_RULES = {
  abstractTitleTerms: ABSTRACT_TITLE_TERMS,
  lecture: {
    minChars: 8000,
    goalChars: 9000,
    introLines: 3,
    minBodyHeadings: 3,
    maxParagraphSentences: 3,
    requireExperience: true,
    requireNextLecturePreview: true,
  },
  general: {
    minChars: 3000,
    goalChars: 3600,
    introLines: 3,
    minBodyHeadings: 3,
    maxBodyHeadings: 5,
    maxParagraphSentences: 3,
    requireExperience: true,
    requireNextLecturePreview: false,
  },
};

function buildBlogFormatInstruction(type = 'general') {
  const rules = BLOG_FORMAT_RULES[type] || BLOG_FORMAT_RULES.general;
  const lengthLine = type === 'lecture'
    ? `- 길이: 기존 강의 계약을 유지한다. 최소 ${rules.minChars.toLocaleString('ko-KR')}자, 목표 ${rules.goalChars.toLocaleString('ko-KR')}자 이상.`
    : `- 길이: 일반 포스트는 최소 ${rules.minChars.toLocaleString('ko-KR')}자, 목표 ${rules.goalChars.toLocaleString('ko-KR')}자대. 불필요한 장문 반복보다 밀도와 사례를 우선한다.`;
  const nextLectureLine = type === 'lecture'
    ? '- 마무리에는 3줄 요약, 독자가 지금 할 행동 1개, 다음 강 예고를 반드시 넣는다.'
    : '- 마무리에는 3줄 요약과 독자가 지금 할 행동 1개를 반드시 넣는다.';

  return `
[B3 포스팅 형식 규칙 — 반드시 준수]
- 제목: [태그] + 구체 결과/대상/도구명/숫자/"~하는 법" 중 하나를 포함한다.
- 제목 금지 추상어: ${ABSTRACT_TITLE_TERMS.join(', ')}.
- 도입 3줄: 1) 독자 문제 공감 2) 이 글이 주는 결과 3) 누구를 위한 글인지.
- 본문: 소제목 ${rules.minBodyHeadings}${rules.maxBodyHeadings ? `~${rules.maxBodyHeadings}` : '개 이상'}개, 한 단락은 3문장 이내, 따라하기/예시/체크리스트를 우선한다.
- 실경험: 직접 해본 결과, 실수, 수치, 운영 사례 중 1개 이상을 반드시 넣는다.
${nextLectureLine}
${lengthLine}
`.trim();
}

function stripHtmlForFormat(content) {
  return String(content || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeLine(line) {
  return String(line || '')
    .replace(/_THE_END_/g, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*\*|\*\*$/g, '')
    .trim();
}

function getMeaningfulLines(content) {
  return stripHtmlForFormat(content)
    .split('\n')
    .map(normalizeLine)
    .filter(Boolean)
    .filter((line) => !/^━{3,}$/.test(line));
}

function isSectionLine(line) {
  const text = String(line || '').trim();
  const bracketTitle = text.match(/^\[\s*([^\]\n]{2,60})\s*\]/)?.[1]?.trim();
  return (bracketTitle && KNOWN_SECTION_TITLES.includes(bracketTitle))
    || /^(AI 스니펫 요약|핵심 요약|이 글에서 배울 수 있는 것|승호아빠 인사말|본론 섹션|마무리|해시태그|질문형 Q&A|AEO FAQ)/.test(text);
}

function extractTitleLine(content) {
  return getMeaningfulLines(content).find((line) => !isSectionLine(line)) || '';
}

function stripTitlePrefix(title) {
  return String(title || '').replace(/^\[[^\]]+\]\s*/, '').trim();
}

function getIntroLines(content) {
  const lines = getMeaningfulLines(content);
  const titleIndex = lines.findIndex((line) => line === extractTitleLine(content));
  const start = titleIndex >= 0 ? titleIndex + 1 : 0;
  const intro = [];
  for (const line of lines.slice(start)) {
    if (isSectionLine(line) || /^#/.test(line)) {
      if (intro.length > 0) break;
      continue;
    }
    if (line.length < 8) continue;
    intro.push(line);
    if (intro.length >= 3) break;
  }
  return intro;
}

function extractHeadings(content) {
  const raw = String(content || '');
  const htmlHeadings = Array.from(raw.matchAll(/<h[1-3][^>]*>\s*([\s\S]*?)\s*<\/h[1-3]>/gi))
    .map((match) => stripHtmlForFormat(match[1]));
  const bracketHeadings = getMeaningfulLines(raw)
    .map((line) => line.match(/^\[\s*([^\]\n]{2,60})\s*\]/)?.[1]?.trim())
    .filter((title) => title && KNOWN_SECTION_TITLES.includes(title));
  return [...htmlHeadings, ...bracketHeadings].filter(Boolean);
}

function countBodyHeadings(content, type) {
  const headings = extractHeadings(content);
  if (type === 'general') {
    return headings.filter((heading) => /^(본론 섹션|이번 주 IT 뉴스 분석|질문형 Q&A|마무리 제언)/.test(heading)).length;
  }
  return headings.filter((heading) => !/^(핵심 요약|이 글에서 배울 수 있는 것|해시태그|함께 읽으면 좋은 글)/.test(heading)).length;
}

function splitParagraphs(content) {
  return stripHtmlForFormat(content)
    .split('\n')
    .map((paragraph) => normalizeLine(paragraph).replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length >= 80)
    .filter((paragraph) => !isSectionLine(paragraph));
}

function sentenceCount(paragraph) {
  const matches = String(paragraph || '').match(/[^.!?。！？\n]+[.!?。！？]|[^.!?。！？\n]+(?:다|요|죠|까|니다|습니다)(?:\s|$)/g);
  return matches ? matches.length : Math.max(1, Math.ceil(String(paragraph || '').length / 90));
}

function findLongParagraphs(content, maxSentences) {
  return splitParagraphs(content)
    .map((paragraph) => ({ paragraph, sentences: sentenceCount(paragraph) }))
    .filter((item) => item.sentences > maxSentences)
    .slice(0, 3);
}

function countLongParagraphs(content, maxSentences) {
  return splitParagraphs(content)
    .filter((paragraph) => sentenceCount(paragraph) > maxSentences)
    .length;
}

function checkBlogFormatRules(content, type = 'general', options = {}) {
  const rules = BLOG_FORMAT_RULES[type] || BLOG_FORMAT_RULES.general;
  const title = String(options.title || extractTitleLine(content) || '').trim();
  const titleBody = stripTitlePrefix(title);
  const plain = stripHtmlForFormat(content);
  const issues = [];

  const abstractTerms = ABSTRACT_TITLE_TERMS.filter((term) => titleBody.includes(term));
  if (abstractTerms.length > 0) {
    issues.push({ severity: 'warn', msg: `B3 제목 추상어 감지: ${abstractTerms.join(', ')}` });
  }
  if (titleBody && !CONCRETE_TITLE_RE.test(titleBody)) {
    issues.push({ severity: 'warn', msg: 'B3 제목 구체성 부족: 숫자/도구명/결과/방법/실제 사례 중 하나가 필요함' });
  }

  const introLines = getIntroLines(content);
  if (introLines.length < rules.introLines) {
    issues.push({ severity: 'warn', msg: `B3 도입 3줄 부족: ${introLines.length}/${rules.introLines}` });
  }

  const bodyHeadingCount = countBodyHeadings(content, type);
  if (bodyHeadingCount < rules.minBodyHeadings) {
    issues.push({ severity: 'warn', msg: `B3 본문 소제목 부족: ${bodyHeadingCount}/${rules.minBodyHeadings}` });
  }
  if (rules.maxBodyHeadings && bodyHeadingCount > rules.maxBodyHeadings) {
    issues.push({ severity: 'warn', msg: `B3 본문 소제목 과다: ${bodyHeadingCount}/${rules.maxBodyHeadings}` });
  }

  const longParagraphs = findLongParagraphs(content, rules.maxParagraphSentences);
  if (longParagraphs.length > 0) {
    issues.push({ severity: 'warn', msg: `B3 단락 길이 과다: 3문장 초과 단락 ${longParagraphs.length}개` });
  }

  if (rules.requireExperience && !EXPERIENCE_RE.test(plain)) {
    issues.push({ severity: 'warn', msg: 'B3 실경험/실수/수치/운영 사례 1개 이상 필요' });
  }

  const tail = plain.slice(-1200);
  if (!SUMMARY_RE.test(tail)) {
    issues.push({ severity: 'warn', msg: 'B3 마무리 3줄 요약 또는 핵심 정리 부족' });
  }
  if (!ACTION_RE.test(tail)) {
    issues.push({ severity: 'warn', msg: 'B3 독자가 지금 할 행동 1개 부족' });
  }
  if (rules.requireNextLecturePreview && !/다음\s*강|다음\s*\d+\s*강|\d+\s*강.*예고/.test(tail)) {
    issues.push({ severity: 'warn', msg: 'B3 강의 다음 강 예고 부족' });
  }

  return {
    ok: issues.length === 0,
    autoRewriteRecommended: issues.length > 0,
    title,
    introLineCount: introLines.length,
    bodyHeadingCount,
    longParagraphCount: longParagraphs.length,
    issues,
  };
}

module.exports = {
  BLOG_FORMAT_RULES,
  buildBlogFormatInstruction,
  checkBlogFormatRules,
  _testOnly: {
    stripHtmlForFormat,
    extractTitleLine,
    getIntroLines,
    countBodyHeadings,
    countLongParagraphs,
    sentenceCount,
  },
};
