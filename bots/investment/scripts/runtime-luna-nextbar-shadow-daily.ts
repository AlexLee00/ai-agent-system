#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { collectNextbarExecutionShadow } from '../shared/luna-nextbar-shadow-collector.ts';

export const LUNA_NEXTBAR_SHADOW_DAILY_CONFIRM = 'luna-nextbar-shadow-daily';
const DEFAULT_SYMBOLS = Object.freeze(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
const SYMBOL_ALLOWLIST = new Set(DEFAULT_SYMBOLS);

function symbolsFrom(value = DEFAULT_SYMBOLS) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
}

function seoulDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

async function schemaAvailable(queryFn = db.query) {
  const rows = await queryFn(`SELECT to_regclass('investment.luna_nextbar_execution_shadow') AS table_name`);
  return Boolean(rows?.[0]?.table_name);
}

async function hasDailyEvidence(symbol, collectionDate, queryFn = db.query) {
  const rows = await queryFn(`
    SELECT COUNT(*)::int AS count,
           MAX(COALESCE((metadata->>'expectedComparisons')::int, 0))::int AS expected
    FROM luna_nextbar_execution_shadow
    WHERE symbol = $1
      AND metadata->>'source' = 'nextbar-shadow-daily'
      AND metadata->>'collectionDate' = $2
  `, [symbol, collectionDate]);
  const count = Number(rows?.[0]?.count || 0);
  const expected = Number(rows?.[0]?.expected || 0);
  return expected > 0 && count >= expected;
}

export async function runLunaNextbarShadowDaily(options = {}, deps = {}) {
  const apply = options.apply === true;
  const symbols = symbolsFrom(options.symbols || DEFAULT_SYMBOLS);
  const invalidSymbols = symbols.filter((symbol) => !SYMBOL_ALLOWLIST.has(symbol));
  if (invalidSymbols.length) {
    return { ok: false, status: 'symbol_not_allowed', invalidSymbols, apply, planned: 0, written: 0 };
  }
  if (!apply) {
    return { ok: true, status: 'nextbar_shadow_daily_planned', apply: false, planned: symbols.length, written: 0, symbols };
  }
  if (options.confirm !== LUNA_NEXTBAR_SHADOW_DAILY_CONFIRM) {
    return { ok: false, status: 'confirmation_required', apply: true, planned: symbols.length, written: 0 };
  }

  const available = await (deps.schemaAvailableFn || schemaAvailable)();
  if (!available) {
    return { ok: false, status: 'schema_missing', apply: true, planned: symbols.length, written: 0 };
  }
  const now = options.now || new Date();
  const collectionDate = seoulDate(now);
  const hasEvidence = deps.hasDailyEvidenceFn || hasDailyEvidence;
  const collect = deps.collectFn || collectNextbarExecutionShadow;
  const results = [];
  let written = 0;
  let skippedExisting = 0;
  for (const symbol of symbols) {
    if (await hasEvidence(symbol, collectionDate)) {
      skippedExisting += 1;
      results.push({ symbol, status: 'already_collected', persisted: 0 });
      continue;
    }
    try {
      const result = await collect({
        symbol,
        market: 'binance',
        days: Math.max(14, Number(options.days || 30)),
        source: 'nextbar-shadow-daily',
        shadowOnly: true,
        now,
      });
      const persisted = Number(result?.nextbarShadow?.persisted ?? result?.persisted ?? 0);
      written += persisted;
      results.push({ symbol, status: result?.ok === false ? 'collector_error' : 'collected', persisted, result });
    } catch (error) {
      results.push({ symbol, status: 'collector_error', persisted: 0, error: String(error?.message || error) });
    }
  }
  return {
    ok: results.every((row) => row.status !== 'collector_error'),
    status: 'nextbar_shadow_daily_complete',
    apply: true,
    shadowOnly: true,
    collectionDate,
    planned: symbols.length,
    written,
    skippedExisting,
    results,
  };
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaNextbarShadowDaily({
      apply: process.argv.includes('--apply'),
      confirm: argValue('confirm'),
      symbols: argValue('symbols', DEFAULT_SYMBOLS.join(',')),
      days: Number(argValue('days', 30)),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-nextbar-shadow-daily error:',
  });
}
