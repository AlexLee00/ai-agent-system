// @ts-nocheck
'use strict';

const { postAlarm } = require('../../../../packages/core/lib/openclaw-client');
const trackerSync = require('./tracker-sync');
const codexManager = require('./codex-manager');
const gitHygiene = require('./git-hygiene');
const envSync = require('./env-sync-checker');
const launchdManager = require('./launchd-manager');
const telegramManager = require('./telegram-manager');
const kst = require('../../../../packages/core/lib/kst');

async function generateDailySummary() {
  const lines = [`📋 스튜어드 일일 요약 (${kst.today()})`];

  const codex = codexManager.summarize();
  lines.push('', `📝 코덱스: 활성 ${codex.active}개, 아카이브 ${codex.archived}개`);
  codex.names.slice(0, 5).forEach((name) => lines.push(`  · ${name}`));

  const commits = trackerSync.getRecentCommits(24);
  lines.push('', `🔨 최근 24시간 커밋: ${commits.length}건`);
  commits.slice(0, 5).forEach((commit) => lines.push(`  · ${commit.message.slice(0, 80)}`));

  const suspicious = gitHygiene.scanTracked();
  if (suspicious.length > 0) {
    lines.push('', `⚠️ git 위생: 의심 파일 ${suspicious.length}건`);
    suspicious.slice(0, 3).forEach((item) => lines.push(`  · ${item.file} (${item.reason})`));
  } else {
    lines.push('', '✅ git 위생: 깨끗');
  }

  const sync = envSync.checkSync();
  if (sync.synced === true) {
    lines.push('', `✅ 환경 동기화: ${sync.hostname} 최신 (${sync.local})`);
  } else if (sync.synced === false) {
    lines.push('', `⚠️ 환경 동기화: behind ${sync.behind}, ahead ${sync.ahead}`);
  } else {
    lines.push('', `❓ 환경 동기화: ${sync.reason}`);
  }

  const health = launchdManager.checkHealth();
  lines.push('', `🔧 launchd: ${health.total}개 서비스, ${health.running}개 실행 중`);
  if (health.unhealthy.length > 0) {
    lines.push(`  ⚠️ 비정상: ${health.unhealthy.slice(0, 8).map((item) => item.label).join(', ')}`);
  }

  const missingTopics = telegramManager.findMissingTopics();
  if (missingTopics.length > 0) {
    lines.push('', `⚠️ 텔레그램: 미설정 토픽 ${missingTopics.length}개 (${missingTopics.map((item) => item.team).join(', ')})`);
  } else {
    lines.push('', '✅ 텔레그램: 전체 토픽 정상');
  }

  const message = lines.join('\n').slice(0, 3900);
  await postAlarm({
    message,
    team: 'general',
    alertLevel: 1,
    fromBot: 'steward',
  });
  return message;
}

module.exports = { generateDailySummary };
