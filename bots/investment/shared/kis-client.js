/**
 * shared/kis-client.js — KIS 한국투자증권 API 클라이언트
 *
 * 역할: 국내주식(KOSPI/KOSDAQ) + 해외주식(미국) 시장가 주문
 * 모의투자: config.yaml kis.paper_trading: true (기본값)
 * 실전:    config.yaml kis.paper_trading: false
 *
 * API 문서: https://apiportal.koreainvestment.com/
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { loadSecrets, isKisPaper } from './secrets.js';

// ─── 상수 ──────────────────────────────────────────────────────────

const BASE_URL_PAPER = 'https://openapivts.koreainvestment.com:29443';
const BASE_URL_LIVE  = 'https://openapi.koreainvestment.com:9443';

const TR_ID = {
  DOMESTIC_BUY_PAPER:   'VTTC0802U',
  DOMESTIC_SELL_PAPER:  'VTTC0801U',
  DOMESTIC_BUY_LIVE:    'TTTC0802U',
  DOMESTIC_SELL_LIVE:   'TTTC0801U',
  OVERSEAS_BUY_PAPER:   'VTTT1002U',
  OVERSEAS_SELL_PAPER:  'VTTT1001U',
  OVERSEAS_BUY_LIVE:    'TTTT1002U',
  OVERSEAS_SELL_LIVE:   'TTTT1001U',
  DOMESTIC_PRICE:       'FHKST01010100',
  OVERSEAS_PRICE:       'HHDFS00000300',
};

// ─── 토큰 관리 ─────────────────────────────────────────────────────

/** 메모리 캐시: { paper: { token, expires } } */
const _tokenCache = {};

function tokenCachePath(paper) {
  return path.join(os.tmpdir(), paper ? 'kis-token-paper.json' : 'kis-token-live.json');
}

async function getToken(paper) {
  const cacheKey = paper ? 'paper' : 'live';

  // 메모리 캐시
  if (_tokenCache[cacheKey] && Date.now() < _tokenCache[cacheKey].expires - 60_000) {
    return _tokenCache[cacheKey].token;
  }

  // 파일 캐시
  try {
    const raw    = fs.readFileSync(tokenCachePath(paper), 'utf8');
    const cached = JSON.parse(raw);
    if (new Date(cached.expires_at) > new Date(Date.now() + 60_000)) {
      _tokenCache[cacheKey] = {
        token:   cached.access_token,
        expires: new Date(cached.expires_at).getTime(),
      };
      return cached.access_token;
    }
  } catch { /* 캐시 없음 또는 만료 */ }

  // 신규 발급
  const s   = loadSecrets();
  const key = paper ? s.kis_paper_app_key    : s.kis_app_key;
  const sec = paper ? s.kis_paper_app_secret : s.kis_app_secret;

  if (!key || key.length < 5) throw new Error(`KIS ${paper ? '모의' : '실전'} appkey 미설정`);

  const url = (paper ? BASE_URL_PAPER : BASE_URL_LIVE) + '/oauth2/tokenP';
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body:    JSON.stringify({ grant_type: 'client_credentials', appkey: key, appsecret: sec }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`KIS 토큰 발급 실패: ${res.status} ${text}`);
  }

  const data      = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  fs.writeFileSync(tokenCachePath(paper), JSON.stringify({
    access_token: data.access_token,
    expires_at:   expiresAt,
  }));

  _tokenCache[cacheKey] = {
    token:   data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  };

  console.log(`  🔑 [KIS] 토큰 발급 (${paper ? '모의' : '실전'}, 만료: ${expiresAt})`);
  return data.access_token;
}

// ─── 공통 API 요청 ──────────────────────────────────────────────────

async function kisRequest(method, endpoint, { trId, params, body, paper } = {}) {
  const s     = loadSecrets();
  const key   = paper ? s.kis_paper_app_key    : s.kis_app_key;
  const sec   = paper ? s.kis_paper_app_secret : s.kis_app_secret;
  const token = await getToken(paper);
  const base  = paper ? BASE_URL_PAPER : BASE_URL_LIVE;

  let url = base + endpoint;
  if (params) url += '?' + new URLSearchParams(params).toString();

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization:   `Bearer ${token}`,
      appkey:          key,
      appsecret:       sec,
      tr_id:           trId,
      custtype:        'P',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();

  if (data.rt_cd !== '0') {
    throw new Error(`KIS API 오류 [${data.msg_cd}]: ${data.msg1 || JSON.stringify(data)}`);
  }

  return data;
}

// ─── 현재가 조회 ────────────────────────────────────────────────────

/** 국내주식 현재가 (원) */
async function getDomesticPrice(symbol, paper) {
  const data  = await kisRequest('GET', '/uapi/domestic-stock/v1/quotations/inquire-price', {
    trId:   TR_ID.DOMESTIC_PRICE,
    params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: symbol },
    paper,
  });
  const price = parseInt(data.output?.stck_prpr || '0', 10);
  if (!price) throw new Error(`${symbol} 현재가 조회 실패 (응답: ${JSON.stringify(data.output)})`);
  return price;
}

/** 해외주식 현재가 (USD) */
async function getOverseasPrice(symbol, paper) {
  // 거래소 코드: NASD(나스닥) / NYSE
  const excd = symbol === 'NVDA' || symbol.length <= 4 ? 'NASD' : 'NYSE';
  const data  = await kisRequest('GET', '/uapi/overseas-price/v1/quotations/price', {
    trId:   TR_ID.OVERSEAS_PRICE,
    params: { AUTH: '', EXCD: excd, SYMB: symbol },
    paper,
  });
  const price = parseFloat(data.output?.last || '0');
  if (!price) throw new Error(`${symbol} 해외 현재가 조회 실패 (응답: ${JSON.stringify(data.output)})`);
  return { price, excd };
}

// ─── 계좌번호 파싱 ──────────────────────────────────────────────────

/** KIS 계좌번호 → { cano(앞8자리), prodCd(뒤2자리) } */
function parseAccount(paper) {
  const s       = loadSecrets();
  const acctRaw = paper
    ? (s.kis_paper_account_number || s.kis_account_number || '')
    :  s.kis_account_number || '';
  if (!acctRaw) throw new Error('KIS 계좌번호 미설정 (config.yaml kis.paper_account_number)');
  const clean  = acctRaw.replace(/-/g, '');
  return { cano: clean.slice(0, 8), prodCd: clean.slice(8, 10) || '01' };
}

// ─── 국내주식 주문 ──────────────────────────────────────────────────

/**
 * 국내주식 시장가 매수
 * @param {string}  symbol     6자리 종목코드 (예: 005930)
 * @param {number}  amountKrw  투자 금액 (원)
 * @param {boolean} dryRun     true = API 호출 없이 시뮬레이션만
 * @returns {{ qty, price, totalKrw, ordNo?, dryRun? }}
 */
export async function marketBuy(symbol, amountKrw, dryRun = false) {
  const paper = isKisPaper();
  const tag   = dryRun ? '[PAPER]' : paper ? '[모의투자]' : '[실전]';

  const currentPrice = await getDomesticPrice(symbol, paper);
  const qty          = Math.floor(amountKrw / currentPrice);

  if (qty < 1) {
    throw new Error(
      `수량 부족: ${amountKrw?.toLocaleString()}원으로 ${symbol} 1주(${currentPrice.toLocaleString()}원) 매수 불가`,
    );
  }

  console.log(`  📊 [KIS] ${symbol} 현재가 ${currentPrice.toLocaleString()}원 → 매수 ${qty}주 ${tag}`);

  if (dryRun) {
    console.log(`  🔍 [KIS] dryRun — 실제 주문 생략`);
    return { qty, price: currentPrice, totalKrw: qty * currentPrice, dryRun: true };
  }

  const { cano, prodCd } = parseAccount(paper);
  const trId = paper ? TR_ID.DOMESTIC_BUY_PAPER : TR_ID.DOMESTIC_BUY_LIVE;

  const res = await kisRequest('POST', '/uapi/domestic-stock/v1/trading/order-cash', {
    trId, paper,
    body: {
      CANO:         cano,
      ACNT_PRDT_CD: prodCd,
      PDNO:         symbol,
      ORD_DVSN:     '01',      // 시장가
      ORD_QTY:      String(qty),
      ORD_UNPR:     '0',
    },
  });

  const ordNo = res.output?.ODNO;
  console.log(`  ✅ [KIS] ${tag} 매수 완료: ${symbol} ${qty}주 주문번호=${ordNo}`);
  return { qty, price: currentPrice, totalKrw: qty * currentPrice, ordNo };
}

/**
 * 국내주식 시장가 매도
 * @param {string}  symbol  6자리 종목코드
 * @param {number}  qty     매도 수량
 * @param {boolean} dryRun
 * @returns {{ qty, price, totalKrw, ordNo?, dryRun? }}
 */
export async function marketSell(symbol, qty, dryRun = false) {
  const paper = isKisPaper();
  const tag   = dryRun ? '[PAPER]' : paper ? '[모의투자]' : '[실전]';

  const currentPrice = await getDomesticPrice(symbol, paper);
  console.log(`  📊 [KIS] ${symbol} 현재가 ${currentPrice.toLocaleString()}원 → 매도 ${qty}주 ${tag}`);

  if (dryRun) {
    console.log(`  🔍 [KIS] dryRun — 실제 주문 생략`);
    return { qty, price: currentPrice, totalKrw: qty * currentPrice, dryRun: true };
  }

  const { cano, prodCd } = parseAccount(paper);
  const trId = paper ? TR_ID.DOMESTIC_SELL_PAPER : TR_ID.DOMESTIC_SELL_LIVE;

  const res = await kisRequest('POST', '/uapi/domestic-stock/v1/trading/order-cash', {
    trId, paper,
    body: {
      CANO:         cano,
      ACNT_PRDT_CD: prodCd,
      PDNO:         symbol,
      ORD_DVSN:     '01',      // 시장가
      ORD_QTY:      String(qty),
      ORD_UNPR:     '0',
    },
  });

  const ordNo = res.output?.ODNO;
  console.log(`  ✅ [KIS] ${tag} 매도 완료: ${symbol} ${qty}주 주문번호=${ordNo}`);
  return { qty, price: currentPrice, totalKrw: qty * currentPrice, ordNo };
}

// ─── 해외주식 주문 ──────────────────────────────────────────────────

/**
 * 해외주식 지정가(현재가) 매수 — KIS 해외는 시장가 미지원
 * @param {string}  symbol     알파벳 티커 (예: AAPL)
 * @param {number}  amountUsd  투자 금액 (USD)
 * @param {boolean} dryRun
 * @returns {{ qty, price, totalUsd, ordNo?, dryRun? }}
 */
export async function marketBuyOverseas(symbol, amountUsd, dryRun = false) {
  const paper = isKisPaper();
  const tag   = dryRun ? '[PAPER]' : paper ? '[모의투자]' : '[실전]';

  const { price: currentPrice, excd } = await getOverseasPrice(symbol, paper);
  const qty = Math.floor(amountUsd / currentPrice);

  if (qty < 1) {
    throw new Error(`수량 부족: $${amountUsd}로 ${symbol} 1주($${currentPrice}) 매수 불가`);
  }

  console.log(`  📊 [KIS] ${symbol} 현재가 $${currentPrice} → 매수 ${qty}주 ${tag}`);

  if (dryRun) {
    console.log(`  🔍 [KIS] dryRun — 실제 주문 생략`);
    return { qty, price: currentPrice, totalUsd: qty * currentPrice, dryRun: true };
  }

  const { cano, prodCd } = parseAccount(paper);
  const trId = paper ? TR_ID.OVERSEAS_BUY_PAPER : TR_ID.OVERSEAS_BUY_LIVE;

  const res = await kisRequest('POST', '/uapi/overseas-stock/v1/trading/order', {
    trId, paper,
    body: {
      CANO:          cano,
      ACNT_PRDT_CD:  prodCd,
      OVRS_EXCG_CD:  excd,
      PDNO:          symbol,
      ORD_DVSN:      '00',    // 지정가 (해외 시장가 미지원)
      ORD_QTY:       String(qty),
      OVRS_ORD_UNPR: currentPrice.toFixed(2),
    },
  });

  const ordNo = res.output?.ODNO;
  console.log(`  ✅ [KIS] ${tag} 해외 매수 완료: ${symbol} ${qty}주 주문번호=${ordNo}`);
  return { qty, price: currentPrice, totalUsd: qty * currentPrice, ordNo };
}

/**
 * 해외주식 지정가(현재가) 매도
 * @param {string}  symbol  알파벳 티커
 * @param {number}  qty     매도 수량
 * @param {boolean} dryRun
 * @returns {{ qty, price, totalUsd, ordNo?, dryRun? }}
 */
export async function marketSellOverseas(symbol, qty, dryRun = false) {
  const paper = isKisPaper();
  const tag   = dryRun ? '[PAPER]' : paper ? '[모의투자]' : '[실전]';

  const { price: currentPrice, excd } = await getOverseasPrice(symbol, paper);
  console.log(`  📊 [KIS] ${symbol} 현재가 $${currentPrice} → 매도 ${qty}주 ${tag}`);

  if (dryRun) {
    console.log(`  🔍 [KIS] dryRun — 실제 주문 생략`);
    return { qty, price: currentPrice, totalUsd: qty * currentPrice, dryRun: true };
  }

  const { cano, prodCd } = parseAccount(paper);
  const trId = paper ? TR_ID.OVERSEAS_SELL_PAPER : TR_ID.OVERSEAS_SELL_LIVE;

  const res = await kisRequest('POST', '/uapi/overseas-stock/v1/trading/order', {
    trId, paper,
    body: {
      CANO:          cano,
      ACNT_PRDT_CD:  prodCd,
      OVRS_EXCG_CD:  excd,
      PDNO:          symbol,
      ORD_DVSN:      '00',
      ORD_QTY:       String(qty),
      OVRS_ORD_UNPR: currentPrice.toFixed(2),
    },
  });

  const ordNo = res.output?.ODNO;
  console.log(`  ✅ [KIS] ${tag} 해외 매도 완료: ${symbol} ${qty}주 주문번호=${ordNo}`);
  return { qty, price: currentPrice, totalUsd: qty * currentPrice, ordNo };
}
