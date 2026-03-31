'use strict';

const { execSync } = require('child_process');

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

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

module.exports = { runVerifyLoop };
