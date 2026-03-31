/**
 * shared/upbit-client.js — 업비트 API 클라이언트 (ccxt 기반)
 *
 * 역할: KRW→USDT 매수 + 바이낸스 입금 주소로 USDT 출금
 * 주의: 실제 자금 이동 — PAPER_MODE 무관하게 항상 confirm 필요
 */

import ccxt from 'ccxt';
import { loadSecrets } from './secrets.js';

// ─── 업비트 인스턴스 ─────────────────────────────────────────────────

let _upbit = null;

function getUpbit() {
  if (_upbit) return _upbit;
  const s = loadSecrets();
  if (!s.upbit_access_key || !s.upbit_secret_key) {
    throw new Error('업비트 API 키 미설정 (Hub secrets upbit.access_key/secret_key)');
  }
  _upbit = new ccxt.upbit({
    apiKey: s.upbit_access_key,
    secret: s.upbit_secret_key,
    enableRateLimit: true,
    options: {
      createMarketBuyOrderRequiresPrice: false, // KRW 금액을 amount로 전달
    },
  });
  return _upbit;
}

// ─── 바이낸스 인스턴스 ───────────────────────────────────────────────

let _binance = null;

function getBinance() {
  if (_binance) return _binance;
  const s = loadSecrets();
  if (!s.binance_api_key || !s.binance_api_secret) {
    throw new Error('바이낸스 API 키 미설정 (Hub secrets binance.api_key/api_secret)');
  }
  _binance = new ccxt.binance({
    apiKey: s.binance_api_key,
    secret: s.binance_api_secret,
    enableRateLimit: true,
  });
  return _binance;
}

// ─── 업비트 KRW 잔고 조회 ────────────────────────────────────────────

export async function getUpbitKrwBalance() {
  const upbit    = getUpbit();
  const balances = await upbit.fetchBalance();
  return balances?.KRW?.free ?? 0;
}

// ─── 업비트 USDT 잔고 조회 ───────────────────────────────────────────

export async function getUpbitUsdtBalance() {
  const upbit    = getUpbit();
  const balances = await upbit.fetchBalance();
  return balances?.USDT?.free ?? 0;
}

// ─── KRW 전량으로 USDT 시장가 매수 ──────────────────────────────────

/**
 * 업비트 KRW 잔고 전량으로 USDT 시장가 매수
 * @param {number} krwAmount - 매수할 KRW 금액 (0 이면 전량)
 * @returns {{ orderId, krwSpent, usdtFilled, avgPrice }}
 */
export async function buyUsdtWithKrw(krwAmount = 0) {
  const upbit = getUpbit();

  // 잔고 재확인
  const available = await getUpbitKrwBalance();
  if (available < 5000) {
    throw new Error(`KRW 잔고 부족: ${available.toLocaleString()}원 (최소 5,000원)`);
  }

  // 금액 결정 (0이면 전량, 단 수수료 0.05% 감안해 소폭 여유)
  const spend   = krwAmount > 0 ? Math.min(krwAmount, available) : Math.floor(available * 0.999);
  const rounded = Math.floor(spend / 1000) * 1000; // 1,000원 단위 절사

  if (rounded < 5000) {
    throw new Error(`매수 금액이 너무 작습니다: ${rounded.toLocaleString()}원`);
  }

  // ccxt 업비트 시장가 매수: createMarketBuyOrderRequiresPrice=false → KRW 금액을 amount로 전달
  const order = await upbit.createOrder(
    'USDT/KRW',
    'market',
    'buy',
    rounded,      // amount = 사용할 KRW 금액 (quote quantity)
    undefined,
    { type: 'price' }
  );

  return {
    orderId:    order.id,
    krwSpent:   rounded,
    usdtFilled: order.filled  ?? 0,
    avgPrice:   order.average ?? 0,
    status:     order.status,
  };
}

// ─── 바이낸스 USDT 입금 주소 조회 ────────────────────────────────────

/**
 * 바이낸스 USDT 입금 주소 조회 (TRC20 우선, 없으면 ERC20)
 * secrets에 deposit_address_usdt 설정돼 있으면 그것 사용 (권장)
 */
export async function getBinanceDepositAddress() {
  const s = loadSecrets();

  // 사전 설정 주소 우선 사용 (안전)
  if (s.binance_deposit_address_usdt) {
    return {
      address: s.binance_deposit_address_usdt,
      network: s.binance_usdt_network || 'TRC20',
      source:  'config',
    };
  }

  // 동적 조회 (Binance API 필요)
  const binance = getBinance();
  let depositInfo;

  // TRC20 (트론) 우선 — 수수료 저렴
  try {
    depositInfo = await binance.fetchDepositAddress('USDT', { network: 'TRC20' });
  } catch {
    // ERC20 fallback
    depositInfo = await binance.fetchDepositAddress('USDT', { network: 'ERC20' });
  }

  return {
    address: depositInfo.address,
    tag:     depositInfo.tag || '',
    network: depositInfo.network || 'TRC20',
    source:  'api',
  };
}

// ─── 업비트 KRW 입금 이력 조회 (출금지연제 해제 시각 추정) ────────────

/**
 * 가장 최근 KRW 입금 완료 시각 반환
 * - 1차: 업비트 KRW 입금 이력 API (fetchDeposits 'KRW')
 * - 2차: USDT/KRW 최근 체결 주문 시각 (근사치, fetchClosedOrders)
 * @returns {Date|null}
 */
export async function getRecentKrwDepositTime() {
  const upbit = getUpbit();

  // 1차: KRW 입금 이력 (fetchDeposits)
  try {
    const deps = await upbit.fetchDeposits('KRW', undefined, 5);
    if (Array.isArray(deps) && deps.length > 0) {
      const completed = deps
        .filter(d => d.status === 'ok' || d.status === 'done' || d.status === 'accepted')
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      if (completed?.datetime) return new Date(completed.datetime);
    }
  } catch { /* API 미지원 → 2차 시도 */ }

  // 2차: USDT/KRW 최근 체결 주문 (매수 시점 ≈ KRW 입금 직후)
  try {
    const orders = await upbit.fetchClosedOrders('USDT/KRW', undefined, 5);
    const sorted = orders.sort((a, b) => b.timestamp - a.timestamp);
    if (sorted.length > 0) return new Date(sorted[0].timestamp);
  } catch { /* 조회 실패 */ }

  return null;
}

// ─── 업비트 USDT 출금 ────────────────────────────────────────────────

/**
 * 업비트에서 USDT 출금
 * @param {number}  amount  - 출금 USDT 수량 (0 이면 전량)
 * @param {string}  address - 수신 주소 (바이낸스)
 * @param {string}  network - 네트워크 코드 (TRC20|ERC20)
 * @param {string}  tag     - 메모/태그 (없으면 '')
 */
export async function withdrawUsdtToAddress(amount, address, network = 'TRC20', tag = '') {
  const upbit = getUpbit();

  const available = await getUpbitUsdtBalance();
  if (available < 1) {
    throw new Error(`USDT 잔고 부족: ${available}`);
  }

  // 0이면 전량 (출금 수수료 차감 후 남은 전량)
  // 업비트 소수점 6자리 제한 → floor 절사
  const raw            = amount > 0 ? Math.min(amount, available) : available;
  const withdrawAmount = Math.floor(raw * 1e6) / 1e6;

  // 업비트 net_type 매핑 (ccxt가 표준→업비트 변환을 지원 안 함)
  // TRC20(Tron) → TRX, ERC20(Ethereum) → ETH
  const UPBIT_NETWORK_MAP = { TRC20: 'TRX', ERC20: 'ETH', BEP20: 'BNB', MATIC: 'MATIC' };
  const upbitNetwork = UPBIT_NETWORK_MAP[network] ?? network;

  const params = { network: upbitNetwork, net_type: upbitNetwork };
  if (tag) params.tag = tag;

  const result = await upbit.withdraw('USDT', withdrawAmount, address, tag || undefined, params);

  return {
    withdrawalId: result.id,
    amount:       withdrawAmount,
    address,
    network,
    status:       result.status,
  };
}
