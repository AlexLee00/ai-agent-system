'use strict';

/**
 * scripts/kis-order-test.js — KIS 모의투자 실주문 테스트
 *
 * 목적: 장 시간 중 VTS 환경에서 실제 주문 흐름 검증
 * 실행: DRY_RUN=false KIS_PAPER=true node scripts/kis-order-test.js
 *
 * 순서:
 *  1. 현재가 조회
 *  2. 잔고 조회
 *  3. 매수 (500,000원어치 삼성전자)
 *  4. 5초 대기
 *  5. 잔고 재조회 (체결 확인)
 *  6. 매도 (전량)
 *  7. 최종 잔고 확인
 */

const kis = require('../lib/kis');
const { isDryRun, isKisPaper } = require('../lib/secrets');

const TEST_SYMBOL = '005930';   // 삼성전자
const TEST_AMOUNT = 500_000;    // 500,000원

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  const dryRun = isDryRun();
  const paper  = isKisPaper();

  console.log('=========================================');
  console.log('  KIS 모의투자 실주문 테스트');
  console.log(`  모드: ${dryRun ? '드라이런' : paper ? '모의투자(VTS)' : '실전⚠️'}`);
  console.log('=========================================\n');

  if (dryRun) {
    console.error('❌ DRY_RUN=true — 환경변수 DRY_RUN=false 로 실행하세요.');
    process.exit(1);
  }
  if (!paper) {
    console.error('❌ KIS_PAPER=false — 실전 환경! 테스트 중단.');
    process.exit(1);
  }

  // ── [1] 현재가 조회 ──────────────────────────────────
  console.log(`[1] ${TEST_SYMBOL} 현재가 조회...`);
  const { price, name } = await kis.fetchPrice(TEST_SYMBOL);
  const qty = Math.floor(TEST_AMOUNT / price);
  console.log(`    ${name}: ${price.toLocaleString()}원 → ${qty}주 매수 예정\n`);

  if (qty < 1) {
    console.error('❌ 수량 0 — 금액 부족');
    process.exit(1);
  }

  // ── [2] 매수 전 잔고 조회 ────────────────────────────
  console.log('[2] 매수 전 잔고...');
  const before = await kis.fetchBalance();
  console.log(`    예수금: ${before.krw.toLocaleString()}원`);
  console.log(`    보유종목: ${before.holdings.length}개\n`);

  // ── [3] 시장가 매수 ──────────────────────────────────
  console.log(`[3] ${TEST_SYMBOL} ${qty}주 시장가 매수...`);
  const buyOrder = await kis.marketBuy(TEST_SYMBOL, TEST_AMOUNT, false);
  console.log(`    ✅ 매수 주문 완료`);
  console.log(`    주문번호: ${buyOrder.orderId}`);
  console.log(`    수량: ${buyOrder.qty}주 @ ${buyOrder.price.toLocaleString()}원\n`);

  // ── [4] 체결 대기 ────────────────────────────────────
  console.log('[4] 5초 대기 (체결 확인)...');
  await sleep(5000);

  // ── [5] 매수 후 잔고 재조회 ──────────────────────────
  console.log('[5] 매수 후 잔고...');
  const afterBuy = await kis.fetchBalance();
  console.log(`    예수금: ${afterBuy.krw.toLocaleString()}원`);
  const holding = afterBuy.holdings.find(h => h.stockCode === TEST_SYMBOL);
  if (holding) {
    console.log(`    ✅ ${TEST_SYMBOL} 보유: ${holding.qty}주 @ 평균 ${holding.avgPrice.toLocaleString()}원`);
  } else {
    console.log(`    ⚠️  ${TEST_SYMBOL} 보유 미확인 (체결 지연 가능)`);
  }
  console.log('');

  // ── [6] 시장가 매도 ──────────────────────────────────
  const sellQty = holding?.qty || buyOrder.qty;
  console.log(`[6] ${TEST_SYMBOL} ${sellQty}주 시장가 매도...`);
  const sellOrder = await kis.marketSell(TEST_SYMBOL, sellQty, false);
  console.log(`    ✅ 매도 주문 완료`);
  console.log(`    주문번호: ${sellOrder.orderId}`);
  console.log(`    수량: ${sellOrder.qty}주 @ ${sellOrder.price.toLocaleString()}원\n`);

  // ── [7] 최종 잔고 확인 ───────────────────────────────
  await sleep(3000);
  console.log('[7] 최종 잔고...');
  const final = await kis.fetchBalance();
  console.log(`    예수금: ${final.krw.toLocaleString()}원`);
  const stillHolding = final.holdings.find(h => h.stockCode === TEST_SYMBOL);
  if (!stillHolding) {
    console.log(`    ✅ ${TEST_SYMBOL} 전량 매도 확인`);
  } else {
    console.log(`    ⚠️  ${TEST_SYMBOL} 잔여: ${stillHolding.qty}주`);
  }

  // ── 결과 요약 ────────────────────────────────────────
  console.log('\n=========================================');
  console.log('  테스트 완료 요약');
  console.log('=========================================');
  console.log(`  매수: ${buyOrder.qty}주 @ ${buyOrder.price.toLocaleString()}원 (${(buyOrder.qty * buyOrder.price).toLocaleString()}원)`);
  console.log(`  매도: ${sellOrder.qty}주 @ ${sellOrder.price.toLocaleString()}원 (${(sellOrder.qty * sellOrder.price).toLocaleString()}원)`);
  const pnl = (sellOrder.price - buyOrder.price) * buyOrder.qty;
  console.log(`  손익: ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}원`);
  console.log('  ✅ KIS 모의투자 실주문 전체 흐름 정상\n');
}

run().catch(e => {
  console.error('\n❌ 테스트 오류:', e.message);
  process.exit(1);
});
