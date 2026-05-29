#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { executeSignal } from '../shared/signal.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaSampleBiasReport } from './luna-sample-bias-report.ts';

const CONFIRM = 'luna-paper-data-collection';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function boolValue(value: any, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'active'].includes(String(value).trim().toLowerCase());
}

function normalizeSymbol(symbol: any = '') {
  return String(symbol || '').trim().toUpperCase();
}

function normalizeMarket(market: any = '') {
  const text = String(market || '').trim().toLowerCase();
  if (['crypto', 'binance'].includes(text)) return 'crypto';
  if (['domestic', 'domestic_stock', 'kis'].includes(text)) return 'domestic_stock';
  if (['overseas', 'overseas_stock', 'kis_overseas'].includes(text)) return 'overseas_stock';
  return text || 'crypto';
}

function exchangeFor(row = {}) {
  if (row.exchange) return row.exchange;
  const market = normalizeMarket(row.market);
  if (market === 'domestic_stock') return 'kis';
  if (market === 'overseas_stock') return 'kis_overseas';
  return 'binance';
}

function fixtureCandidates(now = new Date().toISOString()) {
  return [
    { id: 101, symbol: 'ETH/USDT', market: 'crypto', exchange: 'binance', candidate_score: 0.82, recommended_action: 'monitor_pass_candidate', observed_at: now, evidence: { regime: 'ranging', strategy_family: 'mean_reversion' } },
    { id: 102, symbol: 'BTC/USDT', market: 'crypto', exchange: 'binance', candidate_score: 0.91, recommended_action: 'monitor_pass_candidate', observed_at: now, evidence: { regime: 'trending_bull', strategy_family: 'trend' } },
    { id: 103, symbol: '005930', market: 'domestic_stock', exchange: 'kis', candidate_score: 0.77, recommended_action: 'monitor_pass_candidate', observed_at: now, evidence: { regime: 'ranging', strategy_family: 'fundamental' } },
  ];
}

export function buildPaperDataCollectionSignal(row = {}, {
  amountUsdt = 10,
  reason = 'monitor_pass_candidate',
} = {}) {
  const symbol = normalizeSymbol(row.symbol);
  const exchange = exchangeFor(row);
  const market = normalizeMarket(row.market || exchange);
  const score = Number(row.candidate_score ?? row.candidateScore ?? row.score ?? 0);
  const evidence = row.evidence && typeof row.evidence === 'object' ? row.evidence : {};
  return {
    id: `PAPER-DATA-${row.id ?? symbol}-${Date.now()}`,
    symbol,
    exchange,
    market,
    action: 'BUY',
    amount_usdt: Number(amountUsdt),
    amountUsdt: Number(amountUsdt),
    confidence: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0.5,
    reasoning: `paper data collection from ${reason}`,
    dataCollectionPaper: true,
    trade_mode: 'paper_data',
    market_regime: evidence.market_regime || evidence.regime || row.market_regime || null,
    strategy_family: evidence.strategy_family || row.strategy_family || null,
    strategy_route: {
      source: 'luna_candidate_bottleneck_shadow',
      candidateId: row.id ?? null,
      recommendedAction: row.recommended_action || row.recommendedAction || reason,
      paperBypassesBacktestGate: true,
      paperSkipsCapitalGuard: true,
    },
  };
}

function dataQualityCheck(row = {}) {
  const symbol = normalizeSymbol(row.symbol);
  const exchange = exchangeFor(row);
  if (!symbol) return { ok: false, reason: 'symbol_missing' };
  if (exchange !== 'binance') return { ok: false, reason: `unsupported_exchange:${exchange}` };
  if (String(row.recommended_action || row.recommendedAction || '') !== 'monitor_pass_candidate') {
    return { ok: false, reason: 'not_monitor_pass_candidate' };
  }
  return { ok: true };
}

async function loadMonitorPassCandidates({ hours = 24, limit = 50, market = null } = {}) {
  const marketWhere = market ? `AND market = ?` : '';
  const params = market ? [hours, market, limit] : [hours, limit];
  return db.query(
    `SELECT DISTINCT ON (symbol, market)
            id, symbol, market, exchange, candidate_score, recommended_action,
            reasons, evidence, observed_at
      FROM investment.luna_candidate_bottleneck_shadow
      WHERE observed_at >= NOW() - (?::text || ' hours')::interval
        AND recommended_action = 'monitor_pass_candidate'
        AND shadow_only IS TRUE
        AND exchange = 'binance'
        ${marketWhere}
      ORDER BY symbol, market, observed_at DESC
      LIMIT ?`,
    params,
  );
}

async function hasOpenLivePosition(row = {}) {
  const symbol = normalizeSymbol(row.symbol);
  const exchange = exchangeFor(row);
  const position = await db.getPosition(symbol, {
    exchange,
    paper: false,
    tradeMode: 'normal',
  }).catch(() => null);
  return Number(position?.amount || 0) > 0;
}

async function hasRecentPaperPosition(row = {}, cooldownHours = 24) {
  const symbol = normalizeSymbol(row.symbol);
  const exchange = exchangeFor(row);
  const sinceMs = Date.now() - (Number(cooldownHours) * 60 * 60 * 1000);
  const found = await db.get(
    `SELECT trade_id
       FROM investment.trade_journal
      WHERE symbol = ?
        AND exchange = ?
        AND is_paper = true
        AND trade_mode = 'paper_data'
        AND entry_time >= ?
      ORDER BY entry_time DESC
      LIMIT 1`,
    [symbol, exchange, sinceMs],
  ).catch(() => null);
  return Boolean(found?.trade_id);
}

function buildRankedCandidates(rows: any[] = [], biasReport: any = {}, {
  epsilon = 0.2,
  rng = Math.random,
} = {}) {
  const preferredSymbols = new Set(biasReport?.diversityInputs?.preferredUnderSampledSymbols || []);
  const preferredRegimes = new Set(biasReport?.diversityInputs?.preferredRegimes || []);
  const preferredStrategies = new Set(biasReport?.diversityInputs?.preferredStrategies || []);
  const explore = [];
  const exploit = [];
  for (const row of rows) {
    const evidence = row.evidence && typeof row.evidence === 'object' ? row.evidence : {};
    const symbol = normalizeSymbol(row.symbol);
    const regime = evidence.market_regime || evidence.regime || row.market_regime || '';
    const strategy = evidence.strategy_family || row.strategy_family || '';
    const diversityScore = Number(preferredSymbols.has(symbol))
      + Number(preferredRegimes.has(regime))
      + Number(preferredStrategies.has(strategy));
    const ranked = {
      ...row,
      symbol,
      diversityScore,
      candidateScore: Number(row.candidate_score ?? row.candidateScore ?? 0),
      explorationSelected: false,
    };
    if (rng() < epsilon) {
      ranked.explorationSelected = true;
      explore.push(ranked);
    } else {
      exploit.push(ranked);
    }
  }
  const sorter = (a, b) => b.diversityScore - a.diversityScore
    || b.candidateScore - a.candidateScore
    || a.symbol.localeCompare(b.symbol);
  return [...explore.sort(sorter), ...exploit.sort(sorter)];
}

export async function runLunaPaperDataCollectionRouter(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const enabled = options.enabled ?? boolValue(process.env.LUNA_PAPER_DATA_COLLECTION_ENABLED, false);
  const confirm = String(options.confirm || '');
  const fixture = options.fixture === true;
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_PAPER_DATA_COLLECTION_LIMIT || 5));
  const hours = Math.max(1, Number(options.hours || process.env.LUNA_PAPER_DATA_COLLECTION_LOOKBACK_HOURS || 24));
  const cooldownHours = Math.max(1, Number(options.cooldownHours || process.env.LUNA_PAPER_DATA_COLLECTION_COOLDOWN_HOURS || 24));
  const amountUsdt = Math.max(1, Number(options.amountUsdt || process.env.LUNA_PAPER_DATA_COLLECTION_AMOUNT_USDT || 10));
  const epsilon = Math.max(0, Math.min(1, Number(options.epsilon ?? process.env.LUNA_PAPER_DATA_COLLECTION_EPSILON ?? 0.2)));
  const market = options.market ? normalizeMarket(options.market) : null;

  if (apply && confirm !== CONFIRM) {
    throw new Error(`runtime:luna-paper-data-collection-router apply requires --confirm=${CONFIRM}`);
  }
  if (apply && enabled !== true) {
    throw new Error('LUNA_PAPER_DATA_COLLECTION_ENABLED must be true for apply mode');
  }

  const candidates = fixture
    ? fixtureCandidates()
    : deps.loadCandidates
      ? await deps.loadCandidates({ hours, limit, market })
      : await loadMonitorPassCandidates({ hours, limit: Math.max(limit * 5, limit), market });
  const biasReport = deps.loadBiasReport
    ? await deps.loadBiasReport()
    : await runLunaSampleBiasReport({ fixture, days: 14, limit: 5000, minSamples: 3 });
  const ranked = buildRankedCandidates(candidates, biasReport, {
    epsilon,
    rng: deps.rng || Math.random,
  });

  const plans = [];
  for (const row of ranked) {
    if (plans.filter((plan) => plan.action === 'execute_paper').length >= limit) break;
    const quality = dataQualityCheck(row);
    if (!quality.ok) {
      plans.push({ symbol: normalizeSymbol(row.symbol), action: 'skip', reason: quality.reason, row });
      continue;
    }
    const liveOpen = deps.hasOpenLivePosition
      ? await deps.hasOpenLivePosition(row)
      : fixture ? false : await hasOpenLivePosition(row);
    if (liveOpen) {
      plans.push({ symbol: normalizeSymbol(row.symbol), action: 'skip', reason: 'live_position_exists', row });
      continue;
    }
    const recentPaper = deps.hasRecentPaperPosition
      ? await deps.hasRecentPaperPosition(row, cooldownHours)
      : fixture ? false : await hasRecentPaperPosition(row, cooldownHours);
    if (recentPaper) {
      plans.push({ symbol: normalizeSymbol(row.symbol), action: 'skip', reason: 'paper_cooldown_active', row });
      continue;
    }
    const signal = buildPaperDataCollectionSignal(row, { amountUsdt });
    plans.push({
      symbol: signal.symbol,
      action: 'execute_paper',
      dryRun,
      enabled,
      explorationSelected: row.explorationSelected === true,
      diversityScore: row.diversityScore || 0,
      signal,
    });
  }

  const executions = [];
  if (apply && !dryRun) {
    for (const plan of plans.filter((item) => item.action === 'execute_paper')) {
      const executor = deps.executeSignal || executeSignal;
      executions.push(await executor(plan.signal));
    }
  }

  const summary = {
    candidates: candidates.length,
    planned: plans.length,
    executable: plans.filter((plan) => plan.action === 'execute_paper').length,
    skipped: plans.filter((plan) => plan.action === 'skip').length,
    executed: executions.length,
    liveMutation: false,
    paperOnly: true,
    dryRun,
    enabled,
    epsilon,
    amountUsdt,
  };

  return {
    ok: true,
    status: apply ? 'luna_paper_data_collection_applied' : 'luna_paper_data_collection_planned',
    gate: 'LUNA_PAPER_DATA_COLLECTION_ENABLED',
    apply,
    dryRun,
    enabled,
    confirmRequired: CONFIRM,
    summary,
    plans,
    executions,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaPaperDataCollectionRouter({
      json: hasFlag('json'),
      fixture: hasFlag('fixture'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      enabled: process.env.LUNA_PAPER_DATA_COLLECTION_ENABLED === undefined
        ? undefined
        : boolValue(process.env.LUNA_PAPER_DATA_COLLECTION_ENABLED, false),
      limit: Number(argValue('limit', process.env.LUNA_PAPER_DATA_COLLECTION_LIMIT || 5)),
      hours: Number(argValue('hours', process.env.LUNA_PAPER_DATA_COLLECTION_LOOKBACK_HOURS || 24)),
      cooldownHours: Number(argValue('cooldown-hours', process.env.LUNA_PAPER_DATA_COLLECTION_COOLDOWN_HOURS || 24)),
      amountUsdt: Number(argValue('amount-usdt', process.env.LUNA_PAPER_DATA_COLLECTION_AMOUNT_USDT || 10)),
      epsilon: Number(argValue('epsilon', process.env.LUNA_PAPER_DATA_COLLECTION_EPSILON || 0.2)),
      market: argValue('market', null),
      confirm: argValue('confirm', ''),
    }),
    onSuccess: async (result) => {
      if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`[luna-paper-data-router] ${result.status} executable=${result.summary.executable} skipped=${result.summary.skipped} dryRun=${result.dryRun}`);
      }
    },
    errorPrefix: 'runtime-luna-paper-data-collection-router error:',
  });
}
