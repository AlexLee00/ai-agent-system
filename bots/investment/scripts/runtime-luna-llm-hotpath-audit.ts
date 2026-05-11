#!/usr/bin/env node
// @ts-nocheck

import { statSync } from 'node:fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { query } from '../shared/db.ts';

const DEFAULT_HOURS = 6;
const DEFAULT_LIMIT = 30;
const DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS = 1;
const DEFAULT_TARGETED_ENRICHMENT_MIN_COOLDOWN_MINUTES = 90;
const SOURCE_MITIGATION_FILES = {
  relaxed_probe_l13: new URL('./runtime-luna-relaxed-probe-runner.ts', import.meta.url),
  active_candidate_targeted_enrichment: new URL('./runtime-luna-active-candidate-analysis-refresh.ts', import.meta.url),
};

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseJsonish(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normalizeMarket(market = '') {
  const value = String(market || '').toLowerCase();
  if (value === 'crypto') return 'binance';
  if (value === 'domestic') return 'kis';
  if (value === 'overseas') return 'kis_overseas';
  return value;
}

function uniq(values = []) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function normalizeNodeIds(nodes = []) {
  return uniq((nodes || []).flat().map((node) => {
    if (typeof node === 'string') return node;
    return node?.nodeId || node?.id || '';
  }));
}

function parseTimeMs(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) return null;
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(text).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function buildSourceMitigationCutoffs() {
  return Object.fromEntries(Object.entries(SOURCE_MITIGATION_FILES).map(([key, fileUrl]) => {
    try {
      return [key, statSync(fileUrl).mtimeMs];
    } catch {
      return [key, null];
    }
  }));
}

function sourceMitigationKeyForPlan({ triggerType, plan }) {
  const normalizedTrigger = String(triggerType || '').toLowerCase();
  const collectMode = String(plan?.collectMode || '').toLowerCase();
  const marketScript = String(plan?.marketScript || '').toLowerCase();
  if (normalizedTrigger === 'relaxed_probe_l13' || marketScript === 'luna_relaxed_probe_runner') {
    return 'relaxed_probe_l13';
  }
  if (
    normalizedTrigger === 'active_candidate_targeted_enrichment'
    || collectMode === 'active_candidate_targeted_enrichment'
  ) {
    return 'active_candidate_targeted_enrichment';
  }
  return null;
}

function assessSourceMitigation({ row, triggerType, plan, sourceMitigationCutoffs }) {
  const source = sourceMitigationKeyForPlan({ triggerType, plan });
  const sourceUpdatedAtMs = Number(source ? sourceMitigationCutoffs?.[source] : null);
  const observedAtMs = parseTimeMs(row.finished_at) || parseTimeMs(row.started_at);
  const mitigated = Boolean(
    source
    && Number.isFinite(sourceUpdatedAtMs)
    && Number.isFinite(observedAtMs)
    && observedAtMs < sourceUpdatedAtMs
  );
  return {
    mitigated,
    source,
    observedAt: toIsoOrNull(observedAtMs),
    sourceUpdatedAt: toIsoOrNull(sourceUpdatedAtMs),
  };
}

export function extractCollectPlan(meta = {}) {
  const parsed = parseJsonish(meta, {});
  const plan =
    parsed.collect_agent_plan ||
    parsed.collectAgentPlan ||
    parsed.collect_metrics?.collectAgentPlan ||
    parsed.collect_metrics?.collect_agent_plan ||
    parsed.agentPlan?.collect ||
    {};
  const nodeIds = normalizeNodeIds(
    plan.nodeIds ||
    plan.perSymbolNodeIds ||
    plan.nodes ||
    parsed.llm_call_policy?.light_collect_nodes ||
    [],
  );
  return {
    source: plan.source || parsed.collect_agent_plan?.source || parsed.collect_metrics?.collectAgentPlan?.source || null,
    nodeIds,
    collectMode:
      parsed.collect_mode ||
      parsed.collectMode ||
      parsed.collect_metrics?.collectMode ||
      parsed.collect_quality?.collectMode ||
      null,
    decisionExecutionSkipped: parsed.decision_execution_skipped === true,
    marketScript: parsed.market_script || null,
    researchOnly: parsed.research_only === true || parsed.planner_payload?.planner_context?.researchOnly === true,
    targetedEnrichment:
      parsed.targeted_enrichment === true ||
      String(parsed.collect_mode || parsed.collectMode || '').toLowerCase() === 'active_candidate_targeted_enrichment',
    llmCallPolicy: parsed.llm_call_policy || {},
  };
}

function isStockMarket(market) {
  return ['kis', 'kis_overseas'].includes(normalizeMarket(market));
}

function isCryptoMarket(market) {
  return normalizeMarket(market) === 'binance';
}

function isStockL04OnlyTargetedEnrichment({ market, nodeIds = [] } = {}) {
  return isStockMarket(market)
    && nodeIds.length > 0
    && nodeIds.every((nodeId) => nodeId === 'L04');
}

function classifyTargetedEnrichment({ market, triggerType, plan }) {
  const collectMode = String(plan.collectMode || '').toLowerCase();
  const intentional =
    plan.targetedEnrichment === true ||
    triggerType === 'active_candidate_targeted_enrichment' ||
    collectMode === 'active_candidate_targeted_enrichment';
  if (!intentional) return { intentional: false, reasons: [] };

  const policy = plan.llmCallPolicy || {};
  const reasons = [];
  const allowedNodes = isCryptoMarket(market) ? new Set(['L03', 'L05']) : new Set(['L03', 'L04']);
  const disallowedNodes = (plan.nodeIds || []).filter((nodeId) => !allowedNodes.has(nodeId));
  if (disallowedNodes.length > 0) reasons.push(`targeted_enrichment_unexpected_nodes:${disallowedNodes.join(',')}`);
  if (String(policy.source_enrichment || '') !== 'targeted_top_n_only') {
    reasons.push('targeted_enrichment_missing_top_n_policy');
  }

  const stockL04Only = isStockL04OnlyTargetedEnrichment({ market, nodeIds: plan.nodeIds || [] });
  const allowedMaxSymbols = Math.max(
    1,
    Number(
      stockL04Only
        ? process.env.LUNA_LLM_HOTPATH_STOCK_L04_TARGETED_MAX_SYMBOLS || 4
        : process.env.LUNA_LLM_HOTPATH_TARGETED_ENRICHMENT_MAX_SYMBOLS || DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS,
    ),
  );
  const maxSymbols = Number(policy.targeted_enrichment_max_symbols);
  if (!Number.isFinite(maxSymbols) || maxSymbols > allowedMaxSymbols) {
    reasons.push('targeted_enrichment_symbol_cap_too_high');
  }

  const requiredCooldownMinutes = Math.max(
    1,
    Number(process.env.LUNA_LLM_HOTPATH_TARGETED_ENRICHMENT_MIN_COOLDOWN_MINUTES || DEFAULT_TARGETED_ENRICHMENT_MIN_COOLDOWN_MINUTES),
  );
  const cooldownMinutes = Number(policy.targeted_enrichment_cooldown_minutes);
  if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < requiredCooldownMinutes) {
    reasons.push('targeted_enrichment_cooldown_too_short');
  }

  return { intentional: true, reasons };
}

export function classifyPipelineLlmHotPath(row = {}, { sourceMitigationCutoffs = null } = {}) {
  const market = normalizeMarket(row.market);
  const triggerType = String(row.trigger_type || '').toLowerCase();
  const plan = extractCollectPlan(row.meta || {});
  const collectMode = String(plan.collectMode || '').toLowerCase();
  const nodeIds = plan.nodeIds || [];
  const reasons = [];
  const targeted = classifyTargetedEnrichment({ market, triggerType, plan });

  if (targeted.intentional) {
    reasons.push(...targeted.reasons);
    const sourceMitigation = reasons.length > 0
      ? assessSourceMitigation({ row, triggerType, plan, sourceMitigationCutoffs })
      : { mitigated: false, source: null, observedAt: null, sourceUpdatedAt: null };
    return {
      ok: reasons.length === 0 || sourceMitigation.mitigated,
      severity: reasons.length > 0
        ? sourceMitigation.mitigated ? 'historical' : 'warning'
        : 'clear',
      sessionId: row.session_id || null,
      market,
      triggerType,
      status: row.status || null,
      startedAt: row.started_at || null,
      finishedAt: row.finished_at || null,
      collectMode: plan.collectMode,
      source: plan.source,
      nodeIds,
      targetedEnrichment: true,
      historicalMitigated: sourceMitigation.mitigated,
      sourceMitigation: sourceMitigation.source ? sourceMitigation : null,
      reasons,
    };
  }

  const stockLight =
    isStockMarket(market) &&
    (
      triggerType === 'active_candidate_analysis_refresh' ||
      collectMode === 'intraday_monitoring_light' ||
      collectMode === 'off_hours_research_light' ||
      collectMode === 'active_candidate_analysis_refresh' ||
      plan.decisionExecutionSkipped === true
    );
  if (stockLight && nodeIds.includes('L03')) {
    reasons.push('stock_light_path_includes_sentiment_node_L03');
  }

  const cryptoLight =
    isCryptoMarket(market) &&
    (
      triggerType === 'active_candidate_analysis_refresh' ||
      collectMode === 'intraday_monitoring_light' ||
      collectMode === 'active_candidate_analysis_refresh' ||
      plan.decisionExecutionSkipped === true
    );
  if (cryptoLight && nodeIds.includes('L03')) reasons.push('crypto_light_path_includes_sentiment_node_L03');
  if (cryptoLight && nodeIds.includes('L05')) reasons.push('crypto_light_path_includes_onchain_node_L05');

  if (isStockMarket(market) && triggerType === 'research' && plan.source === 'default_market_plan' && nodeIds.includes('L03')) {
    reasons.push('stock_research_uses_default_market_plan_with_L03');
  }

  return {
    ok: reasons.length === 0,
    severity: reasons.length > 0 ? 'warning' : 'clear',
    sessionId: row.session_id || null,
    market,
    triggerType,
    status: row.status || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    collectMode: plan.collectMode,
    source: plan.source,
    nodeIds,
    targetedEnrichment: false,
    historicalMitigated: false,
    sourceMitigation: null,
    reasons,
  };
}

export function buildLlmHotPathAudit({
  topCalls = [],
  pipelineSessions = [],
  staleActiveRefreshRunning = [],
  generatedAt = new Date().toISOString(),
  hours = DEFAULT_HOURS,
  since = null,
  sourceMitigationCutoffs = null,
} = {}) {
  const classifiedSessions = (pipelineSessions || [])
    .map((row) => classifyPipelineLlmHotPath(row, { sourceMitigationCutoffs }));
  const suspiciousSessions = classifiedSessions
    .filter((item) => !item.ok && !item.historicalMitigated);
  const historicalMitigatedSessions = classifiedSessions
    .filter((item) => item.historicalMitigated);
  const totalCalls = (topCalls || []).reduce((sum, row) => sum + Number(row.calls || 0), 0);
  const failedCalls = (topCalls || []).reduce((sum, row) => sum + Number(row.failed_calls || 0), 0);
  const topCall = topCalls?.[0] || null;
  const warnings = [];
  const nonBlockingWarnings = [];
  if (suspiciousSessions.length > 0) warnings.push('unexpected_llm_enrichment_path_detected');
  if (historicalMitigatedSessions.length > 0) nonBlockingWarnings.push('historical_llm_hotpath_sessions_before_current_source');
  if ((staleActiveRefreshRunning || []).length > 0) nonBlockingWarnings.push('stale_active_candidate_refresh_sessions_detected');
  const status = warnings.length > 0
    ? 'luna_llm_hotpath_attention'
    : historicalMitigatedSessions.length > 0 && (staleActiveRefreshRunning || []).length > 0
      ? 'luna_llm_hotpath_clear_with_historical_warnings'
      : historicalMitigatedSessions.length > 0
        ? 'luna_llm_hotpath_clear_with_historical_mitigated_sessions'
        : nonBlockingWarnings.length > 0
          ? 'luna_llm_hotpath_clear_with_historical_stale_sessions'
          : 'luna_llm_hotpath_clear';

  return {
    ok: warnings.length === 0,
    status,
    generatedAt,
    hours,
    since,
    totals: {
      calls: totalCalls,
      failedCalls,
      topCalls: topCalls.length,
      pipelineSessions: pipelineSessions.length,
      suspiciousSessions: suspiciousSessions.length,
      historicalMitigatedSessions: historicalMitigatedSessions.length,
      staleActiveRefreshRunning: staleActiveRefreshRunning.length,
    },
    topCall,
    topCalls,
    suspiciousSessions,
    historicalMitigatedSessions,
    staleActiveRefreshRunning,
    warnings,
    nonBlockingWarnings,
    recommendations: warnings.length === 0
      ? [
          'continue monitoring next scheduled market cycle',
          historicalMitigatedSessions.length > 0
            ? 'historical LLM hotpath sessions predate the current source update and should age out of the window'
            : null,
          (staleActiveRefreshRunning || []).length > 0
            ? 'historical stale active refresh sessions can be closed with a separate explicit apply operator after review'
            : null,
        ].filter(Boolean)
      : [
          suspiciousSessions.length > 0
            ? 'verify collect_agent_plan uses runtime_agent_plan/light nodes for stock and crypto non-entry paths'
            : null,
        ].filter(Boolean),
  };
}

async function loadTopCalls({ sinceIso, limit }) {
  return query(
    `SELECT
        COALESCE(agent_name, 'unknown') AS agent_name,
        COALESCE(task_type, 'unknown') AS task_type,
        COALESCE(market, 'unknown') AS market,
        COALESCE(provider, 'unknown') AS provider,
        COUNT(*)::int AS calls,
        SUM(CASE WHEN response_ok = false THEN 1 ELSE 0 END)::int AS failed_calls,
        SUM(CASE WHEN fallback_used = true THEN 1 ELSE 0 END)::int AS fallback_calls,
        MAX(created_at) AS last_seen_at
       FROM investment.llm_routing_log
      WHERE created_at >= $1::timestamptz
      GROUP BY agent_name, task_type, market, provider
      ORDER BY calls DESC, last_seen_at DESC
      LIMIT $2`,
    [sinceIso, limit],
  ).catch(() => []);
}

async function loadPipelineSessions({ sinceMs, limit }) {
  return query(
    `SELECT session_id, market, trigger_type, status, started_at, finished_at, symbols, meta
       FROM pipeline_runs
      WHERE started_at >= $1
      ORDER BY started_at DESC
      LIMIT $2`,
    [sinceMs, limit],
  ).catch(() => []);
}

async function loadStaleActiveRefreshRunning({ staleBeforeMs, limit }) {
  return query(
    `SELECT session_id, market, trigger_type, status, started_at, symbols
       FROM pipeline_runs
      WHERE trigger_type = 'active_candidate_analysis_refresh'
        AND status = 'running'
        AND started_at < $1
      ORDER BY started_at ASC
      LIMIT $2`,
    [staleBeforeMs, limit],
  ).catch(() => []);
}

export async function runLunaLlmHotPathAudit({
  hours = DEFAULT_HOURS,
  limit = DEFAULT_LIMIT,
  staleMinutes = 30,
  since = null,
  now = new Date(),
} = {}) {
  const safeHours = Math.max(1, Number(hours || DEFAULT_HOURS));
  const safeLimit = Math.max(1, Math.min(200, Number(limit || DEFAULT_LIMIT)));
  const minutes = Math.round(safeHours * 60);
  const parsedSinceMs = since ? new Date(since).getTime() : NaN;
  const sinceMs = Number.isFinite(parsedSinceMs) ? parsedSinceMs : now.getTime() - minutes * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  const staleBeforeMs = now.getTime() - Math.max(1, Number(staleMinutes || 30)) * 60 * 1000;
  const [topCalls, pipelineSessions, staleActiveRefreshRunning] = await Promise.all([
    loadTopCalls({ sinceIso, limit: safeLimit }),
    loadPipelineSessions({ sinceMs, limit: safeLimit }),
    loadStaleActiveRefreshRunning({ staleBeforeMs, limit: safeLimit }),
  ]);
  return buildLlmHotPathAudit({
    topCalls,
    pipelineSessions,
    staleActiveRefreshRunning,
    generatedAt: now.toISOString(),
    hours: safeHours,
    since: sinceIso,
    sourceMitigationCutoffs: buildSourceMitigationCutoffs(),
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const result = await runLunaLlmHotPathAudit({
    hours: Math.max(1, Number(argValue('hours', DEFAULT_HOURS, argv)) || DEFAULT_HOURS),
    limit: Math.max(1, Number(argValue('limit', DEFAULT_LIMIT, argv)) || DEFAULT_LIMIT),
    staleMinutes: Math.max(1, Number(argValue('stale-minutes', 30, argv)) || 30),
    since: argValue('since', null, argv),
  });
  if (hasArg('json', argv)) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-llm-hotpath-audit ${result.status}`);
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-llm-hotpath-audit 실패:',
  });
}
