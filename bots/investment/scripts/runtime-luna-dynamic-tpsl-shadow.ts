#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { listActiveEntryTriggers } from '../shared/luna-discovery-entry-store.ts';
import { callViaHub } from '../shared/hub-llm-client.ts';
import {
  buildDynamicTpSlJudgeInput,
  buildDynamicTpSlPrompt,
  compareTpSl,
  normalizeDynamicTpSlShadowResult,
} from '../shared/dynamic-tpsl-shadow-judge.ts';
import { evaluateEntryTriggerShadowCandidate } from '../shared/entry-llm-shadow-judge.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const CONFIRM_TOKEN = 'luna-dynamic-tpsl-shadow';
const VALID_EXCHANGES = new Set(['binance', 'kis', 'kis_overseas']);

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseList(value, fallback = []) {
  const list = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return list.length ? list : fallback;
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
  return {
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
    json: argv.includes('--json'),
    confirm: argValue('confirm', '', argv),
    exchanges: [...new Set(parseList(rawExchanges, ['binance']).map(normalizeExchange))],
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

async function latestDynamicTpSlShadow(queryFn, { triggerId, symbol, exchange, ttlMinutes, force }) {
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
       FROM investment.luna_dynamic_tpsl_shadow
      WHERE ${conds.join(' AND ')}
      ORDER BY observed_at DESC
      LIMIT 1`,
    params,
  )).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  return freshEnough(row, ttlMinutes, force) ? row : null;
}

async function latestEntryShadow(queryFn, { triggerId, symbol, exchange }) {
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
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function latestRegimeShadow(queryFn, market) {
  const rows = await Promise.resolve(queryFn(
    `SELECT market, rule_regime, rule_confidence, llm_regime, llm_confidence, captured_at
       FROM investment.luna_regime_llm_shadow
      WHERE market = $1
      ORDER BY captured_at DESC
      LIMIT 1`,
    [market],
  )).catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function buildPositionContext(queryFn, { symbol, exchange }) {
  const rows = await Promise.resolve(queryFn(
    `SELECT symbol, amount, avg_price, unrealized_pnl, paper, execution_mode, broker_account_mode, trade_mode, updated_at
       FROM investment.positions
      WHERE exchange = $1
        AND amount > 0
      ORDER BY updated_at DESC
      LIMIT 100`,
    [exchange],
  )).catch(() => []);
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const livePositions = (Array.isArray(rows) ? rows : []).filter((row) => row?.paper !== true);
  return {
    openPositions: {
      sameSymbolOpen: livePositions.filter((row) => String(row.symbol || '').trim().toUpperCase() === normalizedSymbol).length,
      exchangeOpenPositionCount: livePositions.length,
      openPositionCount: livePositions.length,
    },
  };
}

async function insertDynamicTpSlShadow(runFn, payload) {
  await Promise.resolve(runFn(
    `INSERT INTO investment.luna_dynamic_tpsl_shadow
       (trigger_id, symbol, exchange, market, entry_price, side,
        rule_tp_pct, rule_sl_pct, rule_tp_price, rule_sl_price,
        llm_tp_pct, llm_sl_pct, llm_tp_price, llm_sl_price,
        rr_ratio, reasoning, risk_assessment, rule_tpsl, context_evidence,
        shadow_only, match)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20,$21)`,
    [
      payload.triggerId,
      payload.symbol,
      payload.exchange,
      payload.market,
      payload.entryPrice,
      payload.side,
      payload.ruleTpSl.tpPct,
      payload.ruleTpSl.slPct,
      payload.ruleTpSl.takeProfit,
      payload.ruleTpSl.stopLoss,
      payload.llmTpSl.tpPct,
      payload.llmTpSl.slPct,
      payload.llmTpSl.takeProfit,
      payload.llmTpSl.stopLoss,
      payload.llmTpSl.rrRatio,
      payload.llmTpSl.reasoning,
      JSON.stringify(payload.llmTpSl.riskAssessment || {}),
      JSON.stringify(payload.ruleTpSl || {}),
      JSON.stringify(payload.contextEvidence || {}),
      true,
      payload.match,
    ],
  ));
}

function candidateFromTrigger(trigger = {}, exchange = 'binance') {
  const blockMeta = typeof trigger.trigger_meta === 'object' && trigger.trigger_meta
    ? trigger.trigger_meta
    : {};
  const hints = trigger.trigger_context?.hints || blockMeta.entryTrigger?.hints || {};
  return {
    symbol: trigger.symbol,
    exchange,
    market: marketForExchange(exchange),
    side: 'BUY',
    confidence: Number(trigger.confidence || 0),
    predictiveScore: Number(trigger.predictive_score || 0),
    entry_price: blockMeta.entry_price ?? blockMeta.entryPrice ?? trigger.entry_price ?? null,
    target_price: trigger.target_price ?? blockMeta.target_price ?? blockMeta.targetPrice ?? blockMeta.event?.targetPrice ?? null,
    stop_loss: trigger.stop_loss ?? blockMeta.stop_loss ?? blockMeta.stopLoss ?? null,
    take_profit: trigger.take_profit ?? blockMeta.take_profit ?? blockMeta.takeProfit ?? null,
    atr: blockMeta.atr ?? blockMeta.atr_value ?? hints.atr ?? null,
    setup_type: trigger.setup_type || trigger.strategy_family || blockMeta.setupType || null,
    trigger_type: trigger.trigger_type || null,
    block_meta: blockMeta,
  };
}

function buildEntryShadowPreview(trigger = {}, { market, regimeShadow, contextEvidence } = {}) {
  try {
    const evaluated = evaluateEntryTriggerShadowCandidate(trigger, {
      market,
      regimeShadow,
      contextEvidence,
    });
    const deterministic = evaluated?.input?.deterministic || {};
    return {
      source: 'phase2_deterministic_preview',
      trigger_id: trigger.id || null,
      symbol: trigger.symbol || null,
      exchange: trigger.exchange || null,
      market,
      trigger_type: trigger.trigger_type || null,
      llm_fire: null,
      llm_confidence: null,
      dynamic_threshold: deterministic.fixedThreshold ?? null,
      deterministic_fire: deterministic.fire ?? null,
      deterministic_reason: deterministic.reason || null,
      deterministic_confidence: deterministic.confidence ?? null,
      fixed_threshold: deterministic.fixedThreshold ?? null,
      n_agent_debate: evaluated?.debate || {},
      observed_at: null,
    };
  } catch {
    return null;
  }
}

async function analyzeTrigger(trigger, options, deps, budget) {
  const queryFn = deps.query || db.query;
  const runFn = deps.run || db.run;
  const llmCaller = deps.callViaHub || callViaHub;
  const exchange = normalizeExchange(trigger.exchange || options.exchange || 'binance');
  const market = marketForExchange(exchange);
  const symbol = trigger.symbol;
  const fresh = await latestDynamicTpSlShadow(queryFn, {
    triggerId: trigger.id,
    symbol,
    exchange,
    ttlMinutes: options.ttlMinutes,
    force: options.force,
  });
  if (fresh) {
    return {
      triggerId: trigger.id,
      symbol,
      exchange,
      market,
      status: 'skipped',
      reason: 'fresh_shadow_exists',
      llmCalled: false,
      written: false,
      shadowObservedAt: fresh.observed_at || null,
    };
  }

  const [entryShadowRow, regimeShadow, positionContext] = await Promise.all([
    latestEntryShadow(queryFn, { triggerId: trigger.id, symbol, exchange }),
    latestRegimeShadow(queryFn, market),
    buildPositionContext(queryFn, { symbol, exchange }),
  ]);
  const candidate = candidateFromTrigger(trigger, exchange);
  const entryShadowPreview = entryShadowRow
    ? null
    : buildEntryShadowPreview(trigger, { market, regimeShadow, contextEvidence: positionContext });
  const entryShadow = entryShadowRow || entryShadowPreview;
  const entryShadowSource = entryShadowRow ? 'db' : (entryShadowPreview ? 'deterministic_preview' : 'missing');
  const input = buildDynamicTpSlJudgeInput({
    candidate,
    entryShadow,
    regimeShadow,
    contextEvidence: positionContext,
  });
  const ruleTpSl = input.ruleTpSl;
  if (!ruleTpSl.ok) {
    return {
      triggerId: trigger.id,
      symbol,
      exchange,
      market,
      status: 'skipped',
      reason: ruleTpSl.reason || 'rule_tpsl_not_ready',
      ruleTpSl,
      llmCalled: false,
      written: false,
    };
  }
  if (!options.apply || options.confirm !== CONFIRM_TOKEN) {
    return {
      triggerId: trigger.id,
      symbol,
      exchange,
      market,
      status: 'planned',
      reason: 'apply_confirm_required',
      ruleTpSl,
      entryShadowReady: Boolean(entryShadow),
      entryShadowSource,
      regimeShadowReady: Boolean(regimeShadow),
      contextEvidence: positionContext,
      llmCalled: false,
      written: false,
    };
  }
  if (budget.llmCalls >= options.maxLlmCalls) {
    return {
      triggerId: trigger.id,
      symbol,
      exchange,
      market,
      status: 'skipped',
      reason: 'llm_call_cap_reached',
      ruleTpSl,
      llmCalled: false,
      written: false,
    };
  }

  budget.llmCalls += 1;
  const llm = await Promise.resolve(llmCaller(
    'luna',
    'Luna Phase 3 dynamic TP/SL shadow judge',
    buildDynamicTpSlPrompt(input),
    {
      market,
      taskType: 'dynamic_tpsl_shadow',
      urgency: 'low',
      maxTokens: 900,
      timeoutMs: 60_000,
    },
  )).catch((error) => ({ ok: false, error: error?.message || String(error) }));

  if (!llm.ok) {
    return {
      triggerId: trigger.id,
      symbol,
      exchange,
      market,
      status: 'degraded',
      reason: 'llm_call_failed',
      error: redactError(llm.error || 'unknown'),
      ruleTpSl,
      llmCalled: true,
      written: false,
    };
  }

  let llmTpSl;
  try {
    llmTpSl = normalizeDynamicTpSlShadowResult(llm.text, {
      entryPrice: ruleTpSl.entryPrice,
      side: ruleTpSl.side,
      tpPct: ruleTpSl.tpPct,
      slPct: ruleTpSl.slPct,
    });
  } catch (error) {
    return {
      triggerId: trigger.id,
      symbol,
      exchange,
      market,
      status: 'degraded',
      reason: 'llm_parse_failed',
      error: redactError(error?.message || error),
      ruleTpSl,
      llmCalled: true,
      written: false,
    };
  }
  const comparison = compareTpSl(ruleTpSl, llmTpSl);
  await insertDynamicTpSlShadow(runFn, {
    triggerId: trigger.id,
    symbol,
    exchange,
    market,
    entryPrice: ruleTpSl.entryPrice,
    side: ruleTpSl.side,
    ruleTpSl,
    llmTpSl,
    contextEvidence: {
      ...positionContext,
      entryShadow: input.entryShadow,
      regime: {
        ruleRegime: regimeShadow?.rule_regime || null,
        llmRegime: regimeShadow?.llm_regime || null,
        capturedAt: regimeShadow?.captured_at || null,
      },
    },
    match: comparison.match,
  });

  return {
    triggerId: trigger.id,
    symbol,
    exchange,
    market,
    status: 'written',
    ruleTpSl,
    llmTpSl,
    match: comparison.match,
    comparison,
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

export async function runLunaDynamicTpSlShadow(options = parseArgs(), deps = {}) {
  if (process.env.LUNA_DYNAMIC_TPSL_SHADOW_ENABLED === 'false') {
    return {
      ok: true,
      status: 'luna_dynamic_tpsl_shadow_disabled',
      apply: options.apply,
      confirmRequired: CONFIRM_TOKEN,
      rows: [],
    };
  }
  const initSchema = deps.initSchema || db.initSchema;
  if (options.apply && options.confirm === CONFIRM_TOKEN && initSchema) {
    await Promise.resolve(initSchema()).catch(() => null);
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
      ? 'luna_dynamic_tpsl_shadow_written'
      : degraded > 0
        ? 'luna_dynamic_tpsl_shadow_degraded'
        : planned > 0
          ? 'luna_dynamic_tpsl_shadow_planned'
          : 'luna_dynamic_tpsl_shadow_skipped',
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
  const result = await runLunaDynamicTpSlShadow(parseArgs());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status} written=${result.summary?.written || 0} planned=${result.summary?.planned || 0}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna dynamic TP/SL shadow 오류:',
  });
}
