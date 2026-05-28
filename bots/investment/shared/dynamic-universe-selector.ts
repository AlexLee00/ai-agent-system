// @ts-nocheck
// dynamic-universe-selector.ts — 3축(거래량/시총/섹터) × 체제별 동적 유니버스 셀렉터
// Phase 2: 마스터 비전 "유니버스도 동적!"
// 체제별 축 가중치 → 종목 점수 → 상위 N 선택 → universe_selection_shadow 기록

import { query } from './db/core.ts';
import { fetchBinanceTopVolumeUniverse } from './binance-top-volume-universe.ts';
import { getCachedKisDomesticUniverse, getCachedKisOverseasUniverse } from './kis-top-volume-universe.ts';
import { buildSectorUniverse } from './sector-rotation-universe.ts';

// ─── 환경 게이트 ──────────────────────────────────────────────────────────────
function boolEnv(name: string, fallback = false): boolean {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// ─── 체제별 축 가중치 (초기값, 학습으로 조정됨) ──────────────────────────────
export const REGIME_AXIS_WEIGHTS: Record<string, { volume: number; cap: number; sector: number }> = {
  TRENDING_BULL: { volume: 0.5, cap: 0.2, sector: 0.3 },
  TRENDING_BEAR: { volume: 0.2, cap: 0.5, sector: 0.3 },
  RANGING:       { volume: 0.3, cap: 0.2, sector: 0.5 },
  VOLATILE:      { volume: 0.4, cap: 0.4, sector: 0.2 },
};

// 유니버스 크기 기본값
const DEFAULT_UNIVERSE_SIZE: Record<string, number> = {
  crypto:   30,
  domestic: 50,
  overseas: 50,
};

// ─── 체제 정규화 ──────────────────────────────────────────────────────────────
function normalizeRegime(regime = ''): string {
  const r = String(regime || '').toUpperCase();
  if (r.includes('BULL'))  return 'TRENDING_BULL';
  if (r.includes('BEAR'))  return 'TRENDING_BEAR';
  if (r.includes('VOLAT')) return 'VOLATILE';
  return 'RANGING';
}

// ─── 거래량 축: 거래량 순위 → 0~1 점수 정규화 ───────────────────────────────

function buildVolumeScores(
  symbols: string[],
): Record<string, number> {
  const scores: Record<string, number> = {};
  const n = symbols.length;
  if (n === 0) return scores;
  symbols.forEach((sym, idx) => {
    // 1등 = 1.0, 꼴등 = 1/n (선형 역순)
    scores[sym.toUpperCase()] = (n - idx) / n;
  });
  return scores;
}

// ─── 시총 축: DB에서 market_cap 조회 → 0~1 점수 ─────────────────────────────

async function buildCapScores(
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  // corp_fundamentals에서 시총 조회 (국내 주식만, 크립토/해외는 0으로 기본)
  const rows = await query(
    `SELECT DISTINCT ON (cf.stock_code)
       cf.stock_code,
       cf.market_cap
     FROM investment.corp_fundamentals cf
     WHERE cf.stock_code = ANY($1)
       AND cf.market_cap IS NOT NULL
     ORDER BY cf.stock_code, cf.updated_at DESC`,
    [symbols],
  ).catch(() => []);

  const capMap: Record<string, number> = {};
  for (const row of (rows || [])) {
    capMap[String(row.stock_code || '').toUpperCase()] = Number(row.market_cap || 0);
  }

  // 최대 시총 기준 정규화
  const maxCap = Math.max(1, ...Object.values(capMap));
  const scores: Record<string, number> = {};
  for (const sym of symbols) {
    const key = sym.toUpperCase();
    const cap = capMap[key] || 0;
    scores[key] = cap > 0 ? Math.min(1, cap / maxCap) : 0.1; // 데이터 없으면 하한값
  }
  return scores;
}

// ─── 섹터 축: sector-rotation-universe → 0~1 점수 ───────────────────────────

async function buildSectorScores(
  exchange: string,
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  const sectorResult = await buildSectorUniverse(exchange, { days: 14, topSectorCount: 6 }).catch(() => ({
    symbolsWithSector: [],
    totalSymbols: 0,
  }));

  const scores: Record<string, number> = {};
  const sectorSymbolMap: Record<string, number> = {};

  // 섹터 점수 매핑
  for (const item of (sectorResult.symbolsWithSector || [])) {
    sectorSymbolMap[item.symbol.toUpperCase()] = item.sectorScore;
  }

  // 요청된 심볼에 점수 할당 (없으면 중립 0.3)
  for (const sym of symbols) {
    const key = sym.toUpperCase();
    scores[key] = sectorSymbolMap[key] ?? 0.3;
  }

  return scores;
}

// ─── 종합 점수 계산 ───────────────────────────────────────────────────────────

function computeCompositeScores(
  symbols: string[],
  volumeScores: Record<string, number>,
  capScores: Record<string, number>,
  sectorScores: Record<string, number>,
  axisWeights: { volume: number; cap: number; sector: number },
): { symbol: string; score: number; volumeScore: number; capScore: number; sectorScore: number }[] {
  return symbols.map((sym) => {
    const key = sym.toUpperCase();
    const vScore = volumeScores[key] ?? 0;
    const cScore = capScores[key] ?? 0.1;
    const sScore = sectorScores[key] ?? 0.3;
    const composite = vScore * axisWeights.volume + cScore * axisWeights.cap + sScore * axisWeights.sector;
    return { symbol: sym, score: composite, volumeScore: vScore, capScore: cScore, sectorScore: sScore };
  }).sort((a, b) => b.score - a.score);
}

// ─── universe_selection_shadow 기록 ──────────────────────────────────────────

async function persistSelectionShadow(
  regime: string,
  exchange: string,
  axisWeights: Record<string, number>,
  selectedSymbols: { symbol: string; score: number }[],
): Promise<void> {
  await query(
    `INSERT INTO investment.universe_selection_shadow
       (selected_at, regime, exchange, axis_weights, selected_symbols, universe_size, shadow_only)
     VALUES (NOW(), $1, $2, $3, $4, $5, TRUE)`,
    [
      regime,
      exchange,
      JSON.stringify(axisWeights),
      JSON.stringify(selectedSymbols.map((s) => ({ symbol: s.symbol, score: Number(s.score.toFixed(4)) }))),
      selectedSymbols.length,
    ],
  ).catch((err) => {
    // 테이블 없으면 마이그레이션 필요 — 조용히 무시
    console.warn(`[DynamicUniverse] shadow 저장 실패 (테이블 없음?): ${err?.message}`);
  });
}

// ─── 메인: 동적 유니버스 빌드 ───────────────────────────────────────────────

export interface DynamicUniverseResult {
  exchange: string;
  regime: string;
  axisWeights: { volume: number; cap: number; sector: number };
  selectedSymbols: { symbol: string; score: number; volumeScore: number; capScore: number; sectorScore: number }[];
  universeSize: number;
  shadowOnly: boolean;
}

export async function buildDynamicUniverse(
  regime: string,
  exchange: string,
  options: {
    universeSize?: number;
    skipPersist?: boolean;
    dryRun?: boolean;
  } = {},
): Promise<DynamicUniverseResult> {
  const normalizedReg = normalizeRegime(regime);
  const axisWeights = REGIME_AXIS_WEIGHTS[normalizedReg] ?? REGIME_AXIS_WEIGHTS.RANGING;
  const maxSize = options.universeSize ?? (
    exchange === 'binance' ? DEFAULT_UNIVERSE_SIZE.crypto :
    exchange === 'kis' ? DEFAULT_UNIVERSE_SIZE.domestic :
    DEFAULT_UNIVERSE_SIZE.overseas
  );

  // 1. 거래량 풀 수집
  let volumeSymbols: string[] = [];

  if (exchange === 'binance') {
    const binanceResult = await fetchBinanceTopVolumeUniverse().catch(() => ({ symbols: [] }));
    volumeSymbols = (binanceResult.symbols || []).map((s: string) => s.replace('/USDT', ''));
  } else if (exchange === 'kis') {
    const kisCache = await getCachedKisDomesticUniverse().catch(() => ({ symbols: [] }));
    volumeSymbols = kisCache.symbols ?? [];
  } else {
    // kis_overseas
    const kisCache = await getCachedKisOverseasUniverse().catch(() => ({ symbols: [] }));
    volumeSymbols = kisCache.symbols ?? [];
  }

  // 중복 제거, 대문자
  const allSymbols = [...new Set(volumeSymbols.map((s) => String(s).toUpperCase()))];

  if (allSymbols.length === 0) {
    console.warn(`[DynamicUniverse] ${exchange}/${normalizedReg} 심볼 없음 — 빈 유니버스 반환`);
    return {
      exchange,
      regime: normalizedReg,
      axisWeights,
      selectedSymbols: [],
      universeSize: 0,
      shadowOnly: true,
    };
  }

  // 2. 3축 점수 병렬 계산
  const [volumeScores, capScores, sectorScores] = await Promise.all([
    Promise.resolve(buildVolumeScores(allSymbols)),
    buildCapScores(allSymbols),
    buildSectorScores(exchange, allSymbols),
  ]);

  // 3. 종합 점수 계산 + 상위 N 선택
  const scored = computeCompositeScores(allSymbols, volumeScores, capScores, sectorScores, axisWeights);
  const selected = scored.slice(0, maxSize);

  // 4. shadow 기록 (skipPersist/dryRun 아닐 때)
  if (!options.skipPersist && !options.dryRun) {
    await persistSelectionShadow(normalizedReg, exchange, axisWeights, selected);
  }

  console.log(
    `[DynamicUniverse] ${exchange}/${normalizedReg} — 후보 ${allSymbols.length}개 → 선택 ${selected.length}개`,
    `(weights: vol=${axisWeights.volume} cap=${axisWeights.cap} sector=${axisWeights.sector})`,
  );

  return {
    exchange,
    regime: normalizedReg,
    axisWeights,
    selectedSymbols: selected,
    universeSize: selected.length,
    shadowOnly: !boolEnv('LUNA_DYNAMIC_UNIVERSE_ACTIVE', true),
  };
}

// ─── 현재 체제 조회 (market-regime 테이블 또는 기본값) ───────────────────────

export async function getCurrentRegime(exchange = 'binance'): Promise<string> {
  const marketByExchange: Record<string, string> = {
    binance: 'crypto',
    kis: 'domestic',
    kis_overseas: 'overseas',
  };
  const normalizedExchange = String(exchange || '').trim().toLowerCase();
  const market = marketByExchange[normalizedExchange] || normalizedExchange || 'crypto';
  const row = await query(
    `SELECT regime
     FROM investment.market_regime_snapshots
     WHERE market = ANY($1)
     ORDER BY captured_at DESC
     LIMIT 1`,
    [[market, normalizedExchange].filter(Boolean)],
  ).catch(() => []);

  return String((row?.[0] as any)?.regime || 'RANGING');
}

export default {
  buildDynamicUniverse,
  getCurrentRegime,
  REGIME_AXIS_WEIGHTS,
};
