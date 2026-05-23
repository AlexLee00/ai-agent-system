#!/usr/bin/env node
// @ts-nocheck

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildFixtureDomesticOfficialReference,
  getCachedDomesticOfficialReference,
  normalizeDomesticOfficialSymbol,
  summarizeDomesticOfficialReference,
} from '../shared/domestic-official-reference.ts';
import { resolveOpenDartCredentials } from '../lib/korea-data/opendart-client.ts';
import { runLunaOpenDartFinancialRefresh } from './runtime-luna-opendart-financial-refresh.ts';

export const OPENDART_FINANCIAL_BATCH_CONFIRM = 'luna-opendart-financial-batch-write';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const DEFAULT_OUTPUT = resolve(INVESTMENT_ROOT, 'output/luna-opendart-financial-batch-refresh.json');
const DEFAULT_LIMIT = 10;
const MAX_REFERENCE_SCAN = 500;
const FIXTURE_CORP_CODES = {
  '005930': { corpCode: '00126380', corpName: '삼성전자' },
  '000660': { corpCode: '00164779', corpName: 'SK하이닉스' },
  '005380': { corpCode: '00164742', corpName: '현대차' },
};

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function text(value, fallback = '') {
  return String(value ?? fallback ?? '').trim();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function symbolsFrom(value = '') {
  return [...new Set(String(value || '')
    .split(',')
    .map((item) => normalizeDomesticOfficialSymbol(item))
    .filter(Boolean))];
}

function parseManualCorpCodeMap(value = '') {
  const map = new Map();
  for (const part of String(value || '').split(',')) {
    const [symbolRaw, corpCodeRaw] = part.split(':');
    const symbol = normalizeDomesticOfficialSymbol(symbolRaw);
    const corpCode = text(corpCodeRaw);
    if (symbol && corpCode) map.set(symbol, { corpCode, corpName: '' });
  }
  return map;
}

function selectReferenceCandidates(reference = {}, options = {}) {
  const requestedSymbols = symbolsFrom(options.symbols || '');
  const requested = new Set(requestedSymbols);
  const limit = Math.max(1, Math.min(MAX_REFERENCE_SCAN, Number(options.limit || DEFAULT_LIMIT)));
  const rows = Array.isArray(reference.rows) ? reference.rows : [];
  const selected = rows
    .filter((row) => normalizeDomesticOfficialSymbol(row.symbol))
    .filter((row) => !requested.size || requested.has(normalizeDomesticOfficialSymbol(row.symbol)))
    .filter((row) => options.includeIneligible === true || row.officialEligible === true)
    .sort((a, b) => Number(b.turnoverKrw || 0) - Number(a.turnoverKrw || 0))
    .slice(0, limit);

  const present = new Set(selected.map((row) => normalizeDomesticOfficialSymbol(row.symbol)));
  const direct = requestedSymbols
    .filter((symbol) => !present.has(symbol))
    .map((symbol) => ({
      symbol,
      name: symbol,
      officialEligible: false,
      officialBlockers: ['not_in_cached_reference'],
      turnoverKrw: 0,
      source: 'direct_symbol_probe',
    }));
  return [...selected, ...direct].slice(0, limit);
}

async function loadExistingCoverage() {
  const empty = {
    corpFinancialReports: null,
    corpFundamentals: null,
    freshCorpFundamentals24h: null,
  };
  try {
    const [financial, fundamentals, fresh] = await Promise.all([
      get('SELECT COUNT(*)::int AS count FROM investment.corp_financial_reports').catch(() => null),
      get('SELECT COUNT(DISTINCT stock_code)::int AS count FROM investment.corp_fundamentals').catch(() => null),
      get("SELECT COUNT(DISTINCT stock_code)::int AS count FROM investment.corp_fundamentals WHERE updated_at >= NOW() - INTERVAL '24 hours'").catch(() => null),
    ]);
    return {
      corpFinancialReports: financial ? Number(financial.count || 0) : null,
      corpFundamentals: fundamentals ? Number(fundamentals.count || 0) : null,
      freshCorpFundamentals24h: fresh ? Number(fresh.count || 0) : null,
    };
  } catch {
    return empty;
  }
}

async function loadFreshFundamentalSymbols() {
  try {
    const row = await get(
      `SELECT COALESCE(json_agg(DISTINCT stock_code), '[]'::json) AS symbols
         FROM investment.corp_fundamentals
        WHERE updated_at >= NOW() - INTERVAL '24 hours'`,
    ).catch(() => null);
    return new Set((Array.isArray(row?.symbols) ? row.symbols : [])
      .map((symbol) => normalizeDomesticOfficialSymbol(symbol))
      .filter(Boolean));
  } catch {
    return new Set();
  }
}

function fixtureCorpCodeMap(symbols = []) {
  return new Map(symbols
    .map((symbol) => [symbol, FIXTURE_CORP_CODES[symbol]])
    .filter(([, value]) => value?.corpCode));
}

async function resolveCorpCodeMap(symbols = [], options = {}) {
  const manual = parseManualCorpCodeMap(options.corpCodeMap || '');
  if (options.fixture) {
    return {
      ok: true,
      source: 'fixture',
      map: new Map([...fixtureCorpCodeMap(symbols), ...manual]),
      requested: symbols.length,
      resolved: symbols.filter((symbol) => FIXTURE_CORP_CODES[symbol] || manual.has(symbol)).length,
      networkUsed: false,
      errors: [],
    };
  }

  const credentials = await resolveOpenDartCredentials({ timeoutMs: options.timeoutMs || 3000 });
  if (!credentials.apiKey) {
    return {
      ok: false,
      source: credentials.status.apiKeySource || null,
      map: manual,
      requested: symbols.length,
      resolved: manual.size,
      networkUsed: false,
      errors: ['missing_opendart_api_key'],
    };
  }

  const pythonScript = resolve(INVESTMENT_ROOT, 'python/korea-data/opendart_client.py');
  if (!existsSync(pythonScript)) {
    return {
      ok: false,
      source: 'python_adapter_missing',
      map: manual,
      requested: symbols.length,
      resolved: manual.size,
      networkUsed: false,
      errors: ['opendart_python_adapter_missing'],
    };
  }

  const python = spawnSync('python3', [
    pythonScript,
    '--corp-code-map',
    `--symbols=${symbols.join(',')}`,
    '--json',
  ], {
    cwd: INVESTMENT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENDART_API_KEY: credentials.apiKey,
      OPENDART_BASE_URL: credentials.baseUrl,
    },
    timeout: Math.max(30_000, Number(options.timeoutMs || 20_000) * 3),
  });
  let parsed = null;
  try {
    parsed = JSON.parse(python.stdout || '{}');
  } catch {
    parsed = { ok: false, error: 'corp_code_map_parse_failed' };
  }

  const map = new Map(manual);
  for (const row of Array.isArray(parsed?.rows) ? parsed.rows : []) {
    const symbol = normalizeDomesticOfficialSymbol(row.stockCode);
    const corpCode = text(row.corpCode);
    if (symbol && corpCode) map.set(symbol, { corpCode, corpName: text(row.corpName), modifyDate: text(row.modifyDate) });
  }
  const errors = [];
  if (python.error) errors.push(String(python.error.message || python.error));
  if (python.status && python.status !== 0) errors.push(parsed?.error || `python_exit_${python.status}`);
  if (parsed?.error) errors.push(parsed.error);
  return {
    ok: map.size > 0 && errors.length === 0,
    source: parsed?.adapter || credentials.status.apiKeySource || 'opendart',
    map,
    requested: symbols.length,
    resolved: symbols.filter((symbol) => map.has(symbol)).length,
    networkUsed: true,
    errors: [...new Set(errors)].slice(0, 8),
  };
}

async function resolveReference(options = {}) {
  if (options.fixture) return buildFixtureDomesticOfficialReference();
  return getCachedDomesticOfficialReference({
    allowNetwork: options.referenceNetwork === true,
    refresh: options.refreshReference === true,
    writeCache: options.writeCache === true,
    baseDate: options.baseDate || null,
    timeoutMs: options.timeoutMs || 8000,
  });
}

export async function runLunaOpenDartFinancialBatchRefresh(options = {}) {
  const write = options.write === true;
  if (write && options.confirm !== OPENDART_FINANCIAL_BATCH_CONFIRM) {
    throw new Error(`runtime:luna-opendart-financial-batch-refresh write requires --confirm=${OPENDART_FINANCIAL_BATCH_CONFIRM}`);
  }
  const reference = await resolveReference(options);
  const freshSymbols = options.skipFresh === true ? await loadFreshFundamentalSymbols() : new Set();
  const offset = Math.max(0, Number(options.offset || 0));
  const candidates = selectReferenceCandidates(reference, {
    ...options,
    limit: Math.max(1, Math.min(100, Number(options.limit || DEFAULT_LIMIT))) + offset + freshSymbols.size,
  })
    .filter((row) => options.skipFresh !== true || !freshSymbols.has(normalizeDomesticOfficialSymbol(row.symbol)))
    .slice(offset, offset + Math.max(1, Math.min(100, Number(options.limit || DEFAULT_LIMIT))));
  const symbols = candidates.map((row) => normalizeDomesticOfficialSymbol(row.symbol)).filter(Boolean);
  const corpCodeMap = await resolveCorpCodeMap(symbols, options);
  const networkFinancialFetch = options.fixture === true || options.network === true || write;
  const existingCoverage = await loadExistingCoverage();
  const bsnsYear = text(options.bsnsYear || process.env.LUNA_OPENDART_FINANCIAL_BSNS_YEAR || '2024');
  const reprtCode = text(options.reprtCode || process.env.LUNA_OPENDART_FINANCIAL_REPRT_CODE || '11011');
  const fsDiv = text(options.fsDiv || process.env.LUNA_OPENDART_FINANCIAL_FS_DIV || 'CFS');

  const planned = candidates.map((row) => {
    const symbol = normalizeDomesticOfficialSymbol(row.symbol);
    const corp = corpCodeMap.map.get(symbol);
    return {
      symbol,
      corpCode: corp?.corpCode || null,
      companyName: corp?.corpName || row.name || symbol,
      marketCap: numberOrNull(row.marketCap),
      listedShares: numberOrNull(row.listedShares),
      price: numberOrNull(row.price),
      turnoverKrw: numberOrNull(row.turnoverKrw),
      officialEligible: row.officialEligible === true,
      officialBlockers: row.officialBlockers || [],
      status: corp?.corpCode ? (networkFinancialFetch ? 'ready_to_fetch' : 'planned') : 'corp_code_missing',
    };
  });

  const refreshed = [];
  const skipped = [];
  if (networkFinancialFetch) {
    for (const item of planned) {
      if (!item.corpCode) {
        skipped.push({ ...item, reason: 'corp_code_missing' });
        continue;
      }
      const result = await runLunaOpenDartFinancialRefresh({
        fixture: options.fixture === true,
        write,
        corpCode: item.corpCode,
        stockCode: item.symbol,
        companyName: item.companyName,
        bsnsYear,
        reprtCode,
        fsDiv,
        marketCap: item.marketCap,
        listedShares: item.listedShares,
        price: item.price,
        run: options.run,
      });
      refreshed.push({
        symbol: item.symbol,
        corpCode: item.corpCode,
        companyName: item.companyName,
        ok: result.ok,
        status: result.status,
        rows: result.rows,
        composite: result.factorScores?.composite ?? null,
        writeApplied: result.writeApplied === true,
        request: result.request ? {
          ok: result.request.ok,
          dartStatus: result.request.dartStatus,
          error: result.request.error,
        } : null,
      });
    }
  }

  const payload = {
    ok: true,
    status: networkFinancialFetch
      ? 'luna_opendart_financial_batch_refresh_completed'
      : 'luna_opendart_financial_batch_refresh_planned',
    generatedAt: new Date().toISOString(),
    dryRun: !write,
    shadowOnly: true,
    liveOrderAllowed: false,
    liveTradeImpact: false,
    writeApplied: write,
    writeMode: write ? 'opendart-financial-batch-write' : 'plan-only',
    policy: {
      networkFinancialFetch,
      corpCodeMapNetwork: corpCodeMap.networkUsed === true,
      referenceNetwork: options.referenceNetwork === true,
      refreshReference: options.refreshReference === true,
      dbWriteRequiresConfirm: OPENDART_FINANCIAL_BATCH_CONFIRM,
      bsnsYear,
      reprtCode,
      fsDiv,
      offset,
      skipFresh: options.skipFresh === true,
      freshSymbolsSkipped: freshSymbols.size,
    },
    coverageBefore: existingCoverage,
    reference: summarizeDomesticOfficialReference(reference),
    corpCodeMap: {
      ok: corpCodeMap.ok,
      source: corpCodeMap.source,
      requested: corpCodeMap.requested,
      resolved: corpCodeMap.resolved,
      missing: Math.max(0, corpCodeMap.requested - corpCodeMap.resolved),
      networkUsed: corpCodeMap.networkUsed === true,
      errors: corpCodeMap.errors,
    },
    counts: {
      candidates: candidates.length,
      planned: planned.length,
      readyToFetch: planned.filter((item) => item.corpCode).length,
      missingCorpCode: planned.filter((item) => !item.corpCode).length,
      refreshed: refreshed.length,
      skipped: skipped.length,
      rows: refreshed.reduce((sum, item) => sum + Number(item.rows || 0), 0),
      successful: refreshed.filter((item) => item.ok).length,
    },
    planned,
    refreshed,
    skipped,
    safety: {
      secretMutation: false,
      protectedProcessTouched: false,
      launchctlTouched: false,
      liveTradeExecuted: false,
      liveOrderAllowed: false,
    },
  };

  if (options.writeReport !== false) {
    mkdirSync(dirname(options.output || DEFAULT_OUTPUT), { recursive: true });
    writeFileSync(options.output || DEFAULT_OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  }
  return payload;
}

async function main() {
  const result = await runLunaOpenDartFinancialBatchRefresh({
    fixture: hasFlag('fixture'),
    network: hasFlag('network'),
    referenceNetwork: hasFlag('reference-network'),
    refreshReference: hasFlag('refresh-reference'),
    writeCache: hasFlag('write-cache'),
    write: hasFlag('write') && !hasFlag('dry-run'),
    confirm: argValue('confirm', ''),
    symbols: argValue('symbols', ''),
    corpCodeMap: argValue('corp-code-map', ''),
    limit: Number(argValue('limit', DEFAULT_LIMIT)),
    bsnsYear: argValue('bsns-year', null),
    reprtCode: argValue('reprt-code', null),
    fsDiv: argValue('fs-div', null),
    baseDate: argValue('base-date', null),
    timeoutMs: Number(argValue('timeout-ms', 8000)),
    includeIneligible: hasFlag('include-ineligible'),
    skipFresh: hasFlag('skip-fresh'),
    offset: Number(argValue('offset', 0)),
    output: argValue('output', DEFAULT_OUTPUT),
    writeReport: !hasFlag('no-write'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-opendart-financial-batch-refresh] ${result.status} ready=${result.counts.readyToFetch} refreshed=${result.counts.refreshed} dryRun=${result.dryRun}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-opendart-financial-batch-refresh error:' });
}
