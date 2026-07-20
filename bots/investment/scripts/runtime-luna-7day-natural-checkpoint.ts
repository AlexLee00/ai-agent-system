#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getLunaOperatingEpoch } from '../shared/luna-operating-epoch.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(INVESTMENT_DIR, 'output', 'reports');
const DEFAULT_OBSERVATION_DAYS = 14;

function boolEnv(name, fallback = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return !['0', 'false', 'off', 'disabled', 'no'].includes(raw);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

export function isLuna7DayNaturalCheckpointEnabled() {
  return boolEnv('LUNA_7DAY_NATURAL_CHECKPOINT_ENABLED', true);
}

export function getNaturalTargets() {
  return {
    reflexions: Number(process.env.LUNA_7DAY_TARGET_REFLEXIONS || 1100) || 1100,
    skills: Number(process.env.LUNA_7DAY_TARGET_SKILLS || 50) || 50,
    rag: Number(process.env.LUNA_7DAY_TARGET_RAG || 500) || 500,
    agentMessages: Number(process.env.LUNA_7DAY_TARGET_AGENT_MESSAGES || 5000) || 5000,
  };
}

async function countRows(metric, sql, params = [], queryFn = db.get) {
  try {
    const row = await queryFn(sql, params);
    return { metric, count: Number(row?.cnt || 0), error: null };
  } catch (error) {
    return {
      metric,
      count: null,
      error: String(error?.message || error || 'query_failed'),
    };
  }
}

export async function collectNaturalCounts({
  lowerBoundSql = null,
  lowerBoundParams = [],
  queryFn = db.get,
} = {}) {
  const bound = lowerBoundSql ? `WHERE ${lowerBoundSql}` : '';
  const params = lowerBoundParams || [];
  const results = await Promise.all([
    countRows(
      'reflexions',
      `SELECT COUNT(*)::int AS cnt FROM investment.luna_failure_reflexions ${bound.replaceAll('{timestamp}', 'created_at')}`,
      params,
      queryFn,
    ),
    countRows(
      'skills',
      `SELECT COUNT(*)::int AS cnt FROM investment.luna_posttrade_skills ${bound.replaceAll('{timestamp}', 'updated_at')}`,
      params,
      queryFn,
    ),
    countRows(
      'rag',
      `SELECT COUNT(*)::int AS cnt FROM investment.luna_rag_documents ${bound.replaceAll('{timestamp}', 'created_at')}`,
      params,
      queryFn,
    ),
    countRows(
      'agentMessages',
      `SELECT COUNT(*)::int AS cnt FROM investment.agent_messages ${bound.replaceAll('{timestamp}', 'created_at')}`,
      params,
      queryFn,
    ),
  ]);
  return {
    ...Object.fromEntries(results.map((result) => [result.metric, result.count])),
    queryErrors: results
      .filter((result) => result.error)
      .map((result) => ({ metric: result.metric, error: result.error })),
  };
}

export async function collectNaturalAccumulation({
  days = DEFAULT_OBSERVATION_DAYS,
  queryFn = db.get,
} = {}) {
  const safeDays = Math.max(1, Math.round(Number(days || 7)));
  const epoch = getLunaOperatingEpoch();
  const rolling = await collectNaturalCounts({
    lowerBoundSql: `{timestamp} >= NOW() - ($1::int * INTERVAL '1 day')`,
    lowerBoundParams: [safeDays],
    queryFn,
  });
  const allTime = await collectNaturalCounts({ queryFn });
  const operatingEpoch = epoch.enabled && epoch.valid
    ? await collectNaturalCounts({
        lowerBoundSql: `{timestamp} >= $1::timestamptz`,
        lowerBoundParams: [epoch.startedAt],
        queryFn,
      })
    : null;
  const queryErrors = [
    ...(rolling.queryErrors || []).map((error) => ({ ...error, scope: 'rolling_window' })),
    ...(allTime.queryErrors || []).map((error) => ({ ...error, scope: 'all_time' })),
    ...(operatingEpoch?.queryErrors || []).map((error) => ({ ...error, scope: 'operating_epoch' })),
  ];
  return {
    days: safeDays,
    ...rolling,
    scope: 'rolling_window',
    epoch,
    allTime,
    operatingEpoch,
    queryErrors,
  };
}

export function buildNaturalCheckpoint({
  accumulation,
  targets = getNaturalTargets(),
  generatedAt = new Date().toISOString(),
}: {
  accumulation?: any;
  targets?: ReturnType<typeof getNaturalTargets>;
  generatedAt?: string;
} = {}) {
  const queryErrors = Array.isArray(accumulation?.queryErrors) ? accumulation.queryErrors : [];
  const currentValue = (name) => (
    accumulation?.[name] === null || accumulation?.[name] === undefined
      ? null
      : Number(accumulation[name])
  );
  const progress = {
    reflexions: {
      current: currentValue('reflexions'),
      target: Number(targets.reflexions || 0),
    },
    skills: {
      current: currentValue('skills'),
      target: Number(targets.skills || 0),
    },
    rag: {
      current: currentValue('rag'),
      target: Number(targets.rag || 0),
    },
    agentMessages: {
      current: currentValue('agentMessages'),
      target: Number(targets.agentMessages || 0),
    },
  };
  for (const item of Object.values(progress)) {
    item.ready = item.current !== null && item.current >= item.target;
    item.ratio = item.current === null ? null : (item.target > 0 ? Number((item.current / item.target).toFixed(4)) : 1);
    item.remaining = item.current === null ? null : Math.max(0, item.target - item.current);
  }
  const pendingObservation = Object.entries(progress)
    .filter(([, item]) => !item.ready)
    .map(([name, item]) => item.current === null ? `${name}:query_error` : `${name}:${item.current}/${item.target}`);
  const allTimeReady = accumulation?.allTime && (accumulation.allTime.queryErrors || []).length === 0
    ? Object.entries(targets).every(([name, target]) => Number(accumulation.allTime?.[name] || 0) >= Number(target || 0))
    : null;
  const operatingEpochReady = accumulation?.operatingEpoch && (accumulation.operatingEpoch.queryErrors || []).length === 0
    ? Object.entries(targets).every(([name, target]) => Number(accumulation.operatingEpoch?.[name] || 0) >= Number(target || 0))
    : null;
  const epochAgeHours = accumulation?.epoch?.enabled && accumulation?.epoch?.valid
    ? Math.max(0, (new Date(generatedAt).getTime() - new Date(accumulation.epoch.startedAt).getTime()) / 36e5)
    : null;
  const diagnostics = {
    scope: accumulation?.scope || 'rolling_window',
    allTimeReady,
    operatingEpochReady,
    epochAgeHours: Number.isFinite(epochAgeHours) ? Number(epochAgeHours.toFixed(2)) : null,
    developmentDataImpact: queryErrors.length === 0 && allTimeReady === true && pendingObservation.length > 0
      ? 'historical_or_development_data_is_not_sufficient_for_current_rolling_window'
      : null,
    operatingEpochImpact: queryErrors.length === 0 && accumulation?.epoch?.enabled && pendingObservation.length > 0
      ? 'operating_epoch_data_is_still_accumulating'
      : null,
  };
  return {
    ok: queryErrors.length === 0,
    status: queryErrors.length > 0
      ? 'query_error'
      : (pendingObservation.length === 0 ? 'natural_targets_met' : 'pending_natural_accumulation'),
    enabled: isLuna7DayNaturalCheckpointEnabled(),
    generatedAt,
    days: Number(accumulation?.days || 7),
    progress,
    targets,
    allTime: accumulation?.allTime || null,
    operatingEpoch: accumulation?.operatingEpoch || null,
    epoch: accumulation?.epoch || null,
    diagnostics,
    queryErrors,
    pendingObservation,
    nextActions: queryErrors.length > 0
      ? ['repair natural checkpoint read queries before evaluating accumulation progress']
      : pendingObservation.length === 0
      ? ['natural accumulation targets met; keep daily checkpoint active']
      : [
        'run failed-reflexion backfill dry-run, then apply only with explicit confirm if accepted',
        'run voyager natural acceleration dry-run; keep production writes behind confirm',
        'continue natural observation before marking operational natural-complete',
      ],
  };
}

export async function runLuna7DayNaturalCheckpoint({
  days = Number(process.env.LUNA_NATURAL_OBSERVATION_DAYS || DEFAULT_OBSERVATION_DAYS),
  write = false,
  outputDir = DEFAULT_OUTPUT_DIR,
  accumulation = null,
} = {}) {
  if (!isLuna7DayNaturalCheckpointEnabled()) {
    return {
      ok: false,
      status: 'disabled',
      enabled: false,
      generatedAt: new Date().toISOString(),
      days,
    };
  }
  const actual = accumulation || await collectNaturalAccumulation({ days });
  const report = buildNaturalCheckpoint({ accumulation: actual });
  if (write) {
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `luna-7day-natural-checkpoint-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
    return { ...report, outputPath };
  }
  return report;
}

export async function runLuna7DayNaturalCheckpointSmoke() {
  const pending = await runLuna7DayNaturalCheckpoint({
    accumulation: { days: 7, reflexions: 4, skills: 8, rag: 109, agentMessages: 412 },
  });
  if (pending.status !== 'pending_natural_accumulation' || pending.pendingObservation.length !== 4) {
    throw new Error('pending natural checkpoint contract failed');
  }
  const clear = await runLuna7DayNaturalCheckpoint({
    accumulation: { days: 7, reflexions: 1100, skills: 50, rag: 500, agentMessages: 5000 },
  });
  if (clear.status !== 'natural_targets_met' || clear.pendingObservation.length !== 0) {
    throw new Error('natural target clear contract failed');
  }
  return { ok: true, pending, clear };
}

async function main() {
  const result = hasArg('smoke')
    ? await runLuna7DayNaturalCheckpointSmoke()
    : await runLuna7DayNaturalCheckpoint({
      days: Number(argValue('days', process.env.LUNA_NATURAL_OBSERVATION_DAYS || DEFAULT_OBSERVATION_DAYS)),
      write: hasArg('write'),
    });
  if (hasArg('json') || hasArg('smoke')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-7day-natural-checkpoint] ${result.status}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-7day-natural-checkpoint 실패:',
  });
}
