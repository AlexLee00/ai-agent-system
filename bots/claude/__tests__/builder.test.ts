'use strict';

/**
 * Phase A: builder.ts 단위 테스트
 *
 * 실행: node bots/claude/__tests__/builder.test.ts
 */

const assert = require('assert');
const Module = require('module');
const path   = require('path');
const os     = require('os');

const BUILDER_PATH = path.resolve(__dirname, '../src/builder.ts');

// ROOT를 절대경로로 설정하고 테스트 파일도 절대경로 사용
const TEST_ROOT = '/';

function makeBuilderMocks(overrides = {}) {
  return {
    '../../../packages/core/lib/hub-alarm-client': {
      postAlarm: async () => ({ ok: true }),
    },
    '../../../packages/core/lib/env': {
      PROJECT_ROOT: TEST_ROOT,
    },
    './reviewer': {
      analyzeChanges: async () => ({ files: [], added_lines: 0, removed_lines: 0, diff_summary: '' }),
      getChangedFiles: async () => [],
    },
    child_process: {
      execSync: (cmd) => {
        if (cmd.includes('npm run build')) return 'Build complete';
        if (cmd.includes('mix compile'))   return 'Compiled 5 files';
        if (cmd.includes('npx tsc'))       return '';
        if (cmd.includes('git diff'))      return '';
        return '';
      },
    },
    fs: require('fs'),
    path: require('path'),
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
    delete require.cache[BUILDER_PATH];
    return await fn(require(BUILDER_PATH));
  } finally {
    Module._load = original;
    delete require.cache[BUILDER_PATH];
  }
}

// ─── Test 1: needsBuild — 패턴 매칭 ──────────────────────────────────

async function test_needsBuild_matches_patterns() {
  await withMocks(makeBuilderMocks(), async (builder) => {
    const plans = builder.needsBuild([
      '/packages/core/lib/pg-pool.js',
    ]);
    assert.ok(Array.isArray(plans), 'needsBuild는 배열 반환');
    const ids = plans.map(p => p.id);
    assert.ok(ids.includes('packages-core'), 'packages-core 패턴 매칭');
  });
  console.log('✅ builder: needsBuild matches correct patterns');
}

// ─── Test 2: needsBuild — 매칭 없는 파일 ─────────────────────────────

async function test_needsBuild_no_match() {
  await withMocks(makeBuilderMocks(), async (builder) => {
    const plans = builder.needsBuild(['/docs/readme.md', '/bots/blog/src/nothing.ts']);
    assert.strictEqual(plans.length, 0, '매칭 없는 파일은 빈 배열');
  });
  console.log('✅ builder: needsBuild returns empty for non-build files');
}

// ─── Test 3: BUILD_PLANS — 기본 플랜 목록 ────────────────────────────

async function test_build_plans_defined() {
  await withMocks(makeBuilderMocks(), async (builder) => {
    assert.ok(Array.isArray(builder.BUILD_PLANS), 'BUILD_PLANS는 배열');
    assert.ok(builder.BUILD_PLANS.length > 0, '최소 1개 이상');
    const ids = builder.BUILD_PLANS.map(p => p.id);
    assert.ok(ids.includes('packages-core'), 'packages-core 플랜 존재');
    assert.ok(ids.includes('elixir-team-jay'), 'elixir-team-jay 플랜 존재');
  });
  console.log('✅ builder: BUILD_PLANS contains all expected plans');
}

// ─── Test 4: runTypescriptBuild — 디렉토리 없을 때 스킵 ──────────────

async function test_runTypescriptBuild_skips_missing_dir() {
  await withMocks(makeBuilderMocks(), async (builder) => {
    const plan = {
      id: 'test-plan',
      name: 'Test',
      cwd: '/nonexistent/path/xyz',
      timeout: 60000,
      type: 'typescript',
      patterns: [],
    };
    const result = await builder.runTypescriptBuild(plan);
    assert.ok(typeof result === 'object', '결과 객체 반환');
    assert.ok(result.skipped === true || result.pass === true, '없는 디렉토리는 스킵 처리');
  });
  console.log('✅ builder: runTypescriptBuild skips missing directory');
}

// ─── Test 5: runElixirCompile — 디렉토리 없을 때 스킵 ────────────────

async function test_runElixirCompile_skips_missing_dir() {
  await withMocks(makeBuilderMocks(), async (builder) => {
    const plan = {
      id: 'test-elixir',
      name: 'Test Elixir',
      cwd: '/nonexistent/elixir/xyz',
      timeout: 120000,
      type: 'elixir',
      patterns: [],
    };
    const result = await builder.runElixirCompile(plan);
    assert.ok(typeof result === 'object', '결과 객체 반환');
    assert.ok(result.skipped === true, '없는 디렉토리는 스킵');
  });
  console.log('✅ builder: runElixirCompile skips missing directory');
}

// ─── Test 6: reportBuildStatus — postAlarm 호출 ───────────────────────

async function test_reportBuildStatus_calls_postAlarm() {
  const postAlarmCalls = [];
  const mocks = makeBuilderMocks({
    '../../../packages/core/lib/hub-alarm-client': {
      postAlarm: async (p) => { postAlarmCalls.push(p); return { ok: true }; },
    },
  });

  await withMocks(mocks, async (builder) => {
    await builder.reportBuildStatus([
      { pass: true, skipped: false, plan: { id: 'test', name: 'test' } },
    ]);
    assert.ok(postAlarmCalls.length > 0, 'postAlarm 호출됨');
  });
  console.log('✅ builder: reportBuildStatus calls postAlarm');
}

// ─── Test 7: formatBuildReport — 문자열 반환 ─────────────────────────

async function test_formatBuildReport_returns_string() {
  await withMocks(makeBuilderMocks(), async (builder) => {
    const report = builder.formatBuildReport([
      { pass: true, skipped: false, plan: { id: 'packages-core', name: 'Core' } },
      { pass: false, skipped: false, error: '빌드 실패', plan: { id: 'packages-core', name: 'Core' } },
    ]);
    assert.ok(typeof report === 'string', '문자열 반환');
    assert.ok(report.length > 0, '비어있지 않음');
  });
  console.log('✅ builder: formatBuildReport returns non-empty string');
}

// ─── 실행 ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Builder 테스트 시작 ===\n');
  const tests = [
    test_needsBuild_matches_patterns,
    test_needsBuild_no_match,
    test_build_plans_defined,
    test_runTypescriptBuild_skips_missing_dir,
    test_runElixirCompile_skips_missing_dir,
    test_reportBuildStatus_calls_postAlarm,
    test_formatBuildReport_returns_string,
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
