/**
 * manual/price/crypto-price.js — 암호화폐 현재가 조회
 *
 * 사용: node manual/price/crypto-price.js [--symbol=BTC,ETH]
 * 기본: BTC, ETH, SOL, BNB
 * 출력: JSON { ok, symbols: [{symbol, price_usd, change_pct, high_24h, low_24h}] }
 */

import ccxt from 'ccxt';
import { loadSecrets } from '../../shared/secrets.js';

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

    output({ ok: true, symbols: results });
  } catch (e) {
    output({ ok: false, error: e.message });
  }
}

function output(r) { process.stdout.write(JSON.stringify(r) + '\n'); }

main();
