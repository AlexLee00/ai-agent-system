#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(INVESTMENT_DIR, 'output', 'reports');

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

async function countRows(sql, params = []) {
  const row = await db.get(sql, params).catch(() => null);
  return Number(row?.cnt || 0);
}

export async function collectNaturalAccumulation({ days = 7 } = {}) {
  const safeDays = Math.max(1, Math.round(Number(days || 7)));
  const [reflexions, skills, rag, agentMessages] = await Promise.all([
    countRows(
      `SELECT COUNT(*)::int AS cnt FROM investment.luna_failure_reflexions
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
      [safeDays],
    ),
    countRows(
      `SELECT COUNT(*)::int AS cnt FROM investment.luna_posttrade_skills
       WHERE updated_at >= NOW() - ($1::int * INTERVAL '1 day')`,
      [safeDays],
    ),
    countRows(
      `SELECT COUNT(*)::int AS cnt FROM investment.luna_rag_documents
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
      [safeDays],
    ),
    countRows(
      `SELECT COUNT(*)::int AS cnt FROM investment.agent_messages
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
      [safeDays],
    ),
  ]);
  return { days: safeDays, reflexions, skills, rag, agentMessages };
}

export function buildNaturalCheckpoint({
  accumulation,
  targets = getNaturalTargets(),
  generatedAt = new Date().toISOString(),
} = {}) {
  const progress = {
    reflexions: {
      current: Number(accumulation?.reflexions || 0),
      target: Number(targets.reflexions || 0),
    },
    skills: {
      current: Number(accumulation?.skills || 0),
      target: Number(targets.skills || 0),
    },
    rag: {
      current: Number(accumulation?.rag || 0),
      target: Number(targets.rag || 0),
    },
    agentMessages: {
      current: Number(accumulation?.agentMessages || 0),
      target: Number(targets.agentMessages || 0),
    },
  };
  for (const item of Object.values(progress)) {
    item.ready = item.current >= item.target;
    item.ratio = item.target > 0 ? Number((item.current / item.target).toFixed(4)) : 1;
    item.remaining = Math.max(0, item.target - item.current);
  }
  const pendingObservation = Object.entries(progress)
    .filter(([, item]) => !item.ready)
    .map(([name, item]) => `${name}:${item.current}/${item.target}`);
  return {
    ok: true,
    status: pendingObservation.length === 0 ? 'natural_targets_met' : 'pending_natural_accumulation',
    enabled: isLuna7DayNaturalCheckpointEnabled(),
    generatedAt,
    days: Number(accumulation?.days || 7),
    progress,
    pendingObservation,
    nextActions: pendingObservation.length === 0
      ? ['natural accumulation targets met; keep daily checkpoint active']
      : [
        'run failed-reflexion backfill dry-run, then apply only with explicit confirm if accepted',
        'run voyager natural acceleration dry-run; keep production writes behind confirm',
        'continue 7-day natural observation before marking operational natural-complete',
      ],
  };
}

export async function runLuna7DayNaturalCheckpoint({
  days = 7,
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
      days: Number(argValue('days', 7)),
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
