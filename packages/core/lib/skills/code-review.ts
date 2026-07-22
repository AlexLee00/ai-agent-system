// @ts-nocheck
'use strict';

const fs = require('fs');
const { execSync } = require('child_process');

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const REVIEW_EXTENSIONS = new Set([...JS_EXTENSIONS, '.ts', '.mts', '.cts']);
const PATTERN_SKIP_FILES = new Set(['.checksums.json']);
const PATTERN_DEFINITION_PATH = 'packages/core/lib/skills/code-review.ts';
const SECRET_ENV_NAME_PATTERN = /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BOT_TOKEN|CLIENT_SECRET|PRIVATE_KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/;
const WHITELISTED_SQL_IDENTIFIER_MARKER = 'code-review: allow-whitelisted-sql-identifiers';

function isTestFixturePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return normalized.includes('/__tests__/')
    || /\.(?:test|spec)\.[cm]?[jt]s$/i.test(normalized)
    || /-smoke\.[cm]?[jt]sx?$/i.test(normalized);
}

function isPatternDefinitionPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === PATTERN_DEFINITION_PATH
    || normalized.endsWith(`/${PATTERN_DEFINITION_PATH}`);
}

function looksLikeKnownCredentialLiteral(line) {
  const text = String(line || '');
  return /['"`](?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{20,})['"`]/.test(text);
}

function looksLikeHardcodedCredential(line) {
  const text = String(line || '');
  if (looksLikeKnownCredentialLiteral(text)) return true;

  const typedAssignment = text.match(
    /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*[A-Za-z_$][A-Za-z0-9_$<>,\[\]|?. ]{0,79}\s*=\s*['"`]([A-Za-z0-9._-]{24,})['"`]/,
  );
  const assignment = typedAssignment
    || text.match(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|:)\s*['"`]([A-Za-z0-9._-]{24,})['"`]/);
  if (!assignment) return false;
  const identifier = assignment[1]
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase();
  if (/(?:STORAGE|CACHE|LOCAL_STORAGE|SESSION_STORAGE)(?:_|$)/.test(identifier)) return false;
  if (identifier === 'APPLY_CONFIRM_TOKEN') return false;
  return /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BOT_TOKEN|CLIENT_SECRET|PRIVATE_KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/.test(identifier);
}

function hasWhitelistedSqlIdentifierMarker(lines, index, line) {
  if (!/\$\{sets\.join\(['"]\s*,\s*['"]\)\}/.test(line)) return false;
  if (!/\$\$\{params\.length\}/.test(line)) return false;
  return lines.slice(Math.max(0, index - 1), index + 1)
    .some(candidate => candidate.includes(WHITELISTED_SQL_IDENTIFIER_MARKER));
}

const SECURITY_PATTERNS = [
  {
    severity: 'CRITICAL',
    desc: '코드 파일 직접 덮어쓰기 의심',
    match: (line, _lineNumber, filePath) => !isTestFixturePath(filePath)
      && /fs\.writeFileSync\s*\(/.test(line)
      && /\.(js|ts|py|sh)['"`]/.test(line),
  },
  {
    severity: 'CRITICAL',
    desc: 'git commit/push 실행 의심',
    match: (line) => /(exec|execSync)\s*\(/.test(line) && /\bgit\s+(commit|push)\b/.test(line),
  },
  {
    severity: 'HIGH',
    desc: 'API 키 또는 시크릿 하드코딩 의심',
    match: (line, _lineNumber, filePath) => looksLikeKnownCredentialLiteral(line)
      || (!isTestFixturePath(filePath) && looksLikeHardcodedCredential(line)),
  },
  {
    severity: 'HIGH',
    desc: 'env 폴백에 시크릿 문자열 사용 의심',
    match: (line, _lineNumber, filePath) => {
      if (isTestFixturePath(filePath)) return false;
      const match = line.match(/process\.env\.([A-Z0-9_]+)\s*\|\|\s*['"`]([^'"`]{16,})['"`]/);
      if (!match || !SECRET_ENV_NAME_PATTERN.test(match[1])) return false;
      const fallback = match[2];
      if (fallback.includes('${')) return false;
      return !/^(?:postgres(?:ql)?|https?):\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(fallback);
    },
  },
  {
    id: 'interpolated-write-sql',
    severity: 'HIGH',
    desc: '템플릿 문자열 기반 쓰기 SQL 의심',
    match: (line, _lineNumber, filePath) => !isTestFixturePath(filePath)
      && /\$\{[^}]+\}/.test(line)
      && /`[^`]*\b(DELETE|DROP|INSERT|UPDATE)\b[^`]*\b(INTO|FROM|SET|WHERE|TABLE)\b[^`]*`/i.test(line),
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

function getFilesByExtensions(files, extensions) {
  return (Array.isArray(files) ? files : []).filter((file) => {
    if (typeof file !== 'string') return false;
    return Array.from(extensions).some((ext) => file.endsWith(ext));
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
  return getFilesByExtensions(files, JS_EXTENSIONS).map((file) => {
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
      if (isPatternDefinitionPath(filePath) && /^\s*desc:\s*['"`]/.test(line)) return;
      SECURITY_PATTERNS.forEach((pattern) => {
        if (
          pattern.id === 'interpolated-write-sql'
          && hasWhitelistedSqlIdentifierMarker(lines, index, line)
        ) return;
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
  const targetFiles = getFilesByExtensions(files, REVIEW_EXTENSIONS);
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
  looksLikeHardcodedCredential,
};
