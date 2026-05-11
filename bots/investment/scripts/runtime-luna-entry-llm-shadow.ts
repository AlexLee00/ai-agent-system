#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { listActiveEntryTriggers } from '../shared/luna-discovery-entry-store.ts';
import { callViaHub } from '../shared/hub-llm-client.ts';
import {
  buildEntryLlmPrompt,
  evaluateEntryTriggerShadowCandidate,
  normalizeEntryLlmShadowResult,
} from '../shared/entry-llm-shadow-judge.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const CONFIRM_TOKEN = 'luna-entry-llm-shadow';
const VALID_EXCHANGES = new Set(['binance', 'kis', 'kis_overseas']);

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

async function buildEntryContextEvidence(queryFn, { symbol, exchange, hours }) {
  const safeHours = Math.max(1, Number(hours || 24));
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
  };
}

async function analyzeTrigger(trigger, options, deps, budget) {
  const queryFn = deps.query || db.query;
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
    buildEntryContextEvidence(queryFn, {
      symbol: trigger.symbol,
      exchange,
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
