// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  DEFAULT_BINANCE_MAJOR_UNIVERSE_LIMIT,
  DEFAULT_BINANCE_MAJOR_WHITELIST,
  baseAssetFromCanonicalSymbol,
  isMajorExcludedBaseAsset,
  normalizeBinanceUsdtSymbol,
} from './binance-top-volume-universe.ts';
import { investmentOpsRuntimeFile } from './runtime-ops-path.ts';

const require = createRequire(import.meta.url);
const COINGECKO_MARKETS_URL = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
const BINANCE_EXCHANGE_INFO_URL = 'https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT';
const DEFAULT_TIMEOUT_MS = 10_000;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function exchangeInfoBySymbol(exchangeInfo = {}) {
  const map = new Map();
  for (const info of Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : []) {
    const canonical = normalizeBinanceUsdtSymbol(info?.symbol);
    if (canonical) map.set(canonical, info);
  }
  return map;
}

function isTradingUsdtSpot(info = {}) {
  return info?.status === 'TRADING'
    && String(info?.quoteAsset || '').toUpperCase() === 'USDT'
    && info?.isSpotTradingAllowed === true;
}

function normalizeCurrentSymbols(symbols = DEFAULT_BINANCE_MAJOR_WHITELIST) {
  return [...new Set((Array.isArray(symbols) ? symbols : [])
    .map((symbol) => normalizeBinanceUsdtSymbol(symbol))
    .filter(Boolean))];
}

export function buildBinanceMajorUniverseDrift({
  coinGeckoRows = [],
  exchangeInfo = {},
  currentSymbols = DEFAULT_BINANCE_MAJOR_WHITELIST,
  generatedAt = new Date().toISOString(),
} = {}) {
  const current = normalizeCurrentSymbols(currentSymbols);
  const infoBySymbol = exchangeInfoBySymbol(exchangeInfo);
  const seen = new Set();
  const ranked = [];
  const marketRankBySymbol = new Map();
  const excluded = { structural: [], notTrading: [], duplicateSymbol: [] };

  const orderedRows = (Array.isArray(coinGeckoRows) ? coinGeckoRows : [])
    .slice()
    .sort((a, b) => (finiteNumber(a?.market_cap_rank) ?? Number.MAX_SAFE_INTEGER)
      - (finiteNumber(b?.market_cap_rank) ?? Number.MAX_SAFE_INTEGER));

  for (const row of orderedRows) {
    const base = String(row?.symbol || '').trim().toUpperCase();
    const symbol = normalizeBinanceUsdtSymbol(base ? `${base}USDT` : '');
    const marketCapRank = finiteNumber(row?.market_cap_rank);
    if (!symbol || !marketCapRank) continue;
    if (!marketRankBySymbol.has(symbol)) marketRankBySymbol.set(symbol, marketCapRank);
    if (seen.has(symbol)) {
      excluded.duplicateSymbol.push(symbol);
      continue;
    }
    seen.add(symbol);
    if (isMajorExcludedBaseAsset(base)) {
      excluded.structural.push(symbol);
      continue;
    }
    const info = infoBySymbol.get(symbol);
    if (!isTradingUsdtSpot(info)) {
      excluded.notTrading.push(symbol);
      continue;
    }
    ranked.push({
      symbol,
      baseAsset: base,
      coinGeckoId: String(row?.id || '') || null,
      name: String(row?.name || '') || null,
      marketCapRank,
      marketCapUsd: finiteNumber(row?.market_cap),
      binanceStatus: info.status,
    });
  }

  const proposedRows = ranked.slice(0, DEFAULT_BINANCE_MAJOR_UNIVERSE_LIMIT);
  const proposedSymbols = proposedRows.map((row) => row.symbol);
  const currentSet = new Set(current);
  const proposedSet = new Set(proposedSymbols);
  const additions = proposedRows
    .filter((row) => !currentSet.has(row.symbol))
    .map((row) => ({ ...row, reason: 'market_cap_rank_entered_major20' }));
  const removals = current
    .filter((symbol) => !proposedSet.has(symbol))
    .map((symbol) => {
      const info = infoBySymbol.get(symbol);
      const trading = isTradingUsdtSpot(info);
      return {
        symbol,
        baseAsset: baseAssetFromCanonicalSymbol(symbol),
        marketCapRank: marketRankBySymbol.get(symbol) || null,
        binanceStatus: info?.status || 'NOT_LISTED',
        reason: trading ? 'market_cap_rank_decline' : 'binance_not_trading',
      };
    });

  return {
    ok: proposedSymbols.length === DEFAULT_BINANCE_MAJOR_UNIVERSE_LIMIT,
    status: proposedSymbols.length === DEFAULT_BINANCE_MAJOR_UNIVERSE_LIMIT
      ? 'major20_drift_proposal_ready'
      : 'major20_drift_proposal_incomplete',
    generatedAt,
    proposalOnly: true,
    autoApply: false,
    hasChanges: additions.length > 0 || removals.length > 0,
    source: {
      marketCap: 'CoinGecko /api/v3/coins/markets',
      tradingStatus: 'Binance /api/v3/exchangeInfo',
    },
    currentSymbols: current,
    proposedSymbols,
    proposedRows,
    additions,
    removals,
    excluded: {
      structural: [...new Set(excluded.structural)],
      notTrading: [...new Set(excluded.notTrading)],
      duplicateSymbol: [...new Set(excluded.duplicateSymbol)],
    },
    safety: {
      whitelistMutation: false,
      databaseWrite: false,
      orderExecution: false,
    },
  };
}

async function fetchJson(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LunaMajor20Drift/1.0' },
    });
    if (!response?.ok) throw new Error(`HTTP ${response?.status || 'unknown'} ${url}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function writeSnapshot(proposal, snapshotDir) {
  const dir = snapshotDir || investmentOpsRuntimeFile('crypto-major20-drift');
  const stamp = String(proposal.generatedAt).replace(/[:.]/g, '-');
  const filePath = path.join(dir, `major20-drift-${stamp}.json`);
  fs.mkdirSync(dir, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
  return { written: true, path: filePath };
}

function defaultPostAlarm() {
  const module = require('../../../packages/core/lib/hub-alarm-client.js');
  return module.postAlarm || module.default?.postAlarm;
}

async function notifyProposal(proposal, postAlarmFn) {
  if (!proposal.ok) return { sent: false, reason: 'proposal_incomplete' };
  if (!proposal.hasChanges) return { sent: false, reason: 'no_changes' };
  const postAlarm = postAlarmFn || defaultPostAlarm();
  if (typeof postAlarm !== 'function') return { sent: false, reason: 'alarm_client_unavailable' };
  try {
    const result = await postAlarm({
      team: 'investment',
      fromBot: 'luna-major20-drift',
      alertLevel: 2,
      alarmType: 'report',
      visibility: 'human_action',
      actionability: 'needs_approval',
      eventType: 'binance_major20_market_cap_drift_proposal',
      incidentKey: 'luna:binance-major20-market-cap-drift',
      title: 'Binance major-20 변경 제안',
      message: `major-20 변경 제안 additions=${proposal.additions.map((item) => item.symbol).join(',') || '-'} removals=${proposal.removals.map((item) => item.symbol).join(',') || '-'} 자동 적용 없음`,
      payload: {
        proposalOnly: true,
        additions: proposal.additions,
        removals: proposal.removals,
        proposedSymbols: proposal.proposedSymbols,
      },
    });
    if (result?.ok !== true) return { sent: false, reason: 'alarm_failed', result };
    return { sent: true, result };
  } catch (error) {
    return { sent: false, reason: 'alarm_failed', error: String(error?.message || error) };
  }
}

export async function runBinanceMajorUniverseDrift(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const [coinGeckoRows, exchangeInfo] = await Promise.all([
    options.coinGeckoRows || fetchJson(COINGECKO_MARKETS_URL, options),
    options.exchangeInfo || fetchJson(BINANCE_EXCHANGE_INFO_URL, options),
  ]);
  const proposal = buildBinanceMajorUniverseDrift({
    coinGeckoRows,
    exchangeInfo,
    currentSymbols: options.currentSymbols,
    generatedAt: now.toISOString(),
  });
  const snapshot = options.writeSnapshot === false
    ? { written: false, path: null }
    : writeSnapshot(proposal, options.snapshotDir);
  const alert = options.notify === false
    ? { sent: false, reason: 'notification_disabled' }
    : await notifyProposal(proposal, options.postAlarmFn);
  return {
    ok: proposal.ok,
    status: proposal.status,
    proposal,
    snapshot,
    alert,
    mutation: { whitelistChanged: false, autoApplied: false },
  };
}

export default {
  buildBinanceMajorUniverseDrift,
  runBinanceMajorUniverseDrift,
};
