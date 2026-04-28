#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { evaluateActiveEntryTriggersAgainstMarketEvents } from '../shared/entry-trigger-engine.ts';
import { listActiveEntryTriggers } from '../shared/luna-discovery-entry-store.ts';
import { getOHLCV } from '../shared/ohlcv-fetcher.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const DEFAULT_HEARTBEAT_PATH = path.join(INVESTMENT_DIR, 'output', 'ops', 'luna-entry-trigger-worker-heartbeat.json');

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

export function writeEntryTriggerWorkerHeartbeat(payload = {}, file = heartbeatPath()) {
  if (!shouldWriteHeartbeat() || !file) return null;
  const body = {
    ok: payload.ok === true,
    checkedAt: new Date().toISOString(),
    exchange: payload.exchange || null,
    eventSource: payload.eventSource || null,
    eventCount: Number(payload.eventCount || 0),
    result: payload.result || null,
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

export async function runLunaEntryTriggerWorker() {
  const exchange = argValue('--exchange', process.env.LUNA_ENTRY_TRIGGER_EXCHANGE || 'binance');
  let events = parseEvents();
  if (events.length === 0 && hasFlag('--derive-market-events')) {
    events = await deriveMarketEvents({ exchange });
  }
  const result = await evaluateActiveEntryTriggersAgainstMarketEvents(events, { exchange });
  const output = {
    ok: true,
    exchange,
    eventSource: events.length > 0 ? 'provided_or_derived' : 'none',
    eventCount: events.length,
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
