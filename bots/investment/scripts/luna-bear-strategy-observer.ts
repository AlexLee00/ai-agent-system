#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { query as dbQuery } from '../shared/db/core.ts';
import { maybeSkipForMemory } from '../shared/memory-pressure-guard.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export const DEFAULT_SINCE_KST = '2026-06-20 20:30:00+09';
export const DEFAULT_MIN_SAMPLE = 3;
export const DEFAULT_STATE_PATH = '/tmp/luna-bear-observer-state.json';
export const DEFAULT_OUTPUT_DIR = '/tmp';
export const DEFAULT_HISTORY_PATH = '/tmp/luna-bear-observer-history.jsonl';

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const inline = argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !String(argv[idx + 1]).startsWith('--')) return argv[idx + 1];
  return fallback;
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normalizeSinceForParse(value) {
  const raw = String(value || DEFAULT_SINCE_KST).trim();
  const withT = raw.includes('T') ? raw : raw.replace(' ', 'T');
  return withT.replace(/([+-]\d{2})$/, '$1:00');
}

function timestampMs(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric > 10_000_000_000) return numeric;
    if (numeric > 0) return numeric * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseSinceMs(value = DEFAULT_SINCE_KST) {
  const parsed = Date.parse(normalizeSinceForParse(value));
  if (!Number.isFinite(parsed)) throw new Error(`invalid_since: ${value}`);
  return parsed;
}

function dateTagKst(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}${map.month}${map.day}`;
}

function normalizeFamily(row) {
  return String(row?.strategy_family || row?.strategyFamily || row?.trade_mode || row?.tradeMode || 'unknown').trim() || 'unknown';
}

export function filterBearRows(rows = [], { sinceMs } = {}) {
  return (rows || []).filter((row) => {
    if (String(row?.exchange || '').toLowerCase() !== 'binance') return false;
    if (row?.is_paper === true || row?.isPaper === true || String(row?.is_paper).toLowerCase() === 'true') return false;
    if (row?.exclude_from_learning === true || row?.excludeFromLearning === true || String(row?.exclude_from_learning).toLowerCase() === 'true') return false;
    if (!String(row?.market_regime || row?.marketRegime || '').toLowerCase().includes('bear')) return false;
    const eventMs = timestampMs(row?.entry_time ?? row?.entryTime ?? row?.exit_time ?? row?.exitTime);
    if (!eventMs || (sinceMs && eventMs < sinceMs)) return false;
    return true;
  });
}

export function summarizeBearStrategyRows(rows = [], { minSample = DEFAULT_MIN_SAMPLE } = {}) {
  const byFamily = {};
  let firstBearAt = null;
  for (const row of rows) {
    const family = normalizeFamily(row);
    byFamily[family] = (byFamily[family] || 0) + 1;
    const eventMs = timestampMs(row?.entry_time ?? row?.entryTime ?? row?.exit_time ?? row?.exitTime);
    if (eventMs && (!firstBearAt || eventMs < firstBearAt)) firstBearAt = eventMs;
  }

  const sample = rows.length;
  const meanReversionCount = Number(byFamily.mean_reversion || 0);
  const defensiveCount = Number(byFamily.defensive_rotation || 0);
  const maxCount = Object.values(byFamily).reduce((max, count) => Math.max(max, Number(count || 0)), 0);
  let status = 'waiting';
  if (sample > 0 && sample < minSample) status = 'observing';
  else if (sample >= minSample) {
    status = meanReversionCount === maxCount && meanReversionCount >= defensiveCount
      ? 'converted'
      : 'not_converted';
  }

  return {
    status,
    sample,
    minSample,
    meanReversionCount,
    defensiveCount,
    byFamily,
    firstBearAt: firstBearAt ? new Date(firstBearAt).toISOString() : null,
  };
}

function readJsonSafe(filePath, fallback, deps) {
  try {
    if (deps.existsSync && !deps.existsSync(filePath)) return fallback;
    const raw = deps.readFile(filePath, 'utf8');
    return JSON.parse(String(raw || '{}'));
  } catch {
    return fallback;
  }
}

function buildMarkdown(result) {
  const lines = [];
  lines.push(`# Luna Bear Strategy Observer — ${result.dateTag}`);
  lines.push('');
  lines.push(`- 상태: **${result.status}**`);
  lines.push(`- 표본: **${result.sample}건** (min=${result.minSample})`);
  lines.push(`- mean_reversion: **${result.meanReversionCount}건**`);
  lines.push(`- defensive_rotation: **${result.defensiveCount}건**`);
  lines.push(`- 상태 변경: **${result.changed ? 'yes' : 'no'}**`);
  lines.push('');
  lines.push('## 전략군 분포');
  lines.push('');
  const entries = Object.entries(result.byFamily || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
  if (entries.length === 0) lines.push('- bear live trade sample 없음');
  for (const [family, count] of entries) lines.push(`- \`${family}\`: ${count}`);
  return `${lines.join('\n')}\n`;
}

function buildTelegramMessage(result) {
  if (result.status === 'observing') {
    return `🐻 bear 국면 진입, 관찰 시작 (${result.sample}건)\nmean_reversion ${result.meanReversionCount} / defensive ${result.defensiveCount}`;
  }
  if (result.status === 'converted') {
    return `✅ bear×mean_reversion 전환 확인!\n표본 ${result.sample}건 | mean_reversion ${result.meanReversionCount} / defensive ${result.defensiveCount}`;
  }
  if (result.status === 'not_converted') {
    return `⚠️ bear에서 여전히 defensive 우세 또는 mean_reversion 미전환\n표본 ${result.sample}건 | mean_reversion ${result.meanReversionCount} / defensive ${result.defensiveCount}`;
  }
  return null;
}

async function defaultNotify(message) {
  const hubToken = process.env.HUB_AUTH_TOKEN;
  if (!hubToken) return { ok: false, error: 'hub_auth_token_missing' };
  const hubUrl = process.env.HUB_URL || 'http://localhost:7788';
  const response = await fetch(`${hubUrl}/hub/notifications/telegram`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hubToken}`,
    },
    body: JSON.stringify({ message, source: 'luna-bear-strategy-observer' }),
  });
  if (!response.ok) return { ok: false, error: `telegram_http_${response.status}` };
  return { ok: true };
}

export async function loadBearStrategyRows({ since = DEFAULT_SINCE_KST, query = dbQuery } = {}) {
  return query(
    `SELECT id, exchange, is_paper, exclude_from_learning, market_regime,
            strategy_family, trade_mode, entry_time, exit_time
       FROM investment.trade_journal
      WHERE exchange = 'binance'
        AND COALESCE(is_paper, false) = false
        AND COALESCE(exclude_from_learning, false) = false
        AND COALESCE(market_regime, '') ILIKE '%bear%'
        AND to_timestamp(COALESCE(entry_time, exit_time) / 1000.0) >= $1::timestamptz
      ORDER BY COALESCE(entry_time, exit_time) ASC`,
    [normalizeSinceForParse(since)],
  );
}

export async function runLunaBearStrategyObserver(options = {}, deps = {}) {
  const now = options.now || new Date();
  const since = options.since || process.env.LUNA_BEAR_OBSERVER_SINCE || DEFAULT_SINCE_KST;
  const minSample = parsePositiveInt(options.minSample ?? process.env.LUNA_BEAR_OBSERVER_MIN_SAMPLE, DEFAULT_MIN_SAMPLE);
  const sinceMs = parseSinceMs(since);
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  const historyPath = options.historyPath || DEFAULT_HISTORY_PATH;
  const noNotify = options.noNotify === true;
  const query = deps.query || dbQuery;
  const notify = deps.notify || defaultNotify;
  const io = {
    existsSync: deps.existsSync || fs.existsSync,
    readFile: deps.readFile || fs.readFileSync,
    writeFile: deps.writeFile || fs.writeFileSync,
    appendFile: deps.appendFile || fs.appendFileSync,
  };

  const rows = filterBearRows(await loadBearStrategyRows({ since, query }), { sinceMs });
  const summary = summarizeBearStrategyRows(rows, { minSample });
  const previousState = readJsonSafe(statePath, {}, io);
  const previousStatus = previousState?.lastStatus || null;
  const changed = previousStatus == null ? summary.status !== 'waiting' : previousStatus !== summary.status;
  const shouldAlert = changed && !noNotify && summary.status !== 'waiting';
  const dateTag = dateTagKst(now);

  const result = {
    ok: true,
    observer: 'luna-bear-strategy-observer',
    dateTag,
    generatedAt: now.toISOString(),
    since,
    status: summary.status,
    sample: summary.sample,
    minSample,
    meanReversionCount: summary.meanReversionCount,
    defensiveCount: summary.defensiveCount,
    byFamily: summary.byFamily,
    firstBearAt: previousState?.firstBearAt || summary.firstBearAt || null,
    previousStatus,
    changed,
    alerted: false,
    alertError: null,
    output: {
      statePath,
      jsonPath: path.join(outputDir, `luna-bear-observer-${dateTag}.json`),
      markdownPath: path.join(outputDir, `luna-bear-observer-${dateTag}.md`),
      historyPath,
    },
    readOnly: true,
    liveMutation: false,
  };

  const message = buildTelegramMessage(result);
  if (shouldAlert && message) {
    try {
      const notifyResult = await notify(message, result);
      result.alerted = Boolean(notifyResult?.ok);
      if (!notifyResult?.ok) result.alertError = notifyResult?.error || 'telegram_failed';
    } catch (error) {
      result.alertError = error?.message || String(error);
    }
  }

  const nextState = {
    lastStatus: result.status,
    lastSample: result.sample,
    lastNotifiedAt: result.alerted ? result.generatedAt : previousState?.lastNotifiedAt || null,
    firstBearAt: result.firstBearAt,
    updatedAt: result.generatedAt,
  };
  io.writeFile(statePath, JSON.stringify(nextState, null, 2), 'utf8');
  io.writeFile(result.output.jsonPath, JSON.stringify(result, null, 2), 'utf8');
  io.writeFile(result.output.markdownPath, buildMarkdown(result), 'utf8');
  io.appendFile(historyPath, `${JSON.stringify({
    generatedAt: result.generatedAt,
    status: result.status,
    sample: result.sample,
    meanReversionCount: result.meanReversionCount,
    defensiveCount: result.defensiveCount,
    changed: result.changed,
    alerted: result.alerted,
  })}\n`, 'utf8');

  return result;
}

function parseCliOptions(argv = process.argv.slice(2)) {
  return {
    since: argValue('since', process.env.LUNA_BEAR_OBSERVER_SINCE || DEFAULT_SINCE_KST, argv),
    minSample: argValue('min-sample', process.env.LUNA_BEAR_OBSERVER_MIN_SAMPLE || DEFAULT_MIN_SAMPLE, argv),
    noNotify: hasArg('no-notify', argv),
    statePath: argValue('state-path', DEFAULT_STATE_PATH, argv),
    outputDir: argValue('output-dir', DEFAULT_OUTPUT_DIR, argv),
    historyPath: argValue('history-path', DEFAULT_HISTORY_PATH, argv),
    json: hasArg('json', argv),
  };
}

async function main() {
  const options = parseCliOptions();
  if (maybeSkipForMemory('luna.bear-strategy-observer')) {
    if (options.json) console.log(JSON.stringify({ ok: true, skipped: true, reason: 'memory_pressure' }, null, 2));
    return;
  }
  const result = await runLunaBearStrategyObserver(options);
  const stdout = {
    ok: result.ok,
    status: result.status,
    sample: result.sample,
    meanReversionCount: result.meanReversionCount,
    defensiveCount: result.defensiveCount,
    changed: result.changed,
    alerted: result.alerted,
    alertError: result.alertError,
  };
  if (options.json) console.log(JSON.stringify(stdout, null, 2));
  else console.log(`luna-bear-strategy-observer status=${result.status} sample=${result.sample} changed=${result.changed} alerted=${result.alerted}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-bear-strategy-observer 실패:' });
}

