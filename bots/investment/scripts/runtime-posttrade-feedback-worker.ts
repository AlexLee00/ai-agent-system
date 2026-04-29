#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../shared/db.ts';
import { getPosttradeFeedbackRuntimeConfig } from '../shared/runtime-config.ts';
import { runPosttradeFeedback } from './runtime-posttrade-feedback.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const DEFAULT_HEARTBEAT_PATH = path.join(INVESTMENT_DIR, 'output', 'ops', 'posttrade-feedback-worker-heartbeat.json');

function parseArgs(argv = process.argv.slice(2)) {
  const intervalRaw = argv.find((arg) => arg.startsWith('--interval-sec='))?.split('=')[1];
  const limitRaw = argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  const market = argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all';
  const heartbeatPath = argv.find((arg) => arg.startsWith('--heartbeat-path='))?.split('=')[1] || DEFAULT_HEARTBEAT_PATH;
  return {
    json: argv.includes('--json'),
    once: argv.includes('--once') || !argv.includes('--loop'),
    loop: argv.includes('--loop'),
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
    intervalSec: Math.max(10, Number(intervalRaw || 0) || 0),
    limit: Math.max(1, Number(limitRaw || 20) || 20),
    market: String(market).trim().toLowerCase() || 'all',
    heartbeatPath,
  };
}

function writeHeartbeat(filePath: string, payload: Record<string, unknown>) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPosttradeFeedbackWorker(input = {}) {
  const args = {
    ...parseArgs([]),
    ...(input || {}),
  };
  const cfg = getPosttradeFeedbackRuntimeConfig();
  if (!args.force && cfg?.worker?.enabled !== true) {
    return {
      ok: false,
      code: 'posttrade_worker_disabled',
      workerEnabled: cfg?.worker?.enabled === true,
      mode: cfg?.mode || 'shadow',
    };
  }

  await db.initSchema();
  const intervalSec = args.intervalSec || cfg?.worker?.interval_sec || 120;

  const runOnce = async () => {
    const startedAt = new Date().toISOString();
    const result = await runPosttradeFeedback({
      limit: args.limit,
      market: args.market,
      dryRun: args.dryRun,
      json: false,
      tradeId: null,
    });
    const completedAt = new Date().toISOString();
    const payload = {
      ok: true,
      startedAt,
      completedAt,
      mode: cfg?.mode || 'shadow',
      market: args.market,
      result,
    };
    writeHeartbeat(args.heartbeatPath, payload);
    return payload;
  };

  if (args.once || !args.loop) {
    return runOnce();
  }

  const history = [];
  while (true) {
    const runResult = await runOnce();
    history.push(runResult);
    if (history.length > 20) history.shift();
    await sleep(intervalSec * 1000);
  }
}

async function main() {
  const args = parseArgs();
  const result = await runPosttradeFeedbackWorker(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result?.ok) {
      console.log(`posttrade worker ok — market=${args.market} processed=${result?.result?.processed ?? 0} errors=${result?.result?.errors ?? 0}`);
    } else {
      console.log(`posttrade worker blocked — code=${result?.code || 'unknown'}`);
    }
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-worker 실패:',
  });
}

