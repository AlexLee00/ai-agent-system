#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../shared/db.ts';
import { getPosttradeFeedbackRuntimeConfig } from '../shared/runtime-config.ts';
import { runPosttradeFeedback } from './runtime-posttrade-feedback.ts';
import { runPosttradeSkillExtraction } from './runtime-posttrade-skill-extraction.ts';
import { buildPosttradeFeedbackDashboard, recordPosttradeFeedbackDashboard } from './runtime-posttrade-feedback-dashboard.ts';
import { buildRuntimeCryptoSelfTune } from './runtime-crypto-self-tune.ts';
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

function resolveLearningDays(cfg: any, market: string) {
  const normalized = String(market || 'all').trim().toLowerCase();
  const cycle = cfg?.market_differentiated?.cycle_days || {};
  if (normalized === 'crypto') return Number(cycle.crypto || 3);
  if (normalized === 'domestic') return Number(cycle.domestic || 7);
  if (normalized === 'overseas') return Number(cycle.overseas || 7);
  return Math.max(
    Number(cycle.crypto || 3),
    Number(cycle.domestic || 7),
    Number(cycle.overseas || 7),
    14,
  );
}

async function runActionAutoApplyIfEnabled({
  cfg = {},
  dryRun = false,
  days = 14,
} = {}) {
  const enabled = cfg?.parameter_feedback_map?.auto_apply === true;
  if (!enabled) {
    return {
      ok: true,
      code: 'posttrade_action_auto_apply_disabled',
      enabled: false,
      applied: [],
      candidates: [],
      skippedByCooldown: [],
    };
  }
  if (dryRun) {
    return {
      ok: true,
      code: 'posttrade_action_auto_apply_dry_run',
      enabled: true,
      applied: [],
      candidates: [],
      skippedByCooldown: [],
    };
  }

  const preview = await buildRuntimeCryptoSelfTune({
    days,
    write: false,
    json: true,
  });
  const candidates = Array.isArray(preview?.candidates) ? preview.candidates : [];
  if (candidates.length === 0) {
    return {
      ok: true,
      code: 'posttrade_action_auto_apply_idle',
      enabled: true,
      status: preview?.status || 'crypto_self_tune_idle',
      candidates,
      skippedByCooldown: preview?.skippedByCooldown || [],
      applied: [],
      source: preview?.source || null,
    };
  }

  const applied = await buildRuntimeCryptoSelfTune({
    days,
    write: true,
    json: true,
  });
  return {
    ok: applied?.ok === true,
    code: applied?.status || 'posttrade_action_auto_apply_applied',
    enabled: true,
    status: applied?.status || null,
    candidates,
    applied: applied?.applied || [],
    skippedByCooldown: applied?.skippedByCooldown || [],
    savedId: applied?.savedId || null,
    source: applied?.source || null,
  };
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
    const learningDays = resolveLearningDays(cfg, args.market);
    const skillExtraction = (args.force || cfg?.skill_extraction?.enabled === true)
      ? await runPosttradeSkillExtraction({
          force: args.force,
          dryRun: args.dryRun,
          days: learningDays,
          market: args.market,
        }).catch((error) => ({
          ok: false,
          code: 'posttrade_skill_extraction_failed',
          error: String(error?.message || error || 'unknown'),
        }))
      : {
          ok: false,
          code: 'posttrade_skill_extraction_disabled',
        };
    const dashboard = (args.force || cfg?.dashboard?.enabled === true)
      ? await buildPosttradeFeedbackDashboard({
          days: learningDays,
          market: args.market,
        }).catch((error) => ({
          ok: false,
          code: 'posttrade_dashboard_failed',
          error: String(error?.message || error || 'unknown'),
        }))
      : {
          ok: false,
          code: 'posttrade_dashboard_disabled',
        };
    const dashboardRecord = dashboard?.ok === true && cfg?.dashboard?.enabled === true
      ? await recordPosttradeFeedbackDashboard(dashboard, { dryRun: args.dryRun }).catch((error) => ({
          ok: false,
          code: 'posttrade_dashboard_record_failed',
          error: String(error?.message || error || 'unknown'),
        }))
      : {
          ok: false,
          code: 'posttrade_dashboard_record_skipped',
        };
    const actionAutoApply = await runActionAutoApplyIfEnabled({
      cfg,
      dryRun: args.dryRun,
      days: learningDays,
    }).catch((error) => ({
      ok: false,
      code: 'posttrade_action_auto_apply_failed',
      enabled: cfg?.parameter_feedback_map?.auto_apply === true,
      error: String(error?.message || error || 'unknown'),
      applied: [],
      candidates: [],
      skippedByCooldown: [],
    }));
    const completedAt = new Date().toISOString();
    const payload = {
      ok: true,
      startedAt,
      completedAt,
      mode: cfg?.mode || 'shadow',
      market: args.market,
      result,
      learning: {
        days: learningDays,
        skillExtraction,
        dashboard,
        dashboardRecord,
        actionAutoApply,
      },
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
