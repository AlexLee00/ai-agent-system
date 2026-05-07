#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { investmentOpsRuntimeFile } from '../shared/runtime-ops-path.ts';
import { runMarketCollectPipeline } from '../shared/pipeline-market-runner.ts';
import { buildLunaDecisionFilterReport } from './runtime-luna-decision-filter-report.ts';

const CONFIRM = 'luna-active-candidate-analysis-refresh';
const DEFAULT_STATE_PATH = investmentOpsRuntimeFile('luna-active-candidate-analysis-refresh-state.json');

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boolEnv(name, fallback = true, env = process.env) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
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

function normalizeMarket(market = 'crypto') {
  const normalized = String(market || 'crypto').toLowerCase();
  if (normalized === 'binance') return 'crypto';
  return normalized;
}

function defaultExchangeForMarket(market = 'crypto') {
  if (market === 'domestic') return 'kis';
  if (market === 'overseas') return 'kis_overseas';
  return 'binance';
}

export function buildActiveCandidateAnalysisRefreshPlan({
  report,
  state = {},
  now = new Date(),
  maxSymbols = 4,
  cooldownMinutes = 45,
  exchange = null,
} = {}) {
  const missing = [...new Set((report?.missingActiveCandidateSymbols || []).map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
  const cooldownMs = Math.max(1, Number(cooldownMinutes || 45)) * 60 * 1000;
  const attempts = state?.symbols || {};
  const selected = [];
  const skippedCooldown = [];
  const attemptKeyFor = (symbol) => exchange ? `${exchange}:${symbol}` : symbol;

  for (const symbol of missing) {
    const attempt = attempts?.[attemptKeyFor(symbol)] || attempts?.[symbol] || null;
    const lastAttemptAt = attempt?.lastAttemptAt || null;
    const ageMs = lastAttemptAt ? now.getTime() - new Date(lastAttemptAt).getTime() : Infinity;
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < cooldownMs) {
      skippedCooldown.push({
        symbol,
        lastAttemptAt,
        nextEligibleAt: new Date(new Date(lastAttemptAt).getTime() + cooldownMs).toISOString(),
      });
      continue;
    }
    if (selected.length < Math.max(1, Number(maxSymbols || 4))) selected.push(symbol);
  }

  return {
    ok: true,
    status: selected.length > 0 ? 'active_candidate_analysis_refresh_needed' : missing.length > 0 ? 'active_candidate_analysis_refresh_cooldown' : 'active_candidate_analysis_refresh_clear',
    missing,
    selected,
    skippedCooldown,
    maxSymbols: Math.max(1, Number(maxSymbols || 4)),
    cooldownMinutes: Math.max(1, Number(cooldownMinutes || 45)),
    nextAction: selected.length > 0
      ? 'collect_missing_active_candidate_analysis_without_decision_execution'
      : missing.length > 0
        ? 'wait_for_refresh_cooldown_or_regular_market_cycle'
        : 'continue_observation',
  };
}

function updateAttemptState(state = {}, symbols = [], result = {}, now = new Date(), { exchange = null } = {}) {
  const next = {
    ...(state || {}),
    updatedAt: now.toISOString(),
    symbols: { ...((state || {}).symbols || {}) },
  };
  for (const symbol of symbols || []) {
    const key = exchange ? `${exchange}:${symbol}` : symbol;
    next.symbols[key] = {
      symbol,
      exchange,
      lastAttemptAt: now.toISOString(),
      lastStatus: result?.ok === true ? 'ok' : 'failed',
      lastOutcome: result?.metrics?.collectQuality?.status || result?.status || null,
      lastSessionId: result?.sessionId || null,
    };
  }
  return next;
}

export async function runActiveCandidateAnalysisRefresh({
  market = 'crypto',
  exchange = null,
  hours = 24,
  limit = 20,
  maxSymbols = Number(process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_MAX_SYMBOLS || 4),
  cooldownMinutes = Number(process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_COOLDOWN_MINUTES || 45),
  enabled = boolEnv('LUNA_ACTIVE_CANDIDATE_REFRESH_ENABLED', true),
  apply = false,
  confirm = null,
  statePath = DEFAULT_STATE_PATH,
  reportBuilder = buildLunaDecisionFilterReport,
  collectRunner = runMarketCollectPipeline,
  now = new Date(),
} = {}) {
  const normalizedMarket = normalizeMarket(market);
  const resolvedExchange = exchange || defaultExchangeForMarket(normalizedMarket);
  if (!['crypto', 'domestic', 'overseas'].includes(normalizedMarket)) {
    return {
      ok: true,
      status: 'active_candidate_analysis_refresh_not_applicable',
      market: normalizedMarket,
      exchange: resolvedExchange,
      reason: 'unsupported_market_for_targeted_refresh',
    };
  }
  if (!enabled) {
    return {
      ok: true,
      status: 'active_candidate_analysis_refresh_disabled',
      market: normalizedMarket,
      exchange: resolvedExchange,
    };
  }

  const state = readJsonSafe(statePath, { symbols: {} });
  const report = await reportBuilder({
    market: normalizedMarket,
    exchange: resolvedExchange,
    activeCandidates: true,
    hours,
    limit,
  });
  const plan = buildActiveCandidateAnalysisRefreshPlan({
    report,
    state,
    now,
    maxSymbols,
    cooldownMinutes,
    exchange: resolvedExchange,
  });

  if (!apply) {
    return {
      ok: true,
      status: plan.status,
      dryRun: true,
      applied: false,
      market: normalizedMarket,
      exchange: resolvedExchange,
      statePath,
      plan,
      report: {
        status: report.status,
        activeCandidateCoverage: report.activeCandidateCoverage,
        bottlenecks: report.bottlenecks,
      },
      applyCommand: `node scripts/runtime-luna-active-candidate-analysis-refresh.ts --apply --confirm=${CONFIRM} --json`,
    };
  }

  if (confirm !== CONFIRM) {
    return {
      ok: false,
      status: 'active_candidate_analysis_refresh_confirm_required',
      dryRun: false,
      applied: false,
      confirmRequired: CONFIRM,
      plan,
    };
  }

  if (plan.selected.length === 0) {
    return {
      ok: true,
      status: plan.status,
      dryRun: false,
      applied: false,
      market: normalizedMarket,
      exchange: resolvedExchange,
      statePath,
      plan,
    };
  }

  const collect = await collectRunner({
    market: resolvedExchange,
    symbols: plan.selected,
    triggerType: 'active_candidate_analysis_refresh',
    meta: {
      market_script: 'active_candidate_analysis_refresh',
      collect_mode: 'active_candidate_analysis_refresh',
      decision_execution_skipped: true,
    },
    universeMeta: {
      screeningSymbolCount: plan.selected.length,
      activeCandidateRefresh: true,
    },
  });
  const nextState = updateAttemptState(state, plan.selected, collect, now, { exchange: resolvedExchange });
  writeJson(statePath, nextState);

  return {
    ok: Number(collect?.metrics?.failedHardCoreTasks || 0) === 0,
    status: 'active_candidate_analysis_refresh_collected',
    dryRun: false,
    applied: true,
    market: normalizedMarket,
    exchange: resolvedExchange,
    statePath,
    plan,
    collect: {
      sessionId: collect.sessionId,
      symbols: collect.symbols,
      summaries: collect.summaries,
      metrics: collect.metrics,
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const result = await runActiveCandidateAnalysisRefresh({
    market: argValue('market', 'crypto', argv),
    exchange: argValue('exchange', null, argv),
    hours: Math.max(1, Number(argValue('hours', 24, argv)) || 24),
    limit: Math.max(1, Number(argValue('limit', 20, argv)) || 20),
    maxSymbols: Math.max(1, Number(argValue('max-symbols', process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_MAX_SYMBOLS || 4, argv)) || 4),
    cooldownMinutes: Math.max(1, Number(argValue('cooldown-minutes', process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_COOLDOWN_MINUTES || 45, argv)) || 45),
    apply: hasArg('apply', argv),
    confirm: argValue('confirm', null, argv),
    statePath: argValue('state-path', DEFAULT_STATE_PATH, argv),
  });
  if (hasArg('json', argv)) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-active-candidate-analysis-refresh ${result.status}`);
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-active-candidate-analysis-refresh 실패:',
  });
}
