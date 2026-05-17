// @ts-nocheck
import { getActiveCandidates } from './discovery-store.ts';
import { runDiscoveryOrchestrator } from './discovery-orchestrator.ts';
import { getLunaIntelligentDiscoveryFlags } from '../../shared/luna-intelligent-discovery-config.ts';
import { checkTradeDataWeakSymbol } from '../../shared/trade-data-derived-guards.ts';
import {
  BINANCE_TOP_VOLUME_BLOCK_REASON,
  evaluateBinanceTopVolumeUniverseGate,
  getCachedBinanceTopVolumeUniverse,
} from '../../shared/binance-top-volume-universe.ts';
import * as db from '../../shared/db.ts';

export function toDiscoveryMarket(exchange = 'binance') {
  if (exchange === 'kis') return 'domestic';
  if (exchange === 'kis_overseas') return 'overseas';
  return 'crypto';
}

export function normalizeDiscoverySymbol(symbol = '', market = 'crypto') {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  if (market === 'crypto') {
    if (/^[A-Z0-9]+\/USDT$/.test(raw)) return raw;
    if (/^[A-Z0-9]+USDT$/.test(raw) && raw.length > 6) {
      return `${raw.slice(0, -4)}/USDT`;
    }
    return null;
  }
  if (market === 'domestic') {
    return /^\d{6}$/.test(raw) ? raw : null;
  }
  return /^[A-Z][A-Z0-9.\-]{0,12}$/.test(raw) ? raw : null;
}

function dedupeCandidateRows(rows = []) {
  const bySymbol = new Map();
  for (const row of rows) {
    const prev = bySymbol.get(row.symbol);
    if (!prev || Number(row.score || 0) > Number(prev.score || 0)) {
      bySymbol.set(row.symbol, row);
    }
  }
  return Array.from(bySymbol.values()).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function resolveTopN(flags, market, explicitLimit) {
  if (explicitLimit != null) return Math.max(1, Number(explicitLimit));
  if (market === 'domestic') return flags.discovery.topDomestic ?? 100;
  if (market === 'overseas') return flags.discovery.topOverseas ?? 100;
  return flags.discovery.topCrypto ?? 50;
}

function exchangeForMarket(market = 'crypto') {
  if (market === 'domestic') return 'kis';
  if (market === 'overseas') return 'kis_overseas';
  return 'binance';
}

function getDiscoverySelectionBlock(symbol, market = 'crypto') {
  const block = checkTradeDataWeakSymbol(symbol, market);
  if (block?.blocked && block.source === 'pre_entry/crypto_structural_symbol_block') return block;
  return null;
}

async function resolveCryptoTopVolumeUniverse(market = 'crypto', options = {}) {
  if (market !== 'crypto') return null;
  if (options.enforceBinanceTopVolumeUniverse === false) return null;
  if (options.binanceTopVolumeUniverse) return options.binanceTopVolumeUniverse;
  return getCachedBinanceTopVolumeUniverse({
    timeoutMs: Math.max(3000, Number(options.timeoutMs || 8000)),
  }).catch((error) => {
    console.warn(`[discovery-universe] Binance Top 30 universe fetch failed: ${error?.message || error}`);
    return null;
  });
}

function getBinanceTopVolumeSelectionBlock(symbol, market = 'crypto', universe = null) {
  if (market !== 'crypto' || !universe) return null;
  const gate = evaluateBinanceTopVolumeUniverseGate(symbol, universe);
  if (gate.ok) return null;
  return {
    blocked: true,
    source: 'pre_entry/binance_top30_volume_universe',
    reason: BINANCE_TOP_VOLUME_BLOCK_REASON,
    gate,
  };
}

function isBuySignal(value) {
  return String(value || '').trim().toUpperCase() === 'BUY';
}

function isSellSignal(value) {
  return String(value || '').trim().toUpperCase() === 'SELL';
}

function buildActionablePromotionScore(rows = [], market = 'crypto') {
  const byAnalyst = {};
  for (const row of rows || []) {
    const analyst = String(row?.analyst || '').trim().toLowerCase();
    if (!analyst) continue;
    if (!byAnalyst[analyst] || new Date(row.created_at || 0) > new Date(byAnalyst[analyst].created_at || 0)) {
      byAnalyst[analyst] = row;
    }
  }
  const latest = Object.values(byAnalyst);
  const sellCount = latest.filter((row) => isSellSignal(row.signal)).length;
  const buyAnalysts = new Set(latest.filter((row) => isBuySignal(row.signal)).map((row) => String(row.analyst || '').toLowerCase()));
  const avgConfidence = latest.length
    ? latest.reduce((sum, row) => sum + Number(row.confidence || 0), 0) / latest.length
    : 0;
  const hasTaBuy = buyAnalysts.has('ta_mtf');
  const hasFlowBuy = buyAnalysts.has('market_flow');
  const hasNewsBuy = buyAnalysts.has('news');
  const hasSentimentBuy = buyAnalysts.has('sentiment');
  const hasOnchainBuy = buyAnalysts.has('onchain');
  const supportingBuy = market === 'crypto'
    ? (hasOnchainBuy || hasSentimentBuy || hasNewsBuy)
    : (hasFlowBuy || hasSentimentBuy || hasNewsBuy);
  const threshold = market === 'crypto' ? 0.28 : 0.18;
  const actionable = sellCount === 0 && hasTaBuy && supportingBuy && avgConfidence >= threshold;
  return {
    actionable,
    score: (actionable ? 10 : 0)
      + (hasTaBuy ? 2 : 0)
      + (supportingBuy ? 2 : 0)
      + buyAnalysts.size
      + avgConfidence,
    avgConfidence,
    buyAnalysts: Array.from(buyAnalysts),
    sellCount,
  };
}

async function findRecentActionableCandidateSymbols(market, candidates = [], options = {}) {
  const enabled = options.promoteRecentActionable !== false
    && String(process.env.LUNA_DISCOVERY_PROMOTE_ACTIONABLE_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled || candidates.length === 0) return [];
  const symbols = candidates.map((row) => row.symbol).filter(Boolean);
  if (symbols.length === 0) return [];
  const hours = Math.max(1, Number(options.actionableLookbackHours || process.env.LUNA_DISCOVERY_ACTIONABLE_LOOKBACK_HOURS || 6));
  const exchange = exchangeForMarket(market);
  const rows = await db.query(
    `SELECT symbol, analyst, signal, confidence, created_at
       FROM analysis
      WHERE exchange = $1
        AND created_at >= now() - ($2::int * INTERVAL '1 hour')
        AND symbol = ANY($3::text[])`,
    [exchange, hours, symbols],
  ).catch(() => []);
  const grouped = new Map();
  for (const row of rows || []) {
    const normalized = normalizeDiscoverySymbol(row.symbol, market);
    if (!normalized) continue;
    if (!grouped.has(normalized)) grouped.set(normalized, []);
    grouped.get(normalized).push(row);
  }
  return Array.from(grouped.entries())
    .map(([symbol, items]) => ({ symbol, ...buildActionablePromotionScore(items, market) }))
    .filter((item) => item.actionable)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .map((item) => item.symbol);
}

export async function buildDiscoveryUniverse(market, now = new Date(), options = {}) {
  const flags = getLunaIntelligentDiscoveryFlags();
  const refresh = options.refresh === true;
  const limit = resolveTopN(flags, market, options.limit ?? null);
  const fallbackSymbols = Array.isArray(options.fallbackSymbols) ? options.fallbackSymbols : [];
  const pinnedSymbols = Array.isArray(options.pinnedSymbols) ? options.pinnedSymbols : [];
  const preferCandidates = options.preferCandidates === true;
  const candidateScanLimit = Math.max(
    limit,
    Number(options.candidateScanLimit || process.env.LUNA_DISCOVERY_CANDIDATE_SCAN_LIMIT || 0) || Math.min(200, Math.max(80, limit * 8)),
  );

  if (flags.phases.discoveryOrchestratorEnabled && refresh) {
    await runDiscoveryOrchestrator({
      markets: [market],
      dryRun: false,
      limit,
      timeoutMs: Math.max(3000, Number(options.timeoutMs || 8000)),
      ttlHours: Math.max(2, Number(options.ttlHours || 24)),
    }).catch((error) => {
      console.warn(`[discovery-universe] orchestrator refresh failed (${market}): ${error?.message || error}`);
    });
  }

  const rows = await getActiveCandidates(market, candidateScanLimit).catch(() => []);
  const binanceTopVolumeUniverse = await resolveCryptoTopVolumeUniverse(market, options);
  const excludedSymbols = [];
  function rememberExcluded(symbol, block, source = 'candidate') {
    if (!symbol || !block?.blocked) return;
    if (excludedSymbols.some((item) => item.symbol === symbol && item.source === block.source)) return;
    excludedSymbols.push({
      symbol,
      source: block.source,
      reason: block.reason,
      inputSource: source,
    });
  }
  const candidates = dedupeCandidateRows(
    rows
      .map((row) => {
        const normalized = normalizeDiscoverySymbol(row.symbol, market);
        if (!normalized) return null;
        return {
          symbol: normalized,
          market,
          source: row.source,
          score: Number(row.score || 0),
          confidence: Number(row.confidence ?? row.score ?? 0.5),
          reason: row.reason || '',
          reasonCode: row.reason_code || null,
          evidenceRef: row.evidence_ref || null,
          qualityFlags: Array.isArray(row.quality_flags) ? row.quality_flags : [],
          discoveredAt: row.discovered_at || null,
          expiresAt: row.expires_at || null,
        };
      })
      .filter((row) => {
        if (!row) return false;
        const block = getDiscoverySelectionBlock(row.symbol, market)
          || getBinanceTopVolumeSelectionBlock(row.symbol, market, binanceTopVolumeUniverse);
        if (block) {
          rememberExcluded(row.symbol, block, 'candidate_universe');
          return false;
        }
        return true;
      }),
  );

  const mergedSymbols = [];
  const seen = new Set();
  const promotedSymbols = await findRecentActionableCandidateSymbols(market, candidates, options);

  function addSymbol(item, source = 'symbol') {
    const normalized = normalizeDiscoverySymbol(item, market);
    if (!normalized || seen.has(normalized)) return;
    const block = getDiscoverySelectionBlock(normalized, market)
      || getBinanceTopVolumeSelectionBlock(normalized, market, binanceTopVolumeUniverse);
    if (block) {
      rememberExcluded(normalized, block, source);
      return;
    }
    seen.add(normalized);
    mergedSymbols.push(normalized);
  }

  for (const item of pinnedSymbols) addSymbol(item, 'pinned');
  for (const item of promotedSymbols) addSymbol(item, 'promoted');
  if (preferCandidates) {
    for (const item of candidates) addSymbol(item.symbol, 'candidate');
    for (const item of fallbackSymbols) addSymbol(item, 'fallback');
  } else {
    for (const item of fallbackSymbols) addSymbol(item, 'fallback');
    for (const item of candidates) addSymbol(item.symbol, 'candidate');
  }
  const limitedSymbols = mergedSymbols.slice(0, limit);

  return {
    market,
    at: now instanceof Date ? now.toISOString() : new Date().toISOString(),
    candidates,
    symbols: limitedSymbols,
    limit,
    candidateScanLimit,
    selectionPolicy: preferCandidates ? 'candidate_first' : 'fallback_first',
    pinnedCount: pinnedSymbols.length,
    promotedCount: promotedSymbols.length,
    promotedSymbols,
    excludedSymbols,
    binanceTopVolumeUniverse: binanceTopVolumeUniverse ? {
      source: binanceTopVolumeUniverse.source,
      fetchedAt: binanceTopVolumeUniverse.fetchedAt,
      limit: binanceTopVolumeUniverse.limit,
      symbols: binanceTopVolumeUniverse.symbols,
    } : null,
    source: candidates.length > 0 ? 'candidate_universe' : 'fallback',
  };
}

export default buildDiscoveryUniverse;
