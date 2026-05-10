#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  evaluateActiveEntryTriggersAgainstMarketEvents,
  refreshEntryTriggersFromRecentBuySignals,
} from '../shared/entry-trigger-engine.ts';
import { buildEntryTriggerAgentPlan } from '../shared/entry-trigger-agent-plan.ts';
import { getLunaBuyingPowerSnapshot } from '../shared/capital-manager.ts';
import { getRecentSignalDuplicate, insertSignal, mergeSignalBlockMeta } from '../shared/db/signals.ts';
import { get as dbGet } from '../shared/db/core.ts';
import { getLunaIntelligentDiscoveryFlags } from '../shared/luna-intelligent-discovery-config.ts';
import { listActiveEntryTriggers, updateEntryTriggerState } from '../shared/luna-discovery-entry-store.ts';
import { getOHLCV } from '../shared/ohlcv-fetcher.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const DEFAULT_HEARTBEAT_PATH = path.join(INVESTMENT_DIR, 'output', 'ops', 'luna-entry-trigger-worker-heartbeat.json');
const LAUNCHCTL_ENV_KEYS = [
  'LUNA_ENTRY_TRIGGER_ENGINE_ENABLED',
  'LUNA_INTELLIGENT_DISCOVERY_MODE',
  'LUNA_LIVE_FIRE_ENABLED',
  'LUNA_PREDICTIVE_VALIDATION_ENABLED',
  'LUNA_PREDICTIVE_VALIDATION_MODE',
  'LUNA_PREDICTIVE_REQUIRE_COMPONENTS',
  'LUNA_ENTRY_TRIGGER_FIRE_IN_AUTONOMOUS',
  'LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE',
  'LUNA_TRADINGVIEW_ENTRY_GUARD_ENABLED',
  'LUNA_TRADINGVIEW_ENTRY_GUARD_REQUIRE_REAL',
  'LUNA_TRADINGVIEW_ENTRY_GUARD_TIMEFRAME',
  'LUNA_TRADINGVIEW_ENTRY_MIN_CHANGE_PCT_24H',
  'LUNA_TRADINGVIEW_ENTRY_MIN_CANDLE_CHANGE_PCT',
  'LUNA_TRADINGVIEW_ENTRY_MAX_AGE_MS',
  'LUNA_TRADINGVIEW_ENTRY_GUARD_DIRECT_HTTP_FALLBACK',
  'LUNA_ENTRY_CHART_GUARD_MARKETS',
  'LUNA_ENTRY_TRIGGER_SIGNAL_REFRESH_ENABLED',
  'LUNA_ENTRY_TRIGGER_SIGNAL_REFRESH_HOURS',
  'LUNA_ENTRY_TRIGGER_SIGNAL_REFRESH_LIMIT',
];

function hydrateEntryTriggerEnvFromLaunchctl() {
  const preferProcessEnv = String(process.env.LUNA_RUNTIME_ENV_SOURCE || '').trim().toLowerCase() === 'process';
  for (const key of LAUNCHCTL_ENV_KEYS) {
    try {
      const value = execFileSync('launchctl', ['getenv', key], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (value && (!preferProcessEnv || !String(process.env[key] || '').trim())) {
        process.env[key] = value;
      }
    } catch {
      // Manual runs outside launchd should still work with explicit env or safe defaults.
    }
  }
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseEvents() {
  const raw = argValue('--events-json', process.env.LUNA_ENTRY_TRIGGER_EVENTS_JSON || '[]');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw new Error(`invalid_events_json: ${error?.message || error}`);
  }
}

function parseJsonObjectArg(rawValue: string, source: string) {
  try {
    const parsed = JSON.parse(String(rawValue || '').trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('agent plan must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`invalid ${source}: ${error?.message || error}`);
  }
}

function readAgentPlanArg() {
  const rawJson = argValue('--agent-plan-json', null);
  if (rawJson) return parseJsonObjectArg(rawJson, 'agent plan json');
  const rawFile = argValue('--agent-plan-file', null);
  if (!rawFile) return null;
  const filePath = path.isAbsolute(rawFile) ? rawFile : path.resolve(process.cwd(), rawFile);
  return parseJsonObjectArg(fs.readFileSync(filePath, 'utf8'), `agent plan file ${filePath}`);
}

function hasFlag(name) {
  return process.argv.includes(name) || String(process.env.LUNA_ENTRY_TRIGGER_DERIVE_MARKET_EVENTS || '').trim().toLowerCase() === 'true';
}

function isoDaysAgo(days = 1) {
  return new Date(Date.now() - Math.max(1, Number(days || 1)) * 24 * 3600_000).toISOString().slice(0, 10);
}

function latestClose(candles = []) {
  const row = Array.isArray(candles) ? candles[candles.length - 1] : null;
  const close = Number(row?.[4]);
  return Number.isFinite(close) && close > 0 ? close : null;
}

function heartbeatPath() {
  return argValue('--heartbeat-path', process.env.LUNA_ENTRY_TRIGGER_HEARTBEAT_PATH || DEFAULT_HEARTBEAT_PATH);
}

function shouldWriteHeartbeat() {
  const raw = String(process.env.LUNA_ENTRY_TRIGGER_WRITE_HEARTBEAT ?? 'true').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

function materializeSignalsEnabled() {
  const raw = String(process.env.LUNA_ENTRY_TRIGGER_MATERIALIZE_SIGNAL_ENABLED ?? 'true').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

function recoverFiredSignalsEnabled() {
  const raw = String(process.env.LUNA_ENTRY_TRIGGER_RECOVER_FIRED_SIGNAL_ENABLED ?? 'true').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

function numberEnv(name, fallback = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export function writeEntryTriggerWorkerHeartbeat(payload = {}, file = heartbeatPath()) {
  if (!shouldWriteHeartbeat() || !file) return null;
  let previous = null;
  try {
    if (fs.existsSync(file)) previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    previous = null;
  }
  const fired = Number(payload?.result?.fired || 0);
  const checkedAt = new Date().toISOString();
  const clearLastFire = payload.clearLastFire === true;
  const body = {
    ok: payload.ok === true,
    checkedAt,
    exchange: payload.exchange || null,
    eventSource: payload.eventSource || null,
    eventCount: Number(payload.eventCount || 0),
    result: payload.result || null,
    lastFire: clearLastFire
      ? null
      : fired > 0
      ? {
          checkedAt,
          exchange: payload.exchange || null,
          eventSource: payload.eventSource || null,
          fired,
        }
      : previous?.lastFire || null,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return { path: file, heartbeat: body };
}

async function deriveMarketEvents({ exchange = 'binance', limit = 100 } = {}) {
  const active = await listActiveEntryTriggers({ exchange, limit }).catch(() => []);
  const events = [];
  for (const trigger of active || []) {
    const symbol = String(trigger?.symbol || '').trim();
    if (!symbol) continue;
    const hints = trigger?.trigger_context?.hints || {};
    let close = null;
    if (exchange === 'binance') {
      const candles = await getOHLCV(symbol, '1m', isoDaysAgo(1), null, exchange).catch(() => []);
      close = latestClose(candles);
    }
    const targetPrice = Number(trigger?.target_price || 0);
    const breakoutRetest = targetPrice > 0 && close != null
      ? close >= targetPrice
      : hints.breakoutRetest === true;
    events.push({
      symbol,
      price: close,
      targetPrice: Number.isFinite(targetPrice) && targetPrice > 0 ? targetPrice : null,
      mtfAgreement: Number(hints.mtfAgreement || 0),
      discoveryScore: Number(hints.discoveryScore || 0),
      volumeBurst: Number(hints.volumeBurst || 0),
      breakoutRetest,
      newsMomentum: Number(hints.newsMomentum || 0),
      triggerHints: {
        ...hints,
        breakoutRetest,
      },
    });
  }
  return events;
}

export async function buildEntryTriggerWorkerRiskContext({
  exchange = 'binance',
  buyingPowerSnapshotBuilder = getLunaBuyingPowerSnapshot,
} = {}) {
  const capitalSnapshot = await buyingPowerSnapshotBuilder(exchange).catch((error) => ({
    exchange,
    mode: 'BALANCE_UNAVAILABLE',
    reasonCode: 'buying_power_snapshot_error',
    balanceStatus: 'unavailable',
    buyableAmount: 0,
    minOrderAmount: 0,
    remainingSlots: 0,
    error: error?.message || String(error),
    observedAt: new Date().toISOString(),
  }));
  return { capitalSnapshot };
}

async function fetchEntryTriggerById(id) {
  if (!id) return null;
  return dbGet(`SELECT * FROM entry_triggers WHERE id = $1`, [id]).catch(() => null);
}

async function fetchRecentFiredUnmaterializedEntryTriggers({ exchange = 'binance', minutes = 30, limit = 10 } = {}) {
  return dbGet(
    `SELECT jsonb_agg(row_to_json(t) ORDER BY t.fired_at DESC) AS rows
       FROM (
         SELECT *
           FROM entry_triggers
          WHERE exchange = $1
            AND trigger_state = 'fired'
            AND fired_at > now() - INTERVAL '1 minute' * $2
            AND COALESCE(trigger_meta->>'materializedSignalId', '') = ''
          ORDER BY fired_at DESC
          LIMIT $3
       ) t`,
    [exchange, Math.max(1, Number(minutes || 30)), Math.max(1, Number(limit || 10))],
  )
    .then((row) => (Array.isArray(row?.rows) ? row.rows : []))
    .catch(() => []);
}

function resolveEntryTriggerSignalAmount({ capitalSnapshot = {}, trigger = {} } = {}) {
  const maxTradeUsdt = Math.max(1, numberEnv('LUNA_MAX_TRADE_USDT', 50));
  const buyableAmount = Number(capitalSnapshot?.buyableAmount || 0);
  const minOrderAmount = Number(capitalSnapshot?.minOrderAmount || 0);
  if (buyableAmount > 0 && minOrderAmount > 0 && buyableAmount < minOrderAmount) return null;
  const targetAmount = Math.min(maxTradeUsdt, buyableAmount > 0 ? buyableAmount : maxTradeUsdt);
  const amount = Math.max(minOrderAmount || 0, targetAmount);
  return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(6)) : null;
}

export async function materializeFiredEntryTriggerSignals({
  exchange = 'binance',
  result = {},
  riskContext = {},
  events = [],
  deps = {},
} = {}) {
  if (!materializeSignalsEnabled()) {
    return { enabled: false, materialized: 0, skipped: 0, items: [], reason: 'materialize_disabled' };
  }
  const triggerFetcher = deps.triggerFetcher || fetchEntryTriggerById;
  const duplicateFinder = deps.duplicateFinder || getRecentSignalDuplicate;
  const signalInserter = deps.signalInserter || insertSignal;
  const blockMetaMerger = deps.blockMetaMerger || mergeSignalBlockMeta;
  const triggerUpdater = deps.triggerUpdater || updateEntryTriggerState;
  const firedResults = (result?.results || []).filter((item) => item?.fired === true && item?.triggerId);
  const items = [];
  let materialized = 0;
  let skipped = 0;
  for (const fired of firedResults) {
    const trigger = await triggerFetcher(fired.triggerId);
    if (!trigger) {
      skipped += 1;
      items.push({ triggerId: fired.triggerId, symbol: fired.symbol || null, status: 'skipped', reason: 'trigger_missing' });
      continue;
    }
    const symbol = String(trigger.symbol || fired.symbol || '').trim();
    if (!symbol) {
      skipped += 1;
      items.push({ triggerId: fired.triggerId, status: 'skipped', reason: 'symbol_missing' });
      continue;
    }
    const duplicate = await Promise.resolve(duplicateFinder({
      symbol,
      action: 'BUY',
      exchange,
      minutesBack: Math.max(1, numberEnv('LUNA_ENTRY_TRIGGER_SIGNAL_DEDUPE_MINUTES', 60)),
    })).catch(() => null);
    if (duplicate) {
      skipped += 1;
      await Promise.resolve(triggerUpdater(trigger.id, {
        triggerState: 'fired',
        triggerMetaPatch: {
          materializedSignalId: duplicate.id,
          materializeStatus: 'duplicate_existing_signal',
        },
      })).catch(() => null);
      items.push({ triggerId: trigger.id, symbol, status: 'skipped', reason: 'duplicate_existing_signal', signalId: duplicate.id });
      continue;
    }
    const amountUsdt = resolveEntryTriggerSignalAmount({ capitalSnapshot: riskContext.capitalSnapshot, trigger });
    if (!(amountUsdt > 0)) {
      skipped += 1;
      items.push({ triggerId: trigger.id, symbol, status: 'skipped', reason: 'amount_unavailable' });
      continue;
    }
    const event = events.find((row) => String(row?.symbol || '').toUpperCase() === symbol.toUpperCase()) || trigger.trigger_meta?.event || null;
    const signalId = await signalInserter({
      symbol,
      action: 'BUY',
      amountUsdt,
      confidence: Number(trigger.confidence || 0),
      reasoning: `entry_trigger_fired(${trigger.trigger_type}) ${symbol}`,
      status: 'approved',
      exchange,
      strategyFamily: trigger.setup_type || trigger.trigger_type || 'entry_trigger',
      strategyRoute: {
        source: 'entry_trigger_fired',
        triggerId: trigger.id,
        triggerType: trigger.trigger_type || null,
        setupType: trigger.setup_type || null,
        predictiveScore: Number(trigger.predictive_score || 0) || null,
      },
      executionOrigin: 'entry_trigger',
      qualityFlag: 'trusted',
      nemesisVerdict: 'approved',
      approvedAt: new Date().toISOString(),
    });
    await Promise.resolve(blockMetaMerger(signalId, {
      event_type: 'entry_trigger_fired_signal_materialized',
      entryTrigger: {
        triggerId: trigger.id,
        triggerType: trigger.trigger_type || null,
        state: 'fired',
        firedAt: trigger.fired_at || null,
        materializedAt: new Date().toISOString(),
      },
      capitalSnapshot: {
        mode: riskContext.capitalSnapshot?.mode || null,
        buyableAmount: Number(riskContext.capitalSnapshot?.buyableAmount || 0),
        minOrderAmount: Number(riskContext.capitalSnapshot?.minOrderAmount || 0),
        remainingSlots: Number(riskContext.capitalSnapshot?.remainingSlots || 0),
      },
      triggerEvent: event,
    })).catch(() => null);
    await Promise.resolve(triggerUpdater(trigger.id, {
      triggerState: 'fired',
      triggerMetaPatch: {
        materializedSignalId: signalId,
        materializeStatus: 'approved_signal_inserted',
        materializedAt: new Date().toISOString(),
      },
    })).catch(() => null);
    materialized += 1;
    items.push({ triggerId: trigger.id, symbol, status: 'materialized', signalId, amountUsdt });
  }
  return { enabled: true, materialized, skipped, items };
}

export async function recoverRecentFiredEntryTriggerSignals({
  exchange = 'binance',
  riskContext = {},
  events = [],
} = {}) {
  if (!recoverFiredSignalsEnabled()) {
    return { enabled: false, materialized: 0, skipped: 0, items: [], reason: 'recover_fired_disabled' };
  }
  const minutes = Math.max(1, numberEnv('LUNA_ENTRY_TRIGGER_RECOVER_FIRED_MINUTES', 30));
  const limit = Math.max(1, numberEnv('LUNA_ENTRY_TRIGGER_RECOVER_FIRED_LIMIT', 10));
  const rows = await fetchRecentFiredUnmaterializedEntryTriggers({ exchange, minutes, limit });
  if (rows.length === 0) {
    return { enabled: true, materialized: 0, skipped: 0, items: [], inspected: 0, minutes };
  }
  const result = await materializeFiredEntryTriggerSignals({
    exchange,
    result: {
      allowLiveFire: true,
      results: rows.map((row) => ({
        triggerId: row.id,
        symbol: row.symbol,
        fired: true,
        recovery: true,
      })),
    },
    riskContext,
    events,
  });
  return {
    ...result,
    inspected: rows.length,
    minutes,
    recovery: true,
  };
}

export async function runLunaEntryTriggerWorker() {
  hydrateEntryTriggerEnvFromLaunchctl();
  const exchange = argValue('--exchange', process.env.LUNA_ENTRY_TRIGGER_EXCHANGE || 'binance');
  const eventsRequested = hasFlag('--derive-market-events');
  const flags = getLunaIntelligentDiscoveryFlags();
  const agentPlan = buildEntryTriggerAgentPlan({
    agentPlan: readAgentPlanArg(),
    runtime: {
      entryTriggerEnabled: flags.phases.entryTriggerEnabled === true,
      signalRefreshEnabled: String(process.env.LUNA_ENTRY_TRIGGER_SIGNAL_REFRESH_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
      deriveMarketEventsRequested: eventsRequested,
    },
  });
  const refresh = agentPlan.signalRefreshEnabled
    ? await refreshEntryTriggersFromRecentBuySignals({
      exchange,
      hours: Number(argValue('--refresh-hours', process.env.LUNA_ENTRY_TRIGGER_SIGNAL_REFRESH_HOURS || '6') || 6),
      limit: Number(argValue('--refresh-limit', process.env.LUNA_ENTRY_TRIGGER_SIGNAL_REFRESH_LIMIT || '25') || 25),
    }).catch((error) => ({
      enabled: true,
      refreshEnabled: true,
      error: error?.message || String(error),
      refreshed: 0,
      armed: 0,
      fired: 0,
      blocked: 0,
      sourceSignals: 0,
    }))
    : {
      enabled: true,
      refreshEnabled: false,
      reason: 'agent_plan_signal_refresh_disabled',
      refreshed: 0,
      armed: 0,
      fired: 0,
      blocked: 0,
      sourceSignals: 0,
    };
  let events = parseEvents();
  if (events.length === 0 && agentPlan.deriveMarketEventsEnabled) {
    events = await deriveMarketEvents({ exchange });
  }
  const riskContext = agentPlan.activeEvaluationEnabled
    ? await buildEntryTriggerWorkerRiskContext({ exchange })
    : { capitalSnapshot: null };
  const result = agentPlan.activeEvaluationEnabled
    ? await evaluateActiveEntryTriggersAgainstMarketEvents(events, { exchange, ...riskContext })
    : { enabled: false, fired: 0, readyBlocked: 0, checked: 0, results: [], reason: 'agent_plan_active_evaluation_disabled' };
  const materializedSignals = agentPlan.activeEvaluationEnabled && result?.allowLiveFire === true
    ? await materializeFiredEntryTriggerSignals({ exchange, result, riskContext, events })
    : { enabled: false, materialized: 0, skipped: 0, items: [], reason: 'active_evaluation_disabled_or_live_fire_off' };
  const recoveredFiredSignals = agentPlan.activeEvaluationEnabled && result?.allowLiveFire === true
    ? await recoverRecentFiredEntryTriggerSignals({ exchange, riskContext, events })
    : { enabled: false, materialized: 0, skipped: 0, items: [], reason: 'active_evaluation_disabled_or_live_fire_off' };
  const output = {
    ok: true,
    exchange,
    eventSource: events.length > 0 ? 'provided_or_derived' : 'none',
    eventCount: events.length,
    agentPlan,
    refresh,
    riskContext: {
      capitalMode: riskContext.capitalSnapshot?.mode || null,
      balanceStatus: riskContext.capitalSnapshot?.balanceStatus || null,
      buyableAmount: Number(riskContext.capitalSnapshot?.buyableAmount || 0),
      minOrderAmount: Number(riskContext.capitalSnapshot?.minOrderAmount || 0),
      remainingSlots: Number(riskContext.capitalSnapshot?.remainingSlots || 0),
      reasonCode: riskContext.capitalSnapshot?.reasonCode || null,
    },
    materializedSignals,
    recoveredFiredSignals,
    result,
  };
  const heartbeat = writeEntryTriggerWorkerHeartbeat(output);
  if (heartbeat) output.heartbeatPath = heartbeat.path;
  return output;
}

async function main() {
  const result = await runLunaEntryTriggerWorker();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`luna entry trigger worker ok — checked=${result.result.checked} fired=${result.result.fired} readyBlocked=${result.result.readyBlocked}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry-trigger worker 실패:',
  });
}
