#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaDecisionFilterReport } from './runtime-luna-decision-filter-report.ts';

const DEFAULT_HOURS = 168;
const DEFAULT_LIMIT = 20;

function parseArgs(argv = process.argv.slice(2)) {
  const symbols = String(argv.find((arg) => arg.startsWith('--symbols='))?.split('=').slice(1).join('=') || '')
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  return {
    json: argv.includes('--json'),
    hours: Math.max(1, Number(argv.find((arg) => arg.startsWith('--hours='))?.split('=')[1] || DEFAULT_HOURS) || DEFAULT_HOURS),
    limit: Math.max(1, Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || DEFAULT_LIMIT) || DEFAULT_LIMIT),
    symbols,
  };
}

function compact(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function firstNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function containsTimeout(value) {
  return /timeout|aborted|timed out/i.test(String(value || ''));
}

function summarizeAnalysts(item = {}) {
  const byAnalyst = item.analystSummary?.byAnalyst || {};
  const result = {};
  for (const [analyst, row] of Object.entries(byAnalyst)) {
    result[analyst] = {
      signal: row?.signal || null,
      confidence: firstNumber(row?.confidence, null),
      timeoutEvidence: containsTimeout(row?.reasoning),
      reasoningExcerpt: String(row?.reasoning || '').replace(/\s+/g, ' ').slice(0, 220),
    };
  }
  return result;
}

function deriveSymbolCause({ item = {}, signalRows = [], openPositions = [] } = {}) {
  if (openPositions.some((row) => row.symbol === item.symbol && row.paper !== true)) {
    return 'active_live_position_monitoring';
  }
  const latestSignal = signalRows
    .filter((row) => row.symbol === item.symbol)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
  if (latestSignal?.status === 'executed') return 'recent_signal_executed';
  if (latestSignal?.status && latestSignal.status !== 'pending') {
    return latestSignal.block_code ? `signal_${latestSignal.status}_${latestSignal.block_code}` : `signal_${latestSignal.status}`;
  }
  const reasons = new Set(item.reasons || []);
  const analysts = summarizeAnalysts(item);
  const analystSignals = Object.values(analysts).map((row) => row?.signal).filter(Boolean);
  if (Object.values(analysts).some((row) => row?.timeoutEvidence)) return 'llm_timeout_evidence_in_analysis';
  if (reasons.has('conflict_detected')) return 'analyst_conflict_detected';
  if (reasons.has('news_only_buy') && reasons.has('market_flow_not_confirmed')) return 'news_buy_without_market_flow_confirmation';
  if (reasons.has('technical_not_confirmed') && reasons.has('market_flow_not_confirmed')) return 'technical_and_market_flow_not_confirmed';
  if (reasons.has('technical_not_confirmed')) return 'technical_not_confirmed';
  if (reasons.has('market_flow_not_confirmed')) return 'market_flow_not_confirmed';
  if (reasons.has('average_confidence_below_min')) return 'average_confidence_below_min';
  if (analystSignals.length > 0 && analystSignals.every((signal) => signal === 'HOLD')) return 'all_analysts_hold';
  return item.actionability || 'analysis_completed_no_actionable_signal';
}

export function buildFunnelClassification({ decisionReport = {}, signalRows = [], openPositions = [], llmRows = [], realUsdViewExists = false, queryErrors = [] } = {}) {
  const top = decisionReport.top || [];
  const perSymbol = top.map((item) => ({
    symbol: item.symbol,
    actionability: item.actionability,
    primaryCause: deriveSymbolCause({ item, signalRows, openPositions }),
    recommendation: item.recommendation,
    reasons: item.reasons || [],
    fused: item.fused || null,
    dailyTechnical: item.dailyTechnical ? {
      ok: item.dailyTechnical.ok,
      reason: item.dailyTechnical.reason,
      cachedAt: item.dailyTechnical.cachedAt,
      cacheAgeMinutes: item.dailyTechnical.cacheAgeMinutes,
    } : null,
    activeCandidate: item.activeCandidate || null,
    analysts: summarizeAnalysts(item),
  }));
  const primaryCauseCounts = {};
  for (const row of perSymbol) {
    primaryCauseCounts[row.primaryCause] = (primaryCauseCounts[row.primaryCause] || 0) + 1;
  }
  const llmTimeoutCount = (llmRows || []).filter((row) => containsTimeout(row.error)).length
    + perSymbol.filter((row) => Object.values(row.analysts || {}).some((analyst) => analyst.timeoutEvidence)).length;
  const attention = [];
  if ((decisionReport.bottlenecks || []).includes('active_candidates_filtered_before_signal')) {
    attention.push('active_candidates_filtered_before_signal');
  }
  if (Number(decisionReport.likelyActionableCount || 0) === 0) {
    attention.push('no_likely_actionable_overseas_candidate');
  }
  if (llmTimeoutCount > 0) attention.push('llm_timeout_or_abort_seen');
  if (!realUsdViewExists) attention.push('missing_investment_v_trades_real_usd_view');
  if (Number(decisionReport.entryCapacity?.remainingSlots || 0) <= 0) attention.push('entry_capacity_full');
  if ((queryErrors || []).length > 0) attention.push('supporting_query_failed');
  return {
    status: attention.length > 0 ? 'kis_overseas_funnel_attention' : 'kis_overseas_funnel_clear',
    attention,
    primaryCauseCounts,
    perSymbol,
  };
}

async function querySafe(label, sql, params = [], fallback = [], queryErrors = []) {
  try {
    return await db.query(sql, params);
  } catch (error) {
    queryErrors.push({ label, error: error?.message || String(error) });
    return fallback;
  }
}

async function loadSignals({ hours, symbols, queryErrors }) {
  return querySafe('signals', `
    SELECT symbol, action, status, block_code, block_reason, created_at, confidence, execution_origin, quality_flag
    FROM investment.signals
    WHERE exchange = 'kis_overseas'
      AND created_at >= now() - ($1::text || ' hours')::interval
      AND ($2::text[] IS NULL OR symbol = ANY($2::text[]))
    ORDER BY created_at DESC
    LIMIT 200
  `, [hours, symbols.length > 0 ? symbols : null], [], queryErrors);
}

async function loadOpenPositions(symbols = [], queryErrors = []) {
  return querySafe('live_positions', `
    SELECT symbol, amount, avg_price, unrealized_pnl, updated_at, paper, trade_mode, execution_mode, broker_account_mode
    FROM investment.positions
    WHERE exchange = 'kis_overseas'
      AND COALESCE(amount, 0) <> 0
      AND COALESCE(paper, false) = false
      AND COALESCE(broker_account_mode, 'real') <> 'mock'
      AND COALESCE(execution_mode, 'live') <> 'paper'
      AND ($1::text[] IS NULL OR symbol = ANY($1::text[]))
    ORDER BY paper ASC, updated_at DESC
  `, [symbols.length > 0 ? symbols : null], [], queryErrors);
}

async function loadPaperPositions(symbols = [], queryErrors = []) {
  return querySafe('paper_positions', `
    SELECT symbol, amount, avg_price, unrealized_pnl, updated_at, paper, trade_mode, execution_mode, broker_account_mode
    FROM investment.positions
    WHERE exchange = 'kis_overseas'
      AND COALESCE(amount, 0) <> 0
      AND (
        COALESCE(paper, false) = true
        OR COALESCE(broker_account_mode, '') = 'mock'
        OR COALESCE(execution_mode, '') = 'paper'
      )
      AND ($1::text[] IS NULL OR symbol = ANY($1::text[]))
    ORDER BY updated_at DESC
    LIMIT 50
  `, [symbols.length > 0 ? symbols : null], [], queryErrors);
}

async function loadAgentEvents({ hours, queryErrors }) {
  return querySafe('agent_events', `
    SELECT event_type, team, bot_name, severity, title, created_at
    FROM agent.event_lake
    WHERE created_at >= now() - ($1::text || ' hours')::interval
      AND (
        team IN ('luna', 'investment')
        OR bot_name ILIKE 'luna%'
        OR metadata::text ILIKE '%kis_overseas%'
        OR metadata::text ILIKE '%"exchange":"kis_overseas"%'
        OR metadata::text ILIKE '%"market":"overseas"%'
      )
      AND NOT (team = 'claude' AND event_type = 'port_agent_completed')
    ORDER BY created_at DESC
    LIMIT 50
  `, [hours], [], queryErrors);
}

async function loadLlmRows({ hours, queryErrors }) {
  return querySafe('hub_llm_request_log', `
    SELECT provider, agent, caller_team, selector_key, selected_route, success, duration_ms, error, created_at
    FROM hub.llm_request_log
    WHERE created_at >= now() - ($1::text || ' hours')::interval
      AND (
        caller_team = 'investment'
        OR agent ILIKE '%luna%'
        OR selector_key ILIKE '%luna%'
      )
    ORDER BY created_at DESC
    LIMIT 120
  `, [hours], [], queryErrors);
}

async function realUsdViewExists(queryErrors = []) {
  const rows = await querySafe('v_trades_real_usd_lookup', `SELECT to_regclass('investment.v_trades_real_usd')::text AS regclass`, [], [], queryErrors);
  return Boolean(rows?.[0]?.regclass);
}

function summarizeRows(rows = [], key) {
  const counts = {};
  for (const row of rows || []) {
    const value = String(row?.[key] || 'unknown');
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

export async function buildKisOverseasFunnelTrace(options = {}) {
  const hours = Math.max(1, Number(options.hours || DEFAULT_HOURS) || DEFAULT_HOURS);
  const limit = Math.max(1, Number(options.limit || DEFAULT_LIMIT) || DEFAULT_LIMIT);
  const symbols = compact(options.symbols || []).map((symbol) => symbol.toUpperCase());
  const decisionReport = await buildLunaDecisionFilterReport({
    market: 'overseas',
    exchange: 'kis_overseas',
    hours,
    limit,
    symbols,
    activeCandidates: symbols.length === 0,
  });
  const scopedSymbols = compact([
    ...symbols,
    ...(decisionReport.activeCandidateSymbols || []),
    ...(decisionReport.openPositionSymbols || []),
    ...(decisionReport.top || []).map((item) => item.symbol),
  ]);
  const queryErrors = [];
  const [signalRows, openPositions, paperPositions, agentEvents, llmRows, viewExists] = await Promise.all([
    loadSignals({ hours, symbols: scopedSymbols, queryErrors }),
    loadOpenPositions(scopedSymbols, queryErrors),
    loadPaperPositions(scopedSymbols, queryErrors),
    loadAgentEvents({ hours, queryErrors }),
    loadLlmRows({ hours, queryErrors }),
    realUsdViewExists(queryErrors),
  ]);
  const classification = buildFunnelClassification({
    decisionReport,
    signalRows,
    openPositions,
    llmRows,
    realUsdViewExists: viewExists,
    queryErrors,
  });
  return {
    ok: true,
    status: classification.status,
    exchange: 'kis_overseas',
    market: 'overseas',
    hours,
    limit,
    symbolScope: symbols.length > 0 ? 'explicit_symbols' : 'active_candidates_plus_open_positions',
    dataHealth: {
      vTradesRealUsdViewExists: viewExists,
      signalRows: signalRows.length,
      openPositions: openPositions.length,
      paperPositions: paperPositions.length,
      agentEvents: agentEvents.length,
      llmRows: llmRows.length,
      queryErrors,
    },
    decisionFilter: {
      status: decisionReport.status,
      activeCandidateCoverage: decisionReport.activeCandidateCoverage,
      dailyTechnicalCoverage: decisionReport.dailyTechnicalCoverage,
      entryCapacity: decisionReport.entryCapacity,
      reasonCounts: decisionReport.reasonCounts,
      likelyActionableCount: decisionReport.likelyActionableCount,
      relaxedProbeCount: decisionReport.relaxedProbeCount,
      nearMissWatchCount: decisionReport.nearMissWatchCount,
      bottlenecks: decisionReport.bottlenecks,
    },
    classification,
    openPositions,
    paperPositions,
    recentSignals: signalRows.slice(0, 30),
    agentActivity: {
      eventTypeCounts: summarizeRows(agentEvents, 'event_type'),
      severityCounts: summarizeRows(agentEvents, 'severity'),
      recent: agentEvents.slice(0, 12),
    },
    llmRouteHealth: {
      successCounts: summarizeRows(llmRows.map((row) => ({ ...row, success_key: row.success === true ? 'success' : row.success === false ? 'failure' : 'unknown' })), 'success_key'),
      timeoutCount: llmRows.filter((row) => containsTimeout(row.error)).length,
      recentFailures: llmRows.filter((row) => row.success === false).slice(0, 10),
    },
    generatedAt: new Date().toISOString(),
  };
}

function renderText(report) {
  const lines = [
    `KIS overseas funnel trace (${report.hours}h, scope=${report.symbolScope})`,
    `status=${report.status}`,
    `attention=${report.classification.attention.join(', ') || 'none'}`,
    `entry_capacity=${report.decisionFilter.entryCapacity?.openCount}/${report.decisionFilter.entryCapacity?.maxOpenPositions} remaining=${report.decisionFilter.entryCapacity?.remainingSlots}`,
    `decision_reasons=${Object.entries(report.decisionFilter.reasonCounts || {}).map(([key, value]) => `${key}:${value}`).join(', ') || 'none'}`,
    `primary_causes=${Object.entries(report.classification.primaryCauseCounts || {}).map(([key, value]) => `${key}:${value}`).join(', ') || 'none'}`,
    '',
  ];
  for (const row of report.classification.perSymbol.slice(0, report.limit)) {
    lines.push(`- ${row.symbol}: ${row.primaryCause} fused=${row.fused?.recommendation || 'n/a'} score=${row.fused?.fusedScore ?? 'n/a'} reasons=${(row.reasons || []).join('|') || 'none'}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  const report = await buildKisOverseasFunnelTrace(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderText(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'runtime-kis-overseas-funnel-trace failed:',
  });
}
