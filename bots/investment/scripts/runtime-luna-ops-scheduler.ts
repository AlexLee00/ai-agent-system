#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const DEFAULT_STATE_PATH = path.join(INVESTMENT_DIR, 'output', 'ops', 'luna-ops-scheduler-state.json');
const DEFAULT_LOCK_PATH = path.join(INVESTMENT_DIR, 'output', 'ops', 'luna-ops-scheduler.lock');
const LOCK_STALE_MS = 20 * 60 * 1000;

function nodeScript(script, args = []) {
  return {
    command: process.execPath,
    args: [path.join(INVESTMENT_DIR, 'scripts', script), ...args],
  };
}

export function getOpsSchedulerJobs() {
  return [
    {
      name: 'market_regime_capture',
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('capture-market-regimes.ts', ['--markets=binance,kis,kis_overseas', '--json']),
    },
    {
      name: 'discovery_candidate_refresh',
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('runtime-discovery-orchestrator-refresh.ts', [
        '--markets=crypto,domestic,overseas',
        '--json',
      ]),
    },
    {
      name: 'discovery_funnel_report',
      cadence: { type: 'interval', seconds: 1800 },
      ...nodeScript('runtime-luna-discovery-funnel-report.ts', ['--hours=24', '--json']),
    },
    {
      name: 'daily_backtest',
      cadence: { type: 'daily', hour: 1, minute: 10 },
      ...nodeScript('runtime-luna-daily-backtest.ts', ['--json', '--dry-run']),
    },
    {
      name: 'guardrails_hourly',
      cadence: { type: 'interval', seconds: 3600 },
      ...nodeScript('runtime-luna-guardrails-hourly.ts', ['--json']),
    },
    {
      name: 'natural_7day_checkpoint',
      cadence: { type: 'interval', seconds: 86400 },
      ...nodeScript('runtime-luna-7day-natural-checkpoint.ts', ['--write', '--json']),
    },
    {
      name: 'trade_journal_dashboard',
      cadence: { type: 'interval', seconds: 3600 },
      ...nodeScript('runtime-trade-journal-dashboard-html.ts', ['--json']),
    },
    {
      name: 'voyager_skill_acceleration',
      cadence: { type: 'interval', seconds: 3600 },
      ...nodeScript('runtime-voyager-natural-acceleration.ts', ['--json']),
    },
    {
      name: 'reconcile_auto_settle',
      cadence: { type: 'interval', seconds: 300 },
      ...nodeScript('runtime-luna-reconcile-auto-settle.ts', [
        '--apply',
        '--confirm=luna-reconcile-auto-settle',
        '--json',
      ]),
    },
  ];
}

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function sameLocalDate(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function dailyDue(cadence, now, lastRunAt) {
  const scheduled = new Date(now);
  scheduled.setHours(Number(cadence.hour || 0), Number(cadence.minute || 0), 0, 0);
  if (now < scheduled) return false;
  if (!lastRunAt) return true;
  const last = new Date(lastRunAt);
  return !sameLocalDate(last, now);
}

function intervalDue(cadence, now, lastRunAt) {
  if (!lastRunAt) return true;
  const elapsedMs = now.getTime() - new Date(lastRunAt).getTime();
  return elapsedMs >= Number(cadence.seconds || 0) * 1000;
}

function isJobDue(job, now, state, force = false) {
  if (force) return true;
  const lastRunAt = state?.jobs?.[job.name]?.lastRunAt || null;
  if (job.cadence?.type === 'daily') return dailyDue(job.cadence, now, lastRunAt);
  return intervalDue(job.cadence || {}, now, lastRunAt);
}

export function buildOpsSchedulerPlan({
  now = new Date(),
  state = {},
  jobs = getOpsSchedulerJobs(),
  onlyJob = null,
  force = false,
} = {}) {
  const selected = jobs.filter((job) => !onlyJob || job.name === onlyJob);
  const plannedJobs = selected.map((job) => ({
    name: job.name,
    cadence: job.cadence,
    due: isJobDue(job, now, state, force),
    command: [job.command, ...(job.args || [])].join(' '),
    lastRunAt: state?.jobs?.[job.name]?.lastRunAt || null,
  }));
  return {
    ok: true,
    generatedAt: now.toISOString(),
    force,
    onlyJob,
    total: plannedJobs.length,
    due: plannedJobs.filter((job) => job.due).length,
    jobs: plannedJobs,
  };
}

function acquireLock(lockPath, now = new Date()) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (fs.existsSync(lockPath)) {
    const current = readJsonSafe(lockPath, {});
    const lockedAt = current.lockedAt ? new Date(current.lockedAt).getTime() : 0;
    if (lockedAt && now.getTime() - lockedAt < LOCK_STALE_MS) {
      return { ok: false, status: 'locked', lockPath, current };
    }
  }
  writeJson(lockPath, { lockedAt: now.toISOString(), pid: process.pid });
  return { ok: true, lockPath };
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // best effort cleanup
  }
}

function runCommand(job, { timeoutMs = 10 * 60 * 1000, runner = null } = {}) {
  if (runner) return runner(job);
  const result = spawnSync(job.command, job.args || [], {
    cwd: INVESTMENT_DIR,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    stdoutTail: String(result.stdout || '').slice(-2000),
    stderrTail: String(result.stderr || '').slice(-2000),
    error: result.error?.message || null,
  };
}

export async function runOpsScheduler({
  dryRun = false,
  force = false,
  onlyJob = null,
  statePath = DEFAULT_STATE_PATH,
  lockPath = DEFAULT_LOCK_PATH,
  writeState = true,
  now = new Date(),
  runner = null,
  jobs = getOpsSchedulerJobs(),
} = {}) {
  if (String(process.env.LUNA_OPS_SCHEDULER_ENABLED || 'true').toLowerCase() === 'false') {
    return { ok: true, status: 'disabled', dryRun, generatedAt: now.toISOString(), executed: [] };
  }

  const lock = dryRun ? { ok: true, dryRun: true } : acquireLock(lockPath, now);
  if (!lock.ok) return { ok: false, status: lock.status, dryRun, lockPath, executed: [] };

  try {
    const state = readJsonSafe(statePath, { jobs: {} });
    const plan = buildOpsSchedulerPlan({ now, state, jobs, onlyJob, force });
    const dueJobs = jobs.filter((job) => plan.jobs.find((item) => item.name === job.name && item.due));
    const executed = [];
    const nextState = { ...state, jobs: { ...(state.jobs || {}) } };

    for (const job of dueJobs) {
      if (dryRun) {
        executed.push({ name: job.name, dryRun: true, planned: true, ok: true });
        continue;
      }
      const startedAt = new Date().toISOString();
      const result = runCommand(job, { runner });
      const finishedAt = new Date().toISOString();
      executed.push({ name: job.name, dryRun: false, startedAt, finishedAt, ...result });
      if (result.ok && writeState) {
        nextState.jobs[job.name] = {
          lastRunAt: now.toISOString(),
          lastStatus: 'ok',
          updatedAt: finishedAt,
        };
      }
    }

    if (!dryRun && writeState) {
      nextState.updatedAt = new Date().toISOString();
      writeJson(statePath, nextState);
    }

    return {
      ok: executed.every((item) => item.ok),
      status: dryRun ? 'planned' : 'executed',
      dryRun,
      statePath,
      plan,
      executed,
    };
  } finally {
    if (!dryRun) releaseLock(lockPath);
  }
}

export function seedOpsSchedulerState({
  statePath = DEFAULT_STATE_PATH,
  now = new Date(),
  jobs = getOpsSchedulerJobs(),
} = {}) {
  const state = {
    seededAt: now.toISOString(),
    updatedAt: now.toISOString(),
    jobs: Object.fromEntries(jobs.map((job) => [job.name, {
      lastRunAt: now.toISOString(),
      lastStatus: 'seeded',
      updatedAt: now.toISOString(),
    }])),
  };
  writeJson(statePath, state);
  return {
    ok: true,
    status: 'seeded',
    statePath,
    seededAt: state.seededAt,
    jobs: jobs.map((job) => job.name),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasArg('seed-state', argv)) {
    const result = seedOpsSchedulerState({
      statePath: argValue('state-path', DEFAULT_STATE_PATH, argv),
    });
    if (hasArg('json', argv)) console.log(JSON.stringify(result, null, 2));
    else console.log(`runtime-luna-ops-scheduler seeded jobs=${result.jobs.length}`);
    return;
  }
  const result = await runOpsScheduler({
    dryRun: hasArg('dry-run', argv),
    force: hasArg('force', argv),
    onlyJob: argValue('job', null, argv),
    statePath: argValue('state-path', DEFAULT_STATE_PATH, argv),
    lockPath: argValue('lock-path', DEFAULT_LOCK_PATH, argv),
    writeState: !hasArg('no-write-state', argv),
  });
  if (hasArg('json', argv)) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-ops-scheduler ${result.status} due=${result.plan?.due || 0} executed=${result.executed?.length || 0}`);
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-ops-scheduler 실패:' });
}
