'use strict';

/**
 * lib/upbit.js — CCXT 업비트 클라이언트
 *
 * 역할:
 * - KRW 잔고 모니터링
 * - KRW → USDT 전환 (업비트에서 USDT 매수)
 * - USDT → 바이낸스 전송 (출금)
 * - 바이낸스 USDT → 업비트 입금 → KRW 전환 (수익 출금)
 *
 * 드라이런: API 키 없으면 가상 잔고 반환
 */

const { loadSecrets, isDryRun } = require('./secrets');

let _exchange = null;

function getExchange() {
  if (_exchange) return _exchange;

  const ccxt = require('ccxt');
  const secrets = loadSecrets();

  _exchange = new ccxt.upbit({
    apiKey: secrets.upbit_access_key || '',
    secret: secrets.upbit_secret_key || '',
    options: { createMarketBuyOrderRequiresPrice: false },
  });

  return _exchange;
}

/**
 * KRW/USDT 잔고 조회
 * @returns {{ KRW: number, USDT: number }}
 */
async function fetchBalance() {
  if (isDryRun()) {
    return { KRW: 1000000, USDT: 0 };
  }
  const ex = getExchange();
  const balance = await ex.fetchBalance();
  return {
    KRW:  balance.total?.KRW  || 0,
    USDT: balance.total?.USDT || 0,
  };
}

/**
 * 현재가 조회 (KRW 기준)
 * @param {string} symbol ex) 'BTC/KRW', 'USDT/KRW'
 */
async function fetchTicker(symbol) {
  const ex = getExchange();
  const ticker = await ex.fetchTicker(symbol);
  return ticker.last;
}

/**
 * 시장가 매수 (KRW → USDT)
 * @param {number} krwAmount  사용할 KRW 금액
 * @param {boolean} dryRun
 * @returns {{ orderId, amountKRW, usdtBought, price, dryRun }}
 */
async function buyUSDT(krwAmount, dryRun = isDryRun()) {
  const ex = getExchange();
  const price = await fetchTicker('USDT/KRW');
  const usdtEstimate = krwAmount / price;

  if (dryRun) {
    console.log(`🧪 [드라이런] 업비트 USDT 매수: ${krwAmount.toLocaleString()}원 → USDT ${usdtEstimate.toFixed(2)} (@ ${price}원)`);
    return {
      orderId:    `DRY-UB-BUY-${Date.now()}`,
      amountKRW:  krwAmount,
      usdtBought: usdtEstimate,
      price,
      dryRun:     true,
    };
  }

  // 업비트 시장가 매수: CCXT upbit에서 amount = KRW 금액 (ord_type: 'price')
  const order = await ex.createOrder('USDT/KRW', 'market', 'buy', krwAmount);
  const usdtBought = order.filled || usdtEstimate;
  return {
    orderId:    order.id,
    amountKRW:  krwAmount,
    usdtBought,
    price:      order.average || price,
    dryRun:     false,
  };
}

/**
 * 업비트 USDT → 바이낸스 출금 (단일 전송)
 * net_type=TRX (TRC20), 소수점 6자리 버림
 * @param {number} usdtAmount   출금할 USDT 금액
 * @param {string} binanceAddr  바이낸스 USDT 입금 주소 (TRC20)
 * @param {string} memo         주소 태그/메모 (TRX는 불필요)
 * @param {boolean} dryRun
 */
async function withdrawToBinance(usdtAmount, binanceAddr, memo, dryRun = isDryRun()) {
  if (dryRun) {
    console.log(`🧪 [드라이런] 업비트 → 바이낸스 출금: USDT ${usdtAmount} → ${binanceAddr}`);
    return { withdrawId: `DRY-WD-${Date.now()}`, amount: usdtAmount, dryRun: true };
  }

  const ex = getExchange();
  // 업비트 TRC20: net_type='TRX' (TRC20 아님), 소수점 6자리 이하만 허용
  const amount = Math.floor(usdtAmount * 1e6) / 1e6;
  const result = await ex.withdraw('USDT', amount, binanceAddr, memo ?? undefined, {
    network: 'TRX',
  });
  return { withdrawId: result.id, amount, dryRun: false };
}

/**
 * 시장가 매도 (USDT → KRW)
 * @param {number} usdtAmount  매도할 USDT 금액
 * @param {boolean} dryRun
 */
async function sellUSDT(usdtAmount, dryRun = isDryRun()) {
  const ex = getExchange();
  const price = await fetchTicker('USDT/KRW');
  const krwEstimate = usdtAmount * price;

  if (dryRun) {
    console.log(`🧪 [드라이런] 업비트 USDT 매도: USDT ${usdtAmount} → ${krwEstimate.toLocaleString()}원`);
    return {
      orderId:     `DRY-UB-SELL-${Date.now()}`,
      usdtAmount,
      krwReceived: krwEstimate,
      price,
      dryRun:      true,
    };
  }

  const order = await ex.createOrder('USDT/KRW', 'market', 'sell', usdtAmount);
  return {
    orderId:     order.id,
    usdtAmount,
    krwReceived: (order.filled || usdtAmount) * (order.average || price),
    price:       order.average || price,
    dryRun:      false,
  };
}

module.exports = { getExchange, fetchBalance, fetchTicker, buyUSDT, withdrawToBinance, sellUSDT };
