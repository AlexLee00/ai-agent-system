// @ts-nocheck
/**
 * manual/balance/upbit-balance.js — 업비트 전체 잔고 조회
 *
 * 사용: node manual/balance/upbit-balance.js
 * 출력: JSON { ok, balances: [{coin, free, total, krw_value}], total_krw }
 */

import ccxt from 'ccxt';
import { loadSecrets } from '../../shared/secrets.ts';
import { buildInvestmentCliInsight } from '../../shared/cli-insight.ts';

async function main() {
  try {
    const s = loadSecrets();
    if (!s.upbit_access_key || !s.upbit_secret_key) {
      const aiSummary = await buildInvestmentCliInsight({
        bot: 'upbit-balance',
        requestType: 'balance',
        title: '업비트 잔고 조회 결과',
        data: {
          mode: 'missing_api_key',
        },
        fallback: '업비트 API 키가 없어 잔고 조회 전에 설정 점검이 먼저 필요합니다.',
      });
      output({ ok: false, error: '업비트 API 키 미설정 (config.yaml upbit.access_key/secret_key)', aiSummary });
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

    const aiSummary = await buildInvestmentCliInsight({
      bot: 'upbit-balance',
      requestType: 'balance',
      title: '업비트 잔고 조회 결과',
      data: {
        balanceCount: result.length,
        totalKrw: Number(total_krw.toFixed(0)),
        topCoins: result.slice(0, 5).map((item) => item.coin),
      },
      fallback: result.length > 0
        ? `업비트 잔고 ${result.length}종이 조회됐고 총 평가금액은 약 ${Math.round(total_krw).toLocaleString('ko-KR')}원입니다.`
        : '업비트 잔고가 비어 있어 원화나 코인 보유 상태를 다시 확인하는 편이 좋습니다.',
    });
    output({ ok: true, balances: result, total_krw, aiSummary });
  } catch (e) {
    const aiSummary = await buildInvestmentCliInsight({
      bot: 'upbit-balance',
      requestType: 'balance',
      title: '업비트 잔고 조회 결과',
      data: {
        error: e.message,
      },
      fallback: '업비트 잔고 조회가 실패해 거래소 연결 상태를 다시 점검하는 편이 좋습니다.',
    });
    output({ ok: false, error: e.message, aiSummary });
  }
}

function output(r) { process.stdout.write(JSON.stringify(r) + '\n'); }

main();
