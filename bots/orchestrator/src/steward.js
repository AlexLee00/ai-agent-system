#!/usr/bin/env node
'use strict';

const trackerSync = require('../lib/steward/tracker-sync');
const codexManager = require('../lib/steward/codex-manager');
const sessionCloser = require('../lib/steward/session-closer');
const gitHygiene = require('../lib/steward/git-hygiene');
const envSync = require('../lib/steward/env-sync-checker');
const launchdManager = require('../lib/steward/launchd-manager');
const telegramManager = require('../lib/steward/telegram-manager');
const dailySummary = require('../lib/steward/daily-summary');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

function parseArgs(argv = process.argv.slice(2)) {
  const modeArg = argv.find((arg) => arg.startsWith('--mode='));
  return { mode: modeArg ? modeArg.split('=')[1] : 'status' };
}

async function runDaily() {
  console.log('[steward] 일일 모드 시작');

  const moved = codexManager.archiveCompleted();
  const suspicious = gitHygiene.scanTracked();
  const commits = trackerSync.getRecentCommits(24);
  const drafted = trackerSync.appendToTracker(trackerSync.analyzeCommits(commits));
  const summary = await dailySummary.generateDailySummary();

  console.log(summary);
  return { moved, suspicious: suspicious.length, drafted, commits: commits.length };
}

async function runHourly() {
  console.log('[steward] 매시 모드 시작');
  const sync = envSync.checkSync();
  if (sync.synced === false && sync.behind > 0) {
    await postAlarm({
      message: `⚠️ [스튜어드] ${sync.hostname} 동기화 필요: origin/main보다 ${sync.behind}건 뒤처짐`,
      team: 'general',
      alertLevel: 2,
      fromBot: 'steward',
    });
  }
  return sync;
}

async function runSession() {
  console.log('[steward] 세션 종료 모드');
  return sessionCloser.generate();
}

function runStatus() {
  const codex = codexManager.summarize();
  const sync = envSync.checkSync();
  const health = launchdManager.checkHealth();
  const topics = telegramManager.listTopics();
  const suspicious = gitHygiene.scanTracked();

  console.log(`코덱스: 활성 ${codex.active}, 아카이브 ${codex.archived}`);
  console.log(`동기화: ${sync.synced === true ? '✅' : sync.synced === false ? '⚠️' : '❓'} ${sync.hostname || ''} ${sync.local || ''}`.trim());
  console.log(`launchd: ${health.total}서비스, ${health.running}실행`);
  console.log(`텔레그램: ${topics.filter((item) => item.configured).length}/${topics.length} 토픽`);
  console.log(`git 위생: ${suspicious.length}건 의심`);

  return { codex, sync, health, topics, suspicious };
}

const { mode } = parseArgs();
const runner = {
  daily: runDaily,
  hourly: runHourly,
  session: runSession,
  status: runStatus,
}[mode];

if (!runner) {
  console.error(`알 수 없는 모드: ${mode}. daily/hourly/session/status 중 선택`);
  process.exit(1);
}

Promise.resolve()
  .then(() => runner())
  .then((result) => {
    if (mode !== 'status') {
      console.log('결과:', JSON.stringify(result));
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error(`[steward] 실패: ${error.message}`);
    process.exit(1);
  });
