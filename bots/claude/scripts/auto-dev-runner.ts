// @ts-nocheck
'use strict';

/**
 * scripts/auto-dev-runner.ts — docs/auto_dev 자동 구현 파이프라인 실행기
 */

process.env.PG_DIRECT = process.env.PG_DIRECT || 'true';

const pipeline = require('../lib/auto-dev-pipeline');
const { writeClaudeHeartbeat, errorHeartbeatMeta } = require('../lib/agent-heartbeat');

const args = process.argv.slice(2);
const once = args.includes('--once');
const test = args.includes('--test');
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const profileArg = args.find(arg => arg.startsWith('--profile='));
const profileIndex = args.indexOf('--profile');
const profile = profileArg
  ? profileArg.split('=').slice(1).join('=').trim()
  : profileIndex >= 0
    ? args[profileIndex + 1]
    : undefined;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeRunnerHeartbeat(status = 'ok', meta = {}) {
  await writeClaudeHeartbeat('auto-dev', status, {
    source: 'auto-dev-runner',
    ...meta,
  });
}

async function runOnce() {
  const result = await pipeline.runAutoDevPipeline({ once, test, dryRun, force, profile });
  console.log(JSON.stringify({
    ok: result.ok,
    profile: result.runtime?.profile,
    count: result.count,
    docs: result.results.map(item => ({
      ok: item.ok,
      skipped: item.skipped,
      relPath: item.job?.relPath,
      stage: item.job?.stage,
      error: item.error,
    })),
  }, null, 2));
  return result;
}

async function main() {
  const runtime = pipeline.resolveAutoDevRuntimeConfig({ profile, test, dryRun });
  await writeRunnerHeartbeat('ok', {
    stage: 'runtime_resolved',
    profile: runtime.profile,
    enabled: runtime.enabled,
    hardDisabled: runtime.hardDisabled,
  });
  if (runtime.hardDisabled) {
    console.log(`[auto-dev] Hard Kill Switch ON — ${runtime.disabledReason || 'CLAUDE_AUTO_DEV_DISABLED'}`);
    await writeRunnerHeartbeat('ok', {
      stage: 'hard_disabled',
      profile: runtime.profile,
      disabledReason: runtime.disabledReason || 'CLAUDE_AUTO_DEV_DISABLED',
    });
    return;
  }
  const enabled = runtime.enabled || once || test;
  if (!enabled) {
    console.log(`[auto-dev] Kill Switch OFF — CLAUDE_AUTO_DEV_PROFILE=${runtime.profile} enabled=false`);
    await writeRunnerHeartbeat('ok', {
      stage: 'disabled_idle',
      profile: runtime.profile,
    });
    if (process.env.CLAUDE_AUTO_DEV_DISABLED_IDLE === 'true') {
      const idleMs = Number(process.env.CLAUDE_AUTO_DEV_DISABLED_IDLE_MS || 10 * 60 * 1000);
      while (true) {
        await writeRunnerHeartbeat('ok', {
          stage: 'disabled_idle',
          profile: runtime.profile,
        });
        await sleep(idleMs);
      }
    }
    return;
  }

  if (once || test) {
    const result = await runOnce();
    process.exit(result.ok ? 0 : 1);
  }

  const intervalMs = Number(process.env.CLAUDE_AUTO_DEV_INTERVAL_MS || 5 * 60 * 1000);
  console.log(`[auto-dev] 시작 — docs/auto_dev 감시 (${intervalMs}ms, profile=${runtime.profile})`);

  while (true) {
    await writeRunnerHeartbeat('ok', {
      stage: 'polling',
      profile: runtime.profile,
    });
    const result = await runOnce();
    await writeRunnerHeartbeat(result.ok ? 'ok' : 'error', {
      stage: 'cycle_complete',
      profile: runtime.profile,
      count: result.count,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
    });
    await sleep(intervalMs);
  }
}

main().catch(error => {
  console.error('[auto-dev] Fatal:', error.message);
  writeRunnerHeartbeat('error', errorHeartbeatMeta(error, { stage: 'fatal' }))
    .finally(() => process.exit(1));
});
