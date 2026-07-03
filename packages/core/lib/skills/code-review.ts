// @ts-nocheck
'use strict';

const fs = require('fs');
const { execSync } = require('child_process');

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const PATTERN_SKIP_FILES = new Set(['.checksums.json']);

const SECURITY_PATTERNS = [
  {
    severity: 'CRITICAL',
    desc: '코드 파일 직접 덮어쓰기 의심',
    match: (line) => /fs\.writeFileSync\s*\(/.test(line) && /\.(js|ts|py|sh)['"`]/.test(line),
  },
  {
    severity: 'CRITICAL',
    desc: 'git commit/push 실행 의심',
    match: (line) => /(exec|execSync)\s*\(/.test(line) && /\bgit\s+(commit|push)\b/.test(line),
  },
  {
    severity: 'HIGH',
    desc: 'API 키 또는 시크릿 하드코딩 의심',
    match: (line) => /['"`][A-Za-z0-9]{32,}['"`]/.test(line),
  },
  {
    severity: 'HIGH',
    desc: 'env 폴백에 시크릿 문자열 사용 의심',
    match: (line) => {
      const match = line.match(/process\.env\.[A-Z0-9_]+\s*\|\|\s*['"`]([^'"`]{16,})['"`]/);
      if (!match) return false;
      const fallback = match[1];
      return !/^postgres(?:ql)?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(fallback);
    },
  },
  {
    severity: 'HIGH',
    desc: '템플릿 문자열 기반 쓰기 SQL 의심',
    match: (line) => /`[^`]*\b(DELETE|DROP|INSERT|UPDATE)\b[^`]*\b(INTO|FROM|SET|WHERE|TABLE)\b[^`]*`/i.test(line),
  },
];

const RULE_PATTERNS = [
  {
    severity: 'MEDIUM',
    desc: 'kst.js 대신 new Date() 직접 사용',
    match: (line) => /\bnew Date\s*\(/.test(line),
  },
  {
    severity: 'LOW',
    desc: 'throw new Error 사용',
    match: (line) => /\bthrow new Error\s*\(/.test(line),
  },
  {
    severity: 'MEDIUM',
    desc: 'pg-pool.js 대신 pg 직접 require',
    match: (line) => /require\s*\(\s*['"]pg['"]\s*\)/.test(line),
  },
];

function getJsFiles(files) {
  return (Array.isArray(files) ? files : []).filter((file) => {
    if (typeof file !== 'string') return false;
    return Array.from(JS_EXTENSIONS).some((ext) => file.endsWith(ext));
  });
}

function normalizeExecError(err) {
  if (!err) return '알 수 없는 오류';
  if (err.stderr) return String(err.stderr).trim();
  if (err.stdout) return String(err.stdout).trim();
  if (err.message) return String(err.message).trim();
  return String(err);
}

function checkSyntax(files) {
  return getJsFiles(files).map((file) => {
    try {
      execSync(`node --check "${file.replace(/"/g, '\\"')}"`, {
        stdio: 'pipe',
        encoding: 'utf8',
      });
      return { file, pass: true };
    } catch (err) {
      return {
        file,
        pass: false,
        error: normalizeExecError(err),
      };
    }
  });
}

function checkPatterns(filePath) {
  try {
    if (PATTERN_SKIP_FILES.has(require('path').basename(filePath))) {
      return [];
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const findings = [];

    lines.forEach((line, index) => {
      SECURITY_PATTERNS.forEach((pattern) => {
        if (pattern.match(line, index + 1, filePath)) {
          findings.push({
            severity: pattern.severity,
            desc: pattern.desc,
            line: index + 1,
          });
        }
      });

      RULE_PATTERNS.forEach((pattern) => {
        if (pattern.match(line, index + 1, filePath)) {
          findings.push({
            severity: pattern.severity,
            desc: pattern.desc,
            line: index + 1,
          });
        }
      });
    });

    return findings;
  } catch (err) {
    console.warn(`[skills/code-review] 패턴 검사 실패: ${filePath} — ${err.message}`);
    return [];
  }
}

function runChecklist(files) {
  const targetFiles = getJsFiles(files);
  const syntax = checkSyntax(targetFiles);
  const findings = [];

  targetFiles.forEach((file) => {
    const fileFindings = checkPatterns(file).map((item) => ({
      file,
      severity: item.severity,
      desc: item.desc,
      line: item.line,
    }));
    findings.push(...fileFindings);
  });

  const summary = {
    totalFiles: targetFiles.length,
    syntaxFails: syntax.filter((item) => item.pass === false).length,
    critical: findings.filter((item) => item.severity === 'CRITICAL').length,
    high: findings.filter((item) => item.severity === 'HIGH').length,
    medium: findings.filter((item) => item.severity === 'MEDIUM').length,
  };

  summary.pass = summary.syntaxFails === 0 && summary.critical === 0 && summary.high === 0;

  return {
    syntax,
    findings,
    summary,
  };
}

module.exports = {
  checkSyntax,
  checkPatterns,
  runChecklist,
  SECURITY_PATTERNS,
  RULE_PATTERNS,
};
