// @ts-nocheck
/**
 * scripts/hybrid-scorer.ts — 하이브리드 스코어러 (I-3)
 *
 * 4개 에이전트 신호를 합산해 심볼 우선순위 결정:
 *   아르고스(volume 25%) + 아리아(momentum 25%)
 *   + 오라클(onchain 25%) + 헤르메스(news 25%)
 *
 * 용도: 전체 루나 분석 전 후보 심볼 사전 순위 결정
 *
 * 실행: node scripts/hybrid-scorer.ts --symbols=BTC/USDT,ETH/USDT --exchange=binance
 *       node scripts/hybrid-scorer.ts --symbols=BTC/USDT,ETH/USDT --exchange=binance --news
 */

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { quickMomentumScan } from '../team/aria.ts';
import { fetchFearGreed, fetchFundingRate } from '../team/oracle.ts';
import { analyzeNews } from '../team/hermes.ts';
import { getLongShortRatio } from '../shared/onchain-data.ts';

// ─── 아르고스 점수 조회 ───────────────────────────────────────────────

/**
 * 최신 screening_history에서 심볼별 finalScore 반환 (정규화 전)
 * @param {string} market  'crypto' | 'domestic' | 'overseas'
 * @returns {Map<string, number>}  symbol → finalScore
 */
async function fetchArgosScores(market) {
  try {
    const rows = await db.query(
      `SELECT screening_data FROM investment.screening_history
       WHERE market = $1
       ORDER BY id DESC LIMIT 1`,
      [market],
    );
    if (!rows?.length || !rows[0]?.screening_data?.screening) return new Map();

    const scores = new Map();
    for (const item of rows[0].screening_data.screening) {
      if (item.symbol && typeof item.finalScore === 'number') {
        scores.set(item.symbol, item.finalScore);
      }
    }
    return scores;
  } catch (e) {
    console.warn(`  ⚠️ [하이브리드] 아르고스 점수 조회 실패: ${e.message}`);
    return new Map();
  }
}

// ─── 오라클 온체인 점수 (규칙 기반, LLM 없음) ────────────────────────

/**
 * fear & greed + 펀딩비 → 0~1 점수 (공유 가능한 컨텍스트)
 * @param {number|null} fngValue  공포탐욕지수
 * @param {{ fundingRate: number }|null} funding
 * @param {{ longShortRatio: number }|null} lsRatio
 * @returns {number}  0~1 (0.5 = 중립)
 */
function calcOnchainScore(fngValue, funding, lsRatio) {
  let score = 0; // range: -3 ~ +3

  if (fngValue != null) {
    if (fngValue <= 20)      score += 1.5;
    else if (fngValue >= 80) score -= 1.5;
    else if (fngValue <= 40) score += 0.5;
    else if (fngValue >= 60) score -= 0.5;
  }

  if (funding?.fundingRate != null) {
    const fPct = funding.fundingRate * 100;
    if (fPct > 0.05)        score -= 1.0;
    else if (fPct < -0.01)  score += 1.0;
  }

  if (lsRatio?.longShortRatio != null) {
    if (lsRatio.longShortRatio > 1.8)      score -= 0.5;
    else if (lsRatio.longShortRatio < 0.8) score += 0.5;
  }

  return Math.max(0, Math.min(1, (score + 3) / 6));
}

// ─── 헤르메스 뉴스 점수 (선택적, LLM 포함) ──────────────────────────

/**
 * analyzeNews 결과 → 0~1 점수
 * BUY: 0.5 + confidence/2  /  SELL: 0.5 - confidence/2  /  HOLD: 0.5
 */
function newsResultToScore(result) {
  if (!result) return 0.5;
  const conf = result.confidence ?? 0.3;
  if (result.signal === 'BUY')  return Math.min(1, 0.5 + conf / 2);
  if (result.signal === 'SELL') return Math.max(0, 0.5 - conf / 2);
  return 0.5;
}

// ─── 메인 스코어링 ────────────────────────────────────────────────────

/**
 * 하이브리드 스코어링 실행
 *
 * @param {string[]} symbols
 * @param {'binance'|'kis'|'kis_overseas'} exchange
 * @param {{ includeNews?: boolean }} options
 * @returns {Promise<Array<{
 *   symbol, hybridScore,
 *   argosScore, ariaScore, onchainScore, newsScore,
 *   detail: { argosRaw, momentumScore, rsi, macdHist, bbPosition, currentPrice }
 * }>>}
 */
export async function scoreSymbols(symbols, exchange = 'binance', options = {}) {
  const { includeNews = false } = options;
  const market = exchange === 'binance' ? 'crypto'
    : exchange === 'kis' ? 'domestic' : 'overseas';

  console.log(`\n🔀 [하이브리드] ${symbols.length}개 심볼 스코어링 (${exchange}) includeNews=${includeNews}`);

  // ① 아르고스 점수 (DB 조회)
  const argosMap = await fetchArgosScores(market);
  const argosValues = [...argosMap.values()];
  const maxArgos = argosValues.length ? Math.max(...argosValues) : 1;
  const minArgos = argosValues.length ? Math.min(...argosValues) : 0;
  const argosRange = maxArgos - minArgos || 1;

  // ② 아리아 모멘텀
  const momentumResults = await quickMomentumScan(symbols, exchange);
  const momentumMap = new Map(momentumResults.map(r => [r.symbol, r]));

  // ③ 오라클 온체인 (crypto만 — 한 번만 조회, 전 심볼 공유)
  let onchainBaseScore = 0.5;
  const onchainPerSymbol = new Map();

  if (exchange === 'binance') {
    const [fng, ...fundingArr] = await Promise.allSettled([
      fetchFearGreed(),
      ...symbols.map(s => fetchFundingRate(s.replace('/', ''))),
    ]);
    const fngValue = fng.status === 'fulfilled' ? fng.value?.value : null;
    symbols.forEach((sym, i) => {
      const funding = fundingArr[i]?.status === 'fulfilled' ? fundingArr[i].value : null;
      onchainPerSymbol.set(sym, calcOnchainScore(fngValue, funding, null));
    });
    onchainBaseScore = calcOnchainScore(fngValue, null, null);
  }

  // ④ 헤르메스 뉴스 (선택적)
  const newsMap = new Map();
  if (includeNews) {
    console.log(`  📰 헤르메스 뉴스 분석 중 (${symbols.length}개)...`);
    const newsResults = await Promise.allSettled(
      symbols.map(s => analyzeNews(s, exchange)),
    );
    symbols.forEach((sym, i) => {
      const result = newsResults[i]?.status === 'fulfilled' ? newsResults[i].value : null;
      newsMap.set(sym, newsResultToScore(result));
    });
  }

  // ⑤ 합산
  const scored = symbols.map(symbol => {
    const argosRaw = argosMap.get(symbol) ?? null;
    const argosScore = argosRaw != null
      ? (argosRaw - minArgos) / argosRange
      : 0.4; // 아르고스 데이터 없는 경우 보수적 기본값

    const momentumData = momentumMap.get(symbol);
    const ariaScore = momentumData?.momentumScore ?? 0.5;

    const onchainScore = onchainPerSymbol.get(symbol) ?? onchainBaseScore;
    const newsScore = newsMap.get(symbol) ?? 0.5;

    const hybridScore = argosScore * 0.25
      + ariaScore     * 0.25
      + onchainScore  * 0.25
      + newsScore     * 0.25;

    return {
      symbol,
      hybridScore:   Math.round(hybridScore * 1000) / 1000,
      argosScore:    Math.round(argosScore * 1000) / 1000,
      ariaScore:     Math.round(ariaScore * 1000) / 1000,
      onchainScore:  Math.round(onchainScore * 1000) / 1000,
      newsScore:     Math.round(newsScore * 1000) / 1000,
      detail: {
        argosRaw:     argosRaw != null ? Math.round(argosRaw * 100) / 100 : null,
        momentumScore: momentumData?.momentumScore ?? null,
        rsi:           momentumData?.rsi ?? null,
        macdHist:      momentumData?.macdHist ?? null,
        bbPosition:    momentumData?.bbPosition ?? null,
        currentPrice:  momentumData?.currentPrice ?? null,
      },
    };
  });

  return scored.sort((a, b) => b.hybridScore - a.hybridScore);
}

// ─── CLI 실행 ──────────────────────────────────────────────────────────

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: async () => {
      const args     = process.argv.slice(2);
      const symbolArg = args.find(a => a.startsWith('--symbols='))?.split('=')[1];
      const exchange  = args.find(a => a.startsWith('--exchange='))?.split('=')[1] || 'binance';
      const includeNews = args.includes('--news');
      const jsonMode  = args.includes('--json');

      const symbols = symbolArg
        ? symbolArg.split(',').map(s => s.trim()).filter(Boolean)
        : ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'];

      const results = await scoreSymbols(symbols, exchange, { includeNews });

      if (jsonMode) {
        console.log(JSON.stringify(results, null, 2));
        return results;
      }

      console.log('\n🏆 하이브리드 스코어 순위:');
      results.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.symbol.padEnd(16)} hybrid=${r.hybridScore.toFixed(3)} | argos=${r.argosScore.toFixed(3)} aria=${r.ariaScore.toFixed(3)} onchain=${r.onchainScore.toFixed(3)} news=${r.newsScore.toFixed(3)}`);
        if (r.detail.rsi != null) {
          console.log(`     rsi=${r.detail.rsi} macdHist=${r.detail.macdHist} bb=${r.detail.bbPosition} price=${r.detail.currentPrice}`);
        }
      });
      return results;
    },
    onSuccess: () => {},
    errorPrefix: '❌ 하이브리드 스코어러 오류:',
  });
}
