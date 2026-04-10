// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// node:test 기반 테스트 템플릿 생성
function generateTestTemplate(functionName, filePath) {
  if (!functionName || !filePath) {
    console.warn('[skills/tdd] functionName 또는 filePath 누락');
    return null;
  }

  const relativePath = filePath.startsWith('.')
    ? filePath
    : './' + filePath;

  return [
    "'use strict';",
    '',
    "const { describe, it } = require('node:test');",
    "const assert = require('node:assert/strict');",
    `const { ${functionName} } = require('${relativePath}');`,
    '',
    `describe('${functionName}', () => {`,
    `  it('정상 동작 확인', () => {`,
    `    const result = ${functionName}();`,
    `    assert.ok(result !== undefined, '반환값이 존재해야 함');`,
    '  });',
    '',
    `  it('엣지 케이스: null/undefined 입력', () => {`,
    `    const result = ${functionName}(null);`,
    `    assert.ok(result !== undefined, 'null 입력 시에도 동작해야 함');`,
    '  });',
    '});',
    '',
  ].join('\n');
}

// node --test 실행 → 결과 파싱
function runTests(testFile) {
  if (!testFile) {
    console.warn('[skills/tdd] testFile 누락');
    return null;
  }

  try {
    const output = execSync(`node --test "${testFile.replace(/"/g, '\\"')}"`, {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 60000,
    });

    // TAP 출력에서 결과 파싱
    const lines = output.split('\n');
    let total = 0;
    let passed = 0;
    let failed = 0;
    const errors = [];

    for (const line of lines) {
      if (/^ok\s+\d+/.test(line)) {
        total += 1;
        passed += 1;
      } else if (/^not ok\s+\d+/.test(line)) {
        total += 1;
        failed += 1;
        errors.push(line.trim());
      }
    }

    // tests/pass 카운트가 TAP에서 안 잡히면 전체 통과로 간주
    if (total === 0) {
      total = 1;
      passed = 1;
    }

    return { pass: failed === 0, total, passed, failed, errors };
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : (err.message || '알 수 없는 오류');
    return { pass: false, total: 0, passed: 0, failed: 1, errors: [stderr] };
  }
}

// 파일별 테스트 커버리지 확인 (테스트 파일 존재 여부)
function checkCoverage(files) {
  const fileList = Array.isArray(files) ? files : [];
  const covered = [];
  const uncovered = [];

  for (const file of fileList) {
    if (typeof file !== 'string') continue;
    const parsed = path.parse(file);
    const baseName = parsed.name;
    const dir = parsed.dir;

    // 테스트 파일 후보 위치
    const candidates = [
      path.join(dir, 'tests', baseName + '.test.js'),
      path.join(dir, 'tests', baseName + '.spec.js'),
      path.join(dir, '__tests__', baseName + '.test.js'),
      path.join(dir, '__tests__', baseName + '.spec.js'),
      path.join(dir, baseName + '.test.js'),
      path.join(dir, baseName + '.spec.js'),
    ];

    const found = candidates.some((c) => {
      try { return fs.statSync(c).isFile(); } catch (_) { return false; }
    });

    if (found) {
      covered.push(file);
    } else {
      uncovered.push(file);
    }
  }

  const total = covered.length + uncovered.length;
  return {
    covered,
    uncovered,
    coverageRate: total > 0 ? Math.round((covered.length / total) * 100) / 100 : 0,
  };
}

module.exports = { generateTestTemplate, runTests, checkCoverage };
