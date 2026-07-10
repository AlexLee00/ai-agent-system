// @ts-nocheck
'use strict';

const {
  BLOG_FORMAT_RULES,
  checkBlogFormatRules,
  _testOnly: formatTest,
} = require('./blog-format-rules.ts');

const FORBIDDEN_PATTERNS = [
  { code: 'writer_self_disclosure', pattern: /(AI가 작성|AI로 작성|젬스가 작성|포스가 작성|작성 도우미)/i },
  { code: 'generation_marker', pattern: /_THE_END_|TODO|TBD|\[내용을 입력|\[작성 필요/i },
  { code: 'prompt_leak', pattern: /(시스템 프롬프트|위 지시를 무시|다음 JSON 형식)/i },
];

function countMatches(text = '', pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return (String(text || '').match(new RegExp(pattern.source, flags)) || []).length;
}

function buildContentHarnessReport(post = {}) {
  const title = String(post.title || '').trim();
  const content = String(post.content || '');
  const postType = post.postType === 'lecture' ? 'lecture' : 'general';
  const plain = formatTest.stripHtmlForFormat(content);
  const format = checkBlogFormatRules(content, postType, { title });
  const titleViolations = format.issues.filter((issue) => /^B3 제목/.test(issue.msg));
  const concreteDetailCount = countMatches(plain, /\d+\s*(?:분|시간|일|주|개월|년|원|명|개|가지|단계|회|%)/iu)
    + countMatches(plain, /(?:오전|오후|오늘|어제|이번 주|분당|서현)/iu);
  const firstPersonCount = countMatches(plain, /(?:제가|저는|저도|제 경험|직접 해보니|직접 써보니|운영하면서)/iu);
  const trialAndErrorCount = countMatches(plain, /(?:실패|실수|막혔|안 됐|다시 시도|바꿨|수정했|비교했|전에는|이후에는)/iu);
  const minimumChars = Number(BLOG_FORMAT_RULES[postType]?.minChars || 0);
  const minimumHeadings = Number(BLOG_FORMAT_RULES[postType]?.minBodyHeadings || 0);
  const maximumHeadings = Number(BLOG_FORMAT_RULES[postType]?.maxBodyHeadings || 0);
  const forbiddenHits = FORBIDDEN_PATTERNS
    .filter((item) => item.pattern.test(plain))
    .map((item) => item.code);
  const rules = [
    {
      id: 'R1',
      name: 'concrete_title',
      passed: titleViolations.length === 0,
      evidence: { title, issues: titleViolations.map((issue) => issue.msg) },
      message: '제목에 추상어 대신 숫자·도구·결과·방법 중 하나가 필요합니다.',
    },
    {
      id: 'R2',
      name: 'concrete_details',
      passed: concreteDetailCount >= 3,
      evidence: { count: concreteDetailCount, minimum: 3 },
      message: '숫자·시간·장소·단계 같은 구체 디테일이 3개 이상 필요합니다.',
    },
    {
      id: 'R3',
      name: 'first_person_experience',
      passed: firstPersonCount >= 1,
      evidence: { count: firstPersonCount, minimum: 1 },
      message: '1인칭 실제 경험 신호가 1개 이상 필요합니다.',
    },
    {
      id: 'R4',
      name: 'trial_and_error',
      passed: trialAndErrorCount >= 1,
      evidence: { count: trialAndErrorCount, minimum: 1 },
      message: '실패·실수·비교·수정 같은 시행착오 신호가 1개 이상 필요합니다.',
    },
    {
      id: 'R5',
      name: 'structure_and_length',
      passed: content.length >= minimumChars
        && format.introLineCount >= Number(BLOG_FORMAT_RULES[postType]?.introLines || 0)
        && format.bodyHeadingCount >= minimumHeadings
        && (!maximumHeadings || format.bodyHeadingCount <= maximumHeadings)
        && format.longParagraphCount === 0,
      evidence: {
        char_count: content.length,
        minimum_chars: minimumChars,
        intro_lines: format.introLineCount,
        minimum_intro_lines: Number(BLOG_FORMAT_RULES[postType]?.introLines || 0),
        body_headings: format.bodyHeadingCount,
        minimum_body_headings: minimumHeadings,
        maximum_body_headings: maximumHeadings || null,
        long_paragraphs: format.longParagraphCount,
      },
      message: '최소 길이·도입 3줄·본문 소제목 구조를 충족해야 합니다.',
    },
    {
      id: 'R6',
      name: 'forbidden_artifacts',
      passed: forbiddenHits.length === 0,
      evidence: { hits: forbiddenHits },
      message: '작성자 자기노출·생성 마커·프롬프트 흔적을 제거해야 합니다.',
    },
  ];
  const violations = rules
    .filter((rule) => !rule.passed)
    .map((rule) => ({ rule: rule.id, code: rule.name, message: rule.message }));

  return {
    version: 'r1-r6-v1',
    mode: 'report',
    requested_mode: String(process.env.BLOG_CONTENT_HARNESS_MODE || 'report'),
    blocking_enabled: false,
    would_block: violations.length > 0,
    score: Math.round((rules.filter((rule) => rule.passed).length / rules.length) * 100),
    violations,
    rules: rules.map(({ message, ...rule }) => rule),
  };
}

module.exports = {
  buildContentHarnessReport,
};
