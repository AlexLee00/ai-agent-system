// @ts-nocheck
'use strict';

// PostToolUse hook 전용 CLI — security-pipeline 모듈 래퍼
// 사용: tsx packages/core/lib/skills/bin/security-pipeline-cli.ts [file1 file2 ...]
// 파일 미지정 시: git diff --name-only 기반 자동 감지

const path = require('path');
const { execSync } = require('child_process');
const { runSecurityPipeline } = require(path.join(__dirname, '../security-pipeline'));

const ROOT = path.resolve(__dirname, '../../../../..');

function getChangedFiles() {
  try {
    const out = execSync('git diff --name-only HEAD 2>/dev/null', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

const args = process.argv.slice(2);
const files = args.length > 0
  ? args.map((f) => (path.isAbsolute(f) ? f : path.join(ROOT, f)))
  : getChangedFiles().map((f) => path.join(ROOT, f));

const jstsFiles = files.filter((f) => /\.(js|ts|mjs|cjs)$/.test(f) && !/\.d\.ts$/.test(f));

if (jstsFiles.length === 0) {
  process.exit(0);
}

const result = runSecurityPipeline(jstsFiles);
const { summary } = result;

if (summary.critical > 0 || summary.high > 0) {
  console.log(`[Security] ⚠️  보안 경고 — CRITICAL:${summary.critical} HIGH:${summary.high} MEDIUM:${summary.medium}`);

  const critical = result.results.filter((r) => r.severity === 'CRITICAL');
  const high = result.results.filter((r) => r.severity === 'HIGH');

  [...critical, ...high].slice(0, 5).forEach((f) => {
    const rel = f.file ? path.relative(ROOT, f.file) : '';
    console.log(`  [${f.severity}] ${rel}:${f.line} — ${f.desc}`);
  });
} else if (summary.medium > 0) {
  console.log(`[Security] 🟡 규칙 위반 ${summary.medium}건 (MEDIUM) — 확인 권장`);
}

if (!summary.gitignorePass) {
  console.log(`[Security] ⚠️  .gitignore 필수 항목 누락: ${result.gitignore.missing.join(', ')}`);
}

process.exit(0);
