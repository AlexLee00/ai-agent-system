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
import yaml from 'js-yaml';

const _require = createRequire(import.meta.url);
const kst     = _require('../../../packages/core/lib/kst');

const __dirname = dirname(fileURLToPath(import.meta.url));

let _secrets = null;

export function loadSecrets() {
  if (_secrets) return _secrets;

  // config.yaml 우선
  try {
    const c = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8'));
    _secrets = {
      telegram_bot_token:   c.telegram?.bot_token  || '',
      telegram_chat_id:     String(c.telegram?.chat_id || '***REMOVED***'),
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
      kis_paper_trading:    c.kis?.paper_trading   !== false,
      kis_symbols:          c.kis?.symbols          || [],  // 아르고스 동적 선정
      kis_overseas_symbols: c.kis?.overseas_symbols || [],  // 아르고스 동적 선정
      // LLM
      anthropic_api_key:    c.anthropic?.api_key   || '',
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
      paper_mode: c.paper_mode !== false,
    };
    return _secrets;
  } catch { /* config.yaml 없음 */ }

  // secrets.json fallback
  try {
    _secrets = JSON.parse(readFileSync(join(__dirname, '..', 'secrets.json'), 'utf8'));
    return _secrets;
  } catch {
    console.warn('⚠️ config.yaml / secrets.json 없음 — PAPER_MODE=true 기본값');
    _secrets = { paper_mode: true, binance_symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'] };
    return _secrets;
  }
}

// ─── PAPER_MODE ─────────────────────────────────────────────────────

export function isPaperMode() {
  if (process.env.PAPER_MODE === 'false') return false;
  if (process.env.PAPER_MODE === 'true')  return true;
  const s = loadSecrets();
  if (s.paper_mode === false) return false;
  return true;
}

export function isTestnet() {
  const s = loadSecrets();
  return s.binance_testnet === true || process.env.BINANCE_TESTNET === 'true';
}

// ─── 심볼 헬퍼 ─────────────────────────────────────────────────────

export function getSymbols() {
  return loadSecrets().binance_symbols || ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT'];
}

export function getKisSymbols() {
  return loadSecrets().kis_symbols || ['005930', '000660'];
}

export function getKisOverseasSymbols() {
  return loadSecrets().kis_overseas_symbols || ['AAPL', 'TSLA', 'NVDA'];
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

/**
 * 해당 날짜가 NYSE 휴장일인지 확인
 * @param {Date} [date]
 * @returns {{ isHoliday: boolean, name: string|null }}
 */
export function isNyseHoliday(date = new Date()) {
  const dateStr = date.toISOString().slice(0, 10); // UTC 기준 (NYSE는 ET, 하루 단위로 충분)
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
  const kst     = new Date(date.getTime() + 9 * 3600 * 1000);
  const dateStr = kst.toISOString().slice(0, 10);

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
  const kstOffset  = 9 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);
  const kstDay     = new Date(now.getTime() + kstOffset * 60000).getUTCDay();
  if (kstDay === 0 || kstDay === 6) return false;
  return kstMinutes >= 9 * 60 && kstMinutes < 15 * 60 + 30;
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
  const utcDay     = now.getUTCDay();
  if (utcDay === 0 || utcDay === 6) return false;
  if (isNyseHoliday(now).isHoliday)  return false;
  const isDST    = isUsDST(now);
  const openUtc  = isDST ? 13 * 60 + 30 : 14 * 60 + 30;
  const closeUtc = isDST ? 20 * 60       : 21 * 60;
  return utcMinutes >= openUtc && utcMinutes < closeUtc;
}

// ─── KIS 헬퍼 ───────────────────────────────────────────────────────

export function isKisPaper() {
  return loadSecrets().kis_paper_trading !== false;
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
