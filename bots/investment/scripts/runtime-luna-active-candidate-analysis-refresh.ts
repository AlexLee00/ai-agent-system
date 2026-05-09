#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { investmentOpsRuntimeFile } from '../shared/runtime-ops-path.ts';
import { runMarketCollectPipeline } from '../shared/pipeline-market-runner.ts';
import { finishPipelineRun } from '../shared/pipeline-db.ts';
import { buildLunaDecisionFilterReport } from './runtime-luna-decision-filter-report.ts';
import { buildStockIntradayLlmPolicyMeta } from '../shared/stock-intraday-llm-policy.ts';

const CONFIRM = 'luna-active-candidate-analysis-refresh';
const DEFAULT_STATE_PATH = investmentOpsRuntimeFile('luna-active-candidate-analysis-refresh-state.json');
const DEFAULT_DECISION_FILTER_HOURS = 2;
const DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS = 1;
const DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES = 120;
const DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE = 0.58;
const DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES = 10;
const DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS = 0;
const GLOBAL_TARGETED_ENRICHMENT_SYMBOL = '__global__';

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

function isCollectResultOk(result = {}) {
  if (typeof result?.ok === 'boolean') return result.ok === true;
  return Number(result?.metrics?.failedHardCoreTasks || 0) === 0;
}

function defaultExchangeForMarket(market = 'crypto') {
  if (market === 'domestic') return 'kis';
  if (market === 'overseas') return 'kis_overseas';
  return 'binance';
}

function missingEnrichmentNodeIds(item = {}) {
  const exchange = String(item.exchange || '').trim();
  const reasons = new Set(Array.isArray(item.reasons) ? item.reasons : []);
  const nodes = [];
  if (reasons.has('sentiment_not_confirmed')) nodes.push('L03');
  if (exchange === 'binance' && reasons.has('onchain_not_confirmed')) nodes.push('L05');
  if ((exchange === 'kis' || exchange === 'kis_overseas') && reasons.has('market_flow_not_confirmed')) nodes.push('L04');
  return [...new Set(nodes)];
}

function hasTechnicalBuy(item = {}) {
  const byAnalyst = item?.analystSummary?.byAnalyst || {};
  return ['ta_mtf', 'ta', 'technical'].some((analyst) => String(byAnalyst?.[analyst]?.signal || '').toUpperCase() === 'BUY')
    || String(item?.fused?.recommendation || '').toUpperCase() === 'LONG';
}

function isProbeCriticalCandidate(item = {}) {
  if (item?.actionability === 'relaxed_probe_candidate') return true;
  if (item?.relaxation?.ok === true) return true;
  return false;
}

function numericValues(values = []) {
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function candidateConfidence(item = {}) {
  const analystConfidences = Object.values(item?.analystSummary?.byAnalyst || {}).map((analyst) => analyst?.confidence);
  const values = numericValues([
    item?.confidence,
    item?.fused?.averageConfidence,
    item?.fused?.confidence,
    item?.relaxation?.confidence,
    ...analystConfidences,
  ]);
  if (values.length === 0) return 0;
  return Math.max(...values);
}

function buildTargetedEnrichmentPlan({
  report,
  state = {},
  now = new Date(),
  maxSymbols = DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS,
  cooldownMinutes = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES,
  minConfidence = DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE,
  cooldownBypassMinMinutes = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES,
  cooldownBypassMaxSymbols = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS,
  exchange = null,
  excludeSymbols = [],
} = {}) {
  const attempts = state?.symbols || {};
  const safeCooldownMinutes = Math.max(1, Number(cooldownMinutes || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES));
  const safeMinConfidence = Math.max(0, Math.min(1, Number(minConfidence ?? DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE)));
  const cooldownMs = safeCooldownMinutes * 60 * 1000;
  const bypassMs = Math.max(1, Number(cooldownBypassMinMinutes || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES)) * 60 * 1000;
  const bypassMax = Math.max(0, Number(cooldownBypassMaxSymbols || 0));
  const excluded = new Set((excludeSymbols || []).map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean));
  const selected = [];
  const skippedCooldown = [];
  const skippedQuality = [];
  const nodeIds = new Set();
  let cooldownBypassed = 0;
  let globalCooldown = null;
  const globalKey = exchange
    ? `${exchange}:targeted_enrichment:${GLOBAL_TARGETED_ENRICHMENT_SYMBOL}`
    : `targeted_enrichment:${GLOBAL_TARGETED_ENRICHMENT_SYMBOL}`;
  const globalAttempt = attempts?.[globalKey] || null;
  const globalLastAttemptAt = globalAttempt?.lastAttemptAt || null;
  const globalAgeMs = globalLastAttemptAt ? now.getTime() - new Date(globalLastAttemptAt).getTime() : Infinity;
  if (Number.isFinite(globalAgeMs) && globalAgeMs >= 0 && globalAgeMs < cooldownMs) {
    globalCooldown = {
      lastAttemptAt: globalLastAttemptAt,
      nextEligibleAt: new Date(new Date(globalLastAttemptAt).getTime() + cooldownMs).toISOString(),
      cooldownMinutes: safeCooldownMinutes,
    };
  }

  for (const item of report?.top || []) {
    const symbol = String(item?.symbol || '').trim().toUpperCase();
    if (!symbol || excluded.has(symbol)) continue;
    if (item.actionability === 'likely_actionable') continue;
    if (!hasTechnicalBuy(item)) continue;
    const confidence = candidateConfidence(item);
    if (!isProbeCriticalCandidate(item) && confidence < safeMinConfidence) {
      skippedQuality.push({
        symbol,
        confidence,
        minConfidence: safeMinConfidence,
        reason: 'targeted_enrichment_low_confidence',
      });
      continue;
    }
    const reasons = new Set(Array.isArray(item.reasons) ? item.reasons : []);
    if (reasons.has('conflict_detected') || reasons.has('news_only_buy')) continue;
    const missingNodes = missingEnrichmentNodeIds(item);
    if (missingNodes.length === 0) continue;
    if (globalCooldown) {
      skippedCooldown.push({
        symbol,
        lastAttemptAt: globalCooldown.lastAttemptAt,
        nextEligibleAt: globalCooldown.nextEligibleAt,
        missingNodes,
        scope: 'market_global',
      });
      continue;
    }

    const key = exchange ? `${exchange}:targeted_enrichment:${symbol}` : `targeted_enrichment:${symbol}`;
    const attempt = attempts?.[key] || null;
    const lastAttemptAt = attempt?.lastAttemptAt || null;
    const ageMs = lastAttemptAt ? now.getTime() - new Date(lastAttemptAt).getTime() : Infinity;
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < cooldownMs) {
      const bypassAllowed = isProbeCriticalCandidate(item)
        && cooldownBypassed < bypassMax
        && ageMs >= bypassMs
        && selected.length < Math.max(0, Number(maxSymbols || 0));
      if (bypassAllowed) {
        cooldownBypassed += 1;
        selected.push({
          symbol,
          reasons: [...reasons],
          missingNodes,
          confidence,
          fused: item.fused || null,
          recommendation: item.recommendation || null,
          cooldownBypassed: true,
          lastAttemptAt,
          nextEligibleAt: new Date(new Date(lastAttemptAt).getTime() + cooldownMs).toISOString(),
        });
        for (const nodeId of missingNodes) nodeIds.add(nodeId);
        if (selected.length >= Math.max(0, Number(maxSymbols || 0))) break;
        continue;
      }
      skippedCooldown.push({
        symbol,
        lastAttemptAt,
        nextEligibleAt: new Date(new Date(lastAttemptAt).getTime() + cooldownMs).toISOString(),
        missingNodes,
      });
      continue;
    }

    selected.push({
      symbol,
      reasons: [...reasons],
      missingNodes,
      confidence,
      fused: item.fused || null,
      recommendation: item.recommendation || null,
    });
    for (const nodeId of missingNodes) nodeIds.add(nodeId);
    if (selected.length >= Math.max(0, Number(maxSymbols || 0))) break;
  }

  return {
    ok: true,
    enabled: Math.max(0, Number(maxSymbols || 0)) > 0,
    status: selected.length > 0
      ? 'targeted_enrichment_needed'
      : skippedCooldown.length > 0
        ? 'targeted_enrichment_cooldown'
        : skippedQuality.length > 0
          ? 'targeted_enrichment_quality_filtered'
          : 'targeted_enrichment_clear',
    selected,
    selectedSymbols: selected.map((item) => item.symbol),
    nodeIds: [...nodeIds],
    skippedCooldown,
    skippedQuality,
    globalCooldown,
    cooldownBypassed,
    cooldownBypassedSymbols: selected.filter((item) => item.cooldownBypassed).map((item) => item.symbol),
    maxSymbols: Math.max(0, Number(maxSymbols || 0)),
    cooldownMinutes: safeCooldownMinutes,
    minConfidence: safeMinConfidence,
    cooldownBypassMinMinutes: Math.max(1, Number(cooldownBypassMinMinutes || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES)),
    cooldownBypassMaxSymbols: bypassMax,
  };
}

export function buildActiveCandidateAnalysisRefreshPlan({
  report,
  state = {},
  now = new Date(),
  maxSymbols = 4,
  maxEnrichmentSymbols = DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS,
  cooldownMinutes = 45,
  targetedCooldownMinutes = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES,
  minTargetedConfidence = DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE,
  cooldownBypassMinMinutes = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES,
  cooldownBypassMaxSymbols = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS,
  exchange = null,
} = {}) {
  const missing = [...new Set((report?.missingActiveCandidateSymbols || []).map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
  const cooldownMs = Math.max(1, Number(cooldownMinutes || 45)) * 60 * 1000;
  const attempts = state?.symbols || {};
  const selected = [];
  const skippedCooldown = [];
  const attemptKeyFor = (symbol) => exchange ? `${exchange}:analysis:${symbol}` : `analysis:${symbol}`;

  for (const symbol of missing) {
    const attempt = attempts?.[attemptKeyFor(symbol)] || attempts?.[exchange ? `${exchange}:${symbol}` : symbol] || null;
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

  const targetedEnrichment = buildTargetedEnrichmentPlan({
    report,
    state,
    now,
    maxSymbols: maxEnrichmentSymbols,
    cooldownMinutes: targetedCooldownMinutes,
    minConfidence: minTargetedConfidence,
    cooldownBypassMinMinutes,
    cooldownBypassMaxSymbols,
    exchange,
    excludeSymbols: selected,
  });
  const hasWork = selected.length > 0 || targetedEnrichment.selected.length > 0;

  return {
    ok: true,
    status: hasWork ? 'active_candidate_analysis_refresh_needed' : missing.length > 0 ? 'active_candidate_analysis_refresh_cooldown' : 'active_candidate_analysis_refresh_clear',
    missing,
    selected,
    skippedCooldown,
    targetedEnrichment,
    maxSymbols: Math.max(1, Number(maxSymbols || 4)),
    maxEnrichmentSymbols: Math.max(0, Number(maxEnrichmentSymbols || 0)),
    cooldownMinutes: Math.max(1, Number(cooldownMinutes || 45)),
    targetedCooldownMinutes: Math.max(1, Number(targetedCooldownMinutes || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES)),
    minTargetedConfidence: Math.max(0, Math.min(1, Number(minTargetedConfidence ?? DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE))),
    nextAction: hasWork
      ? 'collect_missing_or_targeted_enrichment_without_decision_execution'
      : missing.length > 0
        ? 'wait_for_refresh_cooldown_or_regular_market_cycle'
        : 'continue_observation',
  };
}

function updateAttemptState(state = {}, symbols = [], result = {}, now = new Date(), { exchange = null, purpose = 'analysis' } = {}) {
  const next = {
    ...(state || {}),
    updatedAt: now.toISOString(),
    symbols: { ...((state || {}).symbols || {}) },
  };
  for (const symbol of symbols || []) {
    const key = exchange ? `${exchange}:${purpose}:${symbol}` : `${purpose}:${symbol}`;
    next.symbols[key] = {
      symbol,
      exchange,
      purpose,
      lastAttemptAt: now.toISOString(),
      lastStatus: isCollectResultOk(result) ? 'ok' : 'failed',
      lastOutcome: result?.metrics?.collectQuality?.status || result?.status || null,
      lastSessionId: result?.sessionId || null,
    };
  }
  if (purpose === 'targeted_enrichment' && (symbols || []).length > 0) {
    const globalKey = exchange
      ? `${exchange}:targeted_enrichment:${GLOBAL_TARGETED_ENRICHMENT_SYMBOL}`
      : `targeted_enrichment:${GLOBAL_TARGETED_ENRICHMENT_SYMBOL}`;
    next.symbols[globalKey] = {
      symbol: GLOBAL_TARGETED_ENRICHMENT_SYMBOL,
      exchange,
      purpose,
      lastAttemptAt: now.toISOString(),
      lastStatus: isCollectResultOk(result) ? 'ok' : 'failed',
      lastOutcome: result?.metrics?.collectQuality?.status || result?.status || null,
      lastSessionId: result?.sessionId || null,
    };
  }
  return next;
}

export async function runActiveCandidateAnalysisRefresh({
  market = 'crypto',
  exchange = null,
  hours = Number(process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_HOURS || DEFAULT_DECISION_FILTER_HOURS),
  limit = 20,
  maxSymbols = Number(process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_MAX_SYMBOLS || 4),
  maxEnrichmentSymbols = Number(process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_MAX_SYMBOLS || DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS),
  cooldownMinutes = Number(process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_COOLDOWN_MINUTES || 45),
  targetedCooldownMinutes = Number(process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_COOLDOWN_MINUTES || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES),
  minTargetedConfidence = Number(process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_MIN_CONFIDENCE || DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE),
  cooldownBypassMinMinutes = Number(process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES),
  cooldownBypassMaxSymbols = Number(process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS),
  enabled = boolEnv('LUNA_ACTIVE_CANDIDATE_REFRESH_ENABLED', true),
  targetedEnrichmentEnabled = boolEnv('LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_ENABLED', true),
  apply = false,
  confirm = null,
  statePath = DEFAULT_STATE_PATH,
  reportBuilder = buildLunaDecisionFilterReport,
  collectRunner = runMarketCollectPipeline,
  finishRun = finishPipelineRun,
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
    maxEnrichmentSymbols: targetedEnrichmentEnabled ? maxEnrichmentSymbols : 0,
    cooldownMinutes,
    targetedCooldownMinutes,
    minTargetedConfidence,
    cooldownBypassMinMinutes,
    cooldownBypassMaxSymbols,
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

  if (plan.selected.length === 0 && plan.targetedEnrichment.selected.length === 0) {
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

  const collectRuns = [];
  async function runCollectStage({ symbols, purpose, meta, universeMeta }) {
    if (!Array.isArray(symbols) || symbols.length === 0) return null;
    const collect = await collectRunner({
      market: resolvedExchange,
      symbols,
      triggerType: purpose === 'targeted_enrichment'
        ? 'active_candidate_targeted_enrichment'
        : 'active_candidate_analysis_refresh',
      meta,
      universeMeta,
    });
    const collectOk = Number(collect?.metrics?.failedHardCoreTasks || 0) === 0;
    let finishResult = null;
    try {
      finishResult = await finishRun(collect.sessionId, {
        status: collectOk ? 'completed' : 'failed',
        meta: {
          bridge_status: collectOk
            ? `${purpose}_collected`
            : `${purpose}_collect_degraded`,
          market_script: 'active_candidate_analysis_refresh',
          decision_execution_skipped: true,
          collect_purpose: purpose,
          collect_metrics: collect.metrics || null,
          collect_quality: collect.metrics?.collectQuality || null,
          collect_warnings: collect.metrics?.warnings || [],
        },
      });
    } catch (error) {
      finishResult = {
        updated: false,
        reason: 'finish_pipeline_run_failed',
        error: error?.message || String(error),
      };
    }
    const finishOk = finishResult?.updated === true || finishResult?.reason === 'already_terminal';
    const record = { purpose, collect, collectOk, finish: finishResult, finishOk };
    collectRuns.push(record);
    return record;
  }

  const baseRun = await runCollectStage({
    symbols: plan.selected,
    purpose: 'analysis',
    meta: buildStockIntradayLlmPolicyMeta({
      market: resolvedExchange,
      marketScript: 'active_candidate_analysis_refresh',
      collectMode: 'active_candidate_analysis_refresh',
      extraMeta: {
        decision_execution_skipped: true,
      },
    }),
    universeMeta: {
      screeningSymbolCount: plan.selected.length,
      activeCandidateRefresh: true,
    },
  });

  const enrichmentRun = await runCollectStage({
    symbols: plan.targetedEnrichment.selectedSymbols,
    purpose: 'targeted_enrichment',
    meta: buildStockIntradayLlmPolicyMeta({
      market: resolvedExchange,
      marketScript: 'active_candidate_analysis_refresh',
      collectMode: 'active_candidate_targeted_enrichment',
      extraMeta: {
        decision_execution_skipped: true,
        targeted_enrichment: true,
        targeted_enrichment_reason: 'fill_missing_confirmation_before_l13',
        agentPlan: {
          collect: {
            nodeIds: plan.targetedEnrichment.nodeIds,
            concurrencyLimit: Math.min(3, Math.max(1, plan.targetedEnrichment.nodeIds.length || 1)),
          },
        },
        llm_call_policy: {
          source_enrichment: 'targeted_top_n_only',
          targeted_enrichment_nodes: plan.targetedEnrichment.nodeIds,
          targeted_enrichment_max_symbols: plan.targetedEnrichment.maxSymbols,
          targeted_enrichment_cooldown_minutes: plan.targetedEnrichment.cooldownMinutes,
          targeted_enrichment_min_confidence: plan.targetedEnrichment.minConfidence,
          targeted_enrichment_cooldown_bypassed_symbols: plan.targetedEnrichment.cooldownBypassedSymbols || [],
          targeted_enrichment_global_cooldown: plan.targetedEnrichment.globalCooldown,
        },
      },
    }),
    universeMeta: {
      screeningSymbolCount: plan.targetedEnrichment.selectedSymbols.length,
      activeCandidateRefresh: true,
      targetedEnrichment: true,
    },
  });

  const finishOk = collectRuns.every((run) => run.finishOk);
  const collectOk = collectRuns.every((run) => run.collectOk);
  let nextState = updateAttemptState(state, plan.selected, baseRun?.collect || {}, now, { exchange: resolvedExchange, purpose: 'analysis' });
  nextState = updateAttemptState(nextState, plan.targetedEnrichment.selectedSymbols, enrichmentRun?.collect || {}, now, { exchange: resolvedExchange, purpose: 'targeted_enrichment' });
  writeJson(statePath, nextState);

  return {
    ok: collectOk && finishOk,
    status: finishOk
      ? 'active_candidate_analysis_refresh_collected'
      : 'active_candidate_analysis_refresh_finish_failed',
    dryRun: false,
    applied: true,
    market: normalizedMarket,
    exchange: resolvedExchange,
    statePath,
    plan,
    collect: baseRun ? {
      sessionId: baseRun.collect.sessionId,
      symbols: baseRun.collect.symbols,
      summaries: baseRun.collect.summaries,
      metrics: baseRun.collect.metrics,
    } : null,
    targetedEnrichmentCollect: enrichmentRun ? {
      sessionId: enrichmentRun.collect.sessionId,
      symbols: enrichmentRun.collect.symbols,
      summaries: enrichmentRun.collect.summaries,
      metrics: enrichmentRun.collect.metrics,
    } : null,
    finish: baseRun?.finish || enrichmentRun?.finish || null,
    collectRuns: collectRuns.map((run) => ({
      purpose: run.purpose,
      sessionId: run.collect?.sessionId || null,
      symbols: run.collect?.symbols || [],
      collectOk: run.collectOk,
      finishOk: run.finishOk,
      finish: run.finish,
    })),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const result = await runActiveCandidateAnalysisRefresh({
    market: argValue('market', 'crypto', argv),
    exchange: argValue('exchange', null, argv),
    hours: Math.max(1, Number(argValue('hours', process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_HOURS || DEFAULT_DECISION_FILTER_HOURS, argv)) || DEFAULT_DECISION_FILTER_HOURS),
    limit: Math.max(1, Number(argValue('limit', 20, argv)) || 20),
    maxSymbols: Math.max(1, Number(argValue('max-symbols', process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_MAX_SYMBOLS || 4, argv)) || 4),
    maxEnrichmentSymbols: Math.max(0, Number(argValue('max-enrichment-symbols', process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_MAX_SYMBOLS || DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS, argv)) || 0),
    cooldownMinutes: Math.max(1, Number(argValue('cooldown-minutes', process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_COOLDOWN_MINUTES || 45, argv)) || 45),
    targetedCooldownMinutes: Math.max(1, Number(argValue('targeted-cooldown-minutes', process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_COOLDOWN_MINUTES || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES, argv)) || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES),
    minTargetedConfidence: Math.max(0, Math.min(1, Number(argValue('targeted-min-confidence', process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_MIN_CONFIDENCE || DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE, argv)) || DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE)),
    cooldownBypassMinMinutes: Math.max(1, Number(argValue('cooldown-bypass-minutes', process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES, argv)) || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES),
    cooldownBypassMaxSymbols: Math.max(0, Number(argValue('cooldown-bypass-max-symbols', process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS, argv)) || 0),
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
