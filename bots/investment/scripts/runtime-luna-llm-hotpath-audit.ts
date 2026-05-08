#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { query } from '../shared/db.ts';

const DEFAULT_HOURS = 6;
const DEFAULT_LIMIT = 30;

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
  };
}

function isStockMarket(market) {
  return ['kis', 'kis_overseas'].includes(normalizeMarket(market));
}

function isCryptoMarket(market) {
  return normalizeMarket(market) === 'binance';
}

export function classifyPipelineLlmHotPath(row = {}) {
  const market = normalizeMarket(row.market);
  const triggerType = String(row.trigger_type || '').toLowerCase();
  const plan = extractCollectPlan(row.meta || {});
  const collectMode = String(plan.collectMode || '').toLowerCase();
  const nodeIds = plan.nodeIds || [];
  const reasons = [];

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
    collectMode: plan.collectMode,
    source: plan.source,
    nodeIds,
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
} = {}) {
  const suspiciousSessions = (pipelineSessions || [])
    .map(classifyPipelineLlmHotPath)
    .filter((item) => !item.ok);
  const totalCalls = (topCalls || []).reduce((sum, row) => sum + Number(row.calls || 0), 0);
  const failedCalls = (topCalls || []).reduce((sum, row) => sum + Number(row.failed_calls || 0), 0);
  const topCall = topCalls?.[0] || null;
  const warnings = [];
  const nonBlockingWarnings = [];
  if (suspiciousSessions.length > 0) warnings.push('unexpected_llm_enrichment_path_detected');
  if ((staleActiveRefreshRunning || []).length > 0) nonBlockingWarnings.push('stale_active_candidate_refresh_sessions_detected');

  return {
    ok: warnings.length === 0,
    status: warnings.length > 0
      ? 'luna_llm_hotpath_attention'
      : nonBlockingWarnings.length > 0
        ? 'luna_llm_hotpath_clear_with_historical_stale_sessions'
        : 'luna_llm_hotpath_clear',
    generatedAt,
    hours,
    since,
    totals: {
      calls: totalCalls,
      failedCalls,
      topCalls: topCalls.length,
      pipelineSessions: pipelineSessions.length,
      suspiciousSessions: suspiciousSessions.length,
      staleActiveRefreshRunning: staleActiveRefreshRunning.length,
    },
    topCall,
    topCalls,
    suspiciousSessions,
    staleActiveRefreshRunning,
    warnings,
    nonBlockingWarnings,
    recommendations: warnings.length === 0
      ? [
          'continue monitoring next scheduled market cycle',
          nonBlockingWarnings.length > 0
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
