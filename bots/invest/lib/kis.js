'use strict';

/**
 * lib/kis.js — 한국투자증권(KIS) Open API 클라이언트
 *
 * - 실전: openapi.koreainvestment.com:9443
 * - 모의투자: openapivts.koreainvestment.com:9443  (기본값)
 * - 토큰: /oauth2/tokenP → /tmp/kis-token.json 캐싱 (24시간 유효)
 * - 드라이런: API 키 없어도 OHLCV/가격 조회 불가 → fetchPrice 모의값 반환
 *
 * 심볼 형식: 6자리 숫자 문자열 ex) '005930' (삼성전자)
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { loadSecrets, isKisPaper, getKisAccount, getKisAppKey, getKisAppSecret } = require('./secrets');

// ─── 해외거래소 코드 맵 (NASDAQ 기본값) ───────────────────────────────
// secrets.kis_overseas_exchange 로 재정의 가능
const DEFAULT_EXCHANGE_MAP = {
  AAPL: 'NAS', TSLA: 'NAS', NVDA: 'NAS', MSFT: 'NAS', AMZN: 'NAS',
  GOOG: 'NAS', GOOGL: 'NAS', META: 'NAS', NFLX: 'NAS', AMD: 'NAS',
  INTC: 'NAS', QCOM: 'NAS', AVGO: 'NAS', ADBE: 'NAS', CSCO: 'NAS',
  // NYSE 종목
  JPM: 'NYS', BAC: 'NYS', GS: 'NYS', MS: 'NYS', WMT: 'NYS',
  JNJ: 'NYS', PG: 'NYS', KO: 'NYS', DIS: 'NYS', IBM: 'NYS',
};

// 실전/모의투자 토큰 캐시 분리 (서로 다른 API 키이므로 토큰도 별개)
function getTokenCachePath() {
  return isKisPaper() ? '/tmp/kis-token-paper.json' : '/tmp/kis-token.json';
}

// ─── 기본 설정 ──────────────────────────────────────────────────────

/** KIS 국내주식 심볼 여부 (6자리 숫자) */
function isKisSymbol(symbol) {
  return /^\d{6}$/.test(symbol);
}

/** KIS 해외주식 심볼 여부 (알파벳 1~5자) */
function isKisOverseasSymbol(symbol) {
  return /^[A-Z]{1,5}$/.test(symbol);
}

/**
 * 해외거래소 코드 반환 (OVRS_EXCG_CD)
 * secrets.kis_overseas_exchange 재정의 가능, 없으면 기본 맵 참조, 없으면 NAS
 */
function getExchangeCode(symbol) {
  const s   = loadSecrets();
  const map = { ...DEFAULT_EXCHANGE_MAP, ...(s.kis_overseas_exchange || {}) };
  return map[symbol] || 'NAS';
}

/** 실전 / 모의투자 호스트 */
function getBaseHost() {
  return isKisPaper()
    ? 'openapivts.koreainvestment.com'
    : 'openapi.koreainvestment.com';
}

/** tr_id 접두어: T=실전, V=모의투자 */
function trPrefix() {
  return isKisPaper() ? 'V' : 'T';
}

// ─── HTTPS 공통 유틸 ────────────────────────────────────────────────

/**
 * KIS HTTPS 요청 공통 유틸
 * @returns {Promise<object>} 파싱된 JSON 응답
 */
function httpsRequest(method, host, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;

    const reqHeaders = {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    };
    if (bodyBuf) reqHeaders['content-length'] = bodyBuf.length;

    // KIS 포트: 실전 9443 / 모의투자(VTS) 29443
    // VTS는 실전 서버 인증서를 공유해 CN 불일치 → rejectUnauthorized: false
    const isPaperHost = host.includes('vts');
    const port = isPaperHost ? 29443 : 9443;

    const req = https.request(
      { hostname: host, port, path: urlPath, method, headers: reqHeaders,
        ...(isPaperHost ? { rejectUnauthorized: false } : {}) },
      (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            // KIS API 에러 응답 처리 (rt_cd !== '0')
            if (json.rt_cd && json.rt_cd !== '0') {
              reject(new Error(`KIS API 오류 [${json.msg_cd}]: ${json.msg1}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new Error(`JSON 파싱 실패: ${raw.slice(0, 200)}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('KIS API 타임아웃')); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/** KIS 표준 헤더 빌드 (모드에 따라 appkey/appsecret 자동 분기) */
function makeHeaders(trId, token) {
  return {
    'authorization':  `Bearer ${token}`,
    'appkey':         getKisAppKey(),
    'appsecret':      getKisAppSecret(),
    'tr_id':          trId,
    'custtype':       'P', // 개인
  };
}

// ─── 토큰 관리 ──────────────────────────────────────────────────────

/**
 * 액세스 토큰 발급 / 캐시 반환
 * 만료 1분 전 자동 갱신
 * @returns {Promise<string>} access_token
 */
async function getAccessToken() {
  const cachePath = getTokenCachePath();
  const mode      = isKisPaper() ? '모의투자' : '실전';

  // 캐시 확인
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const expiresAt = new Date(cached.expires_at).getTime();
    if (Date.now() < expiresAt - 60_000) {
      return cached.access_token;
    }
  } catch {
    // 캐시 없음 — 신규 발급
  }

  const appKey    = getKisAppKey();
  const appSecret = getKisAppSecret();
  if (!appKey || !appSecret) {
    throw new Error(`KIS API 키 미설정 [${mode}] (kis_${isKisPaper() ? 'paper_' : ''}app_key/secret)`);
  }

  const body = {
    grant_type: 'client_credentials',
    appkey:     appKey,
    appsecret:  appSecret,
  };

  const res = await httpsRequest('POST', getBaseHost(), '/oauth2/tokenP', {}, body);

  const token     = res.access_token;
  const expiresIn = res.expires_in || 86400; // 초 단위 (기본 24시간)
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  try {
    fs.writeFileSync(cachePath, JSON.stringify({ access_token: token, expires_at: expiresAt }));
  } catch (e) {
    console.warn(`⚠️ KIS 토큰 캐시 저장 실패: ${e.message}`);
  }

  console.log(`🔑 [KIS:${mode}] 토큰 발급 완료 (만료: ${expiresAt})`);
  return token;
}

// ─── 시세 조회 ──────────────────────────────────────────────────────

/**
 * 현재가 조회
 * @param {string} stockCode  6자리 종목코드
 * @returns {Promise<{price: number, name: string}>}
 */
async function fetchPrice(stockCode) {
  const token = await getAccessToken();
  const headers = makeHeaders('FHKST01010100', token);

  const res = await httpsRequest(
    'GET',
    getBaseHost(),
    `/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${stockCode}`,
    headers,
    null
  );

  const out = res.output;
  return {
    price: parseInt(out.stck_prpr, 10),
    name:  out.prdt_abrv_name || stockCode,
  };
}

/**
 * 일봉 OHLCV 조회 (CCXT 호환 포맷 반환)
 * @param {string} stockCode  6자리 종목코드
 * @param {number} limit      캔들 개수 (기본 150 — MA120 계산을 위해 최소 150 권장)
 * @returns {Promise<Array>}  [[timestamp_ms, open, high, low, close, volume], ...]  오래된 순
 *
 * KIS VTS(모의투자) 제한: 최근 30 영업일만 반환
 * → KIS 부족 시 Yahoo Finance(.KS) 폴백으로 1년치 이력 확보
 */
async function fetchOHLCV(stockCode, limit = 150) {
  // 1차: KIS API 시도 (현재가 정합성 최우선)
  const kisRows = await _fetchOHLCVFromKIS(stockCode);

  if (kisRows.length >= 60) {
    // KIS 데이터가 충분하면 그대로 사용
    return kisRows.slice(-limit);
  }

  // 2차: KIS 부족(VTS 30일 한도) → Yahoo Finance 폴백
  console.log(`  ⚠️ [KIS OHLCV] ${stockCode}: KIS ${kisRows.length}개 부족 → Yahoo Finance 폴백`);
  try {
    const yahooRows = await _fetchOHLCVFromYahoo(stockCode, limit);
    if (yahooRows.length > 0) {
      // Yahoo 이력 + KIS 최근 데이터 병합 (날짜 중복 제거, KIS 우선)
      const kisDateSet = new Set(kisRows.map(r => r[0]));
      const merged = [
        ...yahooRows.filter(r => !kisDateSet.has(r[0])),
        ...kisRows,
      ].sort((a, b) => a[0] - b[0]);
      console.log(`  ✅ [KIS OHLCV] ${stockCode}: Yahoo ${yahooRows.length}개 + KIS ${kisRows.length}개 병합 → ${merged.length}개`);
      return merged.slice(-limit);
    }
  } catch (e) {
    console.warn(`  ⚠️ [KIS OHLCV] Yahoo Finance 폴백 실패: ${e.message}`);
  }

  // 폴백도 실패 → KIS 데이터만 반환 (30개)
  return kisRows;
}

/**
 * KIS inquire-daily-price API 호출 (최대 30 영업일)
 * @param {string} stockCode
 * @returns {Promise<Array>}  [[timestamp_ms, o, h, l, c, v], ...]  오래된 순
 */
async function _fetchOHLCVFromKIS(stockCode) {
  const token   = await getAccessToken();
  const headers = makeHeaders('FHKST01010400', token);
  const fmt     = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const endDate   = new Date();
  const startDate = new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000); // 90일 달력

  // 레이트 리밋(EGW00201) 발생 시 1초 대기 후 1회 재시도
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await httpsRequest(
        'GET',
        getBaseHost(),
        `/uapi/domestic-stock/v1/quotations/inquire-daily-price` +
          `?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${stockCode}` +
          `&FID_PERIOD_DIV_CODE=D&FID_ORG_ADJ_PRC=0` +
          `&FID_INPUT_DATE_1=${fmt(startDate)}&FID_INPUT_DATE_2=${fmt(endDate)}`,
        headers,
        null
      );
      break;
    } catch (e) {
      if (e.message.includes('EGW00201') && attempt === 0) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw e;
    }
  }

  const rows = (res.output || res.output2 || []);
  return rows.reverse().map(r => {
    const d  = r.stck_bsop_date;
    const ts = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00+09:00`).getTime();
    return [ts, parseInt(r.stck_oprc, 10), parseInt(r.stck_hgpr, 10),
                parseInt(r.stck_lwpr, 10), parseInt(r.stck_clpr, 10), parseInt(r.acml_vol, 10)];
  });
}

/**
 * Yahoo Finance 일봉 OHLCV 폴백 (무료, API 키 불필요)
 * 심볼 변환: 6자리 → {code}.KS (KOSPI/KOSDAQ 자동 판별)
 * @param {string} stockCode  ex) '005930'
 * @param {number} limit
 * @returns {Promise<Array>}  [[timestamp_ms, o, h, l, c, v], ...]  오래된 순
 */
function _fetchOHLCVFromYahoo(stockCode, limit = 150) {
  return new Promise((resolve, reject) => {
    const ticker  = `${stockCode}.KS`; // KOSPI/KOSDAQ 공통 suffix
    const range   = limit <= 60 ? '3mo' : limit <= 130 ? '6mo' : '1y';
    const urlPath = `/v8/finance/chart/${ticker}?range=${range}&interval=1d`;

    const req = https.request(
      {
        hostname: 'query1.finance.yahoo.com',
        path:     urlPath,
        method:   'GET',
        headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      },
      (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const json  = JSON.parse(raw);
            const chart = json.chart?.result?.[0];
            if (!chart) { reject(new Error('Yahoo Finance 데이터 없음')); return; }

            const timestamps = chart.timestamp || [];
            const q          = chart.indicators.quote[0];
            const result     = timestamps
              .map((ts, i) => [
                ts * 1000,
                q.open[i]   || 0,
                q.high[i]   || 0,
                q.low[i]    || 0,
                q.close[i]  || 0,
                q.volume[i] || 0,
              ])
              .filter(c => c[4] > 0); // 유효 캔들만

            resolve(result.slice(-limit));
          } catch (e) {
            reject(new Error(`Yahoo Finance 파싱 실패: ${e.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Yahoo Finance 타임아웃')); });
    req.end();
  });
}

// ─── 잔고 조회 ──────────────────────────────────────────────────────

/**
 * 잔고 조회
 * @returns {Promise<{krw: number, holdings: Array<{stockCode, qty, avgPrice}>}>}
 */
async function fetchBalance() {
  const token = await getAccessToken();
  const { cano, acntPrdtCd } = getKisAccount();
  const trId = `${trPrefix()}TTC8434R`;

  let res;
  try {
    res = await httpsRequest(
      'GET',
      getBaseHost(),
      `/uapi/domestic-stock/v1/trading/inquire-balance` +
        `?CANO=${cano}&ACNT_PRDT_CD=${acntPrdtCd}` +
        `&AFHR_FLPR_YN=N&OFL_YN=N&INQR_DVSN=02&UNPR_DVSN=01&FUND_STTL_ICLD_YN=N` +
        `&FNCG_AMT_AUTO_RDPT_YN=N&PRCS_DVSN=00&CTX_AREA_FK100=&CTX_AREA_NK100=`,
      makeHeaders(trId, token),
      null
    );
  } catch (e) {
    // 모의투자 환경에서 계좌-앱키 미연동 시 MCA00124 발생
    // KIS 개발자 포털에서 모의투자 계좌를 앱키에 등록해야 해결됨
    if (isKisPaper()) {
      console.warn(`⚠️ [KIS:모의투자] 잔고 조회 불가 (${e.message}) — 계좌-앱키 연동 확인 필요`);
      return { krw: 0, holdings: [], unavailable: true };
    }
    throw e;
  }

  const krw = parseInt(res.output2?.[0]?.dnca_tot_amt || '0', 10);
  const holdings = (res.output1 || []).map(h => ({
    stockCode: h.pdno,
    qty:       parseInt(h.hldg_qty, 10),
    avgPrice:  parseInt(h.pchs_avg_pric, 10),
  })).filter(h => h.qty > 0);

  return { krw, holdings };
}

// ─── 주문 ───────────────────────────────────────────────────────────

/**
 * POST 주문 hashkey 발급
 * KIS API POST 주문 시 필수 헤더 — 동일 request body로 해시 발급
 * @param {object} body  주문 body (JSON 직렬화 가능)
 * @returns {Promise<string>} HASH 문자열
 */
async function fetchHashkey(body) {
  const res = await httpsRequest('POST', getBaseHost(), '/uapi/hashkey', {
    'appkey':    getKisAppKey(),
    'appsecret': getKisAppSecret(),
  }, body);
  return res.HASH;
}

/**
 * 시장가 매수
 * @param {string} stockCode   6자리 종목코드
 * @param {number} amountKrw   매수 금액 (원)
 * @param {boolean} dryRun
 * @returns {Promise<{orderId, qty, price, totalKrw, dryRun}>}
 */
async function marketBuy(stockCode, amountKrw, dryRun = true) {
  // 현재가로 수량 계산 (드라이런이어도 가격 조회 시도)
  let price = 0;
  try {
    const info = await fetchPrice(stockCode);
    price = info.price;
  } catch {
    price = 0;
  }

  const qty = price > 0 ? Math.floor(amountKrw / price) : 0;

  if (qty < 1) throw new Error(`매수 수량 0 — 금액 부족 (${amountKrw.toLocaleString()}원, 현재가 ${price.toLocaleString()}원)`);

  if (dryRun) {
    const result = {
      orderId:  `DRY-KIS-BUY-${Date.now()}`,
      qty,
      price,
      totalKrw: qty * price,
      dryRun:   true,
    };
    console.log(`🧪 [드라이런 매수] ${stockCode} ${qty}주 @ ${price?.toLocaleString()}원`);
    return result;
  }

  const token = await getAccessToken();
  const { cano, acntPrdtCd } = getKisAccount();
  const trId = `${trPrefix()}TTC0012U`;

  const body = {
    CANO:            cano,
    ACNT_PRDT_CD:   acntPrdtCd,
    PDNO:            stockCode,
    ORD_DVSN:        '01', // 시장가
    ORD_QTY:         String(qty),
    ORD_UNPR:        '0',  // 시장가는 0
  };

  const hashkey = await fetchHashkey(body);
  const res = await httpsRequest('POST', getBaseHost(), '/uapi/domestic-stock/v1/trading/order-cash', { ...makeHeaders(trId, token), hashkey }, body);
  const orderId = res.output?.ORNO || `KIS-BUY-${Date.now()}`;

  console.log(`✅ [KIS 매수] ${stockCode} ${qty}주 주문번호: ${orderId}`);
  return { orderId, qty, price, totalKrw: qty * price, dryRun: false };
}

/**
 * 시장가 매도
 * @param {string} stockCode  6자리 종목코드
 * @param {number} quantity   매도 수량 (주)
 * @param {boolean} dryRun
 * @returns {Promise<{orderId, qty, price, totalKrw, dryRun}>}
 */
async function marketSell(stockCode, quantity, dryRun = true) {
  let price = 0;
  try {
    const info = await fetchPrice(stockCode);
    price = info.price;
  } catch {
    price = 0;
  }

  if (dryRun) {
    const result = {
      orderId:  `DRY-KIS-SELL-${Date.now()}`,
      qty:      quantity,
      price,
      totalKrw: quantity * price,
      dryRun:   true,
    };
    console.log(`🧪 [드라이런 매도] ${stockCode} ${quantity}주 @ ${price?.toLocaleString()}원`);
    return result;
  }

  const token = await getAccessToken();
  const { cano, acntPrdtCd } = getKisAccount();
  const trId = `${trPrefix()}TTC0011U`;

  const body = {
    CANO:           cano,
    ACNT_PRDT_CD:  acntPrdtCd,
    PDNO:           stockCode,
    ORD_DVSN:       '01', // 시장가
    ORD_QTY:        String(quantity),
    ORD_UNPR:       '0',
  };

  const hashkey = await fetchHashkey(body);
  const res = await httpsRequest('POST', getBaseHost(), '/uapi/domestic-stock/v1/trading/order-cash', { ...makeHeaders(trId, token), hashkey }, body);
  const orderId = res.output?.ORNO || `KIS-SELL-${Date.now()}`;

  console.log(`✅ [KIS 매도] ${stockCode} ${quantity}주 주문번호: ${orderId}`);
  return { orderId, qty: quantity, price, totalKrw: quantity * price, dryRun: false };
}

// ─── 해외주식 시세 ────────────────────────────────────────────────────

/**
 * 해외주식 현재가 조회 (KIS HHDFS00000300)
 * @param {string} symbol  예) 'AAPL', 'TSLA'
 * @returns {Promise<{price: number, name: string}>}
 */
async function fetchPriceOverseas(symbol) {
  const token   = await getAccessToken();
  const excd    = getExchangeCode(symbol);
  const headers = makeHeaders('HHDFS00000300', token);

  const res = await httpsRequest(
    'GET',
    getBaseHost(),
    `/uapi/overseas-price/v1/quotations/price?AUTH=&EXCD=${excd}&SYMB=${symbol}`,
    headers,
    null
  );

  const out = res.output;
  return {
    price: parseFloat(out.last || out.stck_prpr || '0'),
    name:  out.rsym || symbol,
  };
}

/**
 * 해외주식 일봉 OHLCV (Yahoo Finance 직접 — 심볼 변환 없음, AAPL→AAPL)
 * KIS 해외 일봉 API는 100건 제한이어서 Yahoo Finance 우선 사용
 * @param {string} symbol  예) 'AAPL'
 * @param {number} limit
 * @returns {Promise<Array>}  [[timestamp_ms, o, h, l, c, v], ...]  오래된 순
 */
function fetchOHLCVOverseas(symbol, limit = 150) {
  return new Promise((resolve, reject) => {
    const range   = limit <= 60 ? '3mo' : limit <= 130 ? '6mo' : '1y';
    const urlPath = `/v8/finance/chart/${symbol}?range=${range}&interval=1d`;

    const req = https.request(
      {
        hostname: 'query1.finance.yahoo.com',
        path:     urlPath,
        method:   'GET',
        headers:  { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      },
      (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try {
            const json  = JSON.parse(raw);
            const chart = json.chart?.result?.[0];
            if (!chart) { reject(new Error(`Yahoo Finance 데이터 없음: ${symbol}`)); return; }

            const timestamps = chart.timestamp || [];
            const q          = chart.indicators.quote[0];
            const result     = timestamps
              .map((ts, i) => [
                ts * 1000,
                q.open[i]   || 0,
                q.high[i]   || 0,
                q.low[i]    || 0,
                q.close[i]  || 0,
                q.volume[i] || 0,
              ])
              .filter(c => c[4] > 0);

            resolve(result.slice(-limit));
          } catch (e) {
            reject(new Error(`Yahoo Finance 파싱 실패 (${symbol}): ${e.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Yahoo Finance 타임아웃')); });
    req.end();
  });
}

// ─── 해외주식 주문 ────────────────────────────────────────────────────

/**
 * 해외주식 지정가 매수 (현재가 지정 → 사실상 시장가)
 * @param {string}  symbol     예) 'AAPL'
 * @param {number}  amountUsd  매수 금액 (USD)
 * @param {boolean} dryRun
 * @returns {Promise<{orderId, qty, price, totalUsd, dryRun}>}
 */
async function marketBuyOverseas(symbol, amountUsd, dryRun = true) {
  let price = 0;
  try {
    const info = await fetchPriceOverseas(symbol);
    price = info.price;
  } catch {
    price = 0;
  }

  const qty = price > 0 ? Math.floor(amountUsd / price) : 0;
  if (qty < 1) throw new Error(`해외주식 매수 수량 0 — 금액 부족 ($${amountUsd}, 현재가 $${price})`);

  if (dryRun) {
    console.log(`🧪 [드라이런 해외매수] ${symbol} ${qty}주 @ $${price}`);
    return { orderId: `DRY-KIS-OVR-BUY-${Date.now()}`, qty, price, totalUsd: qty * price, dryRun: true };
  }

  const token               = await getAccessToken();
  const { cano, acntPrdtCd } = getKisAccount();
  const excd                = getExchangeCode(symbol);
  const trId                = `${trPrefix()}TTT1002U`; // VTTT1002U(모의) / TTTT1002U(실전)

  const body = {
    CANO:          cano,
    ACNT_PRDT_CD:  acntPrdtCd,
    OVRS_EXCG_CD:  excd,
    PDNO:          symbol,
    ORD_DVSN:      '00',                      // 지정가 (KIS 해외는 지정가로 현재가 입력)
    ORD_QTY:       String(qty),
    OVRS_ORD_UNPR: price.toFixed(2),           // 현재가 지정 → 즉시 체결
    ORD_SVR_DVSN:  '0',
  };

  const hashkey = await fetchHashkey(body);
  const res = await httpsRequest('POST', getBaseHost(), '/uapi/overseas-stock/v1/trading/order', { ...makeHeaders(trId, token), hashkey }, body);
  const orderId = res.output?.ODNO || `KIS-OVR-BUY-${Date.now()}`;

  console.log(`✅ [KIS 해외매수] ${symbol} ${qty}주 주문번호: ${orderId}`);
  return { orderId, qty, price, totalUsd: qty * price, dryRun: false };
}

/**
 * 해외주식 지정가 매도 (현재가 지정 → 사실상 시장가)
 * @param {string}  symbol    예) 'AAPL'
 * @param {number}  quantity  매도 수량 (주)
 * @param {boolean} dryRun
 * @returns {Promise<{orderId, qty, price, totalUsd, dryRun}>}
 */
async function marketSellOverseas(symbol, quantity, dryRun = true) {
  let price = 0;
  try {
    const info = await fetchPriceOverseas(symbol);
    price = info.price;
  } catch {
    price = 0;
  }

  if (dryRun) {
    console.log(`🧪 [드라이런 해외매도] ${symbol} ${quantity}주 @ $${price}`);
    return { orderId: `DRY-KIS-OVR-SELL-${Date.now()}`, qty: quantity, price, totalUsd: quantity * price, dryRun: true };
  }

  const token               = await getAccessToken();
  const { cano, acntPrdtCd } = getKisAccount();
  const excd                = getExchangeCode(symbol);
  const trId                = `${trPrefix()}TTT1006S`; // VTTT1006S(모의) / TTTT1006S(실전)

  const body = {
    CANO:          cano,
    ACNT_PRDT_CD:  acntPrdtCd,
    OVRS_EXCG_CD:  excd,
    PDNO:          symbol,
    ORD_DVSN:      '00',
    ORD_QTY:       String(quantity),
    OVRS_ORD_UNPR: price.toFixed(2),
    ORD_SVR_DVSN:  '0',
  };

  const hashkey = await fetchHashkey(body);
  const res = await httpsRequest('POST', getBaseHost(), '/uapi/overseas-stock/v1/trading/order', { ...makeHeaders(trId, token), hashkey }, body);
  const orderId = res.output?.ODNO || `KIS-OVR-SELL-${Date.now()}`;

  console.log(`✅ [KIS 해외매도] ${symbol} ${quantity}주 주문번호: ${orderId}`);
  return { orderId, qty: quantity, price, totalUsd: quantity * price, dryRun: false };
}

module.exports = {
  isKisSymbol,
  isKisOverseasSymbol,
  getExchangeCode,
  getBaseHost,
  getAccessToken,
  fetchPrice,
  fetchPriceOverseas,
  fetchOHLCV,
  fetchOHLCVOverseas,
  fetchBalance,
  marketBuy,
  marketSell,
  marketBuyOverseas,
  marketSellOverseas,
};
