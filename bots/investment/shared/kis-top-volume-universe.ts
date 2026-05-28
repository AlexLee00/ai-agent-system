// @ts-nocheck
// kis-top-volume-universe.ts — KIS 국내/해외 거래량 Top 50 유니버스
// 국내(KOSPI/KOSDAQ): KRX 거래량 순위 API (Data.go.kr)
// 해외(US NYSE/NASDAQ): 큐레이션 목록 (고거래량 US 주식 Top 50)
// 매일 08:30 갱신 (ai.luna.universe-refresh-daily-0830.plist)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const CACHE_DIR = resolve(INVESTMENT_ROOT, 'output');

export const KIS_DOMESTIC_UNIVERSE_SOURCE = 'krx_volume_top50_domestic';
export const KIS_OVERSEAS_UNIVERSE_SOURCE = 'curated_volume_top50_overseas';
export const DEFAULT_KIS_UNIVERSE_LIMIT = 50;

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60_000; // 24h
const DEFAULT_TIMEOUT_MS = 10_000;

const CACHE_FILE_DOMESTIC = resolve(CACHE_DIR, 'luna-kis-domestic-universe-cache.json');
const CACHE_FILE_OVERSEAS = resolve(CACHE_DIR, 'luna-kis-overseas-universe-cache.json');

// ─── 거래량 상위 해외 주식 (큐레이션, 반기 업데이트) ────────────────────────
// NYSE + NASDAQ 기준 일평균 거래량 Top 50 (2026-05 기준)
const OVERSEAS_TOP50_FIXTURE = [
  // Mega-cap / highest volume
  'NVDA', 'TSLA', 'AAPL', 'AMZN', 'META', 'MSFT', 'GOOGL', 'AMD', 'PLTR', 'INTC',
  // High-volume tech
  'COIN', 'MSTR', 'SOFI', 'MARA', 'RIVN', 'CLSK', 'IREN', 'CIFR', 'CLSK', 'RIOT',
  // ETF (고거래량)
  'SPY', 'QQQ',
  // Fintech / consumer
  'PYPL', 'UBER', 'LYFT', 'SHOP', 'NET', 'CRWD', 'SNOW', 'RBLX',
  // Biotech / healthcare
  'MRNA', 'SNGX', 'RGTI', 'ACHR',
  // Semi / hardware
  'MU', 'AVGO', 'QCOM', 'QBTS',
  // EV / energy
  'NIO', 'XPEV', 'LI', 'LCID', 'PLUG', 'EOSE',
  // Financial
  'BAC', 'JPM', 'BABA', 'PDD',
  // Other
  'F', 'BB', 'NOK', 'ONDS', 'RDDT',
].filter((v, i, arr) => arr.indexOf(v) === i).slice(0, DEFAULT_KIS_UNIVERSE_LIMIT);

// ─── 한국 Data.go.kr 거래량 순위 조회 ────────────────────────────────────────
// API: 주식시세 (거래량 정렬)
const DATA_GO_STOCK_PRICE_URL = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function readCacheFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCacheFile(filePath, data) {
  try {
    ensureCacheDir();
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

function isCacheValid(cache, ttlMs = DEFAULT_CACHE_TTL_MS) {
  if (!cache?.cachedAtMs) return false;
  return Date.now() - cache.cachedAtMs < ttlMs;
}

async function fetchJson(url, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const qs = new URLSearchParams({ ...params, numOfRows: '1000', pageNo: '1', resultType: 'json' });
    const res = await fetch(`${url}?${qs}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LunaKisUniverse/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── 국내 Top 50 조회 (KRX/Data.go.kr) ──────────────────────────────────────

export async function fetchKisDomesticTopVolumeUniverse(options = {}) {
  const serviceKey = String(options.serviceKey || process.env.DATA_GO_SERVICE_KEY || '');
  const fetchedAt = new Date().toISOString();

  if (!serviceKey || options.fixture) {
    return buildKisDomesticFixture(fetchedAt);
  }

  try {
    const data = await fetchJson(DATA_GO_STOCK_PRICE_URL, {
      serviceKey,
      mrktCls: 'ALL',  // KOSPI + KOSDAQ
    }, options.timeoutMs);

    const items = data?.response?.body?.items?.item;
    if (!Array.isArray(items) || items.length === 0) {
      console.warn('[KisUniverse] 국내 API 응답 없음 — fixture 사용');
      return buildKisDomesticFixture(fetchedAt);
    }

    const ranked = items
      .map((item) => ({
        symbol: String(item.srtnCd || item.isinCd || '').trim(),
        name: String(item.itmsNm || '').trim(),
        volume: Number(item.trqu || 0),
        price: Number(item.clpr || 0),
        market: String(item.mrktCtg || '').trim(), // KOSPI / KOSDAQ
        change: Number(item.vs || 0),
        changePct: Number(item.fltRt || 0),
      }))
      .filter((r) => r.symbol && r.volume > 0)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, DEFAULT_KIS_UNIVERSE_LIMIT);

    const ranks = {};
    ranked.forEach((row, idx) => { ranks[row.symbol] = idx + 1; });

    return {
      source: KIS_DOMESTIC_UNIVERSE_SOURCE,
      fetchedAt,
      market: 'domestic',
      limit: DEFAULT_KIS_UNIVERSE_LIMIT,
      symbols: ranked.map((r) => r.symbol),
      ranks,
      rows: ranked,
    };
  } catch (err) {
    console.warn(`[KisUniverse] 국내 API 오류: ${err?.message} — fixture 사용`);
    return buildKisDomesticFixture(fetchedAt);
  }
}

function buildKisDomesticFixture(fetchedAt = new Date().toISOString()) {
  // KOSPI/KOSDAQ 거래량 상위 50 (2026-05 기준 큐레이션)
  const fixture = [
    // KOSPI 대형주 (고거래량)
    '005930', // 삼성전자
    '000660', // SK하이닉스
    '373220', // LG에너지솔루션
    '207940', // 삼성바이오로직스
    '005380', // 현대차
    '068270', // 셀트리온
    '051910', // LG화학
    '035420', // NAVER
    '005490', // POSCO홀딩스
    '000270', // 기아
    // 테마/고거래량 KOSPI
    '003670', // 포스코퓨처엠
    '028260', // 삼성물산
    '066570', // LG전자
    '012330', // 현대모비스
    '055550', // 신한지주
    '105560', // KB금융
    '086790', // 하나금융지주
    '032830', // 삼성생명
    '018260', // 삼성에스디에스
    '096770', // SK이노베이션
    // KOSDAQ 고거래량
    '263750', // 펄어비스
    '293490', // 카카오게임즈
    '096530', // 씨젠
    '247540', // 에코프로비엠
    '086900', // 메디톡스
    '196170', // 알테오젠
    '145020', // 휴젤
    '000100', // 유한양행
    '214150', // 클래시스
    '041510', // 에스엠
    // 2차전지/반도체 테마
    '006400', // 삼성SDI
    '373220', // LG에너지솔루션 (중복 제거됨)
    '047810', // 한국항공우주
    '034020', // 두산에너빌리티
    '009150', // 삼성전기
    '011070', // LG이노텍
    '042660', // 한화오션
    '329180', // 현대중공업
    '010140', // 삼성중공업
    '000720', // 현대건설
    '139480', // 이마트
    '271560', // 오리온
    '282330', // BGF리테일
    '302440', // SK바이오사이언스
    '091990', // 셀트리온헬스케어
    '008770', // 호텔신라
    '120110', // 코스맥스
    '161390', // 한국타이어앤테크놀로지
    '030200', // KT
    '017670', // SK텔레콤
  ].filter((v, i, arr) => arr.indexOf(v) === i).slice(0, DEFAULT_KIS_UNIVERSE_LIMIT);

  const ranks = {};
  fixture.forEach((sym, idx) => { ranks[sym] = idx + 1; });

  return {
    source: KIS_DOMESTIC_UNIVERSE_SOURCE,
    fetchedAt,
    market: 'domestic',
    limit: DEFAULT_KIS_UNIVERSE_LIMIT,
    symbols: fixture,
    ranks,
    rows: fixture.map((sym, idx) => ({ symbol: sym, rank: idx + 1, volume: 0, price: 0, market: 'KOSPI/KOSDAQ' })),
    fixture: true,
  };
}

// ─── 해외 Top 50 (큐레이션 + 갱신) ──────────────────────────────────────────

export async function fetchKisOverseasTopVolumeUniverse(options = {}) {
  const fetchedAt = new Date().toISOString();
  const symbols = [...OVERSEAS_TOP50_FIXTURE];
  const ranks = {};
  symbols.forEach((sym, idx) => { ranks[sym] = idx + 1; });

  return {
    source: KIS_OVERSEAS_UNIVERSE_SOURCE,
    fetchedAt,
    market: 'overseas',
    limit: DEFAULT_KIS_UNIVERSE_LIMIT,
    symbols,
    ranks,
    rows: symbols.map((sym, idx) => ({ symbol: sym, rank: idx + 1 })),
  };
}

// ─── 캐시 포함 조회 ──────────────────────────────────────────────────────────

export async function getCachedKisDomesticUniverse(options = {}) {
  const cache = readCacheFile(CACHE_FILE_DOMESTIC);
  if (!options.refresh && isCacheValid(cache, options.ttlMs)) {
    return cache.value;
  }
  const value = await fetchKisDomesticTopVolumeUniverse(options);
  writeCacheFile(CACHE_FILE_DOMESTIC, { cachedAtMs: Date.now(), value });
  return value;
}

export async function getCachedKisOverseasUniverse(options = {}) {
  const cache = readCacheFile(CACHE_FILE_OVERSEAS);
  if (!options.refresh && isCacheValid(cache, options.ttlMs)) {
    return cache.value;
  }
  const value = await fetchKisOverseasTopVolumeUniverse(options);
  writeCacheFile(CACHE_FILE_OVERSEAS, { cachedAtMs: Date.now(), value });
  return value;
}

// ─── 종목 게이트 평가 ────────────────────────────────────────────────────────

export function evaluateKisTopVolumeUniverseGate(symbol, universe = null) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym || !universe) {
    return { ok: false, blocked: true, reason: 'no_universe_loaded', symbol: sym, rank: null };
  }
  const rank = universe.ranks?.[sym] || universe.ranks?.[String(symbol || '').trim()] || null;
  const limit = universe.limit || DEFAULT_KIS_UNIVERSE_LIMIT;
  const ok = Number(rank || 0) >= 1 && Number(rank || 0) <= limit;
  return {
    ok,
    blocked: !ok,
    reason: ok ? `in_kis_top${limit}_volume_universe` : `outside_kis_top${limit}_volume_universe`,
    symbol: sym,
    rank,
    limit,
    market: universe.market,
    source: universe.source,
    fetchedAt: universe.fetchedAt,
  };
}

// ─── 유니버스 갱신 (두 시장 동시) ───────────────────────────────────────────

export async function refreshKisTopVolumeUniverses(options = {}) {
  const [domestic, overseas] = await Promise.allSettled([
    getCachedKisDomesticUniverse({ ...options, refresh: true }),
    getCachedKisOverseasUniverse({ ...options, refresh: true }),
  ]);

  const result = {
    domestic: domestic.status === 'fulfilled' ? domestic.value : null,
    overseas: overseas.status === 'fulfilled' ? overseas.value : null,
    domesticError: domestic.status === 'rejected' ? String(domestic.reason) : null,
    overseasError: overseas.status === 'rejected' ? String(overseas.reason) : null,
    refreshedAt: new Date().toISOString(),
  };

  console.log(`[KisUniverse] 국내: ${result.domestic?.symbols?.length ?? 0}종목 | 해외: ${result.overseas?.symbols?.length ?? 0}종목`);
  return result;
}

export default {
  fetchKisDomesticTopVolumeUniverse,
  fetchKisOverseasTopVolumeUniverse,
  getCachedKisDomesticUniverse,
  getCachedKisOverseasUniverse,
  evaluateKisTopVolumeUniverseGate,
  refreshKisTopVolumeUniverses,
  DEFAULT_KIS_UNIVERSE_LIMIT,
  KIS_DOMESTIC_UNIVERSE_SOURCE,
  KIS_OVERSEAS_UNIVERSE_SOURCE,
};
