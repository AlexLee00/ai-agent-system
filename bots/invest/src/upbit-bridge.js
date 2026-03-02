'use strict';

/**
 * src/upbit-bridge.js — 업비트 브릿지봇 (몰리, LU-038 v2)
 *
 * 역할:
 * 1. 업비트 KRW 잔고 모니터링
 * 2. 임계값 초과 시 USDT 매수 → 바이낸스 전송
 * 3. 수익 출금 시 바이낸스 → 업비트 → KRW 전환 (수동 트리거)
 * 4. [v2] 바이낸스 포지션 TP/SL 자동 청산 모니터
 *
 * 실행:
 *   node src/upbit-bridge.js [--dry-run] [--check] [--withdraw-profit]
 *   node src/upbit-bridge.js --monitor [--dry-run]   (TP/SL 체크)
 */

const { fetchBalance, buyUSDT, withdrawToBinance, sellUSDT } = require('../lib/upbit');
const { fetchBalance: binanceBalance, fetchTicker, marketSell } = require('../lib/binance');
const { isDryRun, loadSecrets } = require('../lib/secrets');
const { sendTelegram, notifyError } = require('../lib/telegram');
const db = require('../lib/db');

// ─── 설정 ───────────────────────────────────────────────────────────

const CONFIG = {
  // KRW 잔고가 이 금액 이상이면 USDT 전환 시도
  MIN_KRW_TO_CONVERT: 100000,     // 10만원
  // 전환 후 남길 KRW 여유금 (생활비)
  KRW_RESERVE: 50000,             // 5만원
  // 바이낸스 USDT 잔고가 이 금액 이상이면 이미 충분
  BINANCE_MIN_USDT: 200,          // $200
  // 출금 트리거: 바이낸스 USDT 잔고가 이 이상이면 출금 제안
  PROFIT_WITHDRAW_THRESHOLD: 1000, // $1000
  // TP/SL 기준 (v2)
  TP_PCT: 0.03,   // +3% 익절
  SL_PCT: 0.03,   // -3% 손절
};

// ─── 잔고 모니터링 ─────────────────────────────────────────────────

async function checkBalances() {
  const upbit = await fetchBalance();
  let binanceUSDT = 0;
  try {
    const bal   = await binanceBalance();
    binanceUSDT = bal?.USDT?.free ?? bal?.free?.USDT ?? bal?.total?.USDT ?? 0;
  } catch (e) {
    console.warn(`⚠️ 바이낸스 잔고 조회 실패: ${e.message}`);
  }

  return {
    upbitKRW:    upbit.KRW   || 0,
    upbitUSDT:   upbit.USDT  || 0,
    binanceUSDT,
  };
}

// ─── KRW → 바이낸스 USDT 전송 ──────────────────────────────────────

/**
 * 업비트 KRW 잔고가 임계값 초과 시 USDT 매수 후 바이낸스 전송
 */
async function bridgeKrwToBinance() {
  const dryRun = isDryRun();
  const balances = await checkBalances();

  console.log(`\n💱 [업비트 브릿지] 잔고 확인`);
  console.log(`  업비트 KRW:  ${balances.upbitKRW.toLocaleString()}원`);
  console.log(`  업비트 USDT: ${balances.upbitUSDT.toFixed(2)}`);
  console.log(`  바이낸스 USDT: $${balances.binanceUSDT.toFixed(2)}`);

  // 바이낸스에 이미 충분한 USDT 있으면 스킵
  if (balances.binanceUSDT >= CONFIG.BINANCE_MIN_USDT) {
    console.log(`  ✅ 바이낸스 잔고 충분 ($${balances.binanceUSDT.toFixed(2)}) — 전송 불필요`);
    return { action: 'skip', reason: '바이낸스 잔고 충분' };
  }

  // KRW 임계값 미달 시 스킵
  if (balances.upbitKRW < CONFIG.MIN_KRW_TO_CONVERT) {
    console.log(`  ℹ️ 업비트 KRW 부족 (${balances.upbitKRW.toLocaleString()}원 < ${CONFIG.MIN_KRW_TO_CONVERT.toLocaleString()}원) — 스킵`);
    return { action: 'skip', reason: 'KRW 부족' };
  }

  // 전환할 금액 계산
  const convertKRW = balances.upbitKRW - CONFIG.KRW_RESERVE;
  console.log(`  → ${convertKRW.toLocaleString()}원 USDT 전환 예정`);

  // 1. USDT 매수
  const buyResult = await buyUSDT(convertKRW, dryRun);
  console.log(`  ✅ USDT 매수: ${buyResult.usdtBought.toFixed(2)} USDT @ ${buyResult.price}원`);

  // 2. 바이낸스 전송 (주소는 secrets에서)
  const secrets = loadSecrets();
  const binanceAddr = secrets.binance_deposit_address_usdt || '';
  const memo        = secrets.binance_deposit_memo || '';

  if (!binanceAddr) {
    console.warn(`  ⚠️ 바이낸스 USDT 입금 주소 미설정 — 출금 스킵`);
    await sendTelegram(
      `⚠️ [업비트 브릿지] USDT 매수 완료 (${buyResult.usdtBought.toFixed(2)})\n` +
      `바이낸스 입금 주소 미설정 — 수동 전송 필요`
    );
    return { action: 'bought_no_withdraw', buyResult };
  }

  const wdResult = await withdrawToBinance(buyResult.usdtBought, binanceAddr, memo, dryRun);
  console.log(`  ✅ 바이낸스 전송: USDT ${wdResult.amount.toFixed(2)} (ID: ${wdResult.withdrawId})`);

  await sendTelegram(
    `💱 [업비트→바이낸스]${dryRun ? ' [드라이런]' : ''}\n` +
    `${convertKRW.toLocaleString()}원 → USDT ${buyResult.usdtBought.toFixed(2)}\n` +
    `출금 ID: ${wdResult.withdrawId}`
  );

  return { action: 'transferred', buyResult, withdrawResult: wdResult };
}

// ─── 수익 출금 (바이낸스 → 업비트 → KRW) ─────────────────────────

/**
 * 바이낸스 USDT 잔고가 임계값 초과 시 알림 (수동 승인 필요)
 */
async function checkProfitWithdraw() {
  const balances = await checkBalances();

  if (balances.binanceUSDT >= CONFIG.PROFIT_WITHDRAW_THRESHOLD) {
    const msg = [
      `💰 [수익 출금 제안]`,
      `바이낸스 USDT: $${balances.binanceUSDT.toFixed(2)}`,
      `임계값 $${CONFIG.PROFIT_WITHDRAW_THRESHOLD} 초과`,
      `업비트로 출금 후 KRW 전환 고려`,
      `수동 명령: node src/upbit-bridge.js --withdraw-profit`,
    ].join('\n');
    await sendTelegram(msg);
    return { needsWithdraw: true, amount: balances.binanceUSDT };
  }

  return { needsWithdraw: false };
}

/**
 * 수익 출금 실행 (바이낸스 → 업비트 → KRW)
 * 주의: 바이낸스 → 업비트 입금은 바이낸스에서 직접 출금해야 함
 * 이 함수는 업비트에 USDT가 도착했을 때 KRW 전환만 담당
 */
async function withdrawProfit(usdtAmount) {
  const dryRun = isDryRun();
  console.log(`\n💰 [수익 출금] USDT ${usdtAmount} → KRW 전환`);

  const result = await sellUSDT(usdtAmount, dryRun);
  console.log(`  ✅ KRW 수령: ${result.krwReceived.toLocaleString()}원`);

  await sendTelegram(
    `💰 [수익 출금]${dryRun ? ' [드라이런]' : ''}\n` +
    `USDT ${usdtAmount} → ${result.krwReceived.toLocaleString()}원\n` +
    `@ ${result.price}원/USDT`
  );

  return result;
}

// ─── TP/SL 모니터 (v2) ─────────────────────────────────────────────

/**
 * 바이낸스 포지션 TP/SL 내부 청산 실행
 */
async function _executeTpSlSell(symbol, position, currentPrice, reason, dryRun) {
  const { amount, avg_price: avgPrice } = position;
  const pnlPct  = (currentPrice - avgPrice) / avgPrice;
  const pnlUsdt = (currentPrice - avgPrice) * amount;
  const icon    = reason === 'TAKE_PROFIT' ? '🟢' : '🔴';
  const label   = reason === 'TAKE_PROFIT' ? '익절' : '손절';

  console.log(`  ${icon} [${label}] ${symbol}: ${(pnlPct * 100).toFixed(2)}% → 청산`);

  try {
    const order = await marketSell(symbol, amount, dryRun);

    await db.insertTrade({
      signalId:  null,
      symbol,
      side:      'sell',
      amount:    order.amount,
      price:     order.price,
      totalUsdt: order.totalUsdt,
      dryRun:    order.dryRun,
      exchange:  'binance',
    });
    await db.deletePosition(symbol);

    const msg = [
      `${icon} [TP/SL ${label}]${dryRun ? ' [드라이런]' : ''}`,
      `${symbol}: ${(pnlPct * 100).toFixed(2)}%`,
      `진입 $${avgPrice.toFixed(2)} → 청산 $${order.price.toFixed(2)}`,
      `P&L: ${pnlUsdt >= 0 ? '+' : ''}$${pnlUsdt.toFixed(2)}`,
    ].join('\n');
    await sendTelegram(msg);

    console.log(`  ✅ 청산 완료: P&L ${pnlUsdt >= 0 ? '+' : ''}$${pnlUsdt.toFixed(2)}`);
    return { symbol, reason, pnlPct, pnlUsdt, success: true };
  } catch (e) {
    console.error(`  ❌ ${symbol} 청산 실패: ${e.message}`);
    await notifyError(`TP/SL 청산 - ${symbol}`, e);
    return { symbol, reason, success: false, error: e.message };
  }
}

/**
 * 전체 바이낸스 포지션 TP/SL 체크
 * - 진입가 × (1 + TP_PCT) 이상 → 익절
 * - 진입가 × (1 - SL_PCT) 이하 → 손절
 * @returns {Array} 청산된 포지션 결과 목록
 */
async function checkTpSl() {
  const dryRun    = isDryRun();
  const positions = await db.getAllPositions();

  // binance 포지션만 필터 (exchange 컬럼 없으면 binance로 간주)
  const binancePositions = positions.filter(p =>
    !p.exchange || p.exchange === 'binance'
  );

  if (binancePositions.length === 0) {
    console.log('[TP/SL] 바이낸스 포지션 없음 — 스킵');
    return [];
  }

  console.log(`\n🎯 [TP/SL 모니터] ${binancePositions.length}개 포지션 체크 ${dryRun ? '[드라이런]' : ''}`);

  const results = [];

  for (const pos of binancePositions) {
    const { symbol, amount, avg_price: avgPrice } = pos;
    if (!amount || amount <= 0 || !avgPrice) continue;

    try {
      const currentPrice = await fetchTicker(symbol);
      const pnlPct = (currentPrice - avgPrice) / avgPrice;

      console.log(
        `  ${symbol}: 진입 $${avgPrice.toFixed(2)} → 현재 $${currentPrice.toFixed(2)}` +
        ` (${(pnlPct * 100).toFixed(2)}%)`
      );

      let reason = null;
      if (pnlPct >=  CONFIG.TP_PCT) reason = 'TAKE_PROFIT';
      if (pnlPct <= -CONFIG.SL_PCT) reason = 'STOP_LOSS';

      if (reason) {
        const result = await _executeTpSlSell(symbol, pos, currentPrice, reason, dryRun);
        results.push(result);
      }
    } catch (e) {
      console.warn(`  ⚠️ ${symbol} 가격 조회 실패: ${e.message}`);
    }

    // API rate limit 방어
    await new Promise(r => setTimeout(r, 200));
  }

  if (results.length === 0) {
    console.log('  ℹ️ TP/SL 조건 미달 — 청산 없음');
  }

  return results;
}

// CLI 실행
if (require.main === module) {
  const args = process.argv.slice(2);
  const forceDryRun = args.includes('--dry-run');
  if (forceDryRun) process.env.DRY_RUN = 'true';

  async function main() {
    if (args.includes('--monitor')) {
      // TP/SL 모니터
      await checkTpSl();
    } else if (args.includes('--check')) {
      const balances = await checkBalances();
      console.log('현재 잔고:');
      console.log(`  업비트 KRW:    ${balances.upbitKRW.toLocaleString()}원`);
      console.log(`  업비트 USDT:   ${balances.upbitUSDT.toFixed(2)}`);
      console.log(`  바이낸스 USDT: $${balances.binanceUSDT.toFixed(2)}`);
      await checkProfitWithdraw();
    } else if (args.includes('--withdraw-profit')) {
      const amountArg = args.find(a => a.startsWith('--amount='))?.split('=')[1];
      const amount = parseFloat(amountArg || '0');
      if (!amount) { console.error('--amount=<USDT금액> 필요'); process.exit(1); }
      await withdrawProfit(amount);
    } else {
      // 기본: KRW → 바이낸스 브릿지
      await bridgeKrwToBinance();
    }
  }

  main()
    .then(() => process.exit(0))
    .catch(async e => {
      await notifyError('업비트 브릿지', e);
      process.exit(1);
    });
}

module.exports = { bridgeKrwToBinance, checkProfitWithdraw, withdrawProfit, checkBalances, checkTpSl };
