// @ts-nocheck
'use strict';

// Stop hook 전용 CLI — handoff-verify 모듈 래퍼
// 사용: tsx packages/core/lib/skills/bin/handoff-verify-cli.ts [file1 file2 ...]
// 파일 미지정 시 최근 커밋 변경 파일 자동 감지

const path = require('path');
const { execSync } = require('child_process');
const { runHandoffVerify, formatVerifyReport } = require(path.join(__dirname, '../handoff-verify'));

const ROOT = path.resolve(__dirname, '../../../..');

function getRecentChangedFiles() {
  try {
    const out = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    return out ? out.split('\n').filter(Boolean).map((f) => path.join(ROOT, f)) : [];
  } catch (_) {
    return [];
  }
}

const files = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : getRecentChangedFiles();

const jsFiles = files.filter((f) => /\.(js|mjs|cjs)$/.test(f));

if (jsFiles.length === 0) {
  console.log('[HandoffVerify] 검증 대상 JS 파일 없음 — 스킵');
  process.exit(0);
}

const result = runHandoffVerify(jsFiles);
const report = formatVerifyReport(result);

console.log(report);
process.exit(result.pass ? 0 : 1);
