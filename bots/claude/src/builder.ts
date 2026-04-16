// @ts-nocheck
'use strict';

const path = require('path');
const { execSync } = require('child_process');

const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const env = require('../../../packages/core/lib/env');
const reviewer = require('./reviewer');

const ROOT = env.PROJECT_ROOT;
const BUILD_PATTERNS = [
  'bots/worker/web/',
  'bots/worker/package.json',
  'bots/worker/web/package.json',
  'bots/worker/web/next.config.js',
  'bots/worker/web/next.config.mjs',
];

function needsBuild(changedFiles) {
  return (Array.isArray(changedFiles) ? changedFiles : []).some((file) => {
    const relative = path.relative(ROOT, file).replace(/\\/g, '/');
    return BUILD_PATTERNS.some((pattern) => relative.startsWith(pattern) || relative === pattern);
  });
}

function formatBuildReport(result) {
  if (result.skipped) return '✅ 빌더 스킵 — 워커 웹 변경 없음';
  if (result.pass) return `✅ 빌드 통과 — ${result.project}`;
  return [
    `⚠️ 빌드 실패 — ${result.project}`,
    '',
    (result.error || '오류 메시지 없음').slice(0, 1800),
  ].join('\n');
}

async function runBuildCheck(options = {}) {
  const testMode = Boolean(options.test) || process.argv.includes('--test');
  const changedFiles = Array.isArray(options.files) ? options.files : await reviewer.getChangedFiles();
  if (!needsBuild(changedFiles)) {
    const message = formatBuildReport({ skipped: true });
    if (!testMode) await postAlarm({ message, team: 'claude', alertLevel: 2, fromBot: 'builder' });
    return { skipped: true, pass: true, sent: !testMode, message };
  }

  const targetDir = path.join(ROOT, 'bots/worker/web');
  try {
    execSync('npm run build', {
      cwd: targetDir,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 180000,
    });
    const message = formatBuildReport({ skipped: false, pass: true, project: 'bots/worker/web' });
    const sent = testMode ? false : (await postAlarm({ message, team: 'claude', alertLevel: 2, fromBot: 'builder' })).ok;
    return { skipped: false, pass: true, sent, message, project: 'bots/worker/web' };
  } catch (error) {
    const stderr = String(error.stderr || error.stdout || error.message || '').trim();
    const message = formatBuildReport({
      skipped: false,
      pass: false,
      project: 'bots/worker/web',
      error: stderr,
    });
    const sent = testMode ? false : (await postAlarm({ message, team: 'claude', alertLevel: 4, fromBot: 'builder' })).ok;
    return { skipped: false, pass: false, sent, message, error: stderr, project: 'bots/worker/web' };
  }
}

module.exports = { runBuildCheck, needsBuild };

if (require.main === module) {
  runBuildCheck()
    .then((result) => {
      console.log(result.message);
      process.exit(result.pass ? 0 : 1);
    })
    .catch((error) => {
      console.warn(`[builder] 실행 실패: ${error.message}`);
      process.exit(0);
    });
}
