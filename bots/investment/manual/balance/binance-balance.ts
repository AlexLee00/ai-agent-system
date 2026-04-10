// @ts-nocheck
/**
 * manual/balance/binance-balance.js — 바이낸스 전체 잔고 조회
 *
 * 사용: node manual/balance/binance-balance.js
 * 출력: JSON { ok, balances: [{coin, free, total, usdt_value}], total_usdt }
 */

import ccxt from 'ccxt';
import { loadSecrets } from '../../shared/secrets.ts';

async function main() {
  try {
    const s = loadSecrets();
    if (!s.binance_api_key || !s.binance_api_secret) {
      output({ ok: false, error: '바이낸스 API 키 미설정 (config.yaml binance.api_key/api_secret)' });
      return;
    }

    const binance = new ccxt.binance({
      apiKey: s.binance_api_key,
      secret: s.binance_api_secret,
      enableRateLimit: true,
    });

    const balances = await binance.fetchBalance();

    // 잔고 0.000001 초과 항목만 추출
    const nonZero = Object.entries(balances)
      .filter(([coin, bal]) => (bal?.total ?? 0) > 0.000001 && !['info', 'free', 'used', 'total', 'debt'].includes(coin))
      .map(([coin, bal]) => ({ coin, free: bal.free ?? 0, used: bal.used ?? 0, total: bal.total ?? 0 }));

    const result = [];
    let total_usdt = 0;

    for (const item of nonZero) {
      if (item.coin === 'USDT') {
        result.push({ ...item, usdt_value: item.total });
        total_usdt += item.total;
      } else {
        try {
          const ticker = await binance.fetchTicker(`${item.coin}/USDT`);
          const price_usdt = ticker.last || 0;
          const usdt_value = item.total * price_usdt;
          result.push({ ...item, price_usdt, usdt_value });
          total_usdt += usdt_value;
        } catch {
          result.push({ ...item, price_usdt: 0, usdt_value: 0 });
        }
      }
    }

    output({ ok: true, balances: result, total_usdt });
  } catch (e) {
    output({ ok: false, error: e.message });
  }
}

function output(r) { process.stdout.write(JSON.stringify(r) + '\n'); }

main();
