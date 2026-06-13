#!/usr/bin/env tsx

const assert = require('assert/strict');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const {
  BLOG_FORMAT_RULES,
  checkBlogFormatRules,
  _testOnly,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/blog-format-rules.ts'));
const {
  checkQualityEnhanced,
  MIN_CHARS,
  GOAL_CHARS,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/quality-checker.ts'));
const { getBlogGenerationRuntimeConfig } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/runtime-config.ts'));
const { calculateSectionChars } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/section-ratio.ts'));

function sentence(text) {
  return `${text} 오늘 바로 확인할 수 있게 짧게 정리했습니다.`;
}

function bodyLines(prefix, count = 11) {
  return Array.from({ length: count }, (_, index) =>
    sentence(`${prefix} ${index + 1}번 기준은 실제 실행 전에 문제와 결과를 한 줄로 쓰는 것입니다.`)
  ).join('\n');
}

function hashtags() {
  return [
    '#AI', '#AI에이전트', '#업무자동화', '#ClaudeCode', '#Codex', '#ChatGPT',
    '#회의록자동화', '#생산성', '#체크리스트', '#실전가이드', '#분당서현',
    '#커피랑도서관', '#스터디카페', '#집중공간', '#업무루틴', '#블로그운영',
  ].join(' ');
}

function buildGeneralFixture({ title = '[IT정보와분석] Claude Code로 회의록 요약 자동화 — 일주일 써본 결과', includeExperience = true, longParagraph = false } = {}) {
  const experience = includeExperience
    ? '제가 실제로 운영하는 ai-agent-system에서 회의록 요약을 일주일 써보니, 가장 큰 차이는 회의 직후 바로 실행 항목이 남는다는 점이었습니다.'
    : '회의록 요약 자동화는 반복 작업을 줄이고 팀의 정리 속도를 높이는 데 도움이 됩니다.';
  const longText = '이 단락은 일부러 길게 작성했습니다. 첫 번째 문장입니다. 두 번째 문장입니다. 세 번째 문장입니다. 네 번째 문장입니다. 다섯 번째 문장입니다.';
  return [
    title,
    '회의가 끝나고 나면 정작 무엇을 해야 할지 흐려지는 분들이 많습니다.',
    '이 글은 Claude Code로 회의록 요약을 자동화해 실행 항목을 남기는 과정을 보여드립니다.',
    '회의가 잦은 1인 사업자와 작은 팀 운영자를 위한 글입니다.',
    '',
    '[AI 스니펫 요약]',
    '회의록 자동화는 회의 내용을 줄이는 작업이 아니라 다음 행동을 남기는 작업입니다.',
    '',
    '[이 글에서 배울 수 있는 것]',
    '- 회의록 자동화가 필요한 순간',
    '- Claude Code에 맡길 수 있는 정리 범위',
    '- 결과를 확인하는 체크리스트',
    '',
    '[승호아빠 인사말]',
    '오늘 아침 분당 서현에서 작업을 시작하며 전날 회의 메모를 다시 봤습니다.',
    '커피랑도서관 분당서현점처럼 조용한 공간에서는 회의 후 정리 루틴이 훨씬 잘 보입니다.',
    experience,
    '',
    '[본론 섹션 1]',
    longParagraph ? longText : bodyLines('첫 번째 섹션', 10),
    '',
    '[본론 섹션 2]',
    bodyLines('두 번째 섹션', 10),
    '',
    '[본론 섹션 3]',
    bodyLines('세 번째 섹션', 10),
    '',
    '[스터디카페 홍보 섹션]',
    '집중이 필요한 자동화 점검은 주변 소음이 적고 자리 이동이 적은 환경에서 더 잘 됩니다.',
    '커피랑도서관 분당서현점은 업무 메모를 펼쳐두고 차분히 정리하기 좋은 공간입니다.',
    '세스코 에어는 공기질 관리 기능으로만 이해하면 되고, 과장된 효능으로 설명하지 않습니다.',
    '',
    '[질문형 Q&A]',
    'Q. 회의록 자동화를 처음 시작하면 무엇부터 하나요?',
    'A. 먼저 회의 녹취나 메모를 한 파일에 모으고, 결정 사항과 담당자만 뽑아달라고 요청하면 됩니다.',
    'Q. 결과가 틀리면 어떻게 하나요?',
    'A. 누락된 항목을 표시하고 다시 검증해달라고 요청합니다.',
    'Q. 매일 써도 괜찮나요?',
    'A. 민감한 정보는 제외하고 반복되는 형식만 자동화하는 것이 안전합니다.',
    '',
    '[마무리 제언]',
    '3줄 요약: 회의록 자동화의 핵심은 기록보다 실행 항목입니다.',
    '핵심은 도구를 많이 쓰는 것이 아니라 확인할 결과를 먼저 정하는 것입니다.',
    '오늘 바로 할 일은 지난 회의 메모 하나를 골라 결정 사항 세 줄로 바꿔보는 것입니다.',
    '',
    '[함께 읽으면 좋은 글]',
    '→ [에이전트 입문 5강] ← 여기에 링크 삽입',
    '→ [AI 에이전트 체크리스트] ← 여기에 링크 삽입',
    '→ [업무 자동화 시작법] ← 여기에 링크 삽입',
    '',
    '[해시태그]',
    hashtags(),
  ].join('\n');
}

async function run() {
  const tests = [];

  assert.equal(BLOG_FORMAT_RULES.general.minChars, 3000);
  assert.equal(BLOG_FORMAT_RULES.general.goalChars, 3600);
  assert.equal(BLOG_FORMAT_RULES.lecture.minChars, 8000);
  assert.equal(MIN_CHARS.general, 3000);
  assert.equal(GOAL_CHARS.general, 3600);
  assert.equal(MIN_CHARS.lecture, 8000);
  const runtime = getBlogGenerationRuntimeConfig();
  assert.equal(Number(runtime.gemsMinChars), 3000);
  const gemsChars = calculateSectionChars('gems', []);
  assert.ok(gemsChars.totalChars >= 2800 && gemsChars.totalChars <= 4300);
  tests.push({ id: 'TS-B3-1', ok: true, name: 'general length contract changed to 3000/3600 and lecture remains 8000+' });

  const goodContent = buildGeneralFixture();
  const goodFormat = checkBlogFormatRules(goodContent, 'general');
  assert.equal(goodFormat.ok, true, JSON.stringify(goodFormat.issues));
  assert.equal(_testOnly.getIntroLines(goodContent).length, 3);
  tests.push({ id: 'TS-B3-2', ok: true, name: 'concrete title and 3-line intro pass B3 format rules' });

  const abstractTitle = buildGeneralFixture({ title: '[IT정보와분석] 성공적인 업무 자동화 전략' });
  const abstractFormat = checkBlogFormatRules(abstractTitle, 'general');
  assert.ok(abstractFormat.issues.some((issue) => issue.msg.includes('제목 추상어')));
  tests.push({ id: 'TS-B3-3', ok: true, name: 'abstract title terms are warned' });

  const noExperience = buildGeneralFixture({
    title: '[IT정보와분석] Claude Code 회의록 요약 자동화 체크리스트',
    includeExperience: false,
  });
  const noExperienceFormat = checkBlogFormatRules(noExperience, 'general');
  assert.ok(noExperienceFormat.issues.some((issue) => issue.msg.includes('실경험')));
  tests.push({ id: 'TS-B3-4', ok: true, name: 'missing experience is warned' });

  const longParagraph = buildGeneralFixture({ longParagraph: true });
  const longParagraphFormat = checkBlogFormatRules(longParagraph, 'general');
  assert.ok(longParagraphFormat.issues.some((issue) => issue.msg.includes('단락 길이')));
  tests.push({ id: 'TS-B3-5', ok: true, name: 'paragraphs over 3 sentences are warned' });

  assert.ok(goodContent.length >= 3000 && goodContent.length < 6000, `goodContent length=${goodContent.length}`);
  const quality = await checkQualityEnhanced(goodContent, 'general', {
    title: '[IT정보와분석] Claude Code로 회의록 요약 자동화 — 일주일 써본 결과',
    category: 'IT정보와분석',
    skipPackageChecks: true,
  });
  assert.equal(quality.passed, true, JSON.stringify(quality.issues));
  assert.equal(quality.formatRules.ok, true);
  tests.push({ id: 'TS-B3-6', ok: true, name: '3000-character general fixture passes existing quality gates' });

  const warningQuality = await checkQualityEnhanced(abstractTitle, 'general', {
    title: '[IT정보와분석] 성공적인 업무 자동화 전략',
    category: 'IT정보와분석',
    skipPackageChecks: true,
  });
  assert.equal(warningQuality.passed, true);
  assert.equal(warningQuality.autoRewriteRecommended, true);
  assert.ok(warningQuality.issues.some((issue) => issue.msg.includes('B3 제목 추상어')));
  tests.push({ id: 'TS-B3-7', ok: true, name: 'B3 warnings set autoRewriteRecommended without blocking publish' });

  const report = {
    ok: tests.every((test) => test.ok),
    suite: 'blo-b3-format-rules',
    tests,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    suite: 'blo-b3-format-rules',
    error: error && error.stack ? error.stack : String(error),
  }, null, 2));
  process.exit(1);
});
