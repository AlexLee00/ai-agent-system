// @ts-nocheck
/**
 * manual/balance/upbit-balance.js — 업비트 전체 잔고 조회
 *
 * 사용: node manual/balance/upbit-balance.js
 * 출력: JSON { ok, balances: [{coin, free, total, krw_value}], total_krw }
 */

import ccxt from 'ccxt';
import { loadSecrets } from '../../shared/secrets.ts';

async function main() {
  try {
    const s = loadSecrets();
    if (!s.upbit_access_key || !s.upbit_secret_key) {
      output({ ok: false, error: '업비트 API 키 미설정 (config.yaml upbit.access_key/secret_key)' });
      return;
    }

    const upbit = new ccxt.upbit({
      apiKey: s.upbit_access_key,
      secret: s.upbit_secret_key,
      enableRateLimit: true,
    });

    const balances = await upbit.fetchBalance();

    // 잔고 0 초과 항목만 추출
    const nonZero = Object.entries(balances)
      .filter(([coin, bal]) => bal?.total > 0 && !['info', 'free', 'used', 'total', 'debt'].includes(coin))
      .map(([coin, bal]) => ({ coin, free: bal.free ?? 0, used: bal.used ?? 0, total: bal.total ?? 0 }));

    const result = [];
    let total_krw = 0;

    for (const item of nonZero) {
      if (item.coin === 'KRW') {
        result.push({ ...item, krw_value: item.total });
        total_krw += item.total;
      } else {
        try {
          const ticker = await upbit.fetchTicker(`${item.coin}/KRW`);
          const price_krw = ticker.last || 0;
          const krw_value = item.total * price_krw;
          result.push({ ...item, price_krw, krw_value });
          total_krw += krw_value;
        } catch {
          result.push({ ...item, price_krw: 0, krw_value: 0 });
        }
      }
    }

    output({ ok: true, balances: result, total_krw });
  } catch (e) {
    output({ ok: false, error: e.message });
  }
}

function output(r) { process.stdout.write(JSON.stringify(r) + '\n'); }

main();
