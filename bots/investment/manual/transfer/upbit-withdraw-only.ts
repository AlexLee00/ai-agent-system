// @ts-nocheck
/**
 * manual/transfer/upbit-withdraw-only.js — 업비트 USDT 잔고 전량 바이낸스 출금
 *
 * 사용: node manual/transfer/upbit-withdraw-only.js
 * 출력: JSON → stdout
 *   성공: { ok: true, message, usdtAmount, network, address, withdrawalId, status }
 *   지연: { ok: false, delay: true, unlockAt, unlockAtKst, remainHours, message }
 *   오류: { ok: false, error, steps }
 *
 * 주의: 실제 자금 이동 (약 1 USDT TRC20 수수료 차감)
 */

import {
  getUpbitUsdtBalance,
  getBinanceDepositAddress,
  withdrawUsdtToAddress,
  getRecentKrwDepositTime,
} from '../../shared/upbit-client.ts';
import { buildInvestmentCliInsight } from '../../shared/cli-insight.ts';

// 24시간 후 시각 계산 (KST 포맷)
function calcUnlock(depositTime) {
  const unlockAt = new Date(depositTime.getTime() + 24 * 60 * 60 * 1000);
  const remainMs = unlockAt - Date.now();
  const remainH  = Math.max(0, remainMs / (1000 * 60 * 60));
  const remainHr = Math.floor(remainH);
  const remainMn = Math.floor((remainH - remainHr) * 60);

  const kst = new Date(unlockAt.getTime() + 9 * 60 * 60 * 1000);
  const pad  = n => String(n).padStart(2, '0');
  const kstStr = `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())} KST`;

  return { unlockAt: unlockAt.toISOString(), unlockAtKst: kstStr, remainHours: remainH, remainHr, remainMn };
}

async function main() {
  const steps = [];

  try {
    // 1. USDT 잔고 확인
    const usdtBalance = await getUpbitUsdtBalance();
    steps.push(`1. 업비트 USDT 잔고: ${usdtBalance.toFixed(4)} USDT`);

    if (usdtBalance < 1) {
      const aiSummary = await buildInvestmentCliInsight({
        bot: 'upbit-withdraw-only',
        requestType: 'transfer',
        title: '업비트 USDT 출금 결과',
        data: {
          mode: 'insufficient_usdt',
          usdtBalance,
        },
        fallback: 'USDT 잔고가 부족해 이번 출금은 보류하는 편이 맞습니다.',
      });
      output({ ok: false, error: `USDT 잔고 부족: ${usdtBalance} (최소 1 USDT)`, steps, aiSummary });
      return;
    }

    // 2. 바이낸스 입금 주소 조회
    const depositInfo = await getBinanceDepositAddress();
    steps.push(`2. 바이낸스 ${depositInfo.network} 주소: ${depositInfo.address.slice(0, 10)}... (출처: ${depositInfo.source})`);

    // 3. 출금 시도
    steps.push(`3. 출금 요청 중: ${usdtBalance.toFixed(4)} USDT → 바이낸스 (${depositInfo.network})`);
    try {
      const result = await withdrawUsdtToAddress(
        0, // 0 = 전량
        depositInfo.address,
        depositInfo.network,
        depositInfo.tag || ''
      );
      steps.push(`   출금 ID: ${result.withdrawalId}, 상태: ${result.status}`);

      const aiSummary = await buildInvestmentCliInsight({
        bot: 'upbit-withdraw-only',
        requestType: 'transfer',
        title: '업비트 USDT 출금 결과',
        data: {
          mode: 'success',
          usdtAmount: usdtBalance,
          network: depositInfo.network,
          status: result.status,
        },
        fallback: `업비트에서 ${usdtBalance.toFixed(4)} USDT 출금이 접수돼 전송 흐름은 정상입니다.`,
      });
      output({
        ok:           true,
        message: [
          `✅ 업비트 → 바이낸스 출금 완료`,
          `  출금 수량: ${usdtBalance.toFixed(4)} USDT`,
          `  네트워크: ${depositInfo.network}`,
          `  출금 상태: ${result.status}`,
          `  (도착: 약 5~30분, TRC20 수수료 ~1 USDT 차감)`,
        ].join('\n'),
        usdtAmount:   usdtBalance,
        network:      depositInfo.network,
        address:      depositInfo.address,
        withdrawalId: result.withdrawalId,
        status:       result.status,
        steps,
        aiSummary,
      });

    } catch (withdrawErr) {
      const msg = withdrawErr.message || '';

      // ── 출금지연제 감지 ───────────────────────────────────────────
      if (msg.includes('withdraw_delay_time_amount')) {
        steps.push('   ⚠️ 출금지연제 적용 중');

        // 입금 시각 조회 → 해제 예상 시각 계산
        let unlockInfo = null;
        try {
          const depositTime = await getRecentKrwDepositTime();
          if (depositTime) {
            unlockInfo = calcUnlock(depositTime);
            steps.push(`   KRW 입금 시각: ${depositTime.toISOString()}`);
            steps.push(`   예상 해제: ${unlockInfo.unlockAtKst} (약 ${unlockInfo.remainHr}시간 ${unlockInfo.remainMn}분 후)`);
          }
        } catch { /* 조회 실패 — unlockInfo null */ }

        const etaLine = unlockInfo
          ? `  ⏰ 예상 해제: ${unlockInfo.unlockAtKst} (약 ${unlockInfo.remainHr}시간 ${unlockInfo.remainMn}분 후)`
          : `  ⏰ 예상 해제: KRW 입금 후 24시간 (업비트 앱에서 확인)`;

        const aiSummary = await buildInvestmentCliInsight({
          bot: 'upbit-withdraw-only',
          requestType: 'transfer',
          title: '업비트 USDT 출금 결과',
          data: {
            mode: 'delay',
            usdtBalance,
            network: depositInfo.network,
            unlockAtKst: unlockInfo?.unlockAtKst || null,
          },
          fallback: '출금지연제로 묶여 있어 해제 시각까지 기다렸다가 다시 진행하는 편이 맞습니다.',
        });
        output({
          ok:         false,
          delay:      true,
          unlockAt:   unlockInfo?.unlockAt    || null,
          unlockAtKst: unlockInfo?.unlockAtKst || null,
          remainHours: unlockInfo?.remainHours || null,
          usdtBalance,
          network:    depositInfo.network,
          address:    depositInfo.address,
          message: [
            `⏳ 업비트 출금지연제 적용 중`,
            `  USDT 잔고: ${usdtBalance.toFixed(4)} USDT (출금 대기)`,
            etaLine,
            `  📌 해제 후 자동으로 출금을 진행합니다.`,
          ].join('\n'),
          steps,
          aiSummary,
        });
        return;
      }

      // 기타 오류
      throw withdrawErr;
    }

  } catch (e) {
    const aiSummary = await buildInvestmentCliInsight({
      bot: 'upbit-withdraw-only',
      requestType: 'transfer',
      title: '업비트 USDT 출금 결과',
      data: {
        mode: 'error',
        error: e.message,
      },
      fallback: '출금 중 오류가 발생해 거래소 연결과 출금 제한 상태를 수동으로 확인하는 편이 좋습니다.',
    });
    output({ ok: false, error: e.message, steps, aiSummary });
  }
}

function output(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

main();
