#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { Client } from 'pg';
import { INVESTMENT_SCHEMA, pgPool } from '../shared/db/core.ts';
import { performance } from 'node:perf_hooks';
import { listActiveEntryTriggers } from '../shared/luna-discovery-entry-store.ts';
import { callViaHub } from '../shared/hub-llm-client.ts';
import {
  buildEntryLlmPrompt,
  evaluateRecallLatencyBudget,
  evaluateEntryTriggerShadowCandidate,
  normalizeEntryLlmShadowResult,
} from '../shared/entry-llm-shadow-judge.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { normalizeLunaMarketKey } from '../shared/luna-data-contracts.ts';
import {
  tradeJournalMarketSql,
  tradeJournalNumericIdSql,
} from '../shared/posttrade-trade-journal-adapter.ts';

const CONFIRM_TOKEN = 'luna-entry-llm-shadow';
const VALID_EXCHANGES = new Set(['binance', 'kis', 'kis_overseas']);
const REFLECTION_RECALL_LIMIT = 3;
const REFLECTION_RECALL_MAX_TIMEOUT_MS = 200;

function createCancellationClient() {
  const { max, min, idleTimeoutMillis, allowExitOnIdle, maxUses, ...clientConfig } = pgPool.getPool(INVESTMENT_SCHEMA).options;
  return new Client(clientConfig);
}

export async function cancelPostgresBackend(processId, createClient = createCancellationClient) {
  const client = createClient();
  try {
    await client.connect();
    const result = await client.query('SELECT pg_cancel_backend($1)', [processId]);
    return result.rows || [];
  } finally {
    await client.end().catch(() => {});
  }
}

export async function queryWithStatementTimeout(
  sql,
  params = [],
  { timeoutMs = REFLECTION_RECALL_MAX_TIMEOUT_MS, signal = null } = {},
  withTransactionFn = db.withTransaction,
  cancelBackendFn = cancelPostgresBackend,
) {
  const safeTimeoutMs = Math.max(1, Math.min(
    REFLECTION_RECALL_MAX_TIMEOUT_MS,
    Number(timeoutMs) || REFLECTION_RECALL_MAX_TIMEOUT_MS,
  ));
  return withTransactionFn(async (tx, client) => {
    await tx.query(`SELECT set_config('statement_timeout', $1, true)`, [`${safeTimeoutMs}ms`]);
    if (signal?.aborted) throw signal.reason || new Error('reflection_recall_cancelled');
    let cancelPromise = null;
    const cancelQuery = () => {
      if (!client?.processID || cancelPromise) return;
      cancelPromise = cancelBackendFn(client.processID).catch(() => []);
    };
    signal?.addEventListener('abort', cancelQuery, { once: true });
    try {
      return await tx.query(sql, params);
    } finally {
      signal?.removeEventListener('abort', cancelQuery);
      if (cancelPromise) await cancelPromise;
    }
  });
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseList(value, fallback = []) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index)
    || fallback;
}

function normalizeExchange(value) {
  const exchange = String(value || 'binance').trim().toLowerCase();
  if (exchange === 'crypto') return 'binance';
  if (exchange === 'domestic') return 'kis';
  if (exchange === 'overseas') return 'kis_overseas';
  return VALID_EXCHANGES.has(exchange) ? exchange : 'binance';
}

function marketForExchange(exchange) {
  if (exchange === 'kis') return 'domestic';
  if (exchange === 'kis_overseas') return 'overseas';
  return 'crypto';
}

function reflectionSymbolKey(value) {
  return String(value || '').trim().toUpperCase().split(/[\s|&]/, 1)[0];
}

function parseArgs(argv = process.argv.slice(2)) {
  const rawExchanges = argValue('exchanges', argValue('exchange', 'binance,kis,kis_overseas', argv), argv);
  const exchanges = parseList(rawExchanges).map(normalizeExchange);
  return {
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
    json: argv.includes('--json'),
    confirm: argValue('confirm', '', argv),
    exchanges: [...new Set(exchanges.length ? exchanges : ['binance'])],
    symbol: argValue('symbol', null, argv),
    triggerId: argValue('trigger-id', null, argv),
    limit: Math.max(1, Number(argValue('limit', 10, argv)) || 10),
    hours: Math.max(1, Number(argValue('hours', 24, argv)) || 24),
    ttlMinutes: Math.max(15, Number(argValue('ttl-minutes', 120, argv)) || 120),
    maxLlmCalls: Math.max(0, Number(argValue('max-llm-calls', 3, argv)) || 0),
  };
}

function redactError(value) {
  return String(value || 'unknown')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
    .replace(/(api[_-]?key|token|secret|password)=?[A-Za-z0-9._:-]{8,}/gi, '$1=***')
    .slice(0, 500);
}

function freshEnough(row, ttlMinutes, force = false) {
  if (force || !row?.observed_at) return false;
  const ageMs = Date.now() - new Date(row.observed_at).getTime();
  return ageMs >= 0 && ageMs < ttlMinutes * 60 * 1000;
}

async function latestEntryShadow(queryFn, { triggerId, symbol, exchange, ttlMinutes, force }) {
  const params = [];
  const conds = [];
  if (triggerId) {
    params.push(triggerId);
    conds.push(`trigger_id = $${params.length}`);
  }
  if (symbol) {
    params.push(symbol);
    conds.push(`symbol = $${params.length}`);
  }
  if (exchange) {
    params.push(exchange);
    conds.push(`exchange = $${params.length}`);
  }
  if (conds.length === 0) return null;
  const rows = await Promise.resolve(queryFn(
    `SELECT *
       FROM investment.luna_entry_llm_shadow
      WHERE ${conds.join(' AND ')}
      ORDER BY observed_at DESC
      LIMIT 1`,
    params,
  )).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  return freshEnough(row, ttlMinutes, force) ? row : null;
}

async function latestRegimeShadow(queryFn, market) {
  const rows = await Promise.resolve(queryFn(
    `SELECT market, rule_regime, rule_confidence, llm_regime, llm_confidence, match, captured_at
       FROM investment.luna_regime_llm_shadow
      WHERE market = $1
      ORDER BY captured_at DESC
      LIMIT 1`,
    [market],
  )).catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function insertEntryShadow(runFn, payload) {
  await Promise.resolve(runFn(
    `INSERT INTO investment.luna_entry_llm_shadow
       (trigger_id, symbol, exchange, market, trigger_type,
        deterministic_fire, deterministic_reason, deterministic_confidence,
        rule_regime, llm_regime, llm_fire, llm_confidence,
        dynamic_threshold, position_size_pct, reasoning,
        risk_assessment, n_agent_debate, context_evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb)`,
    [
      payload.triggerId,
      payload.symbol,
      payload.exchange,
      payload.market,
      payload.triggerType,
      payload.deterministic.fire,
      payload.deterministic.reason,
      payload.deterministic.confidence,
      payload.regime?.ruleRegime || null,
      payload.regime?.llmRegime || null,
      payload.llm.fire,
      payload.llm.confidence,
      payload.llm.dynamicThreshold,
      payload.llm.positionSizePct,
      payload.llm.reasoning,
      JSON.stringify(payload.llm.riskAssessment || {}),
      JSON.stringify(payload.debate || {}),
      JSON.stringify(payload.contextEvidence || {}),
    ],
  ));
}

export async function fetchSimilarTradeReflections(queryFn, {
  symbol,
  market,
  setupType = null,
  limit = REFLECTION_RECALL_LIMIT,
  timeoutMs = REFLECTION_RECALL_MAX_TIMEOUT_MS,
  controller: suppliedController = null,
} = {}) {
  const startedAt = performance.now();
  const safeLimit = Math.max(1, Math.min(REFLECTION_RECALL_LIMIT, Number(limit) || REFLECTION_RECALL_LIMIT));
  const safeTimeoutMs = Math.max(1, Math.min(REFLECTION_RECALL_MAX_TIMEOUT_MS, Number(timeoutMs) || REFLECTION_RECALL_MAX_TIMEOUT_MS));
  const normalizedMarket = normalizeLunaMarketKey(market);
  const journalIdExpr = tradeJournalNumericIdSql('tj');
  const journalMarketExpr = tradeJournalMarketSql('tj');
  const controller = suppliedController || new AbortController();
  let timer;
  try {
    if (!suppliedController) {
      timer = setTimeout(() => controller.abort(new Error('reflection_recall_timeout')), safeTimeoutMs);
    }
    const rows = await Promise.resolve(queryFn(
        `WITH current_regime AS (
           SELECT COALESCE(llm_regime, rule_regime) AS regime
             FROM investment.luna_regime_llm_shadow
            WHERE market = $1
            ORDER BY captured_at DESC
            LIMIT 1
         ), candidates AS (
           SELECT tqe.trade_id::text AS trade_id,
                  tqe.sub_score_breakdown->'reflection'->>'text' AS hindsight,
                  tqe.sub_score_breakdown->'reflection'->>'symbol' AS symbol,
                  tqe.sub_score_breakdown->'reflection'->>'market' AS market,
                  tqe.sub_score_breakdown->'reflection'->>'regime' AS regime,
                  tqe.sub_score_breakdown->'reflection'->>'setupType' AS setup_type,
                  tqe.evaluated_at AS created_at
             FROM investment.trade_quality_evaluations tqe
            WHERE jsonb_typeof(tqe.sub_score_breakdown->'reflection') = 'object'
           UNION ALL
           SELECT lfr.trade_id::text,
                  lfr.hindsight,
                  COALESCE(lfr.avoid_pattern->>'symbol', lfr.avoid_pattern->>'symbol_pattern'),
                  COALESCE(
                    lfr.stage_attribution->>'market',
                    lfr.avoid_pattern->>'market',
                    NULLIF(${journalMarketExpr}, 'all')
                  ),
                  COALESCE(lfr.avoid_pattern->>'regime', lfr.stage_attribution->>'regime'),
                  lfr.avoid_pattern->>'setup_type',
                  lfr.created_at
             FROM investment.luna_failure_reflexions lfr
             LEFT JOIN investment.trade_journal tj ON ${journalIdExpr} = lfr.trade_id
            WHERE NULLIF(BTRIM(lfr.hindsight), '') IS NOT NULL
         ), normalized_candidates AS (
           SELECT candidates.*,
                  CASE
                    WHEN LOWER(BTRIM(candidates.market)) IN ('crypto', 'binance') THEN 'crypto'
                    WHEN LOWER(BTRIM(candidates.market)) IN ('domestic', 'stocks', 'stock', 'kis', 'krx') THEN 'domestic'
                    WHEN LOWER(BTRIM(candidates.market)) IN ('overseas', 'kis_overseas') THEN 'overseas'
                    ELSE NULLIF(LOWER(BTRIM(candidates.market)), '')
                  END AS normalized_market,
                  UPPER(REGEXP_REPLACE(BTRIM(candidates.symbol), '[[:space:]|&].*$', '')) AS normalized_symbol
             FROM candidates
         ), scored AS (
           SELECT normalized_candidates.*,
                  (CASE WHEN normalized_candidates.normalized_symbol IN (UPPER($2), UPPER(SPLIT_PART($2, '/', 1))) THEN 4 ELSE 0 END
                   + CASE WHEN normalized_candidates.regime = (SELECT regime FROM current_regime) THEN 2 ELSE 0 END
                   + CASE WHEN $3::text IS NOT NULL AND normalized_candidates.setup_type = $3 THEN 1 ELSE 0 END) AS similarity_score,
                  ROW_NUMBER() OVER (
                    PARTITION BY LOWER(BTRIM(normalized_candidates.hindsight))
                    ORDER BY normalized_candidates.created_at DESC
                  ) AS dedupe_rank
             FROM normalized_candidates
            WHERE normalized_candidates.normalized_market = $1
              AND (normalized_candidates.normalized_symbol IN (UPPER($2), UPPER(SPLIT_PART($2, '/', 1)))
               OR normalized_candidates.regime = (SELECT regime FROM current_regime)
               OR ($3::text IS NOT NULL AND normalized_candidates.setup_type = $3))
         )
         SELECT trade_id, hindsight, symbol, market, regime, setup_type, similarity_score, created_at
           FROM scored
          WHERE dedupe_rank = 1
          ORDER BY similarity_score DESC, created_at DESC
          LIMIT $4`,
        [normalizedMarket, symbol, setupType, safeLimit],
        {
          signal: controller.signal,
          timeoutMs: suppliedController ? REFLECTION_RECALL_MAX_TIMEOUT_MS : safeTimeoutMs,
        },
      ));
    const items = (Array.isArray(rows) ? rows : [])
      .filter((row) => {
        const rowMarket = String(row.market || '').trim();
        return rowMarket.length > 0 && normalizeLunaMarketKey(rowMarket) === normalizedMarket;
      })
      .slice(0, safeLimit)
      .map((row) => ({
        tradeId: row.trade_id,
        text: row.hindsight,
        symbol: row.symbol,
        market: normalizeLunaMarketKey(row.market || normalizedMarket),
        regime: row.regime,
        setupType: row.setup_type,
        similarityScore: Number(row.similarity_score || 0),
      }));
    return {
      status: items.length > 0 ? 'injected' : 'empty',
      items,
      latencyMs: performance.now() - startedAt,
    };
  } catch (error) {
    if (controller.signal.aborted || error?.code === '57014') {
      const reason = String(controller.signal.reason?.message || controller.signal.reason || '');
      const status = reason.includes('budget_exceeded') ? 'budget_exceeded' : 'timeout';
      return { status, items: [], latencyMs: performance.now() - startedAt };
    }
    return { status: 'error', items: [], latencyMs: performance.now() - startedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function buildEntryContextEvidence(queryFn, recallQueryFn, { symbol, exchange, market, setupType, hours }) {
  const safeHours = Math.max(1, Number(hours || 24));
  const startedAt = performance.now();
  const baselineStartedAt = startedAt;
  const [analysisRows, positionRows] = await Promise.all([
    Promise.resolve(queryFn(
      `SELECT analyst, signal, confidence, reasoning, created_at
         FROM investment.analysis
        WHERE symbol = $1
          AND exchange = $2
          AND created_at >= now() - ($3::int * INTERVAL '1 hour')
        ORDER BY created_at DESC
        LIMIT 20`,
      [symbol, exchange, safeHours],
    )).catch(() => []),
    Promise.resolve(queryFn(
      `SELECT symbol, amount, avg_price, unrealized_pnl, paper, execution_mode, broker_account_mode, trade_mode, updated_at
         FROM investment.positions
        WHERE exchange = $1
          AND amount > 0
        ORDER BY updated_at DESC
        LIMIT 100`,
      [exchange],
    )).catch(() => []),
  ]);
  const baselineMs = performance.now() - baselineStartedAt;
  const remainingBudgetMs = Math.max(0, baselineMs * 0.2);
  const recallController = new AbortController();
  let budgetTimer;
  let reflectionRecall;
  if (remainingBudgetMs > 0) {
    const recallPromise = fetchSimilarTradeReflections(recallQueryFn, {
      symbol,
      market,
      setupType,
      timeoutMs: Math.min(REFLECTION_RECALL_MAX_TIMEOUT_MS, remainingBudgetMs),
      controller: recallController,
    });
    reflectionRecall = await Promise.race([
      recallPromise,
      new Promise((resolve) => {
        budgetTimer = setTimeout(() => {
          recallController.abort(new Error('reflection_recall_budget_exceeded'));
          resolve({ status: 'budget_exceeded', items: [], latencyMs: remainingBudgetMs });
        }, remainingBudgetMs);
      }),
    ]);
  } else {
    recallController.abort(new Error('reflection_recall_budget_exceeded'));
    reflectionRecall = { status: 'budget_exceeded', items: [], latencyMs: 0 };
  }
  if (budgetTimer) clearTimeout(budgetTimer);
  const totalMs = performance.now() - startedAt;
  const latencyBudget = evaluateRecallLatencyBudget({ baselineMs, totalMs });
  const boundedRecall = latencyBudget.withinBudget
    ? reflectionRecall
    : { status: 'budget_exceeded', items: [], latencyMs: reflectionRecall.latencyMs || 0 };
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const livePositions = (Array.isArray(positionRows) ? positionRows : []).filter((row) => row?.paper !== true);
  return {
    analysis: {
      recent: (Array.isArray(analysisRows) ? analysisRows : []).map((row) => ({
        analyst: row.analyst,
        signal: row.signal,
        confidence: row.confidence,
        reasoning: row.reasoning,
        createdAt: row.created_at || null,
      })),
    },
    openPositions: {
      sameSymbolOpen: livePositions.filter((row) => String(row.symbol || '').trim().toUpperCase() === normalizedSymbol).length,
      exchangeOpenPositionCount: livePositions.length,
      openPositionCount: livePositions.length,
    },
    reflectionRecall: {
      ...boundedRecall,
      ...latencyBudget,
    },
  };
}

async function analyzeTrigger(trigger, options, deps, budget) {
  const queryFn = deps.query || db.query;
  const recallQueryFn = deps.reflectionRecallQuery
    || (deps.query
      ? queryFn
      : (sql, params, queryOptions) => queryWithStatementTimeout(
        sql,
        params,
        queryOptions,
        deps.withTransaction || db.withTransaction,
      ));
  const runFn = deps.run || db.run;
  const llmCaller = deps.callViaHub || callViaHub;
  const exchange = normalizeExchange(trigger.exchange || options.exchange || 'binance');
  const market = marketForExchange(exchange);
  const fresh = await latestEntryShadow(queryFn, {
    triggerId: trigger.id,
    symbol: trigger.symbol,
    exchange,
    ttlMinutes: options.ttlMinutes,
    force: options.force,
  });
  if (fresh) {
    return {
      triggerId: trigger.id,
      symbol: trigger.symbol,
      exchange,
      market,
      status: 'skipped',
      reason: 'fresh_shadow_exists',
      llmCalled: false,
      written: false,
      shadowObservedAt: fresh.observed_at || null,
    };
  }

  const [regimeShadow, contextEvidence] = await Promise.all([
    latestRegimeShadow(queryFn, market),
    buildEntryContextEvidence(queryFn, recallQueryFn, {
      symbol: trigger.symbol,
      exchange,
      market,
      setupType: trigger.setup_type || null,
      hours: options.hours,
    }),
  ]);
  const evaluation = evaluateEntryTriggerShadowCandidate(trigger, {
    market,
    exchange,
    regimeShadow,
    contextEvidence,
  });
  const input = evaluation.input;
  if (!options.apply || options.confirm !== CONFIRM_TOKEN) {
    return {
      triggerId: trigger.id,
      symbol: trigger.symbol,
      exchange,
      market,
      status: 'planned',
      reason: 'apply_confirm_required',
      deterministic: input.deterministic,
      debate: input.debate,
      contextEvidence: input.contextEvidence,
      llmCalled: false,
      written: false,
    };
  }

  if (budget.llmCalls >= options.maxLlmCalls) {
    return {
      triggerId: trigger.id,
      symbol: trigger.symbol,
      exchange,
      market,
      status: 'skipped',
      reason: 'llm_call_cap_reached',
      deterministic: input.deterministic,
      contextEvidence: input.contextEvidence,
      llmCalled: false,
      written: false,
    };
  }

  budget.llmCalls += 1;
  const llm = await Promise.resolve(llmCaller(
    'luna',
    'Luna Phase 2 entry decision shadow judge',
    buildEntryLlmPrompt(input),
    {
      market,
      taskType: 'entry_decision_shadow',
      urgency: 'low',
      maxTokens: 900,
      timeoutMs: 60_000,
    },
  )).catch((error) => ({ ok: false, error: error?.message || String(error) }));

  if (!llm.ok) {
    return {
      triggerId: trigger.id,
      symbol: trigger.symbol,
      exchange,
      market,
      status: 'degraded',
      reason: 'llm_call_failed',
      error: redactError(llm.error || 'unknown'),
      deterministic: input.deterministic,
      llmCalled: true,
      written: false,
    };
  }

  let parsed;
  try {
    parsed = normalizeEntryLlmShadowResult(llm.text, {
      confidence: input.deterministic.confidence,
      dynamicThreshold: input.deterministic.fixedThreshold,
      positionSizePct: 0.1,
    });
  } catch (error) {
    return {
      triggerId: trigger.id,
      symbol: trigger.symbol,
      exchange,
      market,
      status: 'degraded',
      reason: 'llm_parse_failed',
      error: redactError(error?.message || error),
      deterministic: input.deterministic,
      llmCalled: true,
      written: false,
    };
  }

  await insertEntryShadow(runFn, {
    triggerId: trigger.id,
    symbol: trigger.symbol,
    exchange,
    market,
    triggerType: input.triggerType,
    deterministic: input.deterministic,
    regime: input.regime,
    llm: parsed,
    debate: input.debate,
    contextEvidence: input.contextEvidence,
  });

  return {
    triggerId: trigger.id,
    symbol: trigger.symbol,
    exchange,
    market,
    status: 'written',
    deterministic: input.deterministic,
    llm: parsed,
    match: input.deterministic.fire === parsed.fire,
    contextEvidence: input.contextEvidence,
    llmCalled: true,
    written: true,
  };
}

async function listTriggersForExchange(listFn, { exchange, symbol, triggerId, limit, hours }) {
  const updatedAfter = triggerId
    ? null
    : new Date(Date.now() - Math.max(1, Number(hours || 24)) * 60 * 60 * 1000).toISOString();
  const rows = await Promise.resolve(listFn({
    exchange,
    symbol,
    states: ['armed', 'waiting', 'fired'],
    updatedAfter,
    orderBy: 'updated_desc',
    limit,
  })).catch(() => []);
  const filtered = triggerId ? rows.filter((row) => String(row.id || '') === String(triggerId)) : rows;
  return Array.isArray(filtered) ? filtered : [];
}

export async function runLunaEntryLlmShadow(options = parseArgs(), deps = {}) {
  const initSchema = deps.initSchema || db.initSchema;
  if (initSchema) await Promise.resolve(initSchema()).catch(() => null);
  if (process.env.LUNA_ENTRY_LLM_SHADOW_ENABLED === 'false') {
    return {
      ok: true,
      status: 'luna_entry_llm_shadow_disabled',
      apply: options.apply,
      confirmRequired: CONFIRM_TOKEN,
      rows: [],
    };
  }

  const listFn = deps.listActiveEntryTriggers || listActiveEntryTriggers;
  const rows = [];
  const budget = { llmCalls: 0 };
  for (const exchange of options.exchanges || ['binance']) {
    const triggers = await listTriggersForExchange(listFn, {
      exchange,
      symbol: options.symbol,
      triggerId: options.triggerId,
      limit: options.limit,
      hours: options.hours,
    });
    if (triggers.length === 0) {
      rows.push({
        exchange,
        market: marketForExchange(exchange),
        status: 'skipped',
        reason: 'no_active_entry_triggers',
        llmCalled: false,
        written: false,
      });
      continue;
    }
    for (const trigger of triggers) {
      rows.push(await analyzeTrigger(trigger, { ...options, exchange }, deps, budget));
    }
  }

  const written = rows.filter((row) => row.written).length;
  const planned = rows.filter((row) => row.status === 'planned').length;
  const degraded = rows.filter((row) => row.status === 'degraded').length;
  const skipped = rows.filter((row) => row.status === 'skipped').length;
  return {
    ok: true,
    status: written > 0
      ? 'luna_entry_llm_shadow_written'
      : degraded > 0
        ? 'luna_entry_llm_shadow_degraded'
        : planned > 0
          ? 'luna_entry_llm_shadow_planned'
          : 'luna_entry_llm_shadow_skipped',
    apply: options.apply,
    confirmRequired: CONFIRM_TOKEN,
    ttlMinutes: options.ttlMinutes,
    maxLlmCalls: options.maxLlmCalls,
    summary: {
      rows: rows.length,
      written,
      planned,
      degraded,
      skipped,
      llmCalls: budget.llmCalls,
    },
    rows,
  };
}

async function main() {
  const result = await runLunaEntryLlmShadow(parseArgs());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status} written=${result.summary?.written || 0} planned=${result.summary?.planned || 0}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry LLM shadow 오류:',
  });
}
