#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildStockIntradayLlmPolicyMeta } from '../shared/stock-intraday-llm-policy.ts';
import { runMarketCollectPipeline } from '../shared/pipeline-market-runner.ts';
import { runDecisionExecutionPipeline } from '../shared/pipeline-decision-runner.ts';
import { inspectDecisionLlmBudgetForSymbols } from '../shared/pipeline-decision-llm-budget.ts';
import { query } from '../shared/db.ts';
import { expireActiveEntryTriggersForSymbols } from '../shared/luna-discovery-entry-store.ts';
import { buildLunaNearMissWatchlist } from './runtime-luna-near-miss-watchlist.ts';

const CONFIRM = 'luna-relaxed-probe-runner';
const DEFAULT_MARKET = 'crypto';
const DEFAULT_HOURS = 24;
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_SYMBOLS = 1;
const DEFAULT_RECENT_TRADE_COOLDOWN_HOURS = 6;
const DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS = 1;
const DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES = 120;

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function normalizeMarket(market = DEFAULT_MARKET) {
  const normalized = String(market || DEFAULT_MARKET).trim().toLowerCase();
  if (normalized === 'binance') return 'crypto';
  return normalized;
}

function defaultExchangeForMarket(market = DEFAULT_MARKET) {
  if (market === 'domestic') return 'kis';
  if (market === 'overseas') return 'kis_overseas';
  return 'binance';
}

function isRunnableRelaxedProbe(item = {}) {
  return item?.readiness === 'relaxed_probe_watch'
    && item?.nextAction === 'run_l13_probe_with_existing_risk_and_entry_guards';
}

function getRecentTradeCooldownHours(env = process.env) {
  const value = Number(env?.LUNA_RELAXED_PROBE_RECENT_TRADE_COOLDOWN_HOURS);
  if (Number.isFinite(value) && value >= 0) return value;
  return DEFAULT_RECENT_TRADE_COOLDOWN_HOURS;
}

async function loadRecentTradeCooldowns({ exchange, symbols = [], hours = DEFAULT_RECENT_TRADE_COOLDOWN_HOURS } = {}) {
  const cleanSymbols = [...new Set((symbols || []).map((item) => String(item || '').trim()).filter(Boolean))];
  const lookbackHours = Number(hours);
  if (cleanSymbols.length === 0 || !Number.isFinite(lookbackHours) || lookbackHours <= 0) return new Map();
  const placeholders = cleanSymbols.map(() => '?').join(',');
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const rows = await query(
    `SELECT symbol, action, status, created_at
     FROM signals
     WHERE exchange = ?
       AND symbol IN (${placeholders})
       AND status = 'executed'
       AND action IN ('BUY', 'SELL')
       AND created_at >= ?
     ORDER BY created_at DESC`,
    [exchange, ...cleanSymbols, since],
  ).catch(() => []);
  const bySymbol = new Map();
  for (const row of rows || []) {
    const symbol = String(row?.symbol || '').trim();
    if (!symbol || bySymbol.has(symbol)) continue;
    bySymbol.set(symbol, row);
  }
  return bySymbol;
}

function normalizeCooldownMap(value) {
  if (value instanceof Map) return value;
  if (Array.isArray(value)) {
    return new Map(value.map((item) => [String(item?.symbol || '').trim(), item]).filter(([symbol]) => symbol));
  }
  if (value && typeof value === 'object') return new Map(Object.entries(value));
  return new Map();
}

function applyRecentTradeCooldown(plan = {}, cooldownsInput = new Map(), cooldownHours = DEFAULT_RECENT_TRADE_COOLDOWN_HOURS) {
  const cooldowns = normalizeCooldownMap(cooldownsInput);
  if (cooldowns.size === 0) return plan;
  const selected = [];
  const cooldownSkipped = [];
  for (const item of plan.selected || []) {
    const symbol = String(item?.symbol || '').trim();
    const cooldown = cooldowns.get(symbol);
    if (!cooldown) {
      selected.push(item);
      continue;
    }
    cooldownSkipped.push({
      symbol,
      readiness: item.readiness || null,
      nextAction: item.nextAction || null,
      reason: 'recent_executed_trade_cooldown',
      cooldownHours,
      lastAction: cooldown.action || null,
      lastStatus: cooldown.status || null,
      lastCreatedAt: cooldown.created_at || null,
    });
  }
  return {
    ...plan,
    status: selected.length > 0 ? 'relaxed_probe_l13_ready' : 'relaxed_probe_l13_clear',
    selected,
    selectedSymbols: selected.map((item) => item.symbol).filter(Boolean),
    skipped: [
      ...(plan.skipped || []),
      ...cooldownSkipped,
    ],
    recentTradeCooldown: {
      enabled: true,
      hours: cooldownHours,
      skipped: cooldownSkipped.length,
    },
  };
}

function applyDecisionLlmCooldown(plan = {}, budgetInspection = {}) {
  const cooldowns = new Map((budgetInspection?.symbols || [])
    .filter((item) => item?.allowed === false)
    .map((item) => [String(item.symbol || '').trim(), item]));
  if (cooldowns.size === 0) {
    return {
      ...plan,
      decisionLlmBudget: budgetInspection || null,
    };
  }
  const selected = [];
  const cooldownSkipped = [];
  for (const item of plan.selected || []) {
    const symbol = String(item?.symbol || '').trim();
    const cooldown = cooldowns.get(symbol);
    if (!cooldown) {
      selected.push(item);
      continue;
    }
    cooldownSkipped.push({
      symbol,
      readiness: item.readiness || null,
      nextAction: item.nextAction || null,
      reason: 'decision_llm_symbol_cooldown',
      lastAllowedAt: cooldown.lastAllowedAt || null,
      nextEligibleAt: cooldown.nextEligibleAt || null,
      cooldownMinutes: cooldown.cooldownMinutes ?? null,
    });
  }
  return {
    ...plan,
    status: selected.length > 0 ? 'relaxed_probe_l13_ready' : 'relaxed_probe_l13_clear',
    selected,
    selectedSymbols: selected.map((item) => item.symbol).filter(Boolean),
    skipped: [
      ...(plan.skipped || []),
      ...cooldownSkipped,
    ],
    decisionLlmBudget: {
      ...(budgetInspection || {}),
      skipped: cooldownSkipped.length,
    },
  };
}

function buildCollectNodeIds({ exchange, plan = {} } = {}) {
  const nodeIds = new Set(['L06', 'L02']);
  for (const item of plan.selected || []) {
    const missing = new Set(Array.isArray(item?.missingConfirmations) ? item.missingConfirmations : []);
    if (missing.has('sentiment')) nodeIds.add('L03');
    if (exchange === 'binance' && missing.has('onchain')) nodeIds.add('L05');
    if ((exchange === 'kis' || exchange === 'kis_overseas') && missing.has('market_flow')) nodeIds.add('L04');
  }
  return [...nodeIds];
}

function buildTargetedEnrichmentNodeIds(nodeIds = []) {
  return (nodeIds || []).filter((nodeId) => !['L06', 'L02'].includes(nodeId));
}

function buildCollectMeta({ exchange, symbols, plan = {}, reason = 'relaxed_probe_l13' } = {}) {
  const nodeIds = buildCollectNodeIds({ exchange, plan });
  const targetedNodeIds = buildTargetedEnrichmentNodeIds(nodeIds);
  const hasTargetedEnrichment = targetedNodeIds.length > 0;
  const collectNodeIds = hasTargetedEnrichment ? targetedNodeIds : nodeIds;
  const targetedMaxSymbols = Math.max(1, Math.min(DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS, Number(symbols?.length || 1)));
  return buildStockIntradayLlmPolicyMeta({
    market: exchange,
    marketScript: 'luna_relaxed_probe_runner',
    collectMode: 'relaxed_probe_l13_collect',
    lightCollectMode: 'relaxed_probe_l13_light',
    extraMeta: {
      relaxed_probe_runner: true,
      decision_execution_skipped: false,
      manualUniverseMode: 'explicit_symbols',
      disableDiscoveryExpansion: true,
      collect_reason: reason,
      targeted_enrichment: hasTargetedEnrichment,
      llm_call_policy: {
        source_enrichment: hasTargetedEnrichment ? 'targeted_top_n_only' : 'technical_first_only',
        relaxed_probe_runner: true,
        max_symbols: symbols.length,
        targeted_enrichment_nodes: hasTargetedEnrichment ? targetedNodeIds : [],
        targeted_enrichment_max_symbols: hasTargetedEnrichment ? targetedMaxSymbols : null,
        targeted_enrichment_cooldown_minutes: hasTargetedEnrichment ? DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES : null,
      },
      agentPlan: {
        collect: {
          nodeIds: collectNodeIds,
          concurrencyLimit: Math.min(3, Math.max(1, collectNodeIds.length)),
        },
      },
    },
  });
}

function buildRelaxedProbeContext(plan = {}) {
  const bySymbol = {};
  for (const item of plan.selected || []) {
    const symbol = String(item?.symbol || '').trim();
    if (!symbol) continue;
    bySymbol[symbol] = {
      source: 'near_miss_watchlist',
      watchReason: item.watchReason || item.relaxation?.reason || null,
      readiness: item.readiness || null,
      nextAction: item.nextAction || null,
      missingConfirmations: Array.isArray(item.missingConfirmations) ? item.missingConfirmations : [],
      relaxation: item.relaxation || null,
      fused: item.fused || null,
      dailyTechnical: item.dailyTechnical || item.dailyTechnicalCoverage || null,
    };
  }
  return {
    source: 'near_miss_watchlist',
    bySymbol,
  };
}

export function buildLunaRelaxedProbeRunnerPlan(watchlistReport = {}, { maxSymbols = DEFAULT_MAX_SYMBOLS } = {}) {
  const runnable = (watchlistReport.watchlist || [])
    .filter(isRunnableRelaxedProbe)
    .slice(0, Math.max(1, Number(maxSymbols || DEFAULT_MAX_SYMBOLS)));
  const skipped = (watchlistReport.watchlist || [])
    .filter((item) => !isRunnableRelaxedProbe(item))
    .map((item) => ({
      symbol: item.symbol || null,
      readiness: item.readiness || null,
      nextAction: item.nextAction || null,
      reason: 'not_relaxed_l13_probe',
    }));
  return {
    ok: true,
    status: runnable.length > 0 ? 'relaxed_probe_l13_ready' : 'relaxed_probe_l13_clear',
    selected: runnable,
    selectedSymbols: runnable.map((item) => item.symbol).filter(Boolean),
    skipped,
    maxSymbols: Math.max(1, Number(maxSymbols || DEFAULT_MAX_SYMBOLS)),
    sourceStatus: watchlistReport.status || null,
    sourceSummary: watchlistReport.summary || null,
  };
}

export async function runLunaRelaxedProbeRunner({
  market = DEFAULT_MARKET,
  exchange = null,
  hours = DEFAULT_HOURS,
  limit = DEFAULT_LIMIT,
  maxSymbols = DEFAULT_MAX_SYMBOLS,
  apply = false,
  confirm = null,
  watchlistBuilder = buildLunaNearMissWatchlist,
  recentTradeCooldownLoader = loadRecentTradeCooldowns,
  decisionBudgetInspector = inspectDecisionLlmBudgetForSymbols,
  expireCooldownTriggers = expireActiveEntryTriggersForSymbols,
  collectRunner = runMarketCollectPipeline,
  decisionRunner = runDecisionExecutionPipeline,
} = {}) {
  const normalizedMarket = normalizeMarket(market);
  const resolvedExchange = exchange || defaultExchangeForMarket(normalizedMarket);
  const watchlist = await watchlistBuilder({
    market: normalizedMarket,
    exchange: resolvedExchange,
    hours,
    limit,
  });
  const initialPlan = buildLunaRelaxedProbeRunnerPlan(watchlist, { maxSymbols });
  const cooldownHours = getRecentTradeCooldownHours();
  const cooldowns = await recentTradeCooldownLoader({
    exchange: resolvedExchange,
    symbols: initialPlan.selectedSymbols,
    hours: cooldownHours,
  });
  const plan = applyRecentTradeCooldown(initialPlan, cooldowns, cooldownHours);
  const decisionBudget = decisionBudgetInspector
    ? await decisionBudgetInspector({
        exchange: resolvedExchange,
        symbols: plan.selectedSymbols,
      })
    : null;
  const finalPlan = applyDecisionLlmCooldown(plan, decisionBudget);

  if (!apply) {
    return {
      ok: true,
      status: finalPlan.status,
      dryRun: true,
      applied: false,
      market: normalizedMarket,
      exchange: resolvedExchange,
      hours,
      limit,
      plan: finalPlan,
      applyCommand: `node scripts/runtime-luna-relaxed-probe-runner.ts --apply --confirm=${CONFIRM} --json`,
    };
  }

  if (confirm !== CONFIRM) {
    return {
      ok: false,
      status: 'relaxed_probe_l13_confirm_required',
      dryRun: false,
      applied: false,
      market: normalizedMarket,
      exchange: resolvedExchange,
      confirmRequired: CONFIRM,
      plan: finalPlan,
    };
  }

  let expiredCooldownTriggers = null;
  const cooldownSkippedSymbols = (finalPlan.skipped || [])
    .filter((item) => item?.reason === 'recent_executed_trade_cooldown')
    .map((item) => item.symbol)
    .filter(Boolean);
  if (cooldownSkippedSymbols.length > 0) {
    expiredCooldownTriggers = await expireCooldownTriggers({
      symbols: cooldownSkippedSymbols,
      exchange: resolvedExchange,
      reason: 'recent_executed_trade_cooldown',
      triggerMetaPatch: {
        source: 'runtime-luna-relaxed-probe-runner',
        cooldownHours,
      },
    }).catch((error) => ({
      count: 0,
      symbols: [],
      error: error?.message || String(error),
    }));
  }

  if (finalPlan.selectedSymbols.length === 0) {
    return {
      ok: true,
      status: finalPlan.status,
      dryRun: false,
      applied: false,
      market: normalizedMarket,
      exchange: resolvedExchange,
      plan: finalPlan,
      expiredCooldownTriggers,
    };
  }

  const collectMeta = buildCollectMeta({
    exchange: resolvedExchange,
    symbols: finalPlan.selectedSymbols,
    plan: finalPlan,
  });
  const collect = await collectRunner({
    market: resolvedExchange,
    symbols: finalPlan.selectedSymbols,
    triggerType: 'relaxed_probe_l13',
    meta: collectMeta,
    universeMeta: {
      screeningSymbolCount: finalPlan.selectedSymbols.length,
      relaxedProbeRunner: true,
    },
  });
  const decision = await decisionRunner({
    sessionId: collect.sessionId,
    symbols: finalPlan.selectedSymbols,
    exchange: resolvedExchange,
    meta: {
      relaxed_probe_runner: true,
      relaxed_probe_context: buildRelaxedProbeContext(finalPlan),
      manualUniverseMode: 'explicit_symbols',
      disableDiscoveryExpansion: true,
      llm_call_policy: {
        source_enrichment: 'technical_first_only',
        relaxed_probe_runner: true,
      },
    },
  });

  return {
    ok: true,
    status: 'relaxed_probe_l13_executed',
    dryRun: false,
    applied: true,
    market: normalizedMarket,
    exchange: resolvedExchange,
    plan: finalPlan,
    collect: {
      sessionId: collect.sessionId,
      symbols: collect.symbols,
      metrics: collect.metrics,
    },
    decision,
    expiredCooldownTriggers,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const result = await runLunaRelaxedProbeRunner({
    market: argValue('market', DEFAULT_MARKET, argv),
    exchange: argValue('exchange', null, argv),
    hours: Math.max(1, Number(argValue('hours', DEFAULT_HOURS, argv)) || DEFAULT_HOURS),
    limit: Math.max(1, Number(argValue('limit', DEFAULT_LIMIT, argv)) || DEFAULT_LIMIT),
    maxSymbols: Math.max(1, Number(argValue('max-symbols', DEFAULT_MAX_SYMBOLS, argv)) || DEFAULT_MAX_SYMBOLS),
    apply: hasArg('apply', argv),
    confirm: argValue('confirm', null, argv),
  });
  if (hasArg('json', argv)) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-relaxed-probe-runner ${result.status}`);
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-relaxed-probe-runner 실패:',
  });
}
