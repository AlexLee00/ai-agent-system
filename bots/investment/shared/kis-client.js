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
  DOMESTIC_BUY_PAPER:      'VTTC0802U',
  DOMESTIC_SELL_PAPER:     'VTTC0801U',
  DOMESTIC_BUY_LIVE:       'TTTC0802U',
  DOMESTIC_SELL_LIVE:      'TTTC0801U',
  OVERSEAS_BUY_PAPER:      'VTTT1002U',
  OVERSEAS_SELL_PAPER:     'VTTT1006U',   // 미국 매도 모의투자
  OVERSEAS_BUY_LIVE:       'TTTT1002U',
  OVERSEAS_SELL_LIVE:      'TTTT1006U',   // 미국 매도 실전
  DOMESTIC_PRICE:          'FHKST01010100',
  OVERSEAS_PRICE:          'HHDFS76200200', // 해외주식 현재체결가
  // ── 잔고 조회 ──
  DOMESTIC_BALANCE_PAPER:  'VTTC8434R',
  DOMESTIC_BALANCE_LIVE:   'TTTC8434R',
  OVERSEAS_BALANCE_PAPER:  'VTTS3012R',
  OVERSEAS_BALANCE_LIVE:   'TTTS3012R',
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

/** 해외주식 현재가 (USD)
 *  - 가격조회: NAS/NYS (HHDFS76200200 API 요구)
 *  - 주문 EXCD: NASD/NYSE (order API 요구)
 */
async function getOverseasPrice(symbol) {
  // 가격조회용 (shorter code)
  const PRICE_EXCD = {
    AAPL: 'NAS', MSFT: 'NAS', AMZN: 'NAS', GOOGL: 'NAS', META: 'NAS',
    NVDA: 'NAS', TSLA: 'NAS', NFLX: 'NAS', INTC: 'NAS', AMD:  'NAS',
    QCOM: 'NAS', AVGO: 'NAS', ADBE: 'NAS', CSCO: 'NAS', PYPL: 'NAS',
    COIN: 'NAS', MSTR: 'NAS',
    JPM: 'NYS', BAC: 'NYS', WMT: 'NYS', JNJ: 'NYS', BRK: 'NYS',
    XOM: 'NYS', CVX: 'NYS', UNH: 'NYS', HD:  'NYS',
    // EV / 중국계 NYSE 상장
    NIO:  'NYS', XPEV: 'NYS', LI:  'NYS', BABA: 'NYS', PDD: 'NYS',
    JD:   'NYS', BIDU: 'NYS',
    // 기타 NYSE
    RIVN: 'NYS', LCID: 'NYS', PLTR: 'NYS', UBER: 'NYS', LYFT: 'NYS',
  };
  // 주문용 (full code — order API 요구)
  const ORDER_EXCD = {
    AAPL: 'NASD', MSFT: 'NASD', AMZN: 'NASD', GOOGL: 'NASD', META: 'NASD',
    NVDA: 'NASD', TSLA: 'NASD', NFLX: 'NASD', INTC: 'NASD', AMD:  'NASD',
    QCOM: 'NASD', AVGO: 'NASD', ADBE: 'NASD', CSCO: 'NASD', PYPL: 'NASD',
    COIN: 'NASD', MSTR: 'NASD',
    JPM: 'NYSE', BAC: 'NYSE', WMT: 'NYSE', JNJ: 'NYSE', BRK: 'NYSE',
    XOM: 'NYSE', CVX: 'NYSE', UNH: 'NYSE', HD:  'NYSE',
    // EV / 중국계 NYSE 상장
    NIO:  'NYSE', XPEV: 'NYSE', LI:  'NYSE', BABA: 'NYSE', PDD: 'NYSE',
    JD:   'NYSE', BIDU: 'NYSE',
    // 기타 NYSE
    RIVN: 'NYSE', LCID: 'NYSE', PLTR: 'NYSE', UBER: 'NYSE', LYFT: 'NYSE',
  };

  // 시세 조회는 항상 실서버 (openapivts는 해외시세 미지원)
  const tryFetch = async (excd) => kisRequest('GET', '/uapi/overseas-price/v1/quotations/price', {
    trId:   TR_ID.OVERSEAS_PRICE,
    params: { AUTH: '', EXCD: excd, SYMB: symbol },
    paper:  false,
  });

  const priceExcd = PRICE_EXCD[symbol];

  // ① 맵에 있으면 해당 거래소로 1회 조회
  if (priceExcd) {
    const data  = await tryFetch(priceExcd);
    const price = parseFloat(data.output?.last || '0');
    if (!price) throw new Error(`${symbol} 해외 현재가 조회 실패 (응답: ${JSON.stringify(data.output)})`);
    return { price, excd: ORDER_EXCD[symbol] };
  }

  // ② 맵에 없으면 NAS → NYS → AMX 순으로 자동 탐색
  for (const [priceCode, orderCode] of [['NAS', 'NASD'], ['NYS', 'NYSE'], ['AMX', 'AMEX']]) {
    try {
      const data  = await tryFetch(priceCode);
      const price = parseFloat(data.output?.last || '0');
      if (price > 0) {
        console.log(`  ℹ️ [KIS] ${symbol} 거래소 자동 탐지: ${priceCode} → PRICE_EXCD 맵에 추가 권장`);
        return { price, excd: orderCode };
      }
    } catch { /* 다음 거래소 시도 */ }
  }
  throw new Error(`${symbol} 해외 현재가 조회 실패 — NAS/NYS/AMX 전체 응답 없음`);
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

  const { price: currentPrice, excd } = await getOverseasPrice(symbol);
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
      CANO:            cano,
      ACNT_PRDT_CD:    prodCd,
      OVRS_EXCG_CD:    excd,         // NASD / NYSE / AMEX
      PDNO:            symbol,
      ORD_DVSN:        '00',          // 지정가 (해외는 시장가 미지원)
      ORD_QTY:         String(qty),
      OVRS_ORD_UNPR:   currentPrice.toFixed(2),
      CTAC_TLNO:       '',
      MGCO_APTM_ODNO:  '',
      ORD_SVR_DVSN_CD: '0',           // 주문서버구분코드 (필수)
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

  const { price: currentPrice, excd } = await getOverseasPrice(symbol);
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
      CANO:            cano,
      ACNT_PRDT_CD:    prodCd,
      OVRS_EXCG_CD:    excd,
      PDNO:            symbol,
      ORD_DVSN:        '00',
      ORD_QTY:         String(qty),
      OVRS_ORD_UNPR:   currentPrice.toFixed(2),
      CTAC_TLNO:       '',
      MGCO_APTM_ODNO:  '',
      ORD_SVR_DVSN_CD: '0',           // 주문서버구분코드 (필수)
    },
  });

  const ordNo = res.output?.ODNO;
  console.log(`  ✅ [KIS] ${tag} 해외 매도 완료: ${symbol} ${qty}주 주문번호=${ordNo}`);
  return { qty, price: currentPrice, totalUsd: qty * currentPrice, ordNo };
}

// ─── 잔고 조회 ───────────────────────────────────────────────────────

/**
 * 국내주식 잔고 조회 (보유종목·평가손익)
 * TR_ID: TTTC8434R (실전) / VTTC8434R (모의)
 */
export async function getDomesticBalance(paper) {
  const usePaper = paper ?? isKisPaper();
  const { cano, prodCd } = parseAccount(usePaper);
  const data = await kisRequest('GET', '/uapi/domestic-stock/v1/trading/inquire-balance', {
    trId: usePaper ? TR_ID.DOMESTIC_BALANCE_PAPER : TR_ID.DOMESTIC_BALANCE_LIVE,
    params: {
      CANO:                   cano,
      ACNT_PRDT_CD:           prodCd,
      AFHR_FLPR_YN:           'N',
      OFL_YN:                 '',
      INQR_DVSN:              '02',   // 02=종목별
      UNPR_DVSN:              '01',
      FUND_STTL_ICLD_YN:      'N',
      FNCG_AMT_AUTO_RDPT_YN:  'N',
      PRCS_DVSN:              '01',
      CTX_AREA_FK100:         '',
      CTX_AREA_NK100:         '',
    },
    paper: usePaper,
  });

  const holdings = (data.output1 || []).map(h => ({
    symbol:    h.pdno,
    name:      h.prdt_name,
    qty:       parseInt(h.hldg_qty    || '0', 10),
    avg_price: parseFloat(h.pchs_avg_pric || '0'),
    eval_amt:  parseInt(h.evlu_amt    || '0', 10),
    pnl_amt:   parseInt(h.evlu_pfls_amt  || '0', 10),
    pnl_pct:   parseFloat(h.evlu_pfls_rt  || '0'),
  })).filter(h => h.qty > 0);

  const sum = data.output2?.[0] || {};
  return {
    holdings,
    total_eval_amt:     parseInt(sum.tot_evlu_amt       || '0', 10),
    total_purchase_amt: parseInt(sum.pchs_amt_smtl_amt  || '0', 10),
    total_pnl_amt:      parseInt(sum.evlu_pfls_smtl_amt || '0', 10),
    dnca_tot_amt:       parseInt(sum.dnca_tot_amt        || '0', 10),  // 예수금
    paper: usePaper,
  };
}

/**
 * 해외주식 잔고 조회 (미국)
 * TR_ID: TTTS3012R (실전) / VTTS3012R (모의)
 */
export async function getOverseasBalance(paper) {
  const usePaper = paper ?? isKisPaper();
  const { cano, prodCd } = parseAccount(usePaper);
  const data = await kisRequest('GET', '/uapi/overseas-stock/v1/trading/inquire-balance', {
    trId: usePaper ? TR_ID.OVERSEAS_BALANCE_PAPER : TR_ID.OVERSEAS_BALANCE_LIVE,
    params: {
      CANO:            cano,
      ACNT_PRDT_CD:    prodCd,
      OVRS_EXCG_CD:    'NASD',  // 나스닥 기준 (NASD/NYSE/AMEX)
      TR_CRCY_CD:      'USD',
      CTX_AREA_FK200:  '',
      CTX_AREA_NK200:  '',
    },
    paper: usePaper,
  });

  const holdings = (data.output1 || []).map(h => ({
    symbol:     h.ovrs_pdno,
    name:       h.ovrs_item_name,
    qty:        parseFloat(h.ovrs_cblc_qty    || '0'),
    avg_price:  parseFloat(h.pchs_avg_pric    || '0'),
    curr_price: parseFloat(h.now_pric2        || '0'),
    eval_usd:   parseFloat(h.ovrs_stck_evlu_amt  || '0'),
    pnl_usd:    parseFloat(h.frcr_evlu_pfls_amt  || '0'),
    pnl_pct:    parseFloat(h.evlu_pfls_rt         || '0'),
  })).filter(h => h.qty > 0);

  const sum = data.output2 || {};
  return {
    holdings,
    total_eval_usd: parseFloat(sum.tot_evlu_pfls_amt2 || '0'),
    total_pnl_usd:  parseFloat(sum.ovrs_tot_pfls       || '0'),
    paper: usePaper,
  };
}
