// @ts-nocheck
import { getActiveCandidates } from './discovery-store.ts';
import { runDiscoveryOrchestrator } from './discovery-orchestrator.ts';
import { getLunaIntelligentDiscoveryFlags } from '../../shared/luna-intelligent-discovery-config.ts';

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

export async function buildDiscoveryUniverse(market, now = new Date(), options = {}) {
  const flags = getLunaIntelligentDiscoveryFlags();
  const refresh = options.refresh === true;
  const limit = resolveTopN(flags, market, options.limit ?? null);
  const fallbackSymbols = Array.isArray(options.fallbackSymbols) ? options.fallbackSymbols : [];

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

  const rows = await getActiveCandidates(market, limit).catch(() => []);
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
      .filter(Boolean),
  );

  const mergedSymbols = [];
  const seen = new Set();
  for (const item of candidates) {
    if (seen.has(item.symbol)) continue;
    seen.add(item.symbol);
    mergedSymbols.push(item.symbol);
  }
  for (const item of fallbackSymbols) {
    const normalized = normalizeDiscoverySymbol(item, market);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    mergedSymbols.push(normalized);
  }
  const limitedSymbols = mergedSymbols.slice(0, limit);

  return {
    market,
    at: now instanceof Date ? now.toISOString() : new Date().toISOString(),
    candidates,
    symbols: limitedSymbols,
    limit,
    source: candidates.length > 0 ? 'candidate_universe' : 'fallback',
  };
}

export default buildDiscoveryUniverse;
