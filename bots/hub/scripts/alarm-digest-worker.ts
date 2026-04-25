const { flushAlarmDigest } = require('../lib/routes/alarm.ts');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeIntervalMinutes() {
  const value = Math.max(1, Number(process.env.HUB_ALARM_DIGEST_INTERVAL_MINUTES || 10) || 10);
  return value;
}

function normalizeWindowMinutes() {
  return Math.max(5, Number(process.env.HUB_ALARM_DIGEST_WINDOW_MINUTES || 240) || 240);
}

function normalizeLimit() {
  return Math.min(1000, Math.max(10, Number(process.env.HUB_ALARM_DIGEST_LIMIT || 300) || 300));
}

async function main() {
  const intervalMinutes = normalizeIntervalMinutes();
  const windowMinutes = normalizeWindowMinutes();
  const limit = normalizeLimit();
  console.log(`[alarm-digest-worker] start interval=${intervalMinutes}m window=${windowMinutes}m limit=${limit}`);

  while (true) {
    try {
      const result = await flushAlarmDigest({
        minutes: windowMinutes,
        limit,
      });
      const sentTeams = (result.teams || []).filter((team) => team.sent === true).length;
      console.log(`[alarm-digest-worker] flush ok selected=${result.selected_count} sent_teams=${sentTeams}`);
    } catch (error) {
      console.error(`[alarm-digest-worker] flush failed: ${error?.message || error}`);
    }
    await sleep(intervalMinutes * 60 * 1000);
  }
}

main().catch((error) => {
  console.error('[alarm-digest-worker] fatal:', error?.message || error);
  process.exit(1);
});
