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
} from '../../shared/upbit-client.js';

async function main() {
  const steps = [];

  try {
    // 1. KRW 잔고 확인
    const krwBalance = await getUpbitKrwBalance();
    steps.push(`1. KRW 잔고: ${krwBalance.toLocaleString()}원`);

    if (krwBalance < 5000) {
      output({ ok: false, error: `KRW 잔고 부족: ${krwBalance.toLocaleString()}원`, steps });
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
      output({ ok: false, error: `USDT 매수 후 잔고 없음 (${usdtBalance})`, steps });
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
    });

  } catch (e) {
    output({ ok: false, error: e.message, steps });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function output(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

main();
