// @ts-nocheck
/**
 * shared/secrets.js — 설정 로더 (Phase 3-A ESM)
 *
 * config.yaml 우선 로드 → 없으면 secrets.json fallback
 * 하위 호환을 위해 기존 함수 시그니처 유지
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { hostname } from 'os';
import yaml from 'js-yaml';

const _require = createRequire(import.meta.url);
const kst     = _require('../../../packages/core/lib/kst');
const env     = _require('../../../packages/core/lib/env');
const _hubClient = _require('../../../packages/core/lib/hub-client');

const __dirname = dirname(fileURLToPath(import.meta.url));

let _secrets = null;
let _hubInitDone = false;
const _warnedKeys = new Set();

function warnOnce(key, message) {
  if (_warnedKeys.has(key)) return;
  _warnedKeys.add(key);
  console.warn(message);
}

function normalizeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'paper' || normalized === 'live' || normalized === 'inherit') return normalized;
  return null;
}

function normalizeInvestmentTradeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'normal' || normalized === 'validation') return normalized;
  return null;
}

function applyDevSafetyOverrides(secrets) {
  if (env.IS_OPS) return secrets;

  return {
    ...secrets,
    trading_mode: 'paper',
    paper_mode: true,
    binance_mode: secrets.binance_mode === 'live' ? 'paper' : (secrets.binance_mode || 'inherit'),
    kis_mode: secrets.kis_mode === 'live' ? 'paper' : (secrets.kis_mode || 'inherit'),
    binance_testnet: true,
    kis_paper_trading: true,
  };
}

/**
 * Hub에서 전체 config를 가져와 시크릿 캐시에 주입.
 * 투자팀 시작점에서 선택적으로 1회 호출 가능.
 * 실패 시 기존 loadSecrets() 폴백을 유지한다.
 * @returns {Promise<boolean>}
 */
export async function initHubSecrets() {
  if (_hubInitDone) return !!_secrets;

  const [hubConfig, hubLlm] = await Promise.all([
    _hubClient.fetchHubSecrets('config'),
    _hubClient.fetchHubSecrets('llm'),
  ]);

  if (hubConfig || hubLlm) {
    let localConfig = {};
    try {
      localConfig = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8')) || {};
    } catch {
      localConfig = {};
    }
    const c = hubConfig || {};
    const llm = hubLlm || {};
    _secrets = applyDevSafetyOverrides({
      telegram_bot_token:   c.telegram?.bot_token || '',
      telegram_chat_id:     String(c.telegram?.chat_id || process.env.TELEGRAM_CHAT_ID || ''),
      binance_api_key:      c.binance?.api_key || '',
      binance_api_secret:   c.binance?.api_secret || '',
      binance_testnet:      c.binance?.testnet || false,
      binance_symbols:      c.binance?.symbols || ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'],
      binance_deposit_address_usdt: c.binance?.deposit_address_usdt || '',
      upbit_access_key:     c.upbit?.access_key || '',
      upbit_secret_key:     c.upbit?.secret_key || '',
      kis_app_key:          c.kis?.app_key || '',
      kis_app_secret:       c.kis?.app_secret || '',
      kis_paper_app_key:    c.kis?.paper_app_key || '',
      kis_paper_app_secret: c.kis?.paper_app_secret || '',
      kis_account_number:   c.kis?.account_number || '',
      kis_paper_account_number: c.kis?.paper_account_number || '',
      kis_paper_trading: typeof c.kis?.paper_trading === 'boolean'
        ? c.kis.paper_trading
        : (typeof localConfig.kis?.paper_trading === 'boolean' ? localConfig.kis.paper_trading : undefined),
      kis_symbols:          c.kis?.symbols || [],
      kis_overseas_symbols: c.kis?.overseas_symbols || [],
      screening_domestic_core: c.screening?.domestic?.core || [],
      screening_overseas_core: c.screening?.overseas?.core || [],
      screening_crypto_core:   c.screening?.crypto?.core || [],
      screening_domestic_max_dynamic: Number(c.screening?.domestic?.max_dynamic || 0),
      screening_overseas_max_dynamic: Number(c.screening?.overseas?.max_dynamic || 0),
      screening_crypto_max_dynamic:   Number(c.screening?.crypto?.max_dynamic || 0),
      anthropic_api_key:    llm.anthropic?.api_key || c.anthropic?.api_key || '',
      anthropic_admin_api_key: llm.anthropic?.admin_api_key || c.anthropic?.admin_api_key || '',
      openai_api_key:       llm.openai?.api_key || c.openai?.api_key || '',
      openai_admin_api_key: llm.openai?.admin_api_key || c.openai?.admin_api_key || '',
      openai_model:         llm.openai?.model || c.openai?.model || 'gpt-4o',
      gemini_api_key:       llm.gemini?.api_key || c.gemini?.api_key || '',
      gemini_image_api_key: llm.gemini?.image_api_key || c.gemini?.image_api_key || '',
      groq_api_key:         llm.groq?.accounts?.[0]?.api_key || c.groq?.accounts?.[0]?.api_key || '',
      groq_api_keys:        ((llm.groq?.accounts || c.groq?.accounts || [])).map((account) => account.api_key).filter(Boolean),
      cerebras_api_key:     llm.cerebras?.api_key || c.cerebras?.api_key || '',
      sambanova_api_key:    llm.sambanova?.api_key || c.sambanova?.api_key || '',
      xai_api_key:          llm.xai?.api_key || c.xai?.api_key || '',
      naver_client_id:      c.news?.naver_client_id || '',
      naver_client_secret:  c.news?.naver_client_secret || '',
      dart_api_key:         c.news?.dart_api_key || '',
      cryptopanic_api_key:  c.news?.cryptopanic_api_key || '',
      alpha_vantage_api_key: c.news?.alpha_vantage_api_key || '',
      trading_mode: normalizeMode(c.trading_mode) || (c.paper_mode === false ? 'live' : 'paper'),
      binance_mode: normalizeMode(c.binance_mode) || 'inherit',
      kis_mode: normalizeMode(c.kis_mode) || normalizeMode(localConfig.kis_mode) || 'inherit',
      investment_trade_mode: normalizeInvestmentTradeMode(c.investment_trade_mode) || 'normal',
      paper_mode: c.paper_mode !== false,
    });
    _hubInitDone = true;
    return true;
  }

  loadSecrets();
  _hubInitDone = true;
  return false;
}

export function loadSecrets() {
  if (_secrets) return _secrets;

  // config.yaml 우선
  try {
    const c = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
    _secrets = {
      telegram_bot_token:   c.telegram?.bot_token  || '',
      telegram_chat_id:     String(c.telegram?.chat_id || process.env.TELEGRAM_CHAT_ID || ''),
      // 바이낸스
      binance_api_key:      c.binance?.api_key     || '',
      binance_api_secret:   c.binance?.api_secret  || '',
      binance_testnet:      c.binance?.testnet      || false,
      binance_symbols:      c.binance?.symbols      || ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'],
      binance_deposit_address_usdt: c.binance?.deposit_address_usdt || '',
      // 업비트
      upbit_access_key:     c.upbit?.access_key    || '',
      upbit_secret_key:     c.upbit?.secret_key    || '',
      // KIS
      kis_app_key:          c.kis?.app_key         || '',
      kis_app_secret:       c.kis?.app_secret      || '',
      kis_paper_app_key:    c.kis?.paper_app_key   || '',
      kis_paper_app_secret: c.kis?.paper_app_secret|| '',
      kis_account_number:         c.kis?.account_number        || '',
      kis_paper_account_number:   c.kis?.paper_account_number  || '',
      kis_paper_trading: typeof c.kis?.paper_trading === 'boolean' ? c.kis.paper_trading : undefined,
      kis_symbols:          c.kis?.symbols          || [],  // 아르고스 동적 선정
      kis_overseas_symbols: c.kis?.overseas_symbols || [],  // 아르고스 동적 선정
      screening_domestic_core: c.screening?.domestic?.core || [],
      screening_overseas_core: c.screening?.overseas?.core || [],
      screening_crypto_core: c.screening?.crypto?.core || [],
      screening_domestic_max_dynamic: Number(c.screening?.domestic?.max_dynamic || 0),
      screening_overseas_max_dynamic: Number(c.screening?.overseas?.max_dynamic || 0),
      screening_crypto_max_dynamic: Number(c.screening?.crypto?.max_dynamic || 0),
      // LLM
      anthropic_api_key:    c.anthropic?.api_key   || '',
      anthropic_admin_api_key: c.anthropic?.admin_api_key || '',
      openai_api_key:       c.openai?.api_key || '',
      openai_admin_api_key: c.openai?.admin_api_key || '',
      openai_model:         c.openai?.model || 'gpt-4o',
      gemini_api_key:       c.gemini?.api_key || '',
      gemini_image_api_key: c.gemini?.image_api_key || '',
      groq_api_key:         c.groq?.accounts?.[0]?.api_key || '',
      groq_api_keys:        (c.groq?.accounts || []).map(a => a.api_key).filter(Boolean),
      cerebras_api_key:     c.cerebras?.api_key    || '',
      sambanova_api_key:    c.sambanova?.api_key   || '',
      xai_api_key:          c.xai?.api_key         || '',
      // 뉴스·공시
      naver_client_id:      c.news?.naver_client_id     || '',
      naver_client_secret:  c.news?.naver_client_secret || '',
      dart_api_key:         c.news?.dart_api_key        || '',
      cryptopanic_api_key:  c.news?.cryptopanic_api_key || '',
      alpha_vantage_api_key:c.news?.alpha_vantage_api_key || '',
      // 모드
      trading_mode: normalizeMode(c.trading_mode) || (c.paper_mode === false ? 'live' : 'paper'),
      binance_mode: normalizeMode(c.binance_mode) || 'inherit',
      kis_mode: normalizeMode(c.kis_mode) || 'inherit',
      investment_trade_mode: normalizeInvestmentTradeMode(c.investment_trade_mode) || 'normal',
      paper_mode: c.paper_mode !== false,
    };
    return _secrets;
  } catch { /* config.yaml 없음 */ }

  // secrets.json fallback
  try {
    _secrets = JSON.parse(readFileSync(join(__dirname, '..', 'secrets.json'), 'utf8'));
    return _secrets;
  } catch {
    console.warn('⚠️ config.yaml / secrets.json 없음 — executionMode=paper 기본값');
    _secrets = {
      trading_mode: 'paper',
      binance_mode: 'inherit',
      kis_mode: 'inherit',
      investment_trade_mode: 'normal',
      paper_mode: true,
      binance_symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'],
    };
    return _secrets;
  }
}

// ─── executionMode / legacy PAPER_MODE ──────────────────────────────

export function getTradingMode() {
  let resolved;
  const explicitPaperMode = Reflect.get(process.env, 'PAPER_MODE');
  if (explicitPaperMode === 'false')     resolved = 'live';
  else if (explicitPaperMode === 'true') resolved = 'paper';
  else {
    const s = loadSecrets();
    resolved = normalizeMode(s.trading_mode) || (s.paper_mode === false ? 'live' : 'paper');
  }

  // ── 안전장치: 운영 서버(MacStudio)가 아닌 곳에서 live 차단 ──
  // 환경변수·config 어디서 live가 왔든 최종 관문으로 hostname 체크
  if (resolved === 'live' && !hostname().includes('MacStudio') && !env.IS_OPS) {
    console.warn(`⚠️ [secrets] 비운영 서버(${hostname()})에서 live 모드 감지 → paper 강제 전환`);
    return 'paper';
  }

  return resolved;
}

function resolveBrokerMode(overrideMode) {
  const mode = normalizeMode(overrideMode);
  if (mode && mode !== 'inherit') return mode;
  return getTradingMode();
}

export function isPaperMode() {
  return getTradingMode() === 'paper';
}

export function formatExecutionTag(paper) {
  return paper ? '[PAPER] ' : '';
}

export function getExecutionMode() {
  return isPaperMode() ? 'paper' : 'live';
}

export function getInvestmentTradeMode() {
  const envMode = normalizeInvestmentTradeMode(process.env.INVESTMENT_TRADE_MODE);
  if (envMode) return envMode;
  const s = loadSecrets();
  return normalizeInvestmentTradeMode(s.investment_trade_mode) || 'normal';
}

export function isValidationTradeMode() {
  return getInvestmentTradeMode() === 'validation';
}

export function getInvestmentGuardScope() {
  const mode = getInvestmentTradeMode();
  const rail = `investment.${mode}`;
  const market = String(process.env.INVESTMENT_MARKET || '').trim().toLowerCase();
  if (['crypto', 'domestic', 'overseas'].includes(market)) {
    return `${rail}.${market}`;
  }
  return rail;
}

export function isTestnet() {
  const s = loadSecrets();
  return s.binance_testnet === true || process.env.BINANCE_TESTNET === 'true';
}

export function getBrokerAccountMode(marketType = 'crypto') {
  const normalized = String(marketType || 'crypto').trim().toLowerCase();
  const isStockMarket = normalized === 'kis' || normalized === 'kis_overseas' || normalized === 'stock' || normalized === 'stocks';
  if (isStockMarket) return isKisPaper() ? 'mock' : 'real';
  // 현재 시스템 기준 암호화폐는 real 계정만 사용한다.
  // binance_testnet / BINANCE_TESTNET은 레거시 실험용 플래그로 남아 있어도
  // execution/broker mode 분류에는 더 이상 사용하지 않는다.
  return 'real';
}

export function describeModePair({ executionMode, brokerAccountMode, marketLabel = '시장' }) {
  if (executionMode === 'paper' && brokerAccountMode === 'mock') {
    return `${marketLabel}: 📄 PAPER / MOCK (모의투자 계좌 연결, 실자산 리스크 없음)`;
  }
  if (executionMode === 'paper' && brokerAccountMode === 'real') {
    return `${marketLabel}: 📄 PAPER / REAL (실계좌 연결, 실제 주문 차단)`;
  }
  if (executionMode === 'live' && brokerAccountMode === 'mock') {
    return `${marketLabel}: 🔴 LIVE / MOCK (모의투자 계좌로 주문 실행, 실자산 리스크 없음)`;
  }
  return `${marketLabel}: 🔴 LIVE / REAL (실제 투자)`;
}

// ─── 심볼 헬퍼 ─────────────────────────────────────────────────────

export function getSymbols() {
  const s = loadSecrets();
  return s.binance_symbols?.length
    ? s.binance_symbols
    : s.screening_crypto_core?.length
      ? s.screening_crypto_core
      : ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'];
}

export function getCryptoScreeningMaxDynamic() {
  const s = loadSecrets();
  const value = Number(s.screening_crypto_max_dynamic || 0);
  return Number.isFinite(value) && value > 0 ? value : 8;
}

export function getDomesticScreeningMaxDynamic() {
  const s = loadSecrets();
  const value = Number(s.screening_domestic_max_dynamic || 0);
  return Number.isFinite(value) && value > 0 ? value : 8;
}

export function getOverseasScreeningMaxDynamic() {
  const s = loadSecrets();
  const value = Number(s.screening_overseas_max_dynamic || 0);
  return Number.isFinite(value) && value > 0 ? value : 15;
}

export function getKisSymbols() {
  const s = loadSecrets();
  return s.kis_symbols?.length
    ? s.kis_symbols
    : s.screening_domestic_core?.length
      ? s.screening_domestic_core
      : ['005930', '000660'];
}

export function getKisOverseasSymbols() {
  const s = loadSecrets();
  return s.kis_overseas_symbols?.length
    ? s.kis_overseas_symbols
    : s.screening_overseas_core?.length
      ? s.screening_overseas_core
      : ['AAPL', 'TSLA', 'NVDA'];
}

// ─── 공휴일 체크 (ska.environment_factors) ──────────────────────────

const _holidayCache    = new Map(); // key: 'YYYY-MM-DD', value: { isHoliday, name }
const _nyseHolidayCache = new Map(); // key: year, value: Set<'YYYY-MM-DD'>

/**
 * NYSE 휴장일 Set 반환 (nyse-holidays 패키지, 연도별 캐시)
 * @param {number} year
 * @returns {Set<string>} 'YYYY-MM-DD' 형식
 */
function getNyseHolidaySet(year) {
  if (_nyseHolidayCache.has(year)) return _nyseHolidayCache.get(year);
  try {
    const h   = _require('nyse-holidays');
    const set = new Set(h.getHolidays(year).map(d => d.dateString));
    _nyseHolidayCache.set(year, set);
    return set;
  } catch {
    return new Set();
  }
}

function getWeekdayInTimeZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
}

/**
 * 해당 날짜가 NYSE 휴장일인지 확인
 * @param {Date} [date]
 * @returns {{ isHoliday: boolean, name: string|null }}
 */
export function isNyseHoliday(date = new Date()) {
  const dateStr = date.toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });
  const year    = date.getUTCFullYear();
  const set     = getNyseHolidaySet(year);
  if (set.has(dateStr)) {
    try {
      const holidays = _require('nyse-holidays').getHolidays(year);
      const found    = holidays.find(h => h.dateString === dateStr);
      return { isHoliday: true, name: found?.name || 'NYSE Holiday' };
    } catch {
      return { isHoliday: true, name: 'NYSE Holiday' };
    }
  }
  return { isHoliday: false, name: null };
}

/**
 * 오늘이 한국 공휴일인지 확인 (ska.environment_factors 조회)
 * - 당일 캐시 적용 (프로세스 내 1회만 쿼리)
 * - DB 조회 실패 시 false 반환 (장 운영 우선)
 * @returns {Promise<{ isHoliday: boolean, name: string|null }>}
 */
export async function isKisHoliday(date = new Date()) {
  const dateStr = date.toLocaleDateString('sv-SE', { timeZone: kst.TZ });

  if (_holidayCache.has(dateStr)) return _holidayCache.get(dateStr);

  try {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const pgPool  = require('../../../packages/core/lib/pg-pool');
    const rows    = await pgPool.query('reservation', `
      SELECT holiday_flag, holiday_name
      FROM ska.environment_factors
      WHERE date = $1
    `, [dateStr]);

    const result = rows.length > 0 && rows[0].holiday_flag
      ? { isHoliday: true,  name: rows[0].holiday_name || '공휴일' }
      : { isHoliday: false, name: null };

    _holidayCache.set(dateStr, result);
    return result;
  } catch {
    // DB 조회 실패 시 장 운영 우선 (false)
    return { isHoliday: false, name: null };
  }
}

// ─── 시장 오픈 여부 ─────────────────────────────────────────────────

export function isKisMarketOpen() {
  const now        = new Date();
  const kstMinutes = kst.currentHour(now) * 60 + kst.currentMinute(now);
  const kstWeekday = getWeekdayInTimeZone(now, kst.TZ);
  if (kstWeekday === 'Sun' || kstWeekday === 'Sat') return false;
  return kstMinutes >= 9 * 60 && kstMinutes < 15 * 60 + 30;
}

export async function getKisMarketStatus(date = new Date()) {
  const dateStr    = date.toLocaleDateString('sv-SE', { timeZone: kst.TZ });
  const kstMinutes = kst.currentHour(date) * 60 + kst.currentMinute(date);
  const kstWeekday = getWeekdayInTimeZone(date, kst.TZ);
  const holiday    = await isKisHoliday(date);

  if (holiday.isHoliday) {
    return {
      isOpen: false,
      reason: `공휴일 (${holiday.name || '공휴일'})`,
      holiday,
      isWeekend: false,
      sessionDate: dateStr,
    };
  }
  if (kstWeekday === 'Sun' || kstWeekday === 'Sat') {
    return {
      isOpen: false,
      reason: `주말 (${kstWeekday === 'Sat' ? '토요일' : '일요일'})`,
      holiday,
      isWeekend: true,
      sessionDate: dateStr,
    };
  }
  if (kstMinutes < 9 * 60 || kstMinutes >= 15 * 60 + 30) {
    return {
      isOpen: false,
      reason: `장외 시간 (KST ${kst.timeStr(date).slice(0, 5)})`,
      holiday,
      isWeekend: false,
      sessionDate: dateStr,
    };
  }

  return {
    isOpen: true,
    reason: `장중 (KST ${kst.timeStr(date).slice(0, 5)})`,
    holiday,
    isWeekend: false,
    sessionDate: dateStr,
  };
}

/**
 * 미국 DST 여부 (자동 계산)
 * 시작: 3월 둘째 주 일요일 02:00 ET / 종료: 11월 첫째 주 일요일 02:00 ET
 */
function isUsDST(date) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1; // 1~12

  // 3월 둘째 주 일요일 계산
  const marchFirst  = new Date(Date.UTC(y, 2, 1));
  const marchOffset = (7 - marchFirst.getUTCDay()) % 7; // 첫 번째 일요일까지 남은 일수
  const dstStart    = new Date(Date.UTC(y, 2, 1 + marchOffset + 7, 7)); // 둘째 일요일 02:00 ET = UTC 07:00

  // 11월 첫째 주 일요일 계산
  const novFirst  = new Date(Date.UTC(y, 10, 1));
  const novOffset = (7 - novFirst.getUTCDay()) % 7;
  const dstEnd    = new Date(Date.UTC(y, 10, 1 + novOffset, 6)); // 첫째 일요일 02:00 ET = UTC 06:00

  return date >= dstStart && date < dstEnd;
}

export function isKisOverseasMarketOpen() {
  const now        = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const nyWeekday  = getWeekdayInTimeZone(now, 'America/New_York');
  if (nyWeekday === 'Sun' || nyWeekday === 'Sat') return false;
  if (isNyseHoliday(now).isHoliday)  return false;
  const isDST    = isUsDST(now);
  const openUtc  = isDST ? 13 * 60 + 30 : 14 * 60 + 30;
  const closeUtc = isDST ? 20 * 60       : 21 * 60;
  return utcMinutes >= openUtc && utcMinutes < closeUtc;
}

export function getKisOverseasMarketStatus(date = new Date()) {
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const isDST      = isUsDST(date);
  const openUtc    = isDST ? 13 * 60 + 30 : 14 * 60 + 30;
  const closeUtc   = isDST ? 20 * 60       : 21 * 60;
  const nyDate     = date.toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });
  const kstDate    = date.toLocaleDateString('sv-SE', { timeZone: kst.TZ });
  const nyWeekday  = getWeekdayInTimeZone(date, 'America/New_York');
  const holiday    = isNyseHoliday(date);

  if (holiday.isHoliday) {
    return {
      isOpen: false,
      reason: `NYSE 휴장 (${holiday.name || 'Holiday'})`,
      holiday,
      nyDate,
      kstDate,
      isWeekend: false,
    };
  }
  if (nyWeekday === 'Sun' || nyWeekday === 'Sat') {
    return {
      isOpen: false,
      reason: `미국 주말 (${nyWeekday === 'Sat' ? '토요일' : '일요일'}, ET 기준 ${nyDate})`,
      holiday,
      nyDate,
      kstDate,
      isWeekend: true,
    };
  }
  if (utcMinutes < openUtc || utcMinutes >= closeUtc) {
    return {
      isOpen: false,
      reason: `미국 장외 시간 (ET 기준 ${nyDate})`,
      holiday,
      nyDate,
      kstDate,
      isWeekend: false,
    };
  }

  return {
    isOpen: true,
    reason: `미국 장중 (ET 기준 ${nyDate})`,
    holiday,
    nyDate,
    kstDate,
    isWeekend: false,
  };
}

// ─── KIS 헬퍼 ───────────────────────────────────────────────────────

export function isKisPaper() {
  const s = loadSecrets();
  const explicitKisMode = normalizeMode(s.kis_mode);

  if (explicitKisMode && explicitKisMode !== 'inherit') {
    const resolvedFromMode = resolveBrokerMode(explicitKisMode) === 'paper';
    if (typeof s.kis_paper_trading === 'boolean' && s.kis_paper_trading !== resolvedFromMode) {
      warnOnce(
        'kis-mode-legacy-conflict',
        `⚠️ [secrets] kis_mode=${explicitKisMode} 와 kis.paper_trading=${String(s.kis_paper_trading)} 충돌 감지 -> kis_mode 우선 적용`,
      );
    }
    return resolvedFromMode;
  }

  if (s.kis_paper_trading === true) {
    warnOnce(
      'kis-paper-trading-legacy',
      '⚠️ [secrets] kis.paper_trading 레거시 설정 사용 중 -> 향후 kis_mode로 통합 필요',
    );
    return true;
  }
  if (s.kis_paper_trading === false) {
    warnOnce(
      'kis-paper-trading-legacy',
      '⚠️ [secrets] kis.paper_trading 레거시 설정 사용 중 -> 향후 kis_mode로 통합 필요',
    );
    return false;
  }

  return resolveBrokerMode('inherit') === 'paper';
}

export function getKisExecutionModeInfo(marketLabel = '주식') {
  return getMarketExecutionModeInfo('stocks', marketLabel);
}

export function getMarketExecutionModeInfo(marketType = 'crypto', marketLabel = '시장') {
  const normalized = String(marketType || 'crypto').trim().toLowerCase();
  const isStockMarket = normalized === 'kis' || normalized === 'kis_overseas' || normalized === 'stock' || normalized === 'stocks';
  const broker = isStockMarket ? 'KIS' : 'BINANCE';
  const executionMode = getExecutionMode();
  const brokerAccountMode = getBrokerAccountMode(isStockMarket ? 'stocks' : 'crypto');
  const investmentTradeMode = getInvestmentTradeMode();
  const paper = executionMode === 'paper';
  const operationTag = investmentTradeMode === 'validation' ? '[VALIDATION]' : '[NORMAL]';
  return {
    marketType: isStockMarket ? 'stocks' : 'crypto',
    broker,
    executionMode,
    brokerAccountMode,
    investmentTradeMode,
    investmentGuardScope: getInvestmentGuardScope(),
    paper,
    tag: paper ? '[PAPER]' : '[LIVE]',
    operationTag,
    logLine: `${describeModePair({ executionMode, brokerAccountMode, marketLabel })} | broker=${broker} | investmentMode=${investmentTradeMode.toUpperCase()} ${operationTag}`,
  };
}

export function isBinancePaper() {
  return resolveBrokerMode(loadSecrets().binance_mode) === 'paper';
}

export function getKisAccount() {
  const s   = loadSecrets();
  const raw = isKisPaper()
    ? (s.kis_paper_account_number || s.kis_account_number || '')
    : (s.kis_account_number || '');
  const [cano, acntPrdtCd] = raw.split('-');
  return { cano: cano || '', acntPrdtCd: acntPrdtCd || '01' };
}

export function hasKisApiKey() {
  const s = loadSecrets();
  if (isKisPaper()) return !!(s.kis_paper_app_key && s.kis_paper_app_key.length > 5);
  return !!(s.kis_app_key && s.kis_app_key.length > 5);
}

export function getKisAppKey() {
  const s = loadSecrets();
  return isKisPaper() ? (s.kis_paper_app_key || '') : (s.kis_app_key || '');
}

export function getKisAppSecret() {
  const s = loadSecrets();
  return isKisPaper() ? (s.kis_paper_app_secret || '') : (s.kis_app_secret || '');
}
