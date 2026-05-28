// @ts-nocheck
// sector-rotation-universe.ts — 섹터별 종목 풀 + 강세 섹터 식별
// 3축 동적 유니버스(dynamic-universe-selector.ts)에서 섹터 축 데이터 제공
// 크립토: 테마별 그룹 (Layer1/DeFi/AI/GameFi 등)
// 해외주식: GICS-style 섹터 (Tech/Healthcare/Finance 등)
// 국내주식: 업종 기반 분류

import { query } from './db/core.ts';

// ─── 크립토 섹터 매핑 ─────────────────────────────────────────────────────────
export const CRYPTO_SECTORS: Record<string, string[]> = {
  LAYER1:    ['BTC', 'ETH', 'SOL', 'ADA', 'AVAX', 'DOT', 'ATOM', 'NEAR', 'APT', 'SUI'],
  LAYER2:    ['MATIC', 'ARB', 'OP', 'IMX', 'STRK', 'MANTA', 'BLAST', 'SCROLL'],
  DEFI:      ['UNI', 'AAVE', 'MKR', 'COMP', 'CRV', 'SNX', 'LDO', 'RPL', 'PENDLE'],
  AI_DATA:   ['FET', 'AGIX', 'OCEAN', 'RNDR', 'TAO', 'WLD', 'GRT', 'ALT'],
  GAMEFI:    ['AXS', 'SAND', 'MANA', 'ILV', 'GALA', 'ENJ', 'MAGIC', 'BEAM'],
  EXCHANGE:  ['BNB', 'OKB', 'HT', 'KCS', 'FTT', 'CRO', 'GT'],
  MEME:      ['DOGE', 'SHIB', 'PEPE', 'FLOKI', 'BONK', 'WIF', 'BOME', 'MEW'],
  INFRA:     ['LINK', 'VET', 'HBAR', 'XRP', 'XLM', 'ALGO', 'IOTA', 'ROSE'],
  PRIVACY:   ['XMR', 'ZEC', 'DASH', 'SCRT', 'OXEN'],
  RWA:       ['ONDO', 'CFG', 'TRU', 'MPL', 'CPOOL'],
};

// ─── 해외주식 섹터 매핑 (GICS-style) ─────────────────────────────────────────
export const OVERSEAS_SECTORS: Record<string, string[]> = {
  TECH:        ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'META', 'AMD', 'INTC', 'AVGO', 'QCOM', 'MU', 'NET', 'CRWD', 'SNOW', 'PLTR'],
  AI_INFRA:    ['NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM', 'SMCI', 'ALAB', 'TSM'],
  FINTECH:     ['COIN', 'MSTR', 'PYPL', 'SQ', 'SOFI', 'AFRM', 'UPST', 'NU'],
  CRYPTO_EQ:   ['MSTR', 'COIN', 'MARA', 'RIOT', 'CLSK', 'IREN', 'CIFR', 'CORZ', 'HUT'],
  EV_CLEAN:    ['TSLA', 'RIVN', 'NIO', 'XPEV', 'LI', 'LCID', 'PLUG', 'BE', 'FCEL', 'EOSE'],
  E_COMMERCE:  ['AMZN', 'SHOP', 'UBER', 'LYFT', 'DASH', 'ABNB', 'BKNG'],
  BIOTECH:     ['MRNA', 'BNTX', 'SNGX', 'RGTI', 'ACHR', 'ARKG'],
  QUANTUM:     ['QBTS', 'RGTI', 'IONQ', 'QUBT'],
  FINANCIAL:   ['JPM', 'BAC', 'GS', 'MS', 'C', 'WFC', 'V', 'MA'],
  CHINA_ADR:   ['BABA', 'PDD', 'JD', 'NIO', 'XPEV', 'LI', 'BIDU', 'TME'],
};

// ─── 국내 업종 매핑 (KRX 업종 코드 기반 심볼) ───────────────────────────────
// 종목코드는 KIS 거래량 조회 후 동적으로 업데이트되므로 초기값은 대표 종목만
export const DOMESTIC_SECTORS: Record<string, string[]> = {
  SEMICONDUCTOR: ['005930', '000660', '042700', '086520', '058470', '357780'],
  BATTERY:       ['373220', '051910', '247540', '096770', '012330', '006400'],
  BIO:           ['207940', '068270', '128940', '145020', '009290', '011000'],
  AUTO:          ['005380', '000270', '012330', '034220', '204320'],
  STEEL:         ['005490', '004020', '001020', '010060'],
  FINANCE:       ['105560', '055550', '086790', '000080', '004170'],
  IT_SOFTWARE:   ['035420', '035720', '259960', '035900', '263750'],
  ENERGY:        ['096770', '010950', '000880', '078930'],
  SHIPBUILDING:  ['009540', '010140', '329180', '042660'],
  CHEMICAL:      ['051910', '011790', '003410', '096770'],
};

// ─── 거래 이력 기반 섹터 성과 조회 ───────────────────────────────────────────

async function fetchSectorPerformance(exchange: string, days = 14): Promise<Record<string, { winRate: number; avgPnl: number; trades: number }>> {
  const rows = await query(
    `SELECT
       tj.symbol,
       COUNT(*) AS total_trades,
       COUNT(*) FILTER (
         WHERE COALESCE(tj.pnl_percent, 0) > 0
            OR COALESCE(tj.pnl_net, tj.pnl_amount, 0) > 0
       ) AS win_trades,
       AVG(COALESCE(tj.pnl_percent, 0)) AS avg_pnl_pct
     FROM investment.trade_journal tj
     WHERE tj.exit_time IS NOT NULL
       AND NOT COALESCE(tj.is_paper, false)
       AND COALESCE(tj.exchange, 'binance') = $1
       AND to_timestamp(tj.exit_time / 1000.0) >= NOW() - ($2 || ' days')::interval
     GROUP BY tj.symbol
     ORDER BY total_trades DESC
     LIMIT 500`,
    [exchange, days],
  ).catch(() => []);

  // 심볼 → 섹터 매핑으로 집계
  const sectorMap = resolveSectorMap(exchange);
  const symbolPerf: Record<string, { total: number; wins: number; avgPnl: number }> = {};

  for (const row of (rows || [])) {
    symbolPerf[String(row.symbol || '').toUpperCase()] = {
      total: Number(row.total_trades || 0),
      wins: Number(row.win_trades || 0),
      avgPnl: Number(row.avg_pnl_pct || 0),
    };
  }

  // 섹터별 집계
  const sectorPerf: Record<string, { winRate: number; avgPnl: number; trades: number }> = {};
  for (const [sector, symbols] of Object.entries(sectorMap)) {
    let totalTrades = 0;
    let totalWins = 0;
    let totalPnl = 0;
    let coveredCount = 0;

    for (const sym of symbols) {
      const p = symbolPerf[sym.toUpperCase()];
      if (!p || p.total === 0) continue;
      totalTrades += p.total;
      totalWins += p.wins;
      totalPnl += p.avgPnl * p.total;
      coveredCount++;
    }

    if (totalTrades === 0) {
      sectorPerf[sector] = { winRate: 0, avgPnl: 0, trades: 0 };
    } else {
      sectorPerf[sector] = {
        winRate: totalWins / totalTrades,
        avgPnl: totalPnl / totalTrades,
        trades: totalTrades,
      };
    }
  }

  return sectorPerf;
}

// ─── 거래소별 섹터 맵 선택 ────────────────────────────────────────────────────

function resolveSectorMap(exchange: string): Record<string, string[]> {
  if (exchange === 'kis') return DOMESTIC_SECTORS;
  if (exchange === 'kis_overseas') return OVERSEAS_SECTORS;
  return CRYPTO_SECTORS; // binance 기본
}

// ─── 강세 섹터 랭킹 ───────────────────────────────────────────────────────────

function rankSectors(
  sectorPerf: Record<string, { winRate: number; avgPnl: number; trades: number }>,
): { sector: string; score: number; winRate: number; avgPnl: number; trades: number }[] {
  const ranked = Object.entries(sectorPerf).map(([sector, p]) => {
    // 종합 점수: 승률 60% + 평균 손익 40% (데이터 없으면 중립 0.5)
    const winScore = p.trades >= 2 ? p.winRate : 0.5;
    const pnlScore = p.trades >= 2 ? Math.min(1, Math.max(0, p.avgPnl * 10 + 0.5)) : 0.5;
    const score = winScore * 0.6 + pnlScore * 0.4;
    return { sector, score, winRate: p.winRate, avgPnl: p.avgPnl, trades: p.trades };
  });

  return ranked.sort((a, b) => b.score - a.score);
}

// ─── 섹터별 심볼 풀 반환 ─────────────────────────────────────────────────────

export interface SectorUniverseResult {
  exchange: string;
  topSectors: { sector: string; score: number; symbols: string[] }[];
  symbolsWithSector: { symbol: string; sector: string; sectorScore: number }[];
  totalSymbols: number;
}

export async function buildSectorUniverse(
  exchange: string,
  options: { days?: number; topSectorCount?: number } = {},
): Promise<SectorUniverseResult> {
  const days = options.days ?? 14;
  const topSectorCount = options.topSectorCount ?? 4;

  const sectorPerf = await fetchSectorPerformance(exchange, days);
  const ranked = rankSectors(sectorPerf);
  const sectorMap = resolveSectorMap(exchange);

  // 상위 섹터 선택 (데이터 없는 섹터도 포함해서 다양성 확보)
  const topSectors = ranked.slice(0, topSectorCount).map((r) => ({
    sector: r.sector,
    score: r.score,
    symbols: sectorMap[r.sector] ?? [],
  }));

  // 심볼 → 섹터 점수 매핑 (중복 제거, 최고 점수 섹터 채택)
  const symbolBestScore: Record<string, { sector: string; score: number }> = {};
  for (const { sector, score } of ranked) {
    const syms = sectorMap[sector] ?? [];
    for (const sym of syms) {
      const key = sym.toUpperCase();
      if (!symbolBestScore[key] || symbolBestScore[key].score < score) {
        symbolBestScore[key] = { sector, score };
      }
    }
  }

  // 상위 섹터 심볼만 반환
  const topSectorNames = new Set(topSectors.map((s) => s.sector));
  const symbolsWithSector = Object.entries(symbolBestScore)
    .filter(([, v]) => topSectorNames.has(v.sector))
    .map(([symbol, v]) => ({ symbol, sector: v.sector, sectorScore: v.score }))
    .sort((a, b) => b.sectorScore - a.sectorScore);

  return {
    exchange,
    topSectors,
    symbolsWithSector,
    totalSymbols: symbolsWithSector.length,
  };
}

export default { buildSectorUniverse, CRYPTO_SECTORS, OVERSEAS_SECTORS, DOMESTIC_SECTORS };
