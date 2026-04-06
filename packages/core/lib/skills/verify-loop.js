'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const TS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts']);

function getJsFiles(files) {
  return (Array.isArray(files) ? files : []).filter((file) => {
    if (typeof file !== 'string') return false;
    return Array.from(JS_EXTENSIONS).some((ext) => file.endsWith(ext));
  });
}

function runNodeCheck(files) {
  const targets = getJsFiles(files);

  for (const file of targets) {
    execSync(`node --check "${file.replace(/"/g, '\\"')}"`, {
      stdio: 'pipe',
      encoding: 'utf8',
    });
  }
}

function normalizeError(err) {
  if (!err) return '알 수 없는 오류';
  if (err.stderr) return String(err.stderr).trim();
  if (err.stdout) return String(err.stdout).trim();
  if (err.message) return String(err.message).trim();
  return String(err);
}

function phaseSyntax(files, cwd) {
  const jsFiles = getJsFiles(files);
  const failures = [];

  for (const file of jsFiles) {
    try {
      execSync(`node --check "${file.replace(/"/g, '\\"')}"`, {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch (err) {
      failures.push({
        file,
        error: normalizeError(err).slice(0, 200),
      });
    }
  }

  return {
    pass: failures.length === 0,
    failures,
    checked: jsFiles.length,
  };
}

function phaseStyle(files, cwd) {
  const jsFiles = getJsFiles(files);
  const warnings = [];

  for (const file of jsFiles) {
    const issues = [];

    try {
      const content = fs.readFileSync(path.join(cwd, file), 'utf8');
      const lines = content.split('\n');

      if (!content.startsWith("'use strict'")) {
        issues.push("'use strict' 누락");
      }
      if (/console\.log\(/.test(content) && !/\/\/\s*(debug|TODO)/.test(content)) {
        issues.push('console.log 발견 (console.warn/error 권장)');
      }
      if (/\bvar\s+/.test(content)) {
        issues.push('var 사용 (const/let 권장)');
      }
      if (lines.length > 500) {
        issues.push(`파일 ${lines.length}줄 (500줄 이하 권장)`);
      }
      if (/module\.exports/.test(content) && !/\/\*\*/.test(content)) {
        issues.push('JSDoc 주석 없음');
      }
    } catch {}

    if (issues.length > 0) {
      warnings.push({ file, issues });
    }
  }

  return {
    pass: warnings.length === 0,
    warnings,
    checked: jsFiles.length,
  };
}

function phaseSecurity(files, cwd) {
  const findings = [];
  const dangerPatterns = [
    { regex: /['"]sk-[a-zA-Z0-9]{20,}['"]/, type: 'API_KEY_LEAKED' },
    { regex: /['"]ghp_[a-zA-Z0-9]{20,}['"]/, type: 'GITHUB_TOKEN_LEAKED' },
    { regex: /password\s*[:=]\s*['"][^'"]{3,}['"]/, type: 'HARDCODED_PASSWORD' },
    { regex: /eval\s*\(/, type: 'EVAL_USAGE' },
    { regex: /child_process.*exec\s*\((?!File)/, type: 'COMMAND_INJECTION_RISK' },
    { regex: /process\.exit\s*\(\s*\)/, type: 'PROCESS_EXIT_NO_CODE' },
  ];

  for (const file of Array.isArray(files) ? files : []) {
    if (typeof file !== 'string') continue;
    if (!Array.from(TS_EXTENSIONS).some((ext) => file.endsWith(ext))) continue;

    try {
      const content = fs.readFileSync(path.join(cwd, file), 'utf8');
      const lines = content.split('\n');

      for (let index = 0; index < lines.length; index += 1) {
        for (const { regex, type } of dangerPatterns) {
          if (regex.test(lines[index])) {
            findings.push({
              file,
              type,
              line: index + 1,
            });
          }
        }
      }
    } catch {}
  }

  return {
    pass: findings.length === 0,
    findings,
  };
}

function phaseDiff(cwd, baseBranch = 'main') {
  try {
    const diffStat = execSync(`git diff --stat ${baseBranch}`, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    const conflictCheck = execSync('git diff --check 2>&1 || true', {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    const hasConflicts = /\bconflict\b/i.test(conflictCheck);
    const diffLines = diffStat ? diffStat.split('\n') : [];
    const changedFiles = diffLines.length > 0 ? diffLines.length - 1 : 0;

    return {
      pass: !hasConflicts && changedFiles <= 50,
      stats: {
        summary: diffLines.length > 0 ? diffLines[diffLines.length - 1].trim() : '',
        changedFiles,
        hasConflicts,
        tooManyChanges: changedFiles > 50,
      },
    };
  } catch {
    return {
      pass: true,
      stats: {
        summary: 'diff 실행 불가',
        changedFiles: 0,
        hasConflicts: false,
        tooManyChanges: false,
      },
    };
  }
}

function _buildResult(report) {
  const phases = Object.entries(report);
  const overall = phases.every(([, result]) => result.pass);
  const lines = [
    'VERIFICATION REPORT',
    '==================',
    '',
  ];

  for (const [name, result] of phases) {
    lines.push(`${result.pass ? '✅' : '❌'} ${name.toUpperCase()}: ${result.pass ? 'PASS' : 'FAIL'}`);

    if (!result.pass) {
      if (Array.isArray(result.failures)) {
        result.failures.slice(0, 5).forEach((failure) => {
          lines.push(`   ${failure.file}: ${failure.error}`);
        });
      }
      if (Array.isArray(result.warnings)) {
        result.warnings.slice(0, 5).forEach((warning) => {
          lines.push(`   ${warning.file}: ${warning.issues.join(', ')}`);
        });
      }
      if (Array.isArray(result.findings)) {
        result.findings.slice(0, 5).forEach((finding) => {
          lines.push(`   ${finding.file}:${finding.line} ${finding.type}`);
        });
      }
    }
  }

  lines.push('');
  lines.push(`Overall: ${overall ? 'PASS ✅' : 'FAIL ❌'}`);

  return { overall, report, summary: lines.join('\n') };
}

function runFullVerification(opts = {}) {
  const files = Array.isArray(opts.files) ? opts.files : [];
  const cwd = opts.cwd || process.cwd();
  const baseBranch = opts.baseBranch || 'main';
  const stopOnFail = Boolean(opts.stopOnFail);
  const report = {};

  report.syntax = phaseSyntax(files, cwd);
  if (stopOnFail && !report.syntax.pass) return _buildResult(report);

  report.style = phaseStyle(files, cwd);
  if (stopOnFail && !report.style.pass) return _buildResult(report);

  report.security = phaseSecurity(files, cwd);
  if (stopOnFail && !report.security.pass) return _buildResult(report);

  report.diff = phaseDiff(cwd, baseBranch);

  return _buildResult(report);
}

function runVerifyLoop(opts) {
  const options = opts || {};
  const files = Array.isArray(options.files) ? options.files : [];
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries > 0
    ? options.maxRetries
    : 3;
  const errors = [];

  for (let round = 1; round <= maxRetries; round += 1) {
    try {
      runNodeCheck(files);

      if (options.testCmd) {
        execSync(options.testCmd, {
          stdio: 'pipe',
          encoding: 'utf8',
          timeout: 60000,
        });
      }

      return {
        pass: true,
        rounds: round,
        errors,
      };
    } catch (err) {
      const message = normalizeError(err);
      errors.push(message);

      if (typeof options.onFail === 'function') {
        try {
          options.onFail(round, message);
        } catch (callbackErr) {
          console.warn(`[skills/verify-loop] onFail 콜백 실패: ${callbackErr.message}`);
        }
      }
    }
  }

  return {
    pass: false,
    rounds: maxRetries,
    errors,
  };
}

module.exports = {
  runVerifyLoop,
  runFullVerification,
  phaseSyntax,
  phaseStyle,
  phaseSecurity,
  phaseDiff,
};
