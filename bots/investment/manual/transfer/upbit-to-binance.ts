// @ts-nocheck
/**
 * scripts/upbit-to-binance.js — 업비트 KRW→USDT 매수 후 바이낸스 전송
 *
 * 사용: node scripts/upbit-to-binance.js
 * 출력: JSON { ok, message, ... } → stdout
 *
 * 흐름:
 *   1. 업비트 KRW 잔고 확인
 *   2. KRW 전량으로 USDT 시장가 매수
 *   3. 바이낸스 입금 주소 조회 (config 또는 API)
 *   4. 업비트 USDT 전량 바이낸스로 출금
 */

import {
  getUpbitKrwBalance,
  buyUsdtWithKrw,
  getUpbitUsdtBalance,
  getBinanceDepositAddress,
  withdrawUsdtToAddress,
} from '../../shared/upbit-client.ts';
import { buildInvestmentCliInsight } from '../../shared/cli-insight.ts';

async function main() {
  const steps = [];

  try {
    // 1. KRW 잔고 확인
    const krwBalance = await getUpbitKrwBalance();
    steps.push(`1. KRW 잔고: ${krwBalance.toLocaleString()}원`);

    if (krwBalance < 5000) {
      const aiSummary = await buildInvestmentCliInsight({
        bot: 'upbit-to-binance',
        requestType: 'transfer',
        title: '업비트→바이낸스 전송 결과',
        data: {
          mode: 'insufficient_krw',
          krwBalance,
        },
        fallback: '원화 잔고가 부족해 이번 전송은 보류하는 편이 맞습니다.',
      });
      output({ ok: false, error: `KRW 잔고 부족: ${krwBalance.toLocaleString()}원`, steps, aiSummary });
      return;
    }

    // 2. USDT 매수
    steps.push(`2. USDT 시장가 매수 중...`);
    const buyResult = await buyUsdtWithKrw(0); // 0 = 전량
    steps.push(`   주문ID: ${buyResult.orderId}, 매수금액: ${buyResult.krwSpent.toLocaleString()}원`);

    // 주문 체결 대기 (업비트 시장가는 즉시 체결되나 잠깐 대기)
    await sleep(3000);

    // 3. USDT 잔고 확인
    const usdtBalance = await getUpbitUsdtBalance();
    steps.push(`3. USDT 잔고: ${usdtBalance.toFixed(2)} USDT`);

    if (usdtBalance < 1) {
      const aiSummary = await buildInvestmentCliInsight({
        bot: 'upbit-to-binance',
        requestType: 'transfer',
        title: '업비트→바이낸스 전송 결과',
        data: {
          mode: 'missing_usdt_after_buy',
          usdtBalance,
        },
        fallback: 'USDT 매수 뒤 잔고가 없어 체결 또는 반영 상태를 먼저 확인하는 편이 좋습니다.',
      });
      output({ ok: false, error: `USDT 매수 후 잔고 없음 (${usdtBalance})`, steps, aiSummary });
      return;
    }

    // 4. 바이낸스 입금 주소 조회
    const depositInfo = await getBinanceDepositAddress();
    steps.push(`4. 바이낸스 ${depositInfo.network} 주소: ${depositInfo.address.slice(0, 10)}...`);

    // 5. 출금
    steps.push(`5. 출금 요청 중: ${usdtBalance.toFixed(2)} USDT → 바이낸스 (${depositInfo.network})`);
    const withdrawResult = await withdrawUsdtToAddress(
      0, // 0 = 전량
      depositInfo.address,
      depositInfo.network,
      depositInfo.tag || ''
    );
    steps.push(`   출금 ID: ${withdrawResult.withdrawalId}, 상태: ${withdrawResult.status}`);

    const aiSummary = await buildInvestmentCliInsight({
      bot: 'upbit-to-binance',
      requestType: 'transfer',
      title: '업비트→바이낸스 전송 결과',
      data: {
        mode: 'success',
        krwSpent: buyResult.krwSpent,
        usdtAmount: usdtBalance,
        network: depositInfo.network,
        status: withdrawResult.status,
      },
      fallback: `업비트에서 바이낸스로 ${usdtBalance.toFixed(2)} USDT 전송이 시작돼 자금 이동 흐름은 정상입니다.`,
    });
    output({
      ok: true,
      message: [
        `업비트 → 바이낸스 전송 완료`,
        `  KRW 매수: ${buyResult.krwSpent.toLocaleString()}원`,
        `  USDT 출금: ${usdtBalance.toFixed(2)} USDT`,
        `  네트워크: ${depositInfo.network}`,
        `  출금 상태: ${withdrawResult.status}`,
        `  (도착: 네트워크 확인 완료 후 — 약 5~30분)`,
      ].join('\n'),
      krwSpent:     buyResult.krwSpent,
      usdtAmount:   usdtBalance,
      network:      depositInfo.network,
      withdrawalId: withdrawResult.withdrawalId,
      steps,
      aiSummary,
    });

  } catch (e) {
    const aiSummary = await buildInvestmentCliInsight({
      bot: 'upbit-to-binance',
      requestType: 'transfer',
      title: '업비트→바이낸스 전송 결과',
      data: {
        mode: 'error',
        error: e.message,
      },
      fallback: '전송 과정에서 오류가 발생해 거래소 연결과 출금 상태를 수동으로 확인하는 편이 좋습니다.',
    });
    output({ ok: false, error: e.message, steps, aiSummary });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function output(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

main();
