'use strict';

/**
 * lib/binance.js — CCXT Binance 클라이언트
 *
 * - Spot 현물 거래 (Phase 1)
 * - 드라이런: API 키 없어도 공개 데이터(가격/OHLCV) 조회 가능
 * - 테스트넷: secrets.binance_testnet=true 시 사용
 */

const { loadSecrets, isDryRun, isTestnet } = require('./secrets');

let _exchange = null;

function getExchange() {
  if (_exchange) return _exchange;

  const ccxt = require('ccxt');
  const secrets = loadSecrets();
  const testnet = isTestnet();
  const dryRun = isDryRun();

  const options = {
    apiKey:    secrets.binance_api_key || '',
    secret:    secrets.binance_api_secret || '',
    options: {
      defaultType: 'spot',
    },
  };

  if (testnet) {
    options.urls = {
      api: {
        public:  'https://testnet.binance.vision/api',
        private: 'https://testnet.binance.vision/api',
      },
    };
  }

  _exchange = new ccxt.binance(options);

  if (dryRun) {
    console.log('🧪 [바이낸스] 드라이런 모드 — 주문 실행 없음');
  }
  if (testnet) {
    console.log('🔬 [바이낸스] 테스트넷 모드');
  }

  return _exchange;
}

/**
 * 현재가 조회
 * @param {string} symbol  ex) 'BTC/USDT'
 * @returns {number} 현재가
 */
async function fetchTicker(symbol) {
  const ex = getExchange();
  const ticker = await ex.fetchTicker(symbol);
  return ticker.last;
}

/**
 * OHLCV 캔들 데이터 조회
 * @param {string} symbol    ex) 'BTC/USDT'
 * @param {string} timeframe ex) '1h', '4h', '1d'
 * @param {number} limit     캔들 개수 (기본 100)
 * @returns {Array} [[timestamp, open, high, low, close, volume], ...]
 */
async function fetchOHLCV(symbol, timeframe = '1h', limit = 100) {
  const ex = getExchange();
  return ex.fetchOHLCV(symbol, timeframe, undefined, limit);
}

/**
 * 잔고 조회 (USDT)
 * @returns {{ USDT: number, total: object }}
 */
async function fetchBalance() {
  const ex = getExchange();
  if (isDryRun()) {
    return { USDT: { free: 10000, used: 0, total: 10000 }, total: { USDT: 10000 } };
  }
  const balance = await ex.fetchBalance();
  return balance;
}

/**
 * 시장가 매수
 * @param {string} symbol     ex) 'BTC/USDT'
 * @param {number} amountUsdt USDT 금액
 * @param {boolean} dryRun    드라이런 여부 (기본: isDryRun())
 * @returns {{ orderId, symbol, side, amountUsdt, price, filled, dryRun }}
 */
async function marketBuy(symbol, amountUsdt, dryRun = isDryRun()) {
  const ex = getExchange();
  const price = await fetchTicker(symbol);
  const amount = amountUsdt / price;

  if (dryRun) {
    const result = {
      orderId:    `DRY-BUY-${Date.now()}`,
      symbol,
      side:       'buy',
      amountUsdt,
      price,
      filled:     amount,
      dryRun:     true,
    };
    console.log(`🧪 [드라이런 매수] ${symbol} ${amount.toFixed(6)} @ ${price} USDT`);
    return result;
  }

  const order = await ex.createOrder(symbol, 'market', 'buy', amount);
  return {
    orderId:    order.id,
    symbol:     order.symbol,
    side:       order.side,
    amountUsdt,
    price:      order.average || price,
    filled:     order.filled,
    dryRun:     false,
  };
}

/**
 * 시장가 매도
 * @param {string} symbol  ex) 'BTC/USDT'
 * @param {number} amount  매도 수량 (코인 단위)
 * @param {boolean} dryRun 드라이런 여부
 * @returns {{ orderId, symbol, side, amount, price, totalUsdt, dryRun }}
 */
async function marketSell(symbol, amount, dryRun = isDryRun()) {
  const ex = getExchange();
  const price = await fetchTicker(symbol);

  if (dryRun) {
    const result = {
      orderId:   `DRY-SELL-${Date.now()}`,
      symbol,
      side:      'sell',
      amount,
      price,
      totalUsdt: amount * price,
      dryRun:    true,
    };
    console.log(`🧪 [드라이런 매도] ${symbol} ${amount} @ ${price} USDT`);
    return result;
  }

  const order = await ex.createOrder(symbol, 'market', 'sell', amount);
  return {
    orderId:   order.id,
    symbol:    order.symbol,
    side:      order.side,
    amount:    order.filled,
    price:     order.average || price,
    totalUsdt: (order.filled || amount) * (order.average || price),
    dryRun:    false,
  };
}

/**
 * 오픈 오더 조회
 */
async function fetchOpenOrders(symbol) {
  if (isDryRun()) return [];
  const ex = getExchange();
  return ex.fetchOpenOrders(symbol);
}

module.exports = { getExchange, fetchTicker, fetchOHLCV, fetchBalance, marketBuy, marketSell, fetchOpenOrders };
