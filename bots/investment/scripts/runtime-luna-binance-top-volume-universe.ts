#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { query } from '../shared/db/core.ts';
import {
  BINANCE_TOP_VOLUME_BLOCK_REASON,
  DEFAULT_BINANCE_TOP_VOLUME_LIMIT,
  buildFixtureBinanceTopVolumeUniverse,
  evaluateBinanceTopVolumeUniverseGate,
  fetchBinanceTopVolumeUniverse,
  normalizeBinanceUsdtSymbol,
} from '../shared/binance-top-volume-universe.ts';

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
    { symbol: 'BTC/USDT', market: 'crypto', source: 'fixture', score: 0.91, discovered_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() },
    { symbol: 'PEPE/USDT', market: 'crypto', source: 'fixture', score: 0.89, discovered_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() },
    { symbol: 'USDC/USDT', market: 'crypto', source: 'fixture', score: 0.87, discovered_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString() },
  ];
}

function fixturePositions() {
  return [
    { symbol: 'BTC/USDT', amount: 0.01, avg_price: 100000, unrealized_pnl: 0, exchange: 'binance', paper: false, updated_at: new Date().toISOString() },
    { symbol: 'PEPE/USDT', amount: 1000000, avg_price: 0.00001, unrealized_pnl: 0, exchange: 'binance', paper: false, updated_at: new Date().toISOString() },
  ];
}

async function loadActiveCryptoCandidates({ fixture = false, limit = 200 } = {}) {
  if (fixture) return fixtureCandidates();
  return query(`
    SELECT DISTINCT ON (symbol)
           symbol, market, source, score::double precision AS score,
           discovered_at, expires_at, reason, raw_data
      FROM candidate_universe
     WHERE market = 'crypto'
       AND expires_at > NOW()
     ORDER BY symbol, score DESC, discovered_at DESC
     LIMIT $1
  `, [Math.max(1, Number(limit || 200))]).catch(() => []);
}

async function loadOpenBinancePositions({ fixture = false } = {}) {
  if (fixture) return fixturePositions();
  return query(`
    SELECT symbol, amount, avg_price, unrealized_pnl, exchange, paper,
           COALESCE(trade_mode, 'normal') AS trade_mode, updated_at
      FROM positions
     WHERE exchange = 'binance'
       AND COALESCE(paper, false) = false
       AND amount > 0
     ORDER BY symbol
  `).catch(() => []);
}

function evaluateCandidate(row = {}, universe = {}) {
  const gate = evaluateBinanceTopVolumeUniverseGate(row.symbol, universe);
  return {
    symbol: normalizeBinanceUsdtSymbol(row.symbol) || row.symbol,
    market: row.market || 'crypto',
    source: row.source || null,
    score: Number(row.score || 0),
    inBinanceTop30Universe: gate.ok,
    binanceTop30Rank: gate.rank,
    top30Blocker: gate.blocked ? BINANCE_TOP_VOLUME_BLOCK_REASON : null,
    reason: gate.reason,
  };
}

function evaluateHolding(row = {}, universe = {}) {
  const gate = evaluateBinanceTopVolumeUniverseGate(row.symbol, universe);
  return {
    symbol: normalizeBinanceUsdtSymbol(row.symbol) || row.symbol,
    amount: Number(row.amount || 0),
    avgPrice: Number(row.avg_price || row.avgPrice || 0),
    unrealizedPnl: Number(row.unrealized_pnl || row.unrealizedPnl || 0),
    exchange: row.exchange || 'binance',
    paper: row.paper === true,
    updatedAt: row.updated_at || null,
    inBinanceTop30Universe: gate.ok,
    binanceTop30Rank: gate.rank,
    liquidationCandidate: gate.blocked,
    // 'top'으로 일반화 (이전 'top30'). 유니버스 크기 env 가변. 매칭 의존 없는 출력 코드. 숫자 제거는 의도.
    code: gate.blocked ? 'off_universe_top_liquidation_candidate' : null,
    top30Blocker: gate.blocked ? BINANCE_TOP_VOLUME_BLOCK_REASON : null,
  };
}

export async function runLunaBinanceTopVolumeUniverse(options: any = {}) {
  const dryRun = options.dryRun === true;
  const fixture = options.fixture === true;
  // env(LUNA_BINANCE_TOP_VOLUME_LIMIT) 기반 DEFAULT 사용 (기본30/운영50). 과거 hardcoded 30이 env를 무시했음.
  const limit = options.limit && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : DEFAULT_BINANCE_TOP_VOLUME_LIMIT;
  const quote = 'USDT';
  const universe = fixture
    ? buildFixtureBinanceTopVolumeUniverse({ limit })
    : await fetchBinanceTopVolumeUniverse({ limit, quote });
  const [candidateRows, positionRows] = await Promise.all([
    loadActiveCryptoCandidates({ fixture, limit: options.candidateLimit || 200 }),
    loadOpenBinancePositions({ fixture }),
  ]);
  const evaluatedCandidates = candidateRows.map((row) => evaluateCandidate(row, universe));
  const evaluatedHoldings = positionRows.map((row) => evaluateHolding(row, universe));
  const excludedActiveCandidates = evaluatedCandidates.filter((item) => !item.inBinanceTop30Universe);
  const offUniverseHoldings = evaluatedHoldings.filter((item) => item.liquidationCandidate);
  return {
    ok: true,
    status: 'luna_binance_top_volume_universe_ready',
    dryRun,
    fixture,
    policy: {
      limit,
      quote,
      source: universe.source,
      blockReason: BINANCE_TOP_VOLUME_BLOCK_REASON,
      // 'top'으로 일반화 (이전 'top30'). 유니버스 크기 env 가변. 매칭 의존 없는 출력 코드. 숫자 제거는 의도.
      liquidationCandidateCode: 'off_universe_top_liquidation_candidate',
    },
    universe: {
      fetchedAt: universe.fetchedAt,
      source: universe.source,
      limit: universe.limit,
      quote: universe.quote,
      symbols: universe.symbols,
      ranks: universe.ranks,
      excluded: universe.excluded,
    },
    activeCandidates: {
      total: evaluatedCandidates.length,
      inUniverse: evaluatedCandidates.filter((item) => item.inBinanceTop30Universe).length,
      excluded: excludedActiveCandidates.length,
    },
    excludedActiveCandidates,
    holdings: {
      total: evaluatedHoldings.length,
      inUniverse: evaluatedHoldings.filter((item) => item.inBinanceTop30Universe).length,
      offUniverse: offUniverseHoldings.length,
    },
    offUniverseHoldings,
    safety: {
      liveMutation: false,
      liveSellExecuted: false,
      protectedProcessTouched: false,
      secretMutation: false,
    },
  };
}

async function main() {
  const result = await runLunaBinanceTopVolumeUniverse({
    json: hasFlag('json'),
    dryRun: hasFlag('dry-run'),
    fixture: hasFlag('fixture'),
    candidateLimit: Number(argValue('candidate-limit', 200)),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[luna-binance-top-volume-universe] top=${result.universe.symbols.length} excludedCandidates=${result.excludedActiveCandidates.length} offUniverseHoldings=${result.offUniverseHoldings.length}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'runtime-luna-binance-top-volume-universe error:',
  });
}
