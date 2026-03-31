#!/usr/bin/env node
'use strict';

const path = require('path');
const { execSync } = require('child_process');

const sender = require('../../../packages/core/lib/telegram-sender');
const kst = require('../../../packages/core/lib/kst');
const env = require('../../../packages/core/lib/env');
const aggregator = require('../lib/write/report-aggregator');
const docSyncChecker = require('../lib/write/doc-sync-checker');
const changelogWriter = require('../lib/write/changelog-writer');

const ROOT = env.PROJECT_ROOT;

function parseArgs(argv = process.argv.slice(2)) {
  const modeArg = argv.find((arg) => arg.startsWith('--mode='));
  return {
    mode: modeArg ? modeArg.split('=')[1] : 'push',
    test: argv.includes('--test'),
  };
}

function safeExec(command) {
  try {
    return execSync(command, {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    console.warn(`[write] 명령 실행 실패: ${error.message}`);
    return '';
  }
}

function getChangedFiles() {
  const output = safeExec('git diff --name-only HEAD~1');
  if (!output) return [];
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function formatPushReport(syncIssues, changelogEntry) {
  const lines = ['📝 라이트 문서 점검 제안', `- 점검 시각: ${kst.datetimeStr()}`];
  lines.push('');
  lines.push(`- 문서 이슈: ${syncIssues.length}건`);
  if (syncIssues.length > 0) {
    syncIssues.slice(0, 10).forEach((item) => {
      lines.push(`  · ${item.file} -> ${item.doc} | ${item.issue}`);
      lines.push(`    제안: ${item.suggestion}`);
    });
  } else {
    lines.push('  · 문서 불일치 없음');
  }

  lines.push('');
  lines.push('CHANGELOG 초안:');
  lines.push(changelogWriter.formatChangelogEntry(changelogEntry).slice(0, 1800));
  return lines.join('\n');
}

async function runOnPush(options = {}) {
  const changedFiles = getChangedFiles();
  const syncIssues = docSyncChecker.checkAll(changedFiles);
  const changelogEntry = changelogWriter.generateEntry('1 day ago');
  const message = formatPushReport(syncIssues, changelogEntry);
  const sent = options.test ? false : await sender.send('meeting', message);
  return { changedFiles, syncIssues, changelogEntry, sent, message };
}

async function runDaily(options = {}) {
  const collected = await aggregator.collectAll();
  const report = aggregator.formatDailyReport(collected);
  const commits = changelogWriter.generateEntry('yesterday');
  const message = [
    report,
    '',
    '전일 커밋 요약:',
    changelogWriter.formatChangelogEntry(commits).slice(0, 1200),
  ].join('\n');
  const sent = options.test ? false : await sender.send('meeting', message);
  return { collected, sent, message };
}

module.exports = { runOnPush, runDaily };

if (require.main === module) {
  const options = parseArgs();
  const runner = options.mode === 'daily' ? runDaily : runOnPush;
  runner(options)
    .then((result) => {
      console.log(result.message);
      process.exit(0);
    })
    .catch((error) => {
      console.warn(`[write] 실행 실패: ${error.message}`);
      process.exit(0);
    });
}
