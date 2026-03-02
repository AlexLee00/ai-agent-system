#!/usr/bin/env node
'use strict';

/**
 * scripts/dry-run-test.js — 드라이런 전체 흐름 테스트
 *
 * 테스트 순서:
 * 1. DB 초기화 확인
 * 2. 바이낸스 공개 API (OHLCV, 현재가)
 * 3. TA 분석가 실행
 * 4. 신호 생성 (mock)
 * 5. 리스크 매니저 승인
 * 6. 드라이런 주문 실행
 * 7. 포지션 확인
 * 8. 업비트 브릿지 체크
 *
 * 실행: node scripts/dry-run-test.js
 */

process.env.DRY_RUN = 'true';
process.env.TELEGRAM_ENABLED = '0'; // 테스트 중 텔레그램 발송 억제

const db = require('../lib/db');
const { fetchTicker, fetchOHLCV } = require('../lib/binance');
const { analyzeSymbol } = require('../src/analysts/ta-analyst');
const { evaluateSignal } = require('../src/risk-manager');
const { executeSignal } = require('../src/binance-executor');
const { checkBalances } = require('../src/upbit-bridge');

const SYMBOL = 'BTC/USDT';

async function step(name, fn) {
  process.stdout.write(`\n📌 ${name}... `);
  try {
    const result = await fn();
    console.log('✅');
    return result;
  } catch (e) {
    console.log(`❌ ${e.message}`);
    throw e;
  }
}

async function main() {
  console.log('🧪 드라이런 전체 흐름 테스트 시작\n');
  console.log('=' .repeat(50));

  // 1. DB 초기화
  await step('DB 스키마 초기화', async () => {
    await db.initSchema();
    const tables = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='main'`
    );
    if (tables.length < 4) throw new Error(`테이블 ${tables.length}개 (4개 필요)`);
  });

  // 2. 바이낸스 공개 API
  let currentPrice;
  await step(`현재가 조회 (${SYMBOL})`, async () => {
    currentPrice = await fetchTicker(SYMBOL);
    if (!currentPrice || currentPrice <= 0) throw new Error('가격 조회 실패');
    console.log(`\n  현재가: $${currentPrice.toLocaleString()}`);
  });

  await step('OHLCV 조회 (1h x 100)', async () => {
    const ohlcv = await fetchOHLCV(SYMBOL, '1h', 100);
    if (ohlcv.length < 50) throw new Error(`OHLCV ${ohlcv.length}개 (50+ 필요)`);
    console.log(`\n  ${ohlcv.length}개 캔들 수신`);
  });

  // 3. TA 분석
  let taResult;
  await step('TA 분석가 실행', async () => {
    taResult = await analyzeSymbol(SYMBOL, '1h');
    console.log(`\n  신호: ${taResult.signal} (${(taResult.confidence * 100).toFixed(0)}%)`);
  });

  // 4. mock 신호 생성
  let signalId;
  await step('신호 DB 저장', async () => {
    signalId = await db.insertSignal({
      symbol:     SYMBOL,
      action:     'BUY',
      amountUsdt: 100,
      confidence: 0.7,
      reasoning:  '드라이런 테스트 신호',
    });
    if (!signalId) throw new Error('signalId 없음');
    console.log(`\n  signalId: ${signalId}`);
  });

  // 5. 리스크 평가
  await step('리스크 매니저 평가', async () => {
    const signal = { id: signalId, symbol: SYMBOL, action: 'BUY', amount_usdt: 100 };
    const result = await evaluateSignal(signal);
    console.log(`\n  결과: ${result.approved ? '승인' : `거부 (${result.reason})`}`);
  });

  // 6. 드라이런 실행
  await step('드라이런 주문 실행', async () => {
    // 새 신호 생성 (이전 것은 이미 처리됨)
    const newSignalId = await db.insertSignal({
      symbol:     SYMBOL,
      action:     'BUY',
      amountUsdt: 100,
      confidence: 0.8,
      reasoning:  '드라이런 실행 테스트',
    });
    const signal = { id: newSignalId, symbol: SYMBOL, action: 'BUY', amount_usdt: 100 };
    const result = await executeSignal(signal);
    console.log(`\n  성공: ${result.success}`);
  });

  // 7. 포지션 확인
  await step('포지션 조회', async () => {
    const positions = await db.getAllPositions();
    console.log(`\n  포지션 수: ${positions.length}`);
    positions.forEach(p => {
      console.log(`  - ${p.symbol}: ${p.amount} @ $${p.avg_price?.toFixed(2)}`);
    });
  });

  // 8. 거래 이력
  await step('거래 이력 조회', async () => {
    const trades = await db.getTradeHistory(SYMBOL, 5);
    console.log(`\n  최근 거래: ${trades.length}건`);
  });

  // 9. 업비트 브릿지 잔고 체크
  await step('업비트 브릿지 잔고 체크', async () => {
    const balances = await checkBalances();
    console.log(`\n  업비트 KRW: ${balances.upbitKRW.toLocaleString()}원`);
    console.log(`  바이낸스 USDT: $${balances.binanceUSDT.toFixed(2)}`);
  });

  // 10. 정리
  db.close();

  console.log('\n' + '='.repeat(50));
  console.log('✅ 드라이런 전체 흐름 테스트 완료!');
  console.log('\n다음 단계:');
  console.log('  1. secrets.json에 실제 API 키 입력');
  console.log('  2. node src/analysts/ta-analyst.js --symbol=BTC/USDT');
  console.log('  3. node src/analysts/signal-aggregator.js');
  console.log('  4. launchd 등록: ~/Library/LaunchAgents/ai.invest.pipeline.plist');
}

main().catch(e => {
  console.error('\n❌ 테스트 실패:', e.message);
  console.error(e.stack);
  process.exit(1);
});
