#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');

const trackerSync = require('../lib/steward/tracker-sync');
const codexManager = require('../lib/steward/codex-manager');
const sessionCloser = require('../lib/steward/session-closer');
const gitHygiene = require('../lib/steward/git-hygiene');
const envSync = require('../lib/steward/env-sync-checker');
const launchdManager = require('../lib/steward/launchd-manager');
const telegramManager = require('../lib/steward/telegram-manager');
const dailySummary = require('../lib/steward/daily-summary');
const readmeUpdater = require('../lib/steward/readme-updater');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const env = require('../../../packages/core/lib/env');

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

async function runWeekly() {
  console.log('[steward] 주간 모드 시작');
  const result = await readmeUpdater.updateReadme();
  const { stats } = result;

  console.log(`README stats: 에이전트 ${stats.agentCount}, launchd ${stats.launchdTotal}, 토픽 ${stats.topicCount}, 아카이브 ${stats.codexArchive}`);

  if (!result.changed) {
    console.log('  ℹ️ README 변경 없음 — 스킵');
    return { changed: false, stats, committed: false };
  }

  try {
    execFileSync('git', ['add', 'README.md'], {
      cwd: env.PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    execFileSync('git', ['commit', '-m', 'docs(auto): README stats update by write agent'], {
      cwd: env.PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    console.log('  ✅ README 변경 커밋 완료');
    return { changed: true, stats, committed: true };
  } catch (error) {
    console.warn(`  ⚠️ README 자동 커밋 실패: ${error.message}`);
    return { changed: true, stats, committed: false, error: error.message };
  }
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
  weekly: runWeekly,
  status: runStatus,
}[mode];

if (!runner) {
  console.error(`알 수 없는 모드: ${mode}. daily/hourly/session/weekly/status 중 선택`);
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
