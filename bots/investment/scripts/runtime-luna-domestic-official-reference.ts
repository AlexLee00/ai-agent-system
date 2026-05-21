#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { query } from '../shared/db/core.ts';
import {
  DOMESTIC_OFFICIAL_REFERENCE_BLOCK_SOURCE,
  annotateDomesticOfficialReferenceCandidates,
  buildFixtureDomesticOfficialReference,
  evaluateDomesticOfficialReferenceGate,
  fetchDomesticOfficialReference,
  fetchDataGoCorporateFinanceSummary,
  getCachedDomesticOfficialReference,
  summarizeDomesticOfficialReference,
  writeDomesticOfficialReferenceCache,
} from '../shared/domestic-official-reference.ts';

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function fixtureCandidates() {
  return [
    { symbol: '005930', market: 'domestic', source: 'fixture', score: 0.91, discovered_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() },
    { symbol: '069500', market: 'domestic', source: 'fixture', score: 0.88, discovered_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() },
    { symbol: '005935', market: 'domestic', source: 'fixture', score: 0.84, discovered_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() },
    { symbol: '123450', market: 'domestic', source: 'fixture', score: 0.80, discovered_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() },
    { symbol: '000020', market: 'domestic', source: 'fixture', score: 0.72, discovered_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() },
  ];
}

function fixtureHoldings() {
  return [
    { symbol: '005930', amount: 3, avg_price: 80000, unrealized_pnl: 0, exchange: 'kis', paper: false, updated_at: new Date().toISOString() },
    { symbol: '069500', amount: 2, avg_price: 40000, unrealized_pnl: 0, exchange: 'kis', paper: false, updated_at: new Date().toISOString() },
  ];
}

async function loadActiveDomesticCandidates({ fixture = false, limit = 200 } = {}) {
  if (fixture) return fixtureCandidates();
  return query(`
    SELECT DISTINCT ON (symbol)
           symbol, market, source, score::double precision AS score,
           discovered_at, expires_at, reason, raw_data
      FROM candidate_universe
     WHERE market = 'domestic'
       AND expires_at > NOW()
     ORDER BY symbol, score DESC, discovered_at DESC
     LIMIT $1
  `, [Math.max(1, Number(limit || 200))]).catch(() => []);
}

async function loadOpenDomesticPositions({ fixture = false } = {}) {
  if (fixture) return fixtureHoldings();
  return query(`
    SELECT symbol, amount, avg_price, unrealized_pnl, exchange, paper,
           COALESCE(trade_mode, 'normal') AS trade_mode, updated_at
      FROM positions
     WHERE exchange = 'kis'
       AND COALESCE(paper, false) = false
       AND amount > 0
     ORDER BY symbol
  `).catch(() => []);
}

function evaluateHolding(row = {}, reference = {}, options = {}) {
  const gate = evaluateDomesticOfficialReferenceGate(row.symbol, reference, options);
  return {
    symbol: gate.canonicalSymbol || row.symbol,
    amount: Number(row.amount || 0),
    avgPrice: Number(row.avg_price || row.avgPrice || 0),
    unrealizedPnl: Number(row.unrealized_pnl || row.unrealizedPnl || 0),
    exchange: row.exchange || 'kis',
    paper: row.paper === true,
    updatedAt: row.updated_at || null,
    officialReferenceStatus: gate.referenceStatus || 'invalid',
    krxUniverseRank: gate.krxUniverseRank || null,
    officialReferenceName: gate.row?.name || null,
    officialReferenceCrno: gate.row?.crno || null,
    officialReferenceWouldBlock: gate.wouldBlock,
    officialReferenceHardBlocked: gate.hardBlocked,
    officialReferenceBlocker: gate.wouldBlock ? gate.reason : null,
    maintenanceCandidate: true,
    liveSellExecuted: false,
    code: gate.wouldBlock ? 'domestic_official_reference_review_candidate' : null,
  };
}

async function resolveReference(options = {}) {
  if (options.fixture) return buildFixtureDomesticOfficialReference();
  if (options.refresh) {
    const fetched = await fetchDomesticOfficialReference({
      baseDate: options.baseDate,
      timeoutMs: options.timeoutMs,
      minTurnoverKrw: options.minTurnoverKrw,
      minListingAgeDays: options.minListingAgeDays,
      corporateFinanceProbe: options.corporateFinanceProbe,
    });
    if (options.writeCache && fetched.available) {
      writeDomesticOfficialReferenceCache(fetched, options);
    }
    return fetched;
  }
  const reference = await getCachedDomesticOfficialReference({
    allowNetwork: options.allowNetwork,
    writeCache: options.writeCache,
    baseDate: options.baseDate,
    timeoutMs: options.timeoutMs,
    minTurnoverKrw: options.minTurnoverKrw,
    minListingAgeDays: options.minListingAgeDays,
  });
  if (options.writeCache && reference.available) {
    writeDomesticOfficialReferenceCache(reference, options);
  }
  return reference;
}

async function enrichCandidatesWithCorporateFinance(candidates = [], options = {}) {
  if (!options.corporateFinanceCandidateProbe) return candidates;
  const limit = Math.max(0, Math.min(20, Number(options.corporateFinanceCandidateLimit || 5)));
  if (limit <= 0) return candidates;
  const targets = candidates
    .filter((item) => item.officialReferenceCrno)
    .slice(0, limit);
  const bySymbol = new Map();
  for (const item of targets) {
    const result = await fetchDataGoCorporateFinanceSummary({
      crno: item.officialReferenceCrno,
      bizYear: options.corporateFinanceBizYear,
      timeoutMs: options.timeoutMs,
    });
    bySymbol.set(item.symbol, result);
  }
  return candidates.map((item) => {
    const finance = bySymbol.get(item.symbol);
    if (!finance) return item;
    return {
      ...item,
      corporateFinanceStatus: finance.ok && finance.summary ? 'available' : 'missing',
      corporateFinanceRows: finance.rows,
      corporateFinanceTotalCount: finance.totalCount,
      corporateFinanceBizYear: finance.bizYear,
      corporateFinanceFlags: finance.flags || (finance.reason ? [finance.reason] : []),
      corporateFinance: finance.summary || null,
    };
  });
}

export async function runLunaDomesticOfficialReference(options: any = {}) {
  const fixture = options.fixture === true;
  const reference = await resolveReference(options);
  const [candidateRows, positionRows] = await Promise.all([
    loadActiveDomesticCandidates({ fixture, limit: options.candidateLimit || 200 }),
    loadOpenDomesticPositions({ fixture }),
  ]);
  const annotated = annotateDomesticOfficialReferenceCandidates(candidateRows, reference, {
    hardGate: options.hardGate,
  });
  let evaluatedCandidates = [...annotated.candidates, ...annotated.excluded]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  evaluatedCandidates = await enrichCandidatesWithCorporateFinance(evaluatedCandidates, options);
  const evaluatedHoldings = positionRows.map((row) => evaluateHolding(row, reference, {
    hardGate: options.hardGate,
  }));
  return {
    ok: true,
    status: reference.available ? 'luna_domestic_official_reference_ready' : 'luna_domestic_official_reference_unavailable',
    dryRun: options.dryRun !== false,
    fixture,
    policy: {
      source: reference.source,
      blockSource: DOMESTIC_OFFICIAL_REFERENCE_BLOCK_SOURCE,
      hardGateEnabled: annotated.hardGateEnabled,
      liveMutation: false,
      liveBuyBlockedOnlyWhenHardGateEnabled: true,
      minTurnoverKrw: reference.minTurnoverKrw,
      minListingAgeDays: reference.minListingAgeDays,
    },
    reference: summarizeDomesticOfficialReference(reference),
    activeCandidates: {
      total: evaluatedCandidates.length,
      wouldBlock: evaluatedCandidates.filter((item) => item.officialReferenceWouldBlock).length,
      hardBlocked: evaluatedCandidates.filter((item) => item.officialReferenceHardBlocked).length,
      referenceAnnotated: evaluatedCandidates.filter((item) => item.officialReferenceStatus === 'available').length,
    },
    officialReferenceCandidates: evaluatedCandidates.map((item) => ({
      symbol: item.symbol,
      source: item.source || null,
      score: Number(item.score || 0),
      officialReferenceStatus: item.officialReferenceStatus,
      krxUniverseRank: item.krxUniverseRank,
      officialReferenceName: item.officialReferenceName || null,
      officialReferenceCrno: item.officialReferenceCrno || null,
      officialReferenceMarket: item.officialReferenceMarket,
      officialReferenceSecurityType: item.officialReferenceSecurityType,
      officialReferenceStockType: item.officialReferenceStockType,
      officialReferenceListedDate: item.officialReferenceListedDate || null,
      officialReferenceListingAgeDays: item.officialReferenceListingAgeDays ?? null,
      officialReferenceTurnoverKrw: item.officialReferenceTurnoverKrw,
      officialReferenceBlockers: item.officialReferenceBlockers,
      officialReferenceWouldBlock: item.officialReferenceWouldBlock,
      officialReferenceHardBlocked: item.officialReferenceHardBlocked,
      corporateFinanceStatus: item.corporateFinanceStatus || null,
      corporateFinanceRows: item.corporateFinanceRows ?? null,
      corporateFinanceBizYear: item.corporateFinanceBizYear || null,
      corporateFinanceFlags: item.corporateFinanceFlags || [],
      corporateFinance: item.corporateFinance || null,
    })),
    holdings: {
      total: evaluatedHoldings.length,
      wouldBlock: evaluatedHoldings.filter((item) => item.officialReferenceWouldBlock).length,
      hardBlocked: evaluatedHoldings.filter((item) => item.officialReferenceHardBlocked).length,
    },
    officialReferenceHoldings: evaluatedHoldings,
    safety: {
      liveMutation: false,
      liveBuyExecuted: false,
      liveSellExecuted: false,
      protectedProcessTouched: false,
      secretMutation: false,
    },
  };
}

async function main() {
  const result = await runLunaDomesticOfficialReference({
    json: hasFlag('json'),
    dryRun: hasFlag('dry-run') || !hasFlag('apply'),
    fixture: hasFlag('fixture'),
    refresh: hasFlag('refresh'),
    allowNetwork: hasFlag('network'),
    writeCache: hasFlag('write-cache'),
    hardGate: hasFlag('hard-gate'),
    baseDate: argValue('base-date', null),
    candidateLimit: Number(argValue('candidate-limit', 200)),
    timeoutMs: Number(argValue('timeout-ms', 8000)),
    minTurnoverKrw: Number(argValue('min-turnover-krw', process.env.LUNA_DOMESTIC_OFFICIAL_MIN_TURNOVER_KRW || 1_000_000_000)),
    minListingAgeDays: Number(argValue('min-listing-age-days', process.env.LUNA_DOMESTIC_OFFICIAL_MIN_LISTING_AGE_DAYS || 90)),
    corporateFinanceProbe: hasFlag('corporate-finance-probe'),
    corporateFinanceCandidateProbe: hasFlag('corporate-finance-candidate-probe'),
    corporateFinanceCandidateLimit: Number(argValue('corporate-finance-candidate-limit', 5)),
    corporateFinanceBizYear: argValue('corporate-finance-biz-year', process.env.LUNA_CORPORATE_FINANCE_BIZ_YEAR || '2024'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[luna-domestic-official-reference] status=${result.status} candidates=${result.activeCandidates.total} wouldBlock=${result.activeCandidates.wouldBlock} holdingsReview=${result.holdings.wouldBlock}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'runtime-luna-domestic-official-reference error:',
  });
}
