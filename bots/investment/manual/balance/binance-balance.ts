// @ts-nocheck
/**
 * manual/balance/binance-balance.js — 바이낸스 전체 잔고 조회
 *
 * 사용: node manual/balance/binance-balance.js
 * 출력: JSON { ok, balances: [{coin, free, total, usdt_value}], total_usdt }
 */

import ccxt from 'ccxt';
import { loadSecrets } from '../../shared/secrets.ts';
import { buildInvestmentCliInsight } from '../../shared/cli-insight.ts';

async function main() {
  try {
    const s = loadSecrets();
    if (!s.binance_api_key || !s.binance_api_secret) {
      const aiSummary = await buildInvestmentCliInsight({
        bot: 'binance-balance',
        requestType: 'balance',
        title: '바이낸스 잔고 조회 결과',
        data: {
          mode: 'missing_api_key',
        },
        fallback: '바이낸스 API 키가 없어 잔고 조회 전에 설정 점검이 먼저 필요합니다.',
      });
      output({ ok: false, error: '바이낸스 API 키 미설정 (config.yaml binance.api_key/api_secret)', aiSummary });
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

    const aiSummary = await buildInvestmentCliInsight({
      bot: 'binance-balance',
      requestType: 'balance',
      title: '바이낸스 잔고 조회 결과',
      data: {
        balanceCount: result.length,
        totalUsdt: Number(total_usdt.toFixed(2)),
        topCoins: result.slice(0, 5).map((item) => item.coin),
      },
      fallback: result.length > 0
        ? `바이낸스 잔고 ${result.length}종이 조회됐고 총 평가는 약 ${total_usdt.toFixed(2)} USDT입니다.`
        : '바이낸스 잔고가 비어 있어 선물/현물 계정 상태를 다시 확인하는 편이 좋습니다.',
    });
    output({ ok: true, balances: result, total_usdt, aiSummary });
  } catch (e) {
    const aiSummary = await buildInvestmentCliInsight({
      bot: 'binance-balance',
      requestType: 'balance',
      title: '바이낸스 잔고 조회 결과',
      data: {
        error: e.message,
      },
      fallback: '바이낸스 잔고 조회가 실패해 거래소 연결 상태를 다시 점검하는 편이 좋습니다.',
    });
    output({ ok: false, error: e.message, aiSummary });
  }
}

function output(r) { process.stdout.write(JSON.stringify(r) + '\n'); }

main();
