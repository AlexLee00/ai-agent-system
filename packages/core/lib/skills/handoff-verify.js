'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CHECKLIST = {
  build: ['node --check 통과', 'import 경로 실재'],
  feature: ['함수 입출력 일치', '엣지 케이스 처리'],
  safety: ['OPS 수정 없음', 'secrets 없음', 'TP/SL 준수'],
  consistency: ['DB 호환', 'API 인터페이스 유지', '타팀 영향 없음'],
};

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

// 보안 패턴 (간소화 — 상세는 code-review.js에서)
const DANGER_PATTERNS = [
  { pattern: /secrets\.json/i, desc: 'secrets 파일 참조' },
  { pattern: /\.env['"]/i, desc: '.env 파일 참조' },
  { pattern: /sk-ant-api|gsk_[a-zA-Z0-9]/i, desc: 'API 키 하드코딩 의심' },
];

function isJsFile(file) {
  return typeof file === 'string' && Array.from(JS_EXTENSIONS).some((ext) => file.endsWith(ext));
}

function runHandoffVerify(files) {
  const fileList = Array.isArray(files) ? files : [];
  const checklist = [];
  const issues = [];
  let allPass = true;

  // 1. 빌드: node --check
  for (const file of fileList) {
    if (!isJsFile(file)) continue;
    try {
      execSync(`node --check "${file.replace(/"/g, '\\"')}"`, {
        stdio: 'pipe',
        encoding: 'utf8',
      });
      checklist.push({ category: 'build', item: `node --check ${path.basename(file)}`, pass: true });
    } catch (err) {
      const msg = err.stderr ? String(err.stderr).trim() : err.message;
      checklist.push({ category: 'build', item: `node --check ${path.basename(file)}`, pass: false, error: msg });
      issues.push(`문법 오류: ${file}`);
      allPass = false;
    }
  }

  // 2. 빌드: import 경로 확인
  for (const file of fileList) {
    if (!isJsFile(file)) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const requireMatches = content.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g) || [];
      for (const req of requireMatches) {
        const modPath = req.match(/['"]([^'"]+)['"]/)?.[1];
        if (!modPath || !modPath.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), modPath);
        const candidates = [resolved, resolved + '.js', resolved + '.json', path.join(resolved, 'index.js')];
        const exists = candidates.some((c) => {
          try { return fs.statSync(c).isFile(); } catch (_) { return false; }
        });
        if (!exists) {
          checklist.push({ category: 'build', item: `import 경로: ${modPath} (${path.basename(file)})`, pass: false });
          issues.push(`경로 없음: ${modPath} in ${file}`);
          allPass = false;
        }
      }
    } catch (_) { /* 읽기 실패 무시 */ }
  }

  // 3. 안전: 보안 패턴 검사
  for (const file of fileList) {
    if (!isJsFile(file)) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      for (const dp of DANGER_PATTERNS) {
        if (dp.pattern.test(content)) {
          checklist.push({ category: 'safety', item: `${dp.desc} (${path.basename(file)})`, pass: false });
          issues.push(`보안: ${dp.desc} in ${file}`);
          allPass = false;
        }
      }
    } catch (_) { /* 읽기 실패 무시 */ }
  }

  // 4. 기능/정합성: 수동 확인 필요
  checklist.push({ category: 'feature', item: '함수 입출력 일치', pass: null, note: '수동 확인 필요' });
  checklist.push({ category: 'feature', item: '엣지 케이스 처리', pass: null, note: '수동 확인 필요' });
  checklist.push({ category: 'consistency', item: 'DB 호환', pass: null, note: '수동 확인 필요' });
  checklist.push({ category: 'consistency', item: 'API 인터페이스 유지', pass: null, note: '수동 확인 필요' });
  checklist.push({ category: 'consistency', item: '타팀 영향 없음', pass: null, note: '수동 확인 필요' });

  return { checklist, pass: allPass, issues };
}

function formatVerifyReport(result) {
  if (!result) return '검증 결과 없음';

  const lines = ['=== 인수인계 검증 리포트 ===', ''];
  const categories = ['build', 'safety', 'feature', 'consistency'];

  for (const cat of categories) {
    const items = result.checklist.filter((c) => c.category === cat);
    if (items.length === 0) continue;
    lines.push(`[${cat.toUpperCase()}]`);
    for (const item of items) {
      const icon = item.pass === true ? '✅' : item.pass === false ? '❌' : '⚠️';
      const note = item.note ? ` (${item.note})` : '';
      lines.push(`  ${icon} ${item.item}${note}`);
    }
    lines.push('');
  }

  lines.push(result.pass ? '결과: ✅ 통과' : `결과: ❌ 실패 (${result.issues.length}건)`);
  return lines.join('\n');
}

module.exports = { CHECKLIST, runHandoffVerify, formatVerifyReport };
