// @ts-nocheck
/**
 * shared/kis-client.js — KIS 한국투자증권 API 클라이언트
 *
 * 역할: 국내주식(KOSPI/KOSDAQ) + 해외주식(미국) 시장가 주문
 * brokerAccountMode:
 *   - mock: config.yaml kis_mode=paper
 *   - real: config.yaml kis_mode=live
 * executionMode는 별도이며, 실제 주문 차단 여부는 PAPER_MODE / trading_mode가 결정한다.
 *
 * API 문서: https://apiportal.koreainvestment.com/
 */

import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadSecrets, isKisPaper } from './secrets.ts';

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
  DOMESTIC_DAILY_ITEM_CHART: 'FHKST03010100',
  OVERSEAS_PRICE:          'HHDFS76200200', // 해외주식 현재체결가
  OVERSEAS_DAILY_PRICE:     'HHDFS76240000',
  // ── 잔고 조회 ──
  DOMESTIC_BALANCE_PAPER:  'VTTC8434R',
  DOMESTIC_BALANCE_LIVE:   'TTTC8434R',
  OVERSEAS_BALANCE_PAPER:  'VTTS3012R',
  OVERSEAS_BALANCE_LIVE:   'TTTS3012R',
  OVERSEAS_PSAMOUNT_DAY:   'TTTS3007R',
  OVERSEAS_PSAMOUNT_NIGHT: 'JTTT3007R',
  DOMESTIC_DAILY_CCLD_PAPER: 'VTTC0081R',
  DOMESTIC_DAILY_CCLD_LIVE: 'TTTC0081R',
  OVERSEAS_CCLD_PAPER: 'VTTS3035R',
  OVERSEAS_CCLD_LIVE: 'TTTS3035R',
};

const KIS_OVERSEAS_PRICE_EXCD = {
  AAPL: 'NAS', MSFT: 'NAS', AMZN: 'NAS', GOOGL: 'NAS', META: 'NAS',
  NVDA: 'NAS', TSLA: 'NAS', NFLX: 'NAS', INTC: 'NAS', AMD:  'NAS',
  QCOM: 'NAS', AVGO: 'NAS', ADBE: 'NAS', CSCO: 'NAS', PYPL: 'NAS',
  COIN: 'NAS', MSTR: 'NAS', JBLU: 'NAS', NBIS: 'NAS',
  JPM: 'NYS', BAC: 'NYS', WMT: 'NYS', JNJ: 'NYS', BRK: 'NYS',
  XOM: 'NYS', CVX: 'NYS', UNH: 'NYS', HD:  'NYS',
  NIO:  'NYS', XPEV: 'NYS', LI:  'NYS', BABA: 'NYS', PDD: 'NYS',
  JD:   'NYS', BIDU: 'NYS',
  RIVN: 'NYS', LCID: 'NYS', PLTR: 'NYS', UBER: 'NYS', LYFT: 'NYS',
};

const KIS_OVERSEAS_ORDER_EXCD = {
  AAPL: 'NASD', MSFT: 'NASD', AMZN: 'NASD', GOOGL: 'NASD', META: 'NASD',
  NVDA: 'NASD', TSLA: 'NASD', NFLX: 'NASD', INTC: 'NASD', AMD:  'NASD',
  QCOM: 'NASD', AVGO: 'NASD', ADBE: 'NASD', CSCO: 'NASD', PYPL: 'NASD',
  COIN: 'NASD', MSTR: 'NASD', JBLU: 'NASD', NBIS: 'NASD',
  JPM: 'NYSE', BAC: 'NYSE', WMT: 'NYSE', JNJ: 'NYSE', BRK: 'NYSE',
  XOM: 'NYSE', CVX: 'NYSE', UNH: 'NYSE', HD:  'NYSE',
  NIO:  'NYSE', XPEV: 'NYSE', LI:  'NYSE', BABA: 'NYSE', PDD: 'NYSE',
  JD:   'NYSE', BIDU: 'NYSE',
  RIVN: 'NYSE', LCID: 'NYSE', PLTR: 'NYSE', UBER: 'NYSE', LYFT: 'NYSE',
};

const KIS_MIN_INTERVAL_MS = 380;
const KIS_ORDER_MIN_INTERVAL_MS = 980;
const KIS_RATE_LIMIT_RETRY_MS = 1100;
const KIS_RATE_LIMIT_MAX_RETRIES = 2;
const KIS_DEBUG_ENABLED = process.env.KIS_DEBUG === '1';
export const KIS_DOMESTIC_BUY_SLIPPAGE_BUFFER = 1.01;
const KIS_MCP_ENABLED_DEFAULT = String(process.env.KIS_USE_MCP ?? 'true').toLowerCase() !== 'false';
const KIS_MCP_BRIDGE_MODE = process.env.KIS_MCP_BRIDGE === '1';
const KIS_MCP_TIMEOUT_MS = Math.max(4_000, Number(process.env.KIS_MCP_TIMEOUT_MS || 20_000));
const KIS_MCP_MUTATING_ACTIONS = new Set([
  'domestic_buy',
  'domestic_sell',
  'overseas_buy',
  'overseas_sell',
]);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KIS_MCP_SERVER_PATH = process.env.KIS_MCP_SERVER_PATH || path.resolve(__dirname, '../scripts/kis-market-mcp-server.py');
const execFileAsync = promisify(execFile);

const _requestState = {
  paper: {
    quote: { nextAt: 0, tail: Promise.resolve() },
    order: { nextAt: 0, tail: Promise.resolve() },
  },
  live: {
    quote: { nextAt: 0, tail: Promise.resolve() },
    order: { nextAt: 0, tail: Promise.resolve() },
  },
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveKisLane(endpoint = '', method = 'GET') {
  if (String(method).toUpperCase() === 'POST' && String(endpoint).includes('/trading/')) {
    return 'order';
  }
  return 'quote';
}

async function scheduleKisSlot(paper, lane = 'quote') {
  const key = paper ? 'paper' : 'live';
  const state = _requestState[key][lane] || _requestState[key].quote;
  const minInterval = lane === 'order' ? KIS_ORDER_MIN_INTERVAL_MS : KIS_MIN_INTERVAL_MS;
  const run = async () => {
    const waitMs = Math.max(0, state.nextAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    state.nextAt = Date.now() + minInterval;
  };
  const scheduled = state.tail.then(run, run);
  state.tail = scheduled.catch(() => {});
  return scheduled;
}

function isKisRateLimitMessage(message = '') {
  const text = String(message || '');
  return text.includes('초당 거래건수를 초과') || text.toLowerCase().includes('rate limit');
}

// ─── 토큰 관리 ─────────────────────────────────────────────────────

/** 메모리 캐시: { paper: { token, expires } } */
const _tokenCache = {};
const _tokenInflight = {};
const KIS_TOKEN_LOCK_STALE_MS = 30_000;
const KIS_TOKEN_LOCK_WAIT_MS = 35_000;
const KIS_TOKEN_LOCK_POLL_MS = 120;

function tokenCachePath(paper) {
  return path.join(os.tmpdir(), paper ? 'kis-token-paper.json' : 'kis-token-live.json');
}

function tokenLockPath(paper) {
  return path.join(os.tmpdir(), paper ? 'kis-token-paper.lock' : 'kis-token-live.lock');
}

function writeSecureJson(filePath, payload) {
  const serialized = JSON.stringify(payload);
  fs.writeFileSync(filePath, serialized, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // macOS / tmp 환경에선 mode 지정만으로 충분한 경우가 많다.
  }
}

function truncateKisMessage(value, maxLength = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function logKisDebug(label, payload = null) {
  if (!KIS_DEBUG_ENABLED) return;
  if (payload == null) {
    console.warn(`[KIS_DEBUG] ${label}`);
    return;
  }
  console.warn(`[KIS_DEBUG] ${label}: ${truncateKisMessage(payload, 600)}`);
}

function parseKisErrorBody(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';

  try {
    const data = JSON.parse(text);
    const code = truncateKisMessage(data?.msg_cd || data?.rt_cd || '');
    const message = truncateKisMessage(data?.msg1 || data?.message || '');
    if (code && message) return `[${code}] ${message}`;
    if (message) return message;
    if (code) return `[${code}]`;
  } catch {
    // plain text fallback below
  }

  return truncateKisMessage(text);
}

function shouldUseKisMcp() {
  return KIS_MCP_ENABLED_DEFAULT && !KIS_MCP_BRIDGE_MODE;
}

function resolveUsePaper(paper) {
  return paper ?? isKisPaper();
}

function parseJsonFromMixedStdout(stdout = '') {
  const text = String(stdout || '').trim();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // fallback to line scan
    }
  }
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // keep scanning
    }
  }
  return null;
}

async function runKisMcpBridge(action, payload = {}) {
  if (!shouldUseKisMcp()) return null;
  const normalizedAction = String(action || '').trim().toLowerCase();
  const isMutatingAction = KIS_MCP_MUTATING_ACTIONS.has(normalizedAction);
  try {
    const { stdout } = await execFileAsync(
      'python3',
      [
        KIS_MCP_SERVER_PATH,
        '--bridge-action',
        String(action || ''),
        '--payload-json',
        JSON.stringify(payload || {}),
        '--json',
      ],
      {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          PROJECT_ROOT: process.env.PROJECT_ROOT || path.resolve(__dirname, '../../..'),
          REPO_ROOT: process.env.REPO_ROOT || path.resolve(__dirname, '../../..'),
          USE_HUB_SECRETS: process.env.USE_HUB_SECRETS || 'true',
        },
        timeout: KIS_MCP_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const parsed = parseJsonFromMixedStdout(stdout);
    if (!parsed || parsed.status !== 'ok') {
      const bridgeActionError = /** @type {any} */ (new Error(
        parsed?.message || `KIS MCP bridge failed: ${action}`,
      ));
      bridgeActionError.code = parsed?.status === 'error'
        ? 'kis_mcp_action_rejected'
        : 'kis_mcp_bridge_invalid_response';
      bridgeActionError.meta = {
        action: normalizedAction || null,
        parsedStatus: parsed?.status || null,
      };
      throw bridgeActionError;
    }
    return parsed;
  } catch (error) {
    const parsedError = parseJsonFromMixedStdout(error?.stdout || '');
    const parsedMessage = parsedError?.status === 'error'
      ? truncateKisMessage(parsedError.message || '')
      : '';
    const actionRejected = String(error?.code || '').trim().toLowerCase() === 'kis_mcp_action_rejected'
      || parsedError?.status === 'error';
    const rawMessage = parsedMessage || error?.message || error;
    const message = actionRejected
      ? `KIS 주문 거절 (${action}): ${rawMessage}`
      : `KIS MCP bridge failed (${action}): ${rawMessage}`;
    if (isMutatingAction) {
      const failClosed = /** @type {any} */ (new Error(message));
      failClosed.code = actionRejected ? 'kis_order_rejected' : 'kis_mcp_mutating_bridge_failed';
      failClosed.meta = {
        action: normalizedAction || null,
        failClosed: !actionRejected,
        actionRejected,
        parsedStatus: parsedError?.status || null,
        ...(error?.meta && typeof error.meta === 'object' ? error.meta : {}),
      };
      throw failClosed;
    }
    console.warn(`  ⚠️ [KIS MCP] bridge 실패 (${action}) — direct fallback: ${error?.message || error}`);
    return null;
  }
}

function parseNumeric(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value).replace(/,/g, '').trim();
  if (!text) return 0;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : 0;
}

function pickFirstNumber(row, keys = []) {
  for (const key of keys) {
    if (row?.[key] == null || row?.[key] === '') continue;
    const numeric = parseNumeric(row[key]);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function pickFirstString(row, keys = []) {
  for (const key of keys) {
    const value = row?.[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function normalizeOverseasPsamount(output = {}) {
  const row = output && typeof output === 'object' ? output : {};
  const orderableCashUsd = pickFirstNumber(row, [
    'ovrs_ord_psbl_amt',
    'frcr_ord_psbl_amt1',
    'ord_psbl_frcr_amt',
    'echm_af_ord_psbl_amt',
    'sll_ruse_psbl_amt',
  ]);
  const foreignCashUsd = pickFirstNumber(row, [
    'ord_psbl_frcr_amt',
    'frcr_ord_psbl_amt1',
    'ovrs_ord_psbl_amt',
  ]);
  return {
    orderable_cash_usd: orderableCashUsd,
    available_cash_usd: Math.max(orderableCashUsd, foreignCashUsd),
    cash_usd: foreignCashUsd,
    max_orderable_qty: pickFirstNumber(row, [
      'max_ord_psbl_qty',
      'ovrs_max_ord_psbl_qty',
      'ord_psbl_qty',
      'echm_af_ord_psbl_qty',
    ]),
    exchange_rate: pickFirstNumber(row, ['exrt']),
    currency: pickFirstString(row, ['tr_crcy_cd']) || 'USD',
    raw: row,
  };
}

function normalizeOrderNo(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const digits = text.replace(/\D/g, '');
  const normalized = digits.replace(/^0+/, '');
  return normalized || digits || text;
}

function formatYmd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function resolveKisSideCode(side = '') {
  const normalized = String(side || '').toUpperCase();
  if (normalized === 'BUY' || normalized === '02') return { domestic: '02', overseas: '02' };
  if (normalized === 'SELL' || normalized === '01') return { domestic: '01', overseas: '01' };
  return { domestic: '00', overseas: '00' };
}

function readCachedToken(paper) {
  const cacheKey = paper ? 'paper' : 'live';

  if (_tokenCache[cacheKey] && Date.now() < _tokenCache[cacheKey].expires - 60_000) {
    return _tokenCache[cacheKey].token;
  }

  try {
    const raw = fs.readFileSync(tokenCachePath(paper), 'utf8');
    const cached = JSON.parse(raw);
    if (new Date(cached.expires_at) > new Date(Date.now() + 60_000)) {
      _tokenCache[cacheKey] = {
        token: cached.access_token,
        expires: new Date(cached.expires_at).getTime(),
      };
      return cached.access_token;
    }
  } catch {
    // 캐시 없음 또는 만료
  }

  return null;
}

function tryAcquireTokenLock(paper) {
  const lockPath = tokenLockPath(paper);
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > KIS_TOKEN_LOCK_STALE_MS) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      fs.mkdirSync(lockPath, { mode: 0o700 });
      return true;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return tryAcquireTokenLock(paper);
    throw error;
  }

  return false;
}

function releaseTokenLock(paper) {
  fs.rmSync(tokenLockPath(paper), { recursive: true, force: true });
}

async function issueTokenWithProcessLock(paper, issueFn) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < KIS_TOKEN_LOCK_WAIT_MS) {
    const cached = readCachedToken(paper);
    if (cached) return cached;

    if (tryAcquireTokenLock(paper)) {
      try {
        const afterLockCached = readCachedToken(paper);
        if (afterLockCached) return afterLockCached;
        return await issueFn();
      } finally {
        releaseTokenLock(paper);
      }
    }

    await sleep(KIS_TOKEN_LOCK_POLL_MS);
  }

  throw new Error(`KIS ${paper ? '모의' : '실전'} 토큰 발급 lock 대기 초과`);
}

async function getToken(paper) {
  const cacheKey = paper ? 'paper' : 'live';

  const cachedToken = readCachedToken(paper);
  if (cachedToken) return cachedToken;

  if (_tokenInflight[cacheKey]) return _tokenInflight[cacheKey];

  const issue = async () => {
    // 신규 발급
    const s   = loadSecrets();
    const key = paper
      ? (process.env.KIS_PAPER_APP_KEY || s.kis_paper_app_key)
      : (process.env.KIS_APP_KEY || s.kis_app_key);
    const sec = paper
      ? (process.env.KIS_PAPER_APP_SECRET || s.kis_paper_app_secret)
      : (process.env.KIS_APP_SECRET || s.kis_app_secret);

    if (!key || key.length < 5) throw new Error(`KIS ${paper ? '모의' : '실전'} appkey 미설정 (Hub secrets)`);

    const url = (paper ? BASE_URL_PAPER : BASE_URL_LIVE) + '/oauth2/tokenP';
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body:    JSON.stringify({ grant_type: 'client_credentials', appkey: key, appsecret: sec }),
    });

    if (!res.ok) {
      const text = await res.text();
      const reason = parseKisErrorBody(text);
      logKisDebug(`token_http_${res.status}`, text);
      throw new Error(`KIS 토큰 발급 실패: HTTP ${res.status}${reason ? ` ${reason}` : ''}`);
    }

    const data      = await res.json();
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

    writeSecureJson(tokenCachePath(paper), {
      access_token: data.access_token,
      expires_at:   expiresAt,
    });

    _tokenCache[cacheKey] = {
      token:   data.access_token,
      expires: Date.now() + data.expires_in * 1000,
    };

    console.log(`  🔑 [KIS] 토큰 발급 (${paper ? '모의' : '실전'}, 만료: ${expiresAt})`);
    return data.access_token;
  };

  const inflight = issueTokenWithProcessLock(paper, issue).finally(() => {
    if (_tokenInflight[cacheKey] === inflight) delete _tokenInflight[cacheKey];
  });
  _tokenInflight[cacheKey] = inflight;
  return inflight;
}

// ─── 공통 API 요청 ──────────────────────────────────────────────────

/**
 * @param {string} method
 * @param {string} endpoint
 * @param {any} [options]
 * @param {number} [attempt]
 * @returns {Promise<any>}
 */
async function kisRequest(method, endpoint, { trId, params, body, paper } = {}, attempt = 0) {
  const s     = loadSecrets();
  const key   = paper ? s.kis_paper_app_key    : s.kis_app_key;
  const sec   = paper ? s.kis_paper_app_secret : s.kis_app_secret;
  const token = await getToken(paper);
  const base  = paper ? BASE_URL_PAPER : BASE_URL_LIVE;

  let url = base + endpoint;
  if (params) url += '?' + new URLSearchParams(params).toString();

  const lane = resolveKisLane(endpoint, method);
  await scheduleKisSlot(paper, lane);

  try {
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

    const raw = await res.text();
    if (!raw || !raw.trim()) {
      throw new Error(`KIS 빈 응답 (${res.status})`);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      logKisDebug(`json_parse_${res.status}`, raw);
      throw new Error(`KIS JSON 파싱 실패 (${res.status})`);
    }

    if (data.rt_cd !== '0') {
      const code = truncateKisMessage(data.msg_cd || data.rt_cd || '');
      const message = truncateKisMessage(data.msg1 || data.message || '');
      logKisDebug(`api_error_${res.status}`, raw);
      throw new Error(`KIS API 오류${code ? ` [${code}]` : ''}${message ? `: ${message}` : ''}`);
    }

    return data;
  } catch (error) {
    if (attempt < KIS_RATE_LIMIT_MAX_RETRIES && isKisRateLimitMessage(error?.message)) {
      const retryIn = KIS_RATE_LIMIT_RETRY_MS * (attempt + 1);
      console.warn(`  ⚠️ [KIS] rate limit 감지 — ${retryIn}ms 후 재시도 (${attempt + 1}/${KIS_RATE_LIMIT_MAX_RETRIES})`);
      await sleep(retryIn);
      return kisRequest(method, endpoint, { trId, params, body, paper }, attempt + 1);
    }
    throw error;
  }
}

// ─── 현재가 조회 ────────────────────────────────────────────────────

/** 국내주식 현재가 (원) */
export async function getDomesticPrice(symbol, paper) {
  const snapshot = await getDomesticQuoteSnapshot(symbol, paper);
  return snapshot.price;
}

export async function getDomesticQuoteSnapshot(symbol, paper) {
  const usePaper = resolveUsePaper(paper);
  const mcp = await runKisMcpBridge('domestic_quote', { symbol, paper: usePaper });
  if (mcp?.quote && parseNumeric(mcp.quote.price) > 0) {
    return mcp.quote;
  }
  const data  = await kisRequest('GET', '/uapi/domestic-stock/v1/quotations/inquire-price', {
    trId:   TR_ID.DOMESTIC_PRICE,
    params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: symbol },
    paper: usePaper,
  });
  const output = data.output || {};
  const price = parseInt(output.stck_prpr || '0', 10);
  const volume = parseInt(output.acml_vol || '0', 10);
  if (!price) {
    const marketName = output.rprs_mrkt_kor_name || '시장정보없음';
    const statusCode = output.iscd_stat_cls_code || 'unknown';
    const tempStop = output.temp_stop_yn === 'Y' ? '매매정지' : '정지표시없음';
    const hasZeroSnapshot = [
      output.stck_prpr,
      output.stck_oprc,
      output.stck_hgpr,
      output.stck_lwpr,
      output.acml_vol,
    ].every((value) => String(value || '0') === '0');

    const reason = hasZeroSnapshot
      ? 'KIS가 현재 거래 가능한 종목으로 가격을 반환하지 않았습니다. 종목코드 오류, 비상장/거래정지, 권리락/특수종목 코드 가능성을 확인하세요.'
      : 'KIS 현재가 응답이 비정상입니다.';

    throw new Error(
      `${symbol} 현재가 0원 응답 — ${reason} `
      + `(시장=${marketName}, 상태=${statusCode}, ${tempStop}, 거래량=${volume}) `
      + `(응답: ${JSON.stringify(output)})`,
    );
  }
  return {
    symbol,
    price,
    volume,
    marketName: output.rprs_mrkt_kor_name || '시장정보없음',
    statusCode: output.iscd_stat_cls_code || 'unknown',
    tempStop: output.temp_stop_yn === 'Y',
    open: parseInt(output.stck_oprc || '0', 10),
    high: parseInt(output.stck_hgpr || '0', 10),
    low: parseInt(output.stck_lwpr || '0', 10),
  };
}

/** 해외주식 현재가 (USD)
 *  - 가격조회: NAS/NYS (HHDFS76200200 API 요구)
 *  - 주문 EXCD: NASD/NYSE (order API 요구)
 */
export async function getOverseasPrice(symbol) {
  const snapshot = await getOverseasQuoteSnapshot(symbol);
  return { price: snapshot.price, excd: snapshot.excd };
}

export async function getOverseasQuoteSnapshot(symbol) {
  const mcp = await runKisMcpBridge('overseas_quote', { symbol: String(symbol || '').toUpperCase(), paper: false });
  if (mcp?.quote && parseNumeric(mcp.quote.price) > 0) {
    return mcp.quote;
  }
  // 시세 조회는 항상 실서버 (openapivts는 해외시세 미지원)
  const tryFetch = async (excd) => kisRequest('GET', '/uapi/overseas-price/v1/quotations/price', {
    trId:   TR_ID.OVERSEAS_PRICE,
    params: { AUTH: '', EXCD: excd, SYMB: symbol },
    paper:  false,
  });

  const priceExcd = KIS_OVERSEAS_PRICE_EXCD[symbol];

  // ① 맵에 있으면 해당 거래소로 1회 조회
  if (priceExcd) {
    const data  = await tryFetch(priceExcd);
    const price = parseFloat(data.output?.last || '0');
    if (!price) throw new Error(`${symbol} 해외 현재가 조회 실패 (응답: ${JSON.stringify(data.output)})`);
    return {
      symbol,
      price,
      excd: KIS_OVERSEAS_ORDER_EXCD[symbol],
      priceExcd,
      open: parseFloat(data.output?.open || '0'),
      high: parseFloat(data.output?.high || '0'),
      low: parseFloat(data.output?.low || '0'),
      changePct: parseFloat(data.output?.rate || data.output?.prdy_vrss_rt || '0'),
    };
  }

  // ② 맵에 없으면 NAS → NYS → AMX 순으로 자동 탐색
  for (const [priceCode, orderCode] of [['NAS', 'NASD'], ['NYS', 'NYSE'], ['AMX', 'AMEX']]) {
    try {
      const data  = await tryFetch(priceCode);
      const price = parseFloat(data.output?.last || '0');
      if (price > 0) {
        console.log(`  ℹ️ [KIS] ${symbol} 거래소 자동 탐지: ${priceCode} → PRICE_EXCD 맵에 추가 권장`);
        return {
          symbol,
          price,
          excd: orderCode,
          priceExcd: priceCode,
          open: parseFloat(data.output?.open || '0'),
          high: parseFloat(data.output?.high || '0'),
          low: parseFloat(data.output?.low || '0'),
          changePct: parseFloat(data.output?.rate || data.output?.prdy_vrss_rt || '0'),
        };
      }
    } catch { /* 다음 거래소 시도 */ }
  }
  throw new Error(`${symbol} 해외 현재가 조회 실패 — NAS/NYS/AMX 전체 응답 없음`);
}

export async function getOverseasQuote(symbol) {
  return getOverseasPrice(symbol);
}

function daysBefore(date = new Date(), days = 80) {
  return new Date(date.getTime() - Math.max(1, Number(days) || 80) * 24 * 60 * 60 * 1000);
}

function normalizeDailyBar(row = {}, market = 'kis') {
  const date = pickFirstString(row, [
    'stck_bsop_date',
    'xymd',
    'date',
    'Date',
  ]);
  const open = pickFirstNumber(row, ['stck_oprc', 'open', 'Open', 'ovrs_nmix_oprc']);
  const high = pickFirstNumber(row, ['stck_hgpr', 'high', 'High', 'ovrs_nmix_hgpr']);
  const low = pickFirstNumber(row, ['stck_lwpr', 'low', 'Low', 'ovrs_nmix_lwpr']);
  const close = pickFirstNumber(row, ['stck_clpr', 'clos', 'close', 'Close', 'ovrs_nmix_prpr']);
  const volume = pickFirstNumber(row, ['acml_vol', 'tvol', 'volume', 'Volume', 'tr_pbmn']);
  const timestamp = date && /^\d{8}$/.test(date)
    ? new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`).getTime()
    : 0;
  return {
    date,
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    market,
    raw: row,
  };
}

function normalizeDailyBars(rows = [], market = 'kis', limit = 80) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => normalizeDailyBar(row, market))
    .filter((row) => row.date && row.close > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-Math.max(1, Number(limit) || 80));
}

export async function getDomesticDailyPriceBars(symbol, {
  days = 80,
  startDate = null,
  endDate = null,
  paper,
} = {}) {
  const usePaper = resolveUsePaper(paper);
  const end = endDate || formatYmd(new Date());
  const start = startDate || formatYmd(daysBefore(new Date(), Math.max(days * 2, days + 20)));
  const data = await kisRequest('GET', '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', {
    trId: TR_ID.DOMESTIC_DAILY_ITEM_CHART,
    params: {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: String(symbol || '').trim(),
      FID_INPUT_DATE_1: start,
      FID_INPUT_DATE_2: end,
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: '0',
    },
    paper: usePaper,
  });
  return normalizeDailyBars(data.output2 || [], 'kis_domestic', days);
}

export async function getOverseasDailyPriceBars(symbol, {
  days = 80,
  priceExcd = null,
  endDate = '',
} = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const excdCandidates = [
    priceExcd,
    KIS_OVERSEAS_PRICE_EXCD[normalizedSymbol],
    'NAS',
    'NYS',
    'AMX',
  ].filter(Boolean);
  let lastError = null;
  for (const excd of [...new Set(excdCandidates)]) {
    try {
      const data = await kisRequest('GET', '/uapi/overseas-price/v1/quotations/dailyprice', {
        trId: TR_ID.OVERSEAS_DAILY_PRICE,
        params: {
          AUTH: '',
          EXCD: excd,
          SYMB: normalizedSymbol,
          GUBN: '0',
          BYMD: endDate || '',
          MODP: '0',
        },
        paper: false,
      });
      const bars = normalizeDailyBars(data.output2 || [], 'kis_overseas', days);
      if (bars.length > 0) {
        return bars.map((bar) => ({ ...bar, priceExcd: excd }));
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`${normalizedSymbol} 해외 일봉 조회 실패`);
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

function findOrderFillRow(rows = [], { ordNo, symbol = null } = {}) {
  const normalizedOrdNo = normalizeOrderNo(ordNo);
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  return rows.find((row) => {
    const rowOrderNo = normalizeOrderNo(
      row?.ODNO
      || row?.odno
      || row?.ord_no
      || row?.ordNo
      || row?.ordno,
    );
    if (!rowOrderNo) return false;
    if (normalizedOrdNo && rowOrderNo !== normalizedOrdNo) return false;
    if (!normalizedSymbol) return true;
    const rowSymbol = String(
      row?.PDNO
      || row?.pdno
      || row?.ISIN_PDNO
      || row?.ovrs_pdno
      || row?.symb
      || row?.SYMB
      || '',
    ).trim().toUpperCase();
    if (!rowSymbol) return true;
    return rowSymbol === normalizedSymbol;
  }) || null;
}

function resolveFillStatus({ filledQty = 0, remainingQty = 0 }) {
  const filled = parseNumeric(filledQty);
  const remain = parseNumeric(remainingQty);
  if (filled > 0 && remain <= 1e-9) return 'filled_complete';
  if (filled > 0) return 'partial_filled';
  return 'fill_not_confirmed';
}

export async function getDomesticOrderFillByOrdNo({
  symbol,
  ordNo,
  side = 'all',
  paper,
} = {}) {
  const normalizedSymbol = String(symbol || '').trim();
  const normalizedOrdNo = String(ordNo || '').trim();
  const usePaper = resolveUsePaper(paper);

  if (!normalizedSymbol || !normalizedOrdNo) {
    return {
      found: false,
      symbol: normalizedSymbol || null,
      ordNo: normalizedOrdNo || null,
      filledQty: 0,
      remainingQty: 0,
      avgPrice: 0,
      totalAmount: 0,
      status: 'invalid_request',
      paper: usePaper,
      source: 'validation',
      raw: null,
    };
  }

  const mcp = await runKisMcpBridge('domestic_fill', {
    symbol: normalizedSymbol,
    ordNo: normalizedOrdNo,
    side,
    paper: usePaper,
  });
  if (mcp?.result && typeof mcp.result === 'object') {
    return {
      ...mcp.result,
      source: mcp.result.source || 'kis_mcp_domestic_fill',
    };
  }

  const { cano, prodCd } = parseAccount(usePaper);
  const sideCode = resolveKisSideCode(side).domestic;
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  let data;
  try {
    data = await kisRequest('GET', '/uapi/domestic-stock/v1/trading/inquire-daily-ccld', {
      trId: usePaper ? TR_ID.DOMESTIC_DAILY_CCLD_PAPER : TR_ID.DOMESTIC_DAILY_CCLD_LIVE,
      params: {
        CANO: cano,
        ACNT_PRDT_CD: prodCd,
        INQR_STRT_DT: formatYmd(start),
        INQR_END_DT: formatYmd(now),
        SLL_BUY_DVSN_CD: sideCode,
        PDNO: normalizedSymbol,
        CCLD_DVSN: '00',
        INQR_DVSN: '00',
        INQR_DVSN_3: '00',
        ORD_GNO_BRNO: '',
        ODNO: normalizedOrdNo,
        INQR_DVSN_1: '',
        EXCG_ID_DVSN_CD: 'KRX',
        CTX_AREA_FK100: '',
        CTX_AREA_NK100: '',
      },
      paper: usePaper,
    });
  } catch (error) {
    return {
      found: false,
      symbol: normalizedSymbol,
      ordNo: normalizedOrdNo,
      filledQty: 0,
      remainingQty: 0,
      avgPrice: 0,
      totalAmount: 0,
      status: 'lookup_error',
      paper: usePaper,
      source: 'kis_domestic_inquire_daily_ccld',
      error: String(error?.message || error),
      raw: null,
    };
  }

  const rows = Array.isArray(data?.output1) ? data.output1 : [];
  const row = findOrderFillRow(rows, { ordNo: normalizedOrdNo, symbol: normalizedSymbol });
  if (!row) {
    return {
      found: false,
      symbol: normalizedSymbol,
      ordNo: normalizedOrdNo,
      filledQty: 0,
      remainingQty: 0,
      avgPrice: 0,
      totalAmount: 0,
      status: 'not_found',
      paper: usePaper,
      source: 'kis_domestic_inquire_daily_ccld',
      raw: null,
    };
  }

  const filledQty = pickFirstNumber(row, [
    'tot_ccld_qty',
    'tot_ccld_qty1',
    'ccld_qty',
    'ft_ccld_qty',
    'tot_ccld_yn_qty',
  ]);
  const remainingQty = pickFirstNumber(row, [
    'nccs_qty',
    'rmn_qty',
    'ord_remn_qty',
    'ft_nccs_qty',
  ]);
  const avgPrice = pickFirstNumber(row, [
    'avg_prvs',
    'avg_unpr',
    'ccld_unpr',
    'ord_unpr',
    'ft_ccld_unpr3',
  ]);
  const totalAmount = pickFirstNumber(row, [
    'tot_ccld_amt',
    'ccld_amt',
    'ord_amt',
    'ft_ccld_amt3',
  ]);

  return {
    found: true,
    symbol: normalizedSymbol,
    ordNo: normalizedOrdNo,
    filledQty,
    remainingQty,
    avgPrice,
    totalAmount,
    status: resolveFillStatus({ filledQty, remainingQty }),
    paper: usePaper,
    source: 'kis_domestic_inquire_daily_ccld',
    raw: row,
  };
}

export async function getOverseasOrderFillByOrdNo({
  symbol,
  ordNo,
  side = 'all',
  paper,
} = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedOrdNo = String(ordNo || '').trim();
  const usePaper = resolveUsePaper(paper);

  if (!normalizedSymbol || !normalizedOrdNo) {
    return {
      found: false,
      symbol: normalizedSymbol || null,
      ordNo: normalizedOrdNo || null,
      filledQty: 0,
      remainingQty: 0,
      avgPrice: 0,
      totalAmount: 0,
      status: 'invalid_request',
      paper: usePaper,
      source: 'validation',
      raw: null,
    };
  }

  const mcp = await runKisMcpBridge('overseas_fill', {
    symbol: normalizedSymbol,
    ordNo: normalizedOrdNo,
    side,
    paper: usePaper,
  });
  if (mcp?.result && typeof mcp.result === 'object') {
    return {
      ...mcp.result,
      source: mcp.result.source || 'kis_mcp_overseas_fill',
    };
  }

  const { cano, prodCd } = parseAccount(usePaper);
  const sideCode = resolveKisSideCode(side).overseas;
  const now = new Date();
  const start = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  let data;
  try {
    data = await kisRequest('GET', '/uapi/overseas-stock/v1/trading/inquire-ccnl', {
      trId: usePaper ? TR_ID.OVERSEAS_CCLD_PAPER : TR_ID.OVERSEAS_CCLD_LIVE,
      params: {
        CANO: cano,
        ACNT_PRDT_CD: prodCd,
        PDNO: normalizedSymbol,
        ORD_STRT_DT: formatYmd(start),
        ORD_END_DT: formatYmd(now),
        SLL_BUY_DVSN: sideCode,
        CCLD_NCCS_DVSN: '00',
        OVRS_EXCG_CD: '%',
        SORT_SQN: 'DS',
        ORD_DT: '',
        ORD_GNO_BRNO: '',
        // KIS 해외 inquire-ccnl은 ODNO 직접 조회를 지원하지 않아 빈 값으로 호출 후 로컬 필터링한다.
        ODNO: '',
        CTX_AREA_NK200: '',
        CTX_AREA_FK200: '',
      },
      paper: usePaper,
    });
  } catch (error) {
    return {
      found: false,
      symbol: normalizedSymbol,
      ordNo: normalizedOrdNo,
      filledQty: 0,
      remainingQty: 0,
      avgPrice: 0,
      totalAmount: 0,
      status: 'lookup_error',
      paper: usePaper,
      source: 'kis_overseas_inquire_ccnl',
      error: String(error?.message || error),
      raw: null,
    };
  }

  const rows = Array.isArray(data?.output)
    ? data.output
    : Array.isArray(data?.output1)
      ? data.output1
      : [];
  const row = findOrderFillRow(rows, { ordNo: normalizedOrdNo, symbol: normalizedSymbol });
  if (!row) {
    return {
      found: false,
      symbol: normalizedSymbol,
      ordNo: normalizedOrdNo,
      filledQty: 0,
      remainingQty: 0,
      avgPrice: 0,
      totalAmount: 0,
      status: 'not_found',
      paper: usePaper,
      source: 'kis_overseas_inquire_ccnl',
      raw: null,
    };
  }

  const filledQty = pickFirstNumber(row, [
    'tot_ccld_qty',
    'ft_ccld_qty',
    'ccld_qty',
    'tot_ccld_qty1',
  ]);
  const remainingQty = pickFirstNumber(row, [
    'nccs_qty',
    'ft_nccs_qty',
    'rmn_qty',
    'ord_remn_qty',
  ]);
  const avgPrice = pickFirstNumber(row, [
    'ft_ccld_unpr3',
    'avg_unpr',
    'ccld_unpr',
    'ord_unpr',
    'ovrs_krx_fwdg_ord_unpr',
  ]);
  const totalAmount = pickFirstNumber(row, [
    'ft_ccld_amt3',
    'tot_ccld_amt',
    'ccld_amt',
    'ord_amt',
  ]);

  return {
    found: true,
    symbol: normalizedSymbol,
    ordNo: normalizedOrdNo,
    filledQty,
    remainingQty,
    avgPrice,
    totalAmount,
    status: resolveFillStatus({ filledQty, remainingQty }),
    paper: usePaper,
    source: 'kis_overseas_inquire_ccnl',
    raw: row,
  };
}

// ─── 국내주식 주문 ──────────────────────────────────────────────────

/**
 * 국내주식 시장가 매수
 * @param {string}  symbol     6자리 종목코드 (예: 005930)
 * @param {number}  amountKrw  투자 금액 (원)
 * @param {boolean} dryRun     true = API 호출 없이 시뮬레이션만
 * @returns {Promise<any>}
 */
export async function marketBuy(symbol, amountKrw, dryRun = false) {
  const paper = isKisPaper();
  const tag   = dryRun ? '[PAPER]' : paper ? '[LIVE/MOCK]' : '[LIVE/REAL]';

  const mcp = await runKisMcpBridge('domestic_buy', { symbol, amountKrw, dryRun, paper });
  if (mcp?.result && typeof mcp.result === 'object') {
    return mcp.result;
  }

  const currentPrice = await getDomesticPrice(symbol, paper);
  let effectiveAmountKrw = Number(amountKrw || 0);

  if (!dryRun) {
    const balance = await getDomesticBalance(paper).catch(() => null);
    const depositKrw = Number(balance?.dnca_tot_amt || 0);
    const spendableKrw = Math.max(0, depositKrw - 10_000);
    if (depositKrw > 0 && effectiveAmountKrw > spendableKrw) {
      throw new Error(
        `주문가능금액 초과 방지: 요청 ${effectiveAmountKrw.toLocaleString()}원 > 가용 ${spendableKrw.toLocaleString()}원 (예수금 ${depositKrw.toLocaleString()}원)`,
      );
    }
  }

  const bufferedUnitPrice = Math.ceil(currentPrice * KIS_DOMESTIC_BUY_SLIPPAGE_BUFFER);
  const qty = Math.floor(effectiveAmountKrw / bufferedUnitPrice);

  if (qty < 1) {
    throw new Error(
      `수량 부족: ${effectiveAmountKrw?.toLocaleString()}원으로 ${symbol} 1주(${bufferedUnitPrice.toLocaleString()}원, 안전버퍼 포함) 매수 불가`,
    );
  }

  console.log(`  📊 [KIS] ${symbol} 현재가 ${currentPrice.toLocaleString()}원 → 매수 ${qty}주 ${tag} (안전단가 ${bufferedUnitPrice.toLocaleString()}원)`);

  if (dryRun) {
    console.log(`  🔍 [KIS] dryRun — 실제 주문 생략`);
    return { qty, price: currentPrice, totalKrw: qty * currentPrice, dryRun: true };
  }

  const { cano, prodCd } = parseAccount(paper);
  const trId = paper ? TR_ID.DOMESTIC_BUY_PAPER : TR_ID.DOMESTIC_BUY_LIVE;
  const submitBuyOrder = (orderQty) => kisRequest('POST', '/uapi/domestic-stock/v1/trading/order-cash', {
    trId, paper,
    body: {
      CANO:         cano,
      ACNT_PRDT_CD: prodCd,
      PDNO:         symbol,
      ORD_DVSN:     '01',      // 시장가
      ORD_QTY:      String(orderQty),
      ORD_UNPR:     '0',
    },
  });

  let finalQty = qty;
  let res;
  try {
    res = await submitBuyOrder(finalQty);
  } catch (error) {
    const message = String(error?.message || '');
    const isOrderCapacityError = message.includes('APBK0400') || message.includes('APBK0952');
    if (isOrderCapacityError && finalQty > 1) {
      finalQty -= 1;
      console.warn(`  ⚠️ [KIS] ${symbol} 주문 가능 수량/금액 경계 감지 — ${finalQty}주로 1회 재시도`);
      res = await submitBuyOrder(finalQty);
    } else {
      throw error;
    }
  }

  const ordNo = res.output?.ODNO;
  console.log(`  ✅ [KIS] ${tag} 매수 완료: ${symbol} ${finalQty}주 주문번호=${ordNo}`);
  return { qty: finalQty, price: currentPrice, totalKrw: finalQty * currentPrice, ordNo };
}

/**
 * 국내주식 시장가 매도
 * @param {string}  symbol  6자리 종목코드
 * @param {number}  qty     매도 수량
 * @param {boolean} dryRun
 * @returns {Promise<any>}
 */
export async function marketSell(symbol, qty, dryRun = false) {
  const paper = isKisPaper();
  const tag   = dryRun ? '[PAPER]' : paper ? '[LIVE/MOCK]' : '[LIVE/REAL]';

  const mcp = await runKisMcpBridge('domestic_sell', { symbol, qty, dryRun, paper });
  if (mcp?.result && typeof mcp.result === 'object') {
    return mcp.result;
  }

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
 * @returns {Promise<any>}
 */
export async function marketBuyOverseas(symbol, amountUsd, dryRun = false) {
  const paper = isKisPaper();
  const tag   = dryRun ? '[PAPER]' : paper ? '[LIVE/MOCK]' : '[LIVE/REAL]';

  const mcp = await runKisMcpBridge('overseas_buy', {
    symbol: String(symbol || '').toUpperCase(),
    amountUsd,
    dryRun,
    paper,
  });
  if (mcp?.result && typeof mcp.result === 'object') {
    return mcp.result;
  }

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
 * @returns {Promise<any>}
 */
export async function marketSellOverseas(symbol, qty, dryRun = false) {
  const paper = isKisPaper();
  const tag   = dryRun ? '[PAPER]' : paper ? '[LIVE/MOCK]' : '[LIVE/REAL]';

  const mcp = await runKisMcpBridge('overseas_sell', {
    symbol: String(symbol || '').toUpperCase(),
    qty,
    dryRun,
    paper,
  });
  if (mcp?.result && typeof mcp.result === 'object') {
    return mcp.result;
  }

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
      SLL_TYPE:        '00',
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
  const usePaper = resolveUsePaper(paper);
  const mcp = await runKisMcpBridge('domestic_balance', { market: 'domestic', paper: usePaper });
  if (mcp?.balance && typeof mcp.balance === 'object') {
    return mcp.balance;
  }
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
/**
 * 국내주식 거래량 순위 조회 (최대 30종목)
 * TR_ID: FHPST01710000
 */
export async function getDomesticRanking(endpoint, trId, params = {}, paper = false) {
  const mcp = await runKisMcpBridge('domestic_ranking', { endpoint, trId, params, paper });
  if (mcp?.result && Array.isArray(mcp.result)) {
    return mcp.result;
  }
  try {
    const data = await kisRequest('GET', endpoint, {
      trId,
      params: {
        FID_COND_MRKT_DIV_CODE:  'J',
        FID_COND_SCR_DIV_CODE:   '20171',
        FID_INPUT_ISCD:          '0000',
        FID_DIV_CLS_CODE:        '0',
        FID_BLNG_CLS_CODE:       '0',
        FID_TRGT_CLS_CODE:       '111111111',
        FID_TRGT_EXLS_CLS_CODE:  '000000',
        FID_INPUT_PRICE_1:       '',
        FID_INPUT_PRICE_2:       '',
        FID_VOL_CNT:             '',
        FID_INPUT_DATE_1:        '',
        ...params,
      },
      paper,
    });
    return data.output || [];
  } catch (e) {
    console.warn(`[KIS] 국내 순위 조회 실패 (${trId}): ${e.message}`);
    return [];
  }
}

export async function getVolumeRank(paper = false) {
  const mcp = await runKisMcpBridge('volume_rank', { paper });
  if (mcp?.result && Array.isArray(mcp.result)) {
    return mcp.result;
  }
  const rows = await getDomesticRanking(
    '/uapi/domestic-stock/v1/ranking/volume',
    'FHPST01710000',
    {},
    paper,
  );
  return rows.map(r => ({
    stockCode:  r.mksc_shrn_iscd,
    stockName:  r.hts_kor_isnm,
    volume:     parseInt(r.acml_vol || '0', 10),
    changeRate: parseFloat(r.prdy_ctrt || '0'),
  }));
}

export async function getOverseasBalance(paper) {
  const usePaper = resolveUsePaper(paper);
  const mcp = await runKisMcpBridge('overseas_balance', { market: 'overseas', paper: usePaper });
  if (mcp?.balance && typeof mcp.balance === 'object') {
    return mcp.balance;
  }
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
  const psamount = await getOverseasOrderableAmount({
    symbol: 'AAPL',
    price: 1,
    paper: usePaper,
  }).catch((error) => {
    console.warn(`  ⚠️ [KIS] 해외 매수가능금액 조회 실패 — 잔고 summary 사용: ${error?.message || error}`);
    return null;
  });
  const summaryAvailableCash = parseFloat(sum.ovrs_ord_psbl_amt || sum.frcr_dncl_amt_1 || sum.frcr_dncl_amt_2 || sum.frcr_buy_mgn_amt || '0');
  const summaryOrderableCash = parseFloat(sum.ovrs_ord_psbl_amt || sum.frcr_buy_mgn_amt || '0');
  const summaryCash = parseFloat(sum.frcr_dncl_amt_2 || sum.frcr_dncl_amt_1 || '0');
  const orderableCash = Math.max(summaryOrderableCash, Number(psamount?.orderable_cash_usd || 0));
  const availableCash = Math.max(summaryAvailableCash, Number(psamount?.available_cash_usd || 0), orderableCash);
  const cashUsd = Math.max(summaryCash, Number(psamount?.cash_usd || 0), orderableCash);
  return {
    holdings,
    available_cash_usd: availableCash,
    orderable_cash_usd: orderableCash,
    cash_usd: cashUsd,
    total_eval_usd: parseFloat(sum.tot_evlu_pfls_amt2 || '0'),
    total_pnl_usd:  parseFloat(sum.ovrs_tot_pfls       || '0'),
    orderable_source: psamount ? 'inquire_psamount' : 'inquire_balance',
    psamount: psamount
      ? {
          orderable_cash_usd: psamount.orderable_cash_usd,
          available_cash_usd: psamount.available_cash_usd,
          cash_usd: psamount.cash_usd,
          max_orderable_qty: psamount.max_orderable_qty,
          exchange_rate: psamount.exchange_rate,
          currency: psamount.currency,
          tr_id: psamount.tr_id,
        }
      : null,
    paper: usePaper,
  };
}

export async function getOverseasOrderableAmount({
  symbol = 'AAPL',
  price = 1,
  paper = false,
  exchange = 'NASD',
} = {}) {
  const usePaper = resolveUsePaper(paper);
  if (usePaper) {
    throw new Error('kis_overseas_psamount_unavailable_in_paper');
  }

  const { cano, prodCd } = parseAccount(usePaper);
  const normalizedSymbol = String(symbol || 'AAPL').trim().toUpperCase() || 'AAPL';
  const normalizedPrice = Number(price || 0) > 0 ? Number(price) : 1;
  const params = {
    CANO: cano,
    ACNT_PRDT_CD: prodCd,
    OVRS_EXCG_CD: String(exchange || 'NASD').trim().toUpperCase() || 'NASD',
    OVRS_ORD_UNPR: normalizedPrice.toFixed(2),
    ITEM_CD: normalizedSymbol,
  };

  const trIds = [TR_ID.OVERSEAS_PSAMOUNT_NIGHT, TR_ID.OVERSEAS_PSAMOUNT_DAY];
  let lastError = null;
  for (const trId of trIds) {
    try {
      const data = await kisRequest('GET', '/uapi/overseas-stock/v1/trading/inquire-psamount', {
        trId,
        params,
        paper: usePaper,
      });
      return {
        ...normalizeOverseasPsamount(data.output || {}),
        symbol: normalizedSymbol,
        exchange: params.OVRS_EXCG_CD,
        price: normalizedPrice,
        tr_id: trId,
        paper: usePaper,
      };
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || '');
      if (!message.includes('모의투자') && !message.includes('주야간') && !message.includes('원장')) {
        // day/night TR mismatch 외 오류도 day TR로 한 번 더 확인한다.
      }
    }
  }
  throw lastError || new Error('kis_overseas_psamount_failed');
}
