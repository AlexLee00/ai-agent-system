#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { ACTIONS, ANALYST_TYPES } from '../shared/signal.ts';
import {
  buildAnalystWeights,
  fuseSignals,
  getMinConfidence,
} from '../shared/luna-decision-policy.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const DEFAULT_HOURS = 2;
const STOCK_EXCHANGES = new Set(['kis', 'kis_overseas']);
const TECHNICAL_ANALYSTS = new Set([ANALYST_TYPES.TA_MTF, ANALYST_TYPES.TA]);
const NEWS_LIKE_ANALYSTS = new Set([ANALYST_TYPES.NEWS, ANALYST_TYPES.SENTINEL]);

function parseArgs(argv = process.argv.slice(2)) {
  const symbolArg = argv.find((arg) => arg.startsWith('--symbols='))?.split('=').slice(1).join('=') || '';
  return {
    json: argv.includes('--json'),
    activeCandidates: argv.includes('--active-candidates'),
    market: argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'crypto',
    exchange: argv.find((arg) => arg.startsWith('--exchange='))?.split('=')[1] || 'binance',
    hours: Math.max(1, Number(argv.find((arg) => arg.startsWith('--hours='))?.split('=')[1] || DEFAULT_HOURS) || DEFAULT_HOURS),
    limit: Math.max(1, Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 12) || 12),
    symbols: symbolArg
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean),
  };
}

function normalizeCandidateSymbol(symbol, market = 'crypto') {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return raw;
  if (market === 'crypto' && !raw.includes('/') && raw.endsWith('USDT')) return `${raw.slice(0, -4)}/USDT`;
  return raw;
}

function candidateSymbolSqlFilter(market = 'crypto') {
  if (market === 'domestic') return `symbol ~ '^[0-9]{6}$'`;
  if (market === 'overseas') return `symbol !~ '/' AND symbol !~ '^[0-9]{6}$' AND symbol ~ '^[A-Za-z][A-Za-z0-9.\\-]{0,12}$'`;
  return `(symbol ~ '^[A-Za-z0-9]+/USDT$' OR symbol ~ '^[A-Za-z0-9]+USDT$')`;
}

function normalizeAction(value) {
  const action = String(value || ACTIONS.HOLD).trim().toUpperCase();
  if (action === ACTIONS.BUY || action === ACTIONS.SELL || action === ACTIONS.HOLD) return action;
  if (action === 'LONG') return ACTIONS.BUY;
  if (action === 'SHORT') return ACTIONS.SELL;
  return ACTIONS.HOLD;
}

function normalizeAnalysis(row = {}) {
  return {
    ...row,
    symbol: String(row.symbol || '').trim().toUpperCase(),
    analyst: String(row.analyst || '').trim(),
    signal: normalizeAction(row.signal),
    confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 0.5))),
    reasoning: row.reasoning || '',
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    created_at: row.created_at || row.createdAt || null,
  };
}

function latestByAnalyst(analyses = []) {
  const byAnalyst = new Map();
  for (const analysis of analyses.map(normalizeAnalysis)) {
    if (!analysis.symbol || !analysis.analyst) continue;
    if (!byAnalyst.has(analysis.analyst)) {
      byAnalyst.set(analysis.analyst, analysis);
      continue;
    }
    const prev = byAnalyst.get(analysis.analyst);
    const prevTime = Date.parse(prev?.created_at || 0) || 0;
    const nextTime = Date.parse(analysis?.created_at || 0) || 0;
    if (nextTime >= prevTime) byAnalyst.set(analysis.analyst, analysis);
  }
  return [...byAnalyst.values()];
}

function findAnalyst(analyses, candidates) {
  const candidateSet = new Set(candidates);
  return analyses.find((analysis) => candidateSet.has(analysis.analyst)) || null;
}

function summarizeAnalysts(analyses = []) {
  const bySignal = { BUY: 0, HOLD: 0, SELL: 0 };
  const byAnalyst = {};
  for (const analysis of analyses) {
    bySignal[analysis.signal] = (bySignal[analysis.signal] || 0) + 1;
    byAnalyst[analysis.analyst] = {
      signal: analysis.signal,
      confidence: analysis.confidence,
      reasoning: String(analysis.reasoning || '').slice(0, 180),
    };
  }
  return { bySignal, byAnalyst };
}

function buildFilterReasons(analyses, fused, { exchange, minConfidence }) {
  const reasons = [];
  const buyAnalysts = analyses.filter((analysis) => analysis.signal === ACTIONS.BUY);
  const sellAnalysts = analyses.filter((analysis) => analysis.signal === ACTIONS.SELL);
  const technical = findAnalyst(analyses, [ANALYST_TYPES.TA_MTF, ANALYST_TYPES.TA]);
  const sentiment = findAnalyst(analyses, [ANALYST_TYPES.SENTIMENT, ANALYST_TYPES.SENTINEL]);
  const onchain = findAnalyst(analyses, [ANALYST_TYPES.ONCHAIN]);
  const marketFlow = findAnalyst(analyses, [ANALYST_TYPES.MARKET_FLOW]);
  const hasNewsOnlyBuy = buyAnalysts.length > 0 && buyAnalysts.every((analysis) => NEWS_LIKE_ANALYSTS.has(analysis.analyst));

  if (analyses.length < 2) reasons.push('insufficient_analyst_coverage');
  if (fused.recommendation !== 'LONG') reasons.push('fusion_not_long');
  if (Number(fused.averageConfidence || 0) < minConfidence) reasons.push('average_confidence_below_min');
  if (fused.hasConflict || sellAnalysts.length > 0) reasons.push('conflict_detected');
  if (!technical || technical.signal !== ACTIONS.BUY) reasons.push('technical_not_confirmed');
  if (exchange === 'binance' && (!onchain || onchain.signal !== ACTIONS.BUY)) reasons.push('onchain_not_confirmed');
  if (STOCK_EXCHANGES.has(exchange) && marketFlow && marketFlow.signal !== ACTIONS.BUY) reasons.push('market_flow_not_confirmed');
  if (!sentiment || sentiment.signal !== ACTIONS.BUY) reasons.push('sentiment_not_confirmed');
  if (hasNewsOnlyBuy) reasons.push('news_only_buy');

  return [...new Set(reasons)];
}

function buildRecommendation(reasons = []) {
  if (reasons.includes('news_only_buy')) return 'wait_for_technical_and_flow_confirmation';
  if (reasons.includes('technical_not_confirmed')) return 'wait_for_trend_confirmation';
  if (reasons.includes('onchain_not_confirmed')) return 'wait_for_onchain_confirmation';
  if (reasons.includes('market_flow_not_confirmed')) return 'wait_for_market_flow_confirmation';
  if (reasons.includes('average_confidence_below_min')) return 'keep_threshold_and_collect_more_evidence';
  if (reasons.includes('conflict_detected')) return 'send_to_debate_or_hold';
  if (reasons.includes('insufficient_analyst_coverage')) return 'collect_missing_analysts';
  return 'eligible_for_signal_persistence_review';
}

export function buildDecisionFilterDiagnostics(analysisRows = [], options = {}) {
  const exchange = options.exchange || 'binance';
  const weights = options.weights || buildAnalystWeights(exchange, options);
  const minConfidence = Number(options.minConfidence ?? getMinConfidence(exchange));
  const grouped = new Map();
  for (const row of analysisRows || []) {
    const analysis = normalizeAnalysis(row);
    if (!analysis.symbol) continue;
    if (!grouped.has(analysis.symbol)) grouped.set(analysis.symbol, []);
    grouped.get(analysis.symbol).push(analysis);
  }

  const diagnostics = [];
  for (const [symbol, rows] of grouped.entries()) {
    const analyses = latestByAnalyst(rows);
    const fused = fuseSignals(analyses, weights);
    const reasons = buildFilterReasons(analyses, fused, { exchange, minConfidence });
    const actionability = reasons.length === 0 ? 'likely_actionable' : 'filtered_before_signal';
    const analystSummary = summarizeAnalysts(analyses);
    diagnostics.push({
      symbol,
      exchange,
      actionability,
      recommendation: buildRecommendation(reasons),
      reasons,
      minConfidence,
      fused: {
        recommendation: fused.recommendation,
        fusedScore: Number(Number(fused.fusedScore || 0).toFixed(4)),
        averageConfidence: Number(Number(fused.averageConfidence || 0).toFixed(4)),
        hasConflict: fused.hasConflict === true,
      },
      analystCount: analyses.length,
      analystSummary,
      latestAt: analyses
        .map((analysis) => analysis.created_at)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
    });
  }

  diagnostics.sort((a, b) => {
    const actionabilityScore = (item) => item.actionability === 'likely_actionable' ? 1 : 0;
    return (actionabilityScore(b) - actionabilityScore(a))
      || (Number(b.fused.fusedScore || 0) - Number(a.fused.fusedScore || 0))
      || (Number(b.fused.averageConfidence || 0) - Number(a.fused.averageConfidence || 0));
  });

  return diagnostics;
}

async function queryRecentAnalysis({ exchange, hours, symbols }) {
  const symbolFilter = symbols.length > 0 ? 'AND symbol = ANY($3::text[])' : '';
  const params = symbols.length > 0 ? [exchange, hours, symbols] : [exchange, hours];
  return db.query(
    `SELECT symbol, analyst, signal, confidence, reasoning, metadata, exchange, created_at
     FROM analysis
     WHERE exchange = $1
       AND created_at >= now() - ($2::int * INTERVAL '1 hour')
       ${symbolFilter}
     ORDER BY created_at DESC`,
    params,
  ).catch(() => []);
}

async function queryActiveCandidateSymbols({ market, limit }) {
  const rows = await db.query(
    `SELECT symbol
     FROM candidate_universe
     WHERE market = $1
       AND expires_at > now()
       AND ${candidateSymbolSqlFilter(market)}
     ORDER BY score DESC, discovered_at DESC
     LIMIT $2`,
    [market, Math.max(1, Number(limit || 50))],
  ).catch(() => []);
  return [...new Set((rows || [])
    .map((row) => normalizeCandidateSymbol(row.symbol, market))
    .filter(Boolean))];
}

export async function buildLunaDecisionFilterReport(options = {}) {
  const exchange = options.exchange || 'binance';
  const market = options.market || (exchange === 'kis' ? 'domestic' : exchange === 'kis_overseas' ? 'overseas' : 'crypto');
  const hours = Math.max(1, Number(options.hours || DEFAULT_HOURS));
  const limit = Math.max(1, Number(options.limit || 12));
  await db.initSchema();
  const candidateSymbols = options.activeCandidates
    ? await queryActiveCandidateSymbols({ market, limit: Math.max(limit, 50) })
    : [];
  const requestedSymbols = Array.isArray(options.symbols) ? options.symbols : [];
  const rows = await queryRecentAnalysis({
    exchange,
    hours,
    symbols: candidateSymbols.length > 0 ? candidateSymbols : requestedSymbols,
  });
  const diagnostics = buildDecisionFilterDiagnostics(rows, {
    exchange,
    minConfidence: options.minConfidence,
  });
  const filtered = diagnostics.filter((item) => item.actionability !== 'likely_actionable');
  const likelyActionable = diagnostics.filter((item) => item.actionability === 'likely_actionable');
  const reasonCounts = {};
  for (const item of filtered) {
    for (const reason of item.reasons || []) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }
  return {
    ok: true,
    status: filtered.length > 0 ? 'luna_decision_filter_attention' : 'luna_decision_filter_clear',
    exchange,
    market,
    hours,
    symbolScope: candidateSymbols.length > 0 ? 'active_candidates' : requestedSymbols.length > 0 ? 'explicit_symbols' : 'recent_analysis',
    activeCandidateSymbols: candidateSymbols,
    checkedSymbols: diagnostics.length,
    likelyActionableCount: likelyActionable.length,
    filteredCount: filtered.length,
    reasonCounts,
    top: diagnostics.slice(0, limit),
    generatedAt: new Date().toISOString(),
  };
}

function renderText(report) {
  const lines = [
    `Luna decision filter report (${report.exchange}, ${report.hours}h, scope=${report.symbolScope || 'recent_analysis'})`,
    `status=${report.status} checked=${report.checkedSymbols} likely_actionable=${report.likelyActionableCount} filtered=${report.filteredCount}`,
    `reasons=${Object.entries(report.reasonCounts || {}).map(([key, value]) => `${key}:${value}`).join(', ') || 'none'}`,
    '',
  ];
  for (const item of report.top || []) {
    lines.push(
      `- ${item.symbol}: ${item.actionability} fused=${item.fused.recommendation}/${item.fused.fusedScore} avg=${item.fused.averageConfidence} reasons=${item.reasons.join('|') || 'none'}`,
      `  recommendation=${item.recommendation}`,
    );
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  const report = await buildLunaDecisionFilterReport(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderText(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-decision-filter-report 실패:',
  });
}
