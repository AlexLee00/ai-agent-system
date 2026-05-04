#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../shared/db.ts';
import { getPosttradeFeedbackRuntimeConfig } from '../shared/runtime-config.ts';
import { buildHubLlmCallPayload, isDirectFallbackEnabled, isHubEnabled, isHubShadow } from '../shared/hub-llm-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const WORKER_PLIST = path.join(INVESTMENT_DIR, 'launchd', 'ai.luna.ops-scheduler.plist');
const HEARTBEAT_PATH = path.join(INVESTMENT_DIR, 'output', 'ops', 'posttrade-feedback-worker-heartbeat.json');

const REQUIRED_TABLES = [
  'trade_quality_evaluations',
  'trade_decision_attribution',
  'luna_failure_reflexions',
  'feedback_to_action_map',
  'luna_posttrade_skills',
];

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
  };
}

function okCheck(name: string, details: Record<string, unknown> = {}) {
  return { name, ok: true, ...details };
}

function warnCheck(name: string, reason: string, details: Record<string, unknown> = {}) {
  return { name, ok: true, warn: true, reason, ...details };
}

function failCheck(name: string, reason: string, details: Record<string, unknown> = {}) {
  return { name, ok: false, reason, ...details };
}

async function checkTables() {
  const rows = await db.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'investment'
        AND table_name = ANY($1::text[])`,
    [REQUIRED_TABLES],
  ).catch(() => []);
  const present = new Set((rows || []).map((row) => String(row.table_name)));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) return failCheck('posttrade_tables', 'missing_tables', { missing });
  return okCheck('posttrade_tables', { present: REQUIRED_TABLES });
}

async function checkBudgets(cfg: any) {
  const qualityRow = await db.get(
    `SELECT COUNT(*)::int AS cnt
       FROM investment.trade_quality_evaluations
      WHERE evaluated_at >= NOW()::date`,
    [],
  ).catch(() => ({ cnt: 0 }));
  const reflexionRow = await db.get(
    `SELECT COUNT(*)::int AS cnt
       FROM investment.luna_failure_reflexions
      WHERE created_at >= NOW()::date
        AND trade_id > 0
        AND COALESCE(avoid_pattern->>'source', '') <> 'failed-signal-reflexion-trigger'`,
    [],
  ).catch(() => ({ cnt: 0 }));
  const qualityUsed = Number(qualityRow?.cnt || 0) * 0.03;
  const reflexionUsed = Number(reflexionRow?.cnt || 0) * 0.04;
  const qualityBudget = Number(cfg?.trade_quality?.llm_daily_budget_usd || 5);
  const reflexionBudget = Number(cfg?.reflexion?.llm_daily_budget_usd || 3);
  const payload = {
    quality: { usedEstimateUsd: qualityUsed, budgetUsd: qualityBudget },
    reflexion: { usedEstimateUsd: reflexionUsed, budgetUsd: reflexionBudget },
  };
  const ok = qualityUsed <= qualityBudget && reflexionUsed <= reflexionBudget;
  return ok
    ? okCheck('posttrade_llm_budget', payload)
    : failCheck('posttrade_llm_budget', 'budget_exceeded', payload);
}

function checkWorkerPlist() {
  if (!fs.existsSync(WORKER_PLIST)) return failCheck('posttrade_worker_plist', 'plist_missing', { path: WORKER_PLIST });
  const text = fs.readFileSync(WORKER_PLIST, 'utf8');
  const required = [
    'ai.luna.ops-scheduler',
    'runtime-luna-ops-scheduler.ts',
  ];
  const missing = required.filter((needle) => !text.includes(needle));
  if (missing.length > 0) return failCheck('posttrade_worker_plist', 'plist_missing_markers', { missing, path: WORKER_PLIST });
  return okCheck('posttrade_worker_plist', { path: WORKER_PLIST });
}

function checkHeartbeat() {
  if (!fs.existsSync(HEARTBEAT_PATH)) {
    return warnCheck('posttrade_worker_heartbeat', 'heartbeat_missing_until_first_run', { path: HEARTBEAT_PATH });
  }
  const stat = fs.statSync(HEARTBEAT_PATH);
  const ageMinutes = Math.round((Date.now() - stat.mtimeMs) / 60000);
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf8'));
  } catch {
    return failCheck('posttrade_worker_heartbeat', 'heartbeat_json_invalid', { path: HEARTBEAT_PATH, ageMinutes });
  }
  const check = payload?.ok === true
    ? okCheck('posttrade_worker_heartbeat', { path: HEARTBEAT_PATH, ageMinutes, mode: payload.mode, market: payload.market })
    : failCheck('posttrade_worker_heartbeat', 'last_heartbeat_not_ok', { path: HEARTBEAT_PATH, ageMinutes, payload });
  if (ageMinutes > 1440 && check.ok) return warnCheck('posttrade_worker_heartbeat', 'heartbeat_stale', { path: HEARTBEAT_PATH, ageMinutes });
  return check;
}

function checkLlmRoute() {
  const payload = buildHubLlmCallPayload('luna', 'system', 'ping', {
    market: 'crypto',
    taskType: 'posttrade_feedback',
    maxTokens: 16,
  });
  const hubEnabled = isHubEnabled();
  const hubShadow = isHubShadow();
  const directFallback = isDirectFallbackEnabled();
  if (!hubEnabled && !hubShadow && !directFallback) {
    return failCheck('posttrade_llm_route', 'hub_and_direct_fallback_disabled', { hubEnabled, hubShadow, directFallback });
  }
  return okCheck('posttrade_llm_route', {
    hubEnabled,
    hubShadow,
    directFallback,
    selectorKey: payload.selectorKey,
    abstractModel: payload.abstractModel,
    taskType: payload.taskType,
  });
}

export async function buildPosttradeFeedbackDoctor({ strict = false } = {}) {
  await db.initSchema();
  const cfg = getPosttradeFeedbackRuntimeConfig();
  const checks = [
    await checkTables(),
    await checkBudgets(cfg),
    checkWorkerPlist(),
    checkHeartbeat(),
    checkLlmRoute(),
    okCheck('posttrade_kill_switches', {
      mode: cfg.mode,
      tradeQualityEnabled: cfg.trade_quality?.enabled === true,
      stageAttributionEnabled: cfg.stage_attribution?.enabled === true,
      reflexionEnabled: cfg.reflexion?.enabled === true,
      skillExtractionEnabled: cfg.skill_extraction?.enabled === true,
      dashboardEnabled: cfg.dashboard?.enabled === true,
      workerEnabled: cfg.worker?.enabled === true,
    }),
  ];
  const failures = checks.filter((item) => item.ok === false);
  const warnings = checks.filter((item) => item.warn === true);
  return {
    ok: failures.length === 0 && (!strict || warnings.length === 0),
    strict,
    generatedAt: new Date().toISOString(),
    failures,
    warnings,
    checks,
  };
}

async function main() {
  const args = parseArgs();
  const result = await buildPosttradeFeedbackDoctor({ strict: args.strict });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`posttrade doctor ${result.ok ? 'ok' : 'attention'} — failures=${result.failures.length} warnings=${result.warnings.length}`);
  }
  if (!result.ok) {
    throw new Error(`posttrade_doctor_failed failures=${result.failures.length} warnings=${result.warnings.length}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-doctor 실패:',
  });
}
