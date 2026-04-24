'use strict';

/**
 * Phase A: reviewer.ts 단위 테스트
 *
 * 실행: node bots/claude/__tests__/reviewer.test.ts
 */

const assert = require('assert');
const Module = require('module');
const path   = require('path');

const REVIEWER_PATH = path.resolve(__dirname, '../src/reviewer.ts');

function makeReviewerMocks(overrides = {}) {
  return {
    '../../../packages/core/lib/skills': {
      codeReview: {
        runChecklist: () => ({
          summary: { totalFiles: 2, syntaxFails: 0, critical: 0, high: 0, medium: 0, pass: true },
          findings: [],
        }),
      },
      callLLM: async () => ({ text: '코드 품질 양호.' }),
    },
    '../../../packages/core/lib/openclaw-client': {
      postAlarm: async () => ({ ok: true }),
    },
    '../../../packages/core/lib/env': {
      PROJECT_ROOT: '/tmp/test-project',
    },
    child_process: {
      execSync: (cmd) => {
        if (cmd.includes('git diff'))   return 'bots/claude/src/reviewer.ts';
        if (cmd.includes('git log'))    return 'abc1234 feat(claude): 테스트';
        if (cmd.includes('npm test'))   return '5 passing\n0 failing';
        if (cmd.includes('npx tsc'))    return '';
        return '';
      },
    },
    ...overrides,
  };
}

async function withMocks(mocks, fn) {
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[REVIEWER_PATH];
    return await fn(require(REVIEWER_PATH));
  } finally {
    Module._load = original;
    delete require.cache[REVIEWER_PATH];
  }
}

// ─── Test 1: analyzeChanges — 변경 파일 반환 ─────────────────────────

async function test_analyzeChanges_returns_files() {
  await withMocks(makeReviewerMocks(), async (reviewer) => {
    const result = await reviewer.analyzeChanges('HEAD~1');
    assert.ok(Array.isArray(result.files), 'files는 배열이어야 함');
    assert.ok(typeof result.added_lines === 'number', 'added_lines는 숫자여야 함');
    assert.ok(typeof result.removed_lines === 'number', 'removed_lines는 숫자여야 함');
  });
  console.log('✅ reviewer: analyzeChanges returns valid structure');
}

// ─── Test 2: testCoverageDelta — before/after 비교 ───────────────────

async function test_testCoverageDelta_structure() {
  await withMocks(makeReviewerMocks(), async (reviewer) => {
    const before = { tests: 10, failures: 0 };
    const after  = { tests: 12, failures: 0 };
    const result = await reviewer.testCoverageDelta(before, after);
    assert.strictEqual(result.before_tests, 10, 'before_tests = 10');
    assert.strictEqual(result.after_tests, 12, 'after_tests = 12');
    assert.strictEqual(result.regression, false, '증가이므로 regression=false');
    assert.ok(typeof result.before_failures === 'number', 'before_failures는 숫자');
  });
  console.log('✅ reviewer: testCoverageDelta structure valid');
}

// ─── Test 3: testCoverageDelta — 리그레션 감지 ────────────────────────

async function test_testCoverageDelta_detects_regression() {
  await withMocks(makeReviewerMocks(), async (reviewer) => {
    const before = { tests: 10, failures: 0 };
    const after  = { tests: 10, failures: 2 }; // 실패 증가
    const result = await reviewer.testCoverageDelta(before, after);
    assert.strictEqual(result.regression, true, '실패 증가 시 regression=true');
  });
  console.log('✅ reviewer: testCoverageDelta detects regression');
}

// ─── Test 4: runReview — Kill Switch OFF 시 skipped=true ─────────────

async function test_runReview_kill_switch_off_skips() {
  const origEnv = process.env.CLAUDE_REVIEWER_ENABLED;
  process.env.CLAUDE_REVIEWER_ENABLED = 'false';

  try {
    await withMocks(makeReviewerMocks(), async (reviewer) => {
      const result = await reviewer.runReview({});
      assert.strictEqual(result.skipped, true, 'Kill Switch OFF 시 skipped=true');
    });
  } finally {
    process.env.CLAUDE_REVIEWER_ENABLED = origEnv;
  }
  console.log('✅ reviewer: runReview skips when Kill Switch is OFF');
}

// ─── Test 5: runReview — force=true 시 실행 ──────────────────────────

async function test_runReview_force_executes() {
  await withMocks(makeReviewerMocks(), async (reviewer) => {
    const result = await reviewer.runReview({ force: true, test: true });
    assert.ok(typeof result === 'object', '결과 객체 반환');
    assert.ok(typeof result.summary === 'object', 'summary 포함');
    assert.ok(Array.isArray(result.files), 'files 배열 포함');
  });
  console.log('✅ reviewer: runReview executes with force=true');
}

// ─── Test 6: runReview — docs-only 변경은 TS 체크 생략 ───────────────

async function test_runReview_docs_only_skips_typescript_check() {
  const executed = [];
  const mocks = makeReviewerMocks({
    child_process: {
      execSync: (cmd) => {
        executed.push(cmd);
        if (cmd.includes('git diff')) return 'docs/auto_dev/CODEX_DOC_ONLY.md';
        if (cmd.includes('git log')) return 'abc1234 feat(claude): docs only';
        if (cmd.includes('npm test')) return '5 passing\n0 failing';
        if (cmd.includes('npx tsc')) throw new Error('tsc should be skipped for docs-only changes');
        return '';
      },
    },
  });

  await withMocks(mocks, async (reviewer) => {
    const result = await reviewer.runReview({ force: true, test: true });
    assert.strictEqual(result.skipped, true, 'docs-only 변경은 리뷰 스킵');
    assert.strictEqual(result.files.length, 0, 'docs-only 변경은 JS/TS 파일 없음');
  });

  assert.ok(!executed.some((cmd) => cmd.includes('npx tsc')), 'docs-only 변경 시 npx tsc 미실행');
  console.log('✅ reviewer: docs-only change skips TypeScript check');
}

// ─── Test 7: analyzeChanges — 빈 diff ────────────────────────────────

async function test_analyzeChanges_empty_diff() {
  const mocks = makeReviewerMocks({
    child_process: {
      execSync: () => '',
    },
  });
  await withMocks(mocks, async (reviewer) => {
    const result = await reviewer.analyzeChanges('HEAD~1');
    assert.ok(Array.isArray(result.files), '빈 diff도 files 배열 반환');
    assert.strictEqual(result.files.length, 0, '빈 diff 시 파일 없음');
  });
  console.log('✅ reviewer: analyzeChanges handles empty diff');
}

// ─── Test 8: reportToTelegram — postAlarm 호출 ───────────────────────

async function test_reportToTelegram_calls_postAlarm() {
  const postAlarmCalls = [];
  const mocks = makeReviewerMocks({
    '../../../packages/core/lib/openclaw-client': {
      postAlarm: async (p) => { postAlarmCalls.push(p); return { ok: true }; },
    },
  });

  await withMocks(mocks, async (reviewer) => {
    const review = {
      message: '테스트 리뷰 결과',
      summary: { pass: true },
    };
    await reviewer.reportToTelegram(review);
    assert.ok(postAlarmCalls.length > 0, 'postAlarm 호출됨');
    assert.ok(postAlarmCalls[0].message.includes('테스트'), '메시지 전달됨');
  });
  console.log('✅ reviewer: reportToTelegram calls postAlarm');
}

// ─── 실행 ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Reviewer 테스트 시작 ===\n');
  const tests = [
    test_analyzeChanges_returns_files,
    test_testCoverageDelta_structure,
    test_testCoverageDelta_detects_regression,
    test_runReview_kill_switch_off_skips,
    test_runReview_force_executes,
    test_runReview_docs_only_skips_typescript_check,
    test_analyzeChanges_empty_diff,
    test_reportToTelegram_calls_postAlarm,
  ];

  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t();
      passed++;
    } catch (e) {
      console.error(`❌ ${t.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n결과: ${passed}/${tests.length} 통과`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
