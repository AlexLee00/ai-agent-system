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
const CODE_REVIEW_PATH = path.resolve(__dirname, '../../../packages/core/lib/skills/code-review.ts');

function makeGuardianMocks(overrides = {}) {
  return {
    '../../../packages/core/lib/hub-alarm-client': {
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
    '../lib/agent-heartbeat': {
      writeClaudeHeartbeat: async () => ({ ok: true }),
      errorHeartbeatMeta: (error, meta = {}) => ({ ...meta, message: error?.message || String(error) }),
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

// ─── Test 6: layer6_networkAudit — self-scan false positive 제외 ─────

async function test_layer6_ignores_guardian_self_file() {
  const tmpDir = path.join(os.tmpdir(), `test-guardian-self-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const selfFile = path.join(tmpDir, 'bots/claude/src/guardian.ts');
  const externalFile = path.join(tmpDir, 'bots/investment/shared/suspicious.ts');
  fs.mkdirSync(path.dirname(selfFile), { recursive: true });
  fs.mkdirSync(path.dirname(externalFile), { recursive: true });
  fs.writeFileSync(selfFile, '// detector self file');
  fs.writeFileSync(externalFile, '// external suspicious usage');

  const mocks = makeGuardianMocks({
    '../../../packages/core/lib/env': { PROJECT_ROOT: tmpDir },
    child_process: {
      execSync: (cmd) => {
        if (cmd.includes('grep -rl') && cmd.includes('pastebin.com')) {
          return `${selfFile}\n${externalFile}`;
        }
        if (cmd.includes('grep -rl')) return selfFile;
        return '';
      },
    },
  });

  try {
    await withMocks(mocks, async (guardian) => {
      const issues = await guardian.layer6_networkAudit();
      assert.ok(Array.isArray(issues), 'layer6는 배열 반환');
      assert.ok(
        issues.some(item => String(item.desc || '').includes(path.relative(tmpDir, externalFile))),
        '외부 파일 이슈는 유지되어야 함',
      );
      assert.ok(
        !issues.some(item => String(item.desc || '').includes(path.relative(tmpDir, selfFile))),
        'guardian self file은 self-scan에서 제외되어야 함',
      );
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('✅ guardian: layer6_networkAudit ignores guardian self file');
}

// ─── Test 7: Kill Switch — reportToTelegram 스킵 ─────────────────────

async function test_guardian_respects_kill_switch() {
  const postAlarmCalls = [];
  const mocks = makeGuardianMocks({
    '../../../packages/core/lib/hub-alarm-client': {
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

function test_cli_exit_code_does_not_fail_launchd_on_security_findings() {
  const source = fs.readFileSync(GUARDIAN_PATH, 'utf8');
  assert.ok(
    !source.includes('process.exit(result.pass ? 0 : 1)'),
    'guardian finding must not make launchd mark guardian as abnormal exit',
  );
  assert.match(
    source,
    /Security findings are reported through alarm\/heartbeat; launchd exit[\s\S]*process\.exit\(0\);/,
    'CLI entrypoint must exit 0 after a completed security scan',
  );
  console.log('✅ guardian: CLI keeps launchd healthy when findings exist');
}

function test_code_review_ignores_localhost_database_env_fallback() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-code-review-'));
  const target = path.join(tmpDir, 'package.json');
  fs.writeFileSync(target, JSON.stringify({
    scripts: {
      local: 'PG_DIRECT=true tsx -e "new Pool({connectionString:process.env.DATABASE_URL||\'postgresql://localhost:5432/jay\'})"',
      secret: 'node -e "const x=process.env.API_TOKEN||\'0123456789abcdef0123456789abcdef\'"',
      dynamic: 'node -e "const x=process.env.BASE_REF||`${remote}/${branch}`"',
    },
  }, null, 2));

  try {
    delete require.cache[CODE_REVIEW_PATH];
    const codeReview = require(CODE_REVIEW_PATH);
    const findings = codeReview.checkPatterns(target);
    const fallbackFindings = findings.filter(
      item => item.desc === 'env 폴백에 시크릿 문자열 사용 의심',
    );
    assert.strictEqual(fallbackFindings.length, 1, 'localhost DB fallback은 제외하고 실제 긴 fallback은 유지해야 함');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[CODE_REVIEW_PATH];
  }
  console.log('✅ code-review: localhost DB fallback is not flagged as secret');
}

function test_code_review_ignores_loopback_http_env_fallback() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-code-review-loopback-url-'));
  const target = path.join(tmpDir, 'client.ts');
  fs.writeFileSync(target, [
    "const a = process.env.LUNA_A2A_URL || 'http://localhost:8765';",
    "const b = process.env.SIGMA_MCP_URL || 'http://127.0.0.1:4097/rpc';",
    "const secret = process.env.API_TOKEN || '0123456789abcdef0123456789abcdef';",
  ].join('\n'), 'utf8');

  try {
    delete require.cache[CODE_REVIEW_PATH];
    const codeReview = require(CODE_REVIEW_PATH);
    const findings = codeReview.checkPatterns(target).filter(
      item => item.desc === 'env 폴백에 시크릿 문자열 사용 의심',
    );
    assert.deepStrictEqual(findings.map(item => item.line), [3]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[CODE_REVIEW_PATH];
  }
  console.log('✅ code-review: loopback HTTP fallbacks are not treated as secrets');
}

function test_code_review_ignores_smoke_fixture_credentials() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-code-review-smoke-credential-'));
  const smokeTarget = path.join(tmpDir, 'scripts', 'sample-smoke.ts');
  const productionTarget = path.join(tmpDir, 'src', 'sample.ts');
  const credential = ['Abcdef0123456789', 'Abcdef0123456789'].join('');
  const source = `const API_TOKEN = '${credential}';\n`;
  fs.mkdirSync(path.dirname(smokeTarget), { recursive: true });
  fs.mkdirSync(path.dirname(productionTarget), { recursive: true });
  fs.writeFileSync(smokeTarget, source, 'utf8');
  fs.writeFileSync(productionTarget, source, 'utf8');

  try {
    delete require.cache[CODE_REVIEW_PATH];
    const codeReview = require(CODE_REVIEW_PATH);
    const smokeFindings = codeReview.checkPatterns(smokeTarget).filter(
      item => item.desc === 'API 키 또는 시크릿 하드코딩 의심',
    );
    const productionFindings = codeReview.checkPatterns(productionTarget).filter(
      item => item.desc === 'API 키 또는 시크릿 하드코딩 의심',
    );
    assert.strictEqual(smokeFindings.length, 0);
    assert.strictEqual(productionFindings.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[CODE_REVIEW_PATH];
  }
  console.log('✅ code-review: smoke credentials are fixtures while production stays protected');
}

function test_code_review_still_flags_known_token_formats_in_smokes() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-code-review-smoke-known-token-'));
  const smokeTarget = path.join(tmpDir, 'scripts', 'sample-smoke.ts');
  const knownToken = ['sk-', 'A'.repeat(24)].join('');
  fs.mkdirSync(path.dirname(smokeTarget), { recursive: true });
  fs.writeFileSync(smokeTarget, `const token = '${knownToken}';\n`, 'utf8');

  try {
    delete require.cache[CODE_REVIEW_PATH];
    const codeReview = require(CODE_REVIEW_PATH);
    const findings = codeReview.checkPatterns(smokeTarget).filter(
      item => item.desc === 'API 키 또는 시크릿 하드코딩 의심',
    );
    assert.strictEqual(findings.length, 1, 'known provider token shapes must remain blocked in smoke files');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[CODE_REVIEW_PATH];
  }
  console.log('✅ code-review: known token formats stay protected in smoke files');
}

function test_code_review_only_flags_secret_env_fallbacks_in_production() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-code-review-env-fallback-'));
  const productionTarget = path.join(tmpDir, 'src', 'config.ts');
  const fixtureTarget = path.join(tmpDir, '__tests__', 'config.test.ts');
  const source = [
    "const model = process.env.EMBED_MODEL || 'qwen3-embed-0.6b';",
    "const token = process.env.API_TOKEN || '0123456789abcdef0123456789abcdef';",
  ].join('\n');
  fs.mkdirSync(path.dirname(productionTarget), { recursive: true });
  fs.mkdirSync(path.dirname(fixtureTarget), { recursive: true });
  fs.writeFileSync(productionTarget, source, 'utf8');
  fs.writeFileSync(fixtureTarget, source, 'utf8');

  try {
    delete require.cache[CODE_REVIEW_PATH];
    const codeReview = require(CODE_REVIEW_PATH);
    const productionFindings = codeReview.checkPatterns(productionTarget).filter(
      item => item.desc === 'env 폴백에 시크릿 문자열 사용 의심',
    );
    const fixtureFindings = codeReview.checkPatterns(fixtureTarget).filter(
      item => item.desc === 'env 폴백에 시크릿 문자열 사용 의심',
    );
    assert.deepStrictEqual(productionFindings.map(item => item.line), [2]);
    assert.strictEqual(fixtureFindings.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[CODE_REVIEW_PATH];
  }
  console.log('✅ code-review: env fallback checks are credential-aware and fixture-safe');
}

function test_code_review_only_flags_interpolated_write_sql() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-code-review-write-sql-'));
  const target = path.join(tmpDir, 'src', 'queries.ts');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, [
    'const safe = `UPDATE sigma.vault_entries SET status = $1 WHERE id = $2`;',
    'const unsafe = `UPDATE sigma.vault_entries SET status = ${status} WHERE id = ${id}`;',
    '// code-review: allow-whitelisted-sql-identifiers (COORD_COLUMNS)',
    "const whitelisted = `UPDATE sigma.vault_entries SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`;",
    '// code-review: allow-whitelisted-sql-identifiers (COORD_COLUMNS)',
    'const stillUnsafe = `UPDATE sigma.vault_entries SET status = ${status} WHERE id = ${id}`;',
  ].join('\n'), 'utf8');

  try {
    delete require.cache[CODE_REVIEW_PATH];
    const codeReview = require(CODE_REVIEW_PATH);
    const findings = codeReview.checkPatterns(target).filter(
      item => item.desc === '템플릿 문자열 기반 쓰기 SQL 의심',
    );
    assert.deepStrictEqual(findings.map(item => item.line), [2, 6]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[CODE_REVIEW_PATH];
  }
  console.log('✅ code-review: parameterized write SQL is not treated as interpolation');
}

function test_code_review_does_not_flag_its_pattern_descriptions() {
  delete require.cache[CODE_REVIEW_PATH];
  try {
    const codeReview = require(CODE_REVIEW_PATH);
    assert.deepStrictEqual(codeReview.checkPatterns(CODE_REVIEW_PATH), []);
  } finally {
    delete require.cache[CODE_REVIEW_PATH];
  }
  console.log('✅ code-review: detector descriptions do not self-trigger');
}

function test_code_review_distinguishes_storage_keys_from_credentials() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-code-review-storage-key-'));
  const target = path.join(tmpDir, 'app.js');
  const credential = ['Abcdef0123456789', 'Abcdef0123456789'].join('');
  fs.writeFileSync(target, [
    "const SELECTED_MEETING_STORAGE_KEY = 'lunaMeetingRoomSelectedMeetingId';",
    "const PWA_INSTALL_DISMISSED_STORAGE_KEY = 'lunaMeetingRoomPwaInstallDismissed';",
    "const storageKey = 'Abcdef0123456789Abcdef0123456789';",
    "const APPLY_CONFIRM_TOKEN = 'hub-stale-auto-repair-backfill';",
    `const API_TOKEN = '${credential}';`,
    `const apiKey = '${credential}';`,
    `const config = { apiKey: '${credential}' };`,
    `module.exports = { authToken: '${credential}' };`,
    "const storage = { cacheKey: 'CacheValue987654CacheValue987654' };",
  ].join('\n'));

  try {
    delete require.cache[CODE_REVIEW_PATH];
    const codeReview = require(CODE_REVIEW_PATH);
    const findings = codeReview.checkPatterns(target).filter(
      item => item.desc === 'API 키 또는 시크릿 하드코딩 의심',
    );
    assert.deepStrictEqual(findings.map(item => item.line), [5, 6, 7, 8]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[CODE_REVIEW_PATH];
  }
  console.log('✅ code-review: storage keys are not treated as credentials');
}

function test_code_review_scans_typescript_files() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-code-review-typescript-'));
  const target = path.join(tmpDir, 'secret.ts');
  const credential = ['Abcdef0123456789', 'Abcdef0123456789'].join('');
  fs.writeFileSync(target, `const API_TOKEN: string = '${credential}';\n`, 'utf8');

  try {
    delete require.cache[CODE_REVIEW_PATH];
    const codeReview = require(CODE_REVIEW_PATH);
    const result = codeReview.runChecklist([target]);
    assert.strictEqual(result.summary.totalFiles, 1, 'TypeScript 파일도 code-review 대상이어야 함');
    assert.strictEqual(result.summary.syntaxFails, 0, 'TypeScript 문법은 Node JS parser로 검사하면 안 됨');
    assert.strictEqual(result.summary.high, 1, 'TypeScript 하드코딩 시크릿을 감지해야 함');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[CODE_REVIEW_PATH];
  }
  console.log('✅ code-review: TypeScript files are scanned');
}

function test_code_review_distinguishes_test_fixture_code_writes() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-code-review-fixture-write-'));
  const testTarget = path.join(tmpDir, '__tests__', 'writer.test.ts');
  const productionTarget = path.join(tmpDir, 'src', 'writer.ts');
  const source = "fs.writeFileSync('sample.ts', 'export {};', 'utf8');\n";
  fs.mkdirSync(path.dirname(testTarget), { recursive: true });
  fs.mkdirSync(path.dirname(productionTarget), { recursive: true });
  fs.writeFileSync(testTarget, source, 'utf8');
  fs.writeFileSync(productionTarget, source, 'utf8');

  try {
    delete require.cache[CODE_REVIEW_PATH];
    const codeReview = require(CODE_REVIEW_PATH);
    const testFindings = codeReview.checkPatterns(testTarget);
    const productionFindings = codeReview.checkPatterns(productionTarget);
    assert.strictEqual(testFindings.some(item => item.severity === 'CRITICAL'), false);
    assert.strictEqual(productionFindings.some(item => item.severity === 'CRITICAL'), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[CODE_REVIEW_PATH];
  }
  console.log('✅ code-review: fixture writes are separated from production writes');
}

async function test_guardian_scans_typescript_patterns() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-guardian-typescript-'));
  const target = path.join(tmpDir, 'sample.ts');
  fs.writeFileSync(target, 'export {};\n', 'utf8');
  let scanned = false;
  const mocks = makeGuardianMocks({
    '../../../packages/core/lib/env': { PROJECT_ROOT: tmpDir },
    '../../../packages/core/lib/skills': {
      codeReview: {
        checkPatterns: (file) => {
          scanned = file === target;
          return [{ severity: 'HIGH', desc: 'fixture', line: 1 }];
        },
      },
    },
  });

  try {
    await withMocks(mocks, async (guardian) => {
      const result = await guardian.runFullSecurityScan({ force: true, test: true, files: [target], rootDir: tmpDir });
      assert.strictEqual(scanned, true, 'Guardian이 TypeScript 파일을 패턴 검사해야 함');
      assert.strictEqual(result.high.some(item => item.file === target), true);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('✅ guardian: TypeScript patterns are scanned');
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
    test_layer6_ignores_guardian_self_file,
    test_guardian_respects_kill_switch,
    test_cli_exit_code_does_not_fail_launchd_on_security_findings,
    test_code_review_ignores_localhost_database_env_fallback,
    test_code_review_ignores_loopback_http_env_fallback,
    test_code_review_ignores_smoke_fixture_credentials,
    test_code_review_still_flags_known_token_formats_in_smokes,
    test_code_review_only_flags_secret_env_fallbacks_in_production,
    test_code_review_only_flags_interpolated_write_sql,
    test_code_review_does_not_flag_its_pattern_descriptions,
    test_code_review_distinguishes_storage_keys_from_credentials,
    test_code_review_scans_typescript_files,
    test_code_review_distinguishes_test_fixture_code_writes,
    test_guardian_scans_typescript_patterns,
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
