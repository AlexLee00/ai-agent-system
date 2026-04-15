// @ts-nocheck
/**
 * manual/price/crypto-price.js — 암호화폐 현재가 조회
 *
 * 사용: node manual/price/crypto-price.js [--symbol=BTC,ETH]
 * 기본: BTC, ETH, SOL, BNB
 * 출력: JSON { ok, symbols: [{symbol, price_usd, change_pct, high_24h, low_24h}] }
 */

import ccxt from 'ccxt';
import { loadSecrets } from '../../shared/secrets.ts';
import { buildInvestmentCliInsight } from '../../shared/cli-insight.ts';

const DEFAULT_SYMBOLS = ['BTC', 'ETH', 'SOL', 'BNB'];

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? '']; })
  );

  const symbolArg = args.symbol?.toUpperCase();
  const symbols   = symbolArg ? symbolArg.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_SYMBOLS;

  try {
    const s = loadSecrets();

    // 바이낸스로 USD 가격 조회 (API 키 없이도 공개 시세 가능)
    const binanceOpts = { enableRateLimit: true };
    if (s.binance_api_key) {
      binanceOpts.apiKey = s.binance_api_key;
      binanceOpts.secret = s.binance_api_secret;
    }
    const binance = new ccxt.binance(binanceOpts);

    const pairs  = symbols.map(s => `${s}/USDT`);
    const tickers = await binance.fetchTickers(pairs);

    const results = [];
    for (const sym of symbols) {
      const ticker = tickers[`${sym}/USDT`];
      if (ticker) {
        results.push({
          symbol:     sym,
          price_usd:  ticker.last,
          change_pct: ticker.percentage,
          high_24h:   ticker.high,
          low_24h:    ticker.low,
          volume_usdt: ticker.quoteVolume,
        });
      }
    }

    const aiSummary = await buildInvestmentCliInsight({
      bot: 'crypto-price',
      requestType: 'price',
      title: '암호화폐 현재가 조회 결과',
      data: {
        symbolCount: results.length,
        topSymbols: results.slice(0, 5).map((item) => item.symbol),
        positiveCount: results.filter((item) => Number(item.change_pct || 0) > 0).length,
        negativeCount: results.filter((item) => Number(item.change_pct || 0) < 0).length,
      },
      fallback: results.length > 0
        ? `주요 코인 ${results.length}종 시세가 조회돼 단기 방향성을 빠르게 확인할 수 있습니다.`
        : '조회된 코인 시세가 없어 심볼 또는 거래소 응답 상태를 다시 확인하는 편이 좋습니다.',
    });
    output({ ok: true, symbols: results, aiSummary });
  } catch (e) {
    const aiSummary = await buildInvestmentCliInsight({
      bot: 'crypto-price',
      requestType: 'price',
      title: '암호화폐 현재가 조회 결과',
      data: {
        error: e.message,
      },
      fallback: '암호화폐 현재가 조회가 실패해 거래소 시세 연결 상태를 다시 점검하는 편이 좋습니다.',
    });
    output({ ok: false, error: e.message, aiSummary });
  }
}

function output(r) { process.stdout.write(JSON.stringify(r) + '\n'); }

main();
