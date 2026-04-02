#!/usr/bin/env node
'use strict';

const path = require('path');
const { execSync } = require('child_process');

const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const kst = require('../../../packages/core/lib/kst');
const env = require('../../../packages/core/lib/env');
const aggregator = require('../lib/write/report-aggregator');
const docSyncChecker = require('../lib/write/doc-sync-checker');
const changelogWriter = require('../lib/write/changelog-writer');
const docArchiver = require('../lib/write/doc-archiver');

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

function formatPushReport(syncIssues, changelogEntry, archiveResult = {}, trackerResult = {}) {
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
  lines.push(`- 자동 아카이빙: ${(archiveResult.moved || []).length}건`);
  if ((archiveResult.moved || []).length > 0) {
    archiveResult.moved.forEach((file) => lines.push(`  · archive 이동: ${file}`));
    if (archiveResult.commitHash) lines.push(`  · commit: ${archiveResult.commitHash}`);
  }
  lines.push(`- TRACKER 자동 갱신: ${(trackerResult.added || []).length}건`);
  if ((trackerResult.added || []).length > 0) {
    trackerResult.added.forEach((file) => lines.push(`  · TRACKER 추가: ${file}`));
    if (trackerResult.commitHash) lines.push(`  · commit: ${trackerResult.commitHash}`);
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
  const completed = docArchiver.scanCompletedCodex();
  const untrackedFiles = docSyncChecker.findUntrackedFiles(changedFiles);
  const archiveResult = options.test ? { moved: completed.map((item) => item.file), commitHash: null } : docArchiver.archiveCompletedCodex(completed);
  const trackerResult = options.test ? { added: untrackedFiles.slice(0, 5), commitHash: null } : docArchiver.updateTracker(untrackedFiles);
  const message = formatPushReport(syncIssues, changelogEntry, archiveResult, trackerResult);
  const sent = options.test ? false : (await postAlarm({ message, team: 'general', alertLevel: 2, fromBot: 'write' })).ok;
  return { changedFiles, syncIssues, changelogEntry, archiveResult, trackerResult, sent, message };
}

async function runDaily(options = {}) {
  const collected = await aggregator.collectAll();
  const report = aggregator.formatDailyReport(collected);
  const commits = changelogWriter.generateEntry('yesterday');
  const messageLines = [
    report,
    '',
    '전일 커밋 요약:',
    changelogWriter.formatChangelogEntry(commits).slice(0, 1200),
  ];
  if (new Date().getDay() === 0) {
    const codexStatus = docArchiver.scanCompletedCodex();
    const staleDocs = docArchiver.scanStaleRootDocs();
    messageLines.push('', '주간 문서 정리 리포트:');
    messageLines.push(`- 완료 코덱스 프롬프트: ${codexStatus.length}건`);
    codexStatus.slice(0, 10).forEach((item) => {
      messageLines.push(`  · ${item.file} (${item.reason})`);
    });
    messageLines.push(`- 루트 문서 아카이브 후보: ${staleDocs.length}건`);
    staleDocs.slice(0, 10).forEach((item) => {
      messageLines.push(`  · ${item.file} (참조 ${item.refCount}회)`);
    });
  }
  const message = messageLines.join('\n');
  const sent = options.test ? false : (await postAlarm({ message, team: 'general', alertLevel: 2, fromBot: 'write' })).ok;
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
