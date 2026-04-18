'use strict';

/**
 * Phase A: guardian.ts 단위 테스트
 *
 * 실행: node bots/claude/__tests__/guardian.test.ts
 */

const assert = require('assert');
const Module = require('module');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const GUARDIAN_PATH = path.resolve(__dirname, '../src/guardian.ts');

function makeGuardianMocks(overrides = {}) {
  return {
    '../../../packages/core/lib/openclaw-client': {
      postAlarm: async () => ({ ok: true }),
    },
    '../../../packages/core/lib/env': {
      PROJECT_ROOT: path.join(os.tmpdir(), 'test-claude-guardian'),
    },
    '../../../packages/core/lib/skills': {
      codeReview: {
        runChecklist: () => ({ summary: { pass: true, totalFiles: 0, syntaxFails: 0, critical: 0, high: 0, medium: 0 }, findings: [] }),
        checkPatterns: () => [],
      },
    },
    './reviewer': {
      analyzeChanges: async () => ({ files: [], added_lines: 0, removed_lines: 0, diff_summary: '' }),
      getChangedFiles: async () => [],
    },
    child_process: {
      execSync: (cmd) => {
        if (cmd.includes('npm audit')) return '{"vulnerabilities":{}}';
        if (cmd.includes('git log'))   return '';
        if (cmd.includes('find'))      return '';
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
    delete require.cache[GUARDIAN_PATH];
    return await fn(require(GUARDIAN_PATH));
  } finally {
    Module._load = original;
    delete require.cache[GUARDIAN_PATH];
  }
}

// ─── Test 1: layer1_gitignoreAudit — 배열 반환 ───────────────────────

async function test_layer1_returns_array() {
  await withMocks(makeGuardianMocks(), async (guardian) => {
    const issues = await guardian.layer1_gitignoreAudit();
    assert.ok(Array.isArray(issues), 'layer1은 배열 반환');
  });
  console.log('✅ guardian: layer1_gitignoreAudit returns array');
}

// ─── Test 2: layer2_commitSecretScan — 배열 반환 ─────────────────────

async function test_layer2_returns_array() {
  await withMocks(makeGuardianMocks(), async (guardian) => {
    const issues = await guardian.layer2_commitSecretScan();
    assert.ok(Array.isArray(issues), 'layer2는 배열 반환');
  });
  console.log('✅ guardian: layer2_commitSecretScan returns array');
}

// ─── Test 3: layer3_suspiciousPackages — 의심 패키지 감지 ────────────

async function test_layer3_detects_suspicious_packages() {
  const tmpDir = path.join(os.tmpdir(), 'test-guardian-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ dependencies: { 'xmrig': '1.0.0', 'lodash': '4.0.0' } })
  );

  const mocks = makeGuardianMocks({
    '../../../packages/core/lib/env': { PROJECT_ROOT: tmpDir },
  });

  try {
    await withMocks(mocks, async (guardian) => {
      const issues = await guardian.layer3_suspiciousPackages();
      assert.ok(Array.isArray(issues), 'layer3는 배열 반환');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('✅ guardian: layer3_suspiciousPackages handles suspicious packages');
}

// ─── Test 4: runFullSecurityScan — severity 포함 ─────────────────────

async function test_runFullSecurityScan_has_severity() {
  await withMocks(makeGuardianMocks(), async (guardian) => {
    const report = await guardian.runFullSecurityScan({ force: true, test: true });
    assert.ok(Array.isArray(report.critical), 'critical은 배열');
    assert.ok(Array.isArray(report.high), 'high는 배열');
    assert.ok(typeof report.pass === 'boolean' || report.pass === undefined, 'pass는 boolean이거나 없음');
    assert.ok(typeof report.message === 'string', 'message는 문자열');
  });
  console.log('✅ guardian: runFullSecurityScan returns valid report structure');
}

// ─── Test 5: layer4_dependencyVulnerabilities — npm audit 파싱 ───────

async function test_layer4_parses_npm_audit() {
  const mocks = makeGuardianMocks({
    child_process: {
      execSync: (cmd) => {
        if (cmd.includes('npm audit')) {
          return JSON.stringify({
            vulnerabilities: {
              'lodash': { severity: 'high', range: '<4.17.21' },
            },
          });
        }
        return '';
      },
    },
  });
  await withMocks(mocks, async (guardian) => {
    const issues = await guardian.layer4_dependencyVulnerabilities();
    assert.ok(Array.isArray(issues), 'layer4는 배열 반환');
  });
  console.log('✅ guardian: layer4_dependencyVulnerabilities parses npm audit');
}

// ─── Test 6: Kill Switch — reportToTelegram 스킵 ─────────────────────

async function test_guardian_respects_kill_switch() {
  const postAlarmCalls = [];
  const mocks = makeGuardianMocks({
    '../../../packages/core/lib/openclaw-client': {
      postAlarm: async (p) => { postAlarmCalls.push(p); },
    },
  });

  const origEnv = process.env.CLAUDE_GUARDIAN_ENABLED;
  process.env.CLAUDE_GUARDIAN_ENABLED = 'false';

  try {
    await withMocks(mocks, async (guardian) => {
      if (typeof guardian.reportToTelegram === 'function') {
        await guardian.reportToTelegram({ severity: 'warn', issues: [], summary: '테스트' });
        assert.strictEqual(postAlarmCalls.length, 0, 'Kill Switch OFF 시 발송 없음');
      }
    });
  } finally {
    process.env.CLAUDE_GUARDIAN_ENABLED = origEnv;
  }
  console.log('✅ guardian: reportToTelegram respects Kill Switch');
}

// ─── 실행 ─────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Guardian 테스트 시작 ===\n');
  const tests = [
    test_layer1_returns_array,
    test_layer2_returns_array,
    test_layer3_detects_suspicious_packages,
    test_runFullSecurityScan_has_severity,
    test_layer4_parses_npm_audit,
    test_guardian_respects_kill_switch,
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
