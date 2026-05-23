// @ts-nocheck
// Domestic official reference layer for Luna.
// KRX/Data.go.kr are used as read-only reference sources, not as live execution feeds.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const hubClient = require('../../../packages/core/lib/hub-client');

export const DOMESTIC_OFFICIAL_REFERENCE_SOURCE = 'krx_data_go_kr_official_reference';
export const DOMESTIC_OFFICIAL_REFERENCE_BLOCK_SOURCE = 'pre_entry/domestic_official_reference';
export const DEFAULT_DOMESTIC_OFFICIAL_MIN_TURNOVER_KRW = 1_000_000_000;
export const DEFAULT_DOMESTIC_OFFICIAL_MIN_LISTING_AGE_DAYS = 90;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_CACHE_FILE = resolve(INVESTMENT_ROOT, 'output', 'luna-domestic-official-reference-cache.json');
const KRX_STOCK_BASE_URL = 'http://data-dbg.krx.co.kr/svc/apis/sto';
const DATA_GO_STOCK_PRICE_URL = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';
const DATA_GO_KRX_LISTED_INFO_URL = 'https://apis.data.go.kr/1160100/service/GetKrxListedInfoService/getItemInfo';
const DATA_GO_CORPORATE_FINANCE_URL = 'https://apis.data.go.kr/1160100/service/GetFinaStatInfoService_V2/getSummFinaStat_V2';
const DATA_GO_COMPANY_BASIC_URLS = [
  'https://apis.data.go.kr/1160100/service/GetCorpBasicInfoService_V2/getCorpOutline_V2',
  'http://apis.data.go.kr/1160100/service/GetCorpBasicInfoService_V2/getCorpOutline_V2',
  'https://apis.data.go.kr/1160100/service/GetCorpBasicInfoService/getCorpOutline',
  'http://apis.data.go.kr/1160100/service/GetCorpBasicInfoService/getCorpOutline',
];
const DATA_GO_STOCK_PRICE_PAGE_SIZE = 1000;
const DATA_GO_KRX_LISTED_INFO_PAGE_SIZE = 1000;
const DEFAULT_REFERENCE_LOOKBACK_DAYS = 7;
const DEFAULT_CORPORATE_FINANCE_PROBE_CRNO = '1746110000741';
const DEFAULT_CORPORATE_FINANCE_PROBE_BIZ_YEAR = '2019';
const DEFAULT_COMPANY_BASIC_PROBE_CRNO = '1301110006246';

let cachedReference = null;
let cachedHubSecrets = null;

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function num(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const normalized = typeof value === 'string'
    ? value.replace(/[,\s]/g, '').replace(/^[-–]$/u, '')
    : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value, fallback = '') {
  return String(value ?? fallback ?? '').trim();
}

function secretText(value) {
  const normalized = text(value);
  return /^<[^>]+>$/u.test(normalized) ? '' : normalized;
}

function upper(value) {
  return text(value).toUpperCase();
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function valueOf(row = {}, keys = []) {
  for (const key of keys) {
    if (row[key] != null && row[key] !== '') return row[key];
  }
  return null;
}

function nestedValueOf(source = {}, paths = []) {
  for (const path of paths) {
    const value = String(path)
      .split('.')
      .reduce((current, key) => (current && typeof current === 'object' ? current[key] : undefined), source);
    if (value != null && value !== '') return value;
  }
  return null;
}

async function loadHubOfficialReferenceSecrets(timeoutMs = 3000) {
  if (cachedHubSecrets) return cachedHubSecrets;
  try {
    const directCategoryEnabled = bool(process.env.LUNA_OFFICIAL_MARKET_REFERENCE_DIRECT_SECRET_CATEGORY, false);
    const officialPromise = directCategoryEnabled
      ? hubClient.fetchHubSecrets('official_market_reference', timeoutMs).catch(() => null)
      : Promise.resolve(null);
    const [official, config, reservation] = await Promise.all([
      officialPromise,
      hubClient.fetchHubSecrets('config', timeoutMs).catch(() => null),
      hubClient.fetchHubSecrets('reservation', timeoutMs).catch(() => null),
    ]);
    cachedHubSecrets = { official: official || {}, config: config || {}, reservation: reservation || {} };
  } catch {
    cachedHubSecrets = { official: {}, config: {}, reservation: {} };
  }
  return cachedHubSecrets;
}

export async function resolveDomesticOfficialReferenceCredentials(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  let krxAuthKey = secretText(options.krxAuthKey || process.env.KRX_OPENAPI_AUTH_KEY || process.env.KRX_OPEN_API_AUTH_KEY || process.env.KRX_AUTH_KEY);
  let stockPriceServiceKey = secretText(options.dataGoKrStockPriceServiceKey || options.stockPriceServiceKey || process.env.DATA_GO_KR_STOCK_PRICE_SERVICE_KEY || process.env.PUBLIC_DATA_STOCK_PRICE_SERVICE_KEY);
  let krxListedInfoServiceKey = secretText(options.dataGoKrKrxListedInfoServiceKey || options.krxListedInfoServiceKey || process.env.DATA_GO_KR_KRX_LISTED_INFO_SERVICE_KEY || process.env.PUBLIC_DATA_KRX_LISTED_INFO_SERVICE_KEY);
  let corporateFinanceServiceKey = secretText(options.corporateFinanceServiceKey || process.env.DATA_GO_KR_CORPORATE_FINANCE_SERVICE_KEY || process.env.PUBLIC_DATA_CORPORATE_FINANCE_SERVICE_KEY);
  let companyBasicServiceKey = secretText(options.companyBasicServiceKey || options.dataGoKrCompanyBasicServiceKey || process.env.DATA_GO_KR_COMPANY_BASIC_SERVICE_KEY || process.env.PUBLIC_DATA_COMPANY_BASIC_SERVICE_KEY);
  let krxAuthKeySource = krxAuthKey ? 'env' : null;
  let stockPriceServiceKeySource = stockPriceServiceKey ? 'env' : null;
  let krxListedInfoServiceKeySource = krxListedInfoServiceKey ? 'env' : null;
  let corporateFinanceServiceKeySource = corporateFinanceServiceKey ? 'env' : null;
  let companyBasicServiceKeySource = companyBasicServiceKey ? 'env' : null;

  if (!krxAuthKey || !stockPriceServiceKey || !krxListedInfoServiceKey || !corporateFinanceServiceKey || !companyBasicServiceKey) {
    const hub = await loadHubOfficialReferenceSecrets(timeoutMs);
    const official = hub.official || {};
    const config = hub.config || {};
    const reservation = hub.reservation || {};
    if (!krxAuthKey) {
      const value = nestedValueOf(official, [
        'krx_openapi_auth_key',
        'krx_open_api_auth_key',
        'krx_auth_key',
        'krx.openapi_auth_key',
        'krx.auth_key',
      ]) || nestedValueOf(config, [
        'official_market_reference.krx_openapi_auth_key',
        'official_market_reference.krx_open_api_auth_key',
        'official_market_reference.krx_auth_key',
        'official_market_reference.krx.openapi_auth_key',
        'official_market_reference.krx.auth_key',
        'krx.openapi_auth_key',
        'krx.open_api_auth_key',
        'krx.openapi_auth_key',
        'krx.auth_key',
        'data_go_kr.krx_openapi_auth_key',
        'public_data.krx_openapi_auth_key',
        'news.krx_openapi_auth_key',
      ]);
      krxAuthKey = secretText(value);
      krxAuthKeySource = krxAuthKey ? (nestedValueOf(official, ['krx_openapi_auth_key', 'krx_open_api_auth_key', 'krx_auth_key', 'krx.openapi_auth_key', 'krx.auth_key']) ? 'hub:official_market_reference' : 'hub:config.official_market_reference') : null;
    }
    if (!stockPriceServiceKey) {
      const value = nestedValueOf(official, [
        'data_go_kr_stock_price_service_key',
        'stock_price_service_key',
        'data_go_kr.stock_price_service_key',
      ]) || nestedValueOf(config, [
        'official_market_reference.data_go_kr_stock_price_service_key',
        'official_market_reference.stock_price_service_key',
        'official_market_reference.data_go_kr.stock_price_service_key',
        'data_go_kr.stock_price_service_key',
        'data_go_kr.stock_service_key',
        'public_data.stock_price_service_key',
        'public_data.stock_service_key',
        'reservation.datagokr_stock_key',
      ]) || nestedValueOf(reservation, [
        'datagokr_stock_key',
      ]);
      stockPriceServiceKey = secretText(value);
      stockPriceServiceKeySource = stockPriceServiceKey ? (nestedValueOf(official, ['data_go_kr_stock_price_service_key', 'stock_price_service_key', 'data_go_kr.stock_price_service_key']) ? 'hub:official_market_reference' : 'hub:config/reservation') : null;
    }
    if (!krxListedInfoServiceKey) {
      const value = nestedValueOf(official, [
        'data_go_kr_krx_listed_info_service_key',
        'krx_listed_info_service_key',
        'listed_info_service_key',
        'data_go_kr.krx_listed_info_service_key',
        'data_go_kr.listed_info_service_key',
      ]) || nestedValueOf(config, [
        'official_market_reference.data_go_kr_krx_listed_info_service_key',
        'official_market_reference.krx_listed_info_service_key',
        'official_market_reference.listed_info_service_key',
        'official_market_reference.data_go_kr.krx_listed_info_service_key',
        'official_market_reference.data_go_kr.listed_info_service_key',
        'data_go_kr.krx_listed_info_service_key',
        'data_go_kr.listed_info_service_key',
        'public_data.krx_listed_info_service_key',
        'public_data.listed_info_service_key',
        'reservation.datagokr_krx_listed_info_key',
      ]) || nestedValueOf(reservation, [
        'datagokr_krx_listed_info_key',
      ]);
      krxListedInfoServiceKey = secretText(value);
      krxListedInfoServiceKeySource = krxListedInfoServiceKey ? (nestedValueOf(official, ['data_go_kr_krx_listed_info_service_key', 'krx_listed_info_service_key', 'listed_info_service_key', 'data_go_kr.krx_listed_info_service_key', 'data_go_kr.listed_info_service_key']) ? 'hub:official_market_reference' : 'hub:config/reservation') : null;
    }
    if (!corporateFinanceServiceKey) {
      const value = nestedValueOf(official, [
        'data_go_kr_corporate_finance_service_key',
        'corporate_finance_service_key',
        'company_finance_service_key',
        'data_go_kr.corporate_finance_service_key',
        'data_go_kr.company_finance_service_key',
      ]) || nestedValueOf(config, [
        'official_market_reference.data_go_kr_corporate_finance_service_key',
        'official_market_reference.corporate_finance_service_key',
        'official_market_reference.company_finance_service_key',
        'official_market_reference.data_go_kr.corporate_finance_service_key',
        'official_market_reference.data_go_kr.company_finance_service_key',
        'data_go_kr.corporate_finance_service_key',
        'data_go_kr.company_finance_service_key',
        'public_data.corporate_finance_service_key',
        'public_data.company_finance_service_key',
        'reservation.datagokr_corporate_finance_key',
      ]) || nestedValueOf(reservation, [
        'datagokr_corporate_finance_key',
      ]);
      corporateFinanceServiceKey = secretText(value);
      corporateFinanceServiceKeySource = corporateFinanceServiceKey ? (nestedValueOf(official, ['data_go_kr_corporate_finance_service_key', 'corporate_finance_service_key', 'company_finance_service_key', 'data_go_kr.corporate_finance_service_key', 'data_go_kr.company_finance_service_key']) ? 'hub:official_market_reference' : 'hub:config/reservation') : null;
    }
    if (!companyBasicServiceKey) {
      const value = nestedValueOf(official, [
        'data_go_kr_company_basic_service_key',
        'company_basic_service_key',
        'company_info_service_key',
        'corporate_basic_service_key',
        'data_go_kr.company_basic_service_key',
        'data_go_kr.company_info_service_key',
      ]) || nestedValueOf(config, [
        'official_market_reference.data_go_kr_company_basic_service_key',
        'official_market_reference.company_basic_service_key',
        'official_market_reference.company_info_service_key',
        'official_market_reference.corporate_basic_service_key',
        'official_market_reference.data_go_kr.company_basic_service_key',
        'official_market_reference.data_go_kr.company_info_service_key',
        'data_go_kr.company_basic_service_key',
        'data_go_kr.company_info_service_key',
        'public_data.company_basic_service_key',
        'public_data.company_info_service_key',
        'reservation.datagokr_company_basic_key',
      ]) || nestedValueOf(reservation, [
        'datagokr_company_basic_key',
      ]);
      companyBasicServiceKey = secretText(value);
      companyBasicServiceKeySource = companyBasicServiceKey ? (nestedValueOf(official, ['data_go_kr_company_basic_service_key', 'company_basic_service_key', 'company_info_service_key', 'corporate_basic_service_key', 'data_go_kr.company_basic_service_key', 'data_go_kr.company_info_service_key']) ? 'hub:official_market_reference' : 'hub:config/reservation') : null;
    }
  }

  return {
    krxAuthKey,
    stockPriceServiceKey,
    krxListedInfoServiceKey,
    corporateFinanceServiceKey,
    companyBasicServiceKey,
    status: {
      krxConfigured: Boolean(krxAuthKey),
      stockPriceConfigured: Boolean(stockPriceServiceKey),
      krxListedInfoConfigured: Boolean(krxListedInfoServiceKey),
      corporateFinanceConfigured: Boolean(corporateFinanceServiceKey),
      companyBasicConfigured: Boolean(companyBasicServiceKey),
      krxAuthKeySource,
      stockPriceServiceKeySource,
      krxListedInfoServiceKeySource,
      corporateFinanceServiceKeySource,
      companyBasicServiceKeySource,
    },
  };
}

export async function resolveDomesticOfficialReferenceCredentialStatus(options = {}) {
  const credentials = await resolveDomesticOfficialReferenceCredentials(options);
  return credentials.status;
}

function yyyymmddKst(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date).replace(/-/g, '');
}

function addDaysYyyymmdd(value, deltaDays) {
  const raw = text(value);
  if (!/^\d{8}$/u.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day + Number(deltaDays || 0)));
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function parseYyyymmddMs(value) {
  const raw = text(value);
  if (!/^\d{8}$/u.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const ms = Date.UTC(year, month - 1, day);
  return Number.isFinite(ms) ? ms : null;
}

function daysBetweenYyyymmdd(start, end) {
  const startMs = parseYyyymmddMs(start);
  const endMs = parseYyyymmddMs(end);
  if (startMs == null || endMs == null) return null;
  return Math.floor((endMs - startMs) / 86_400_000);
}

function isWeekendYyyymmdd(value) {
  const ms = parseYyyymmddMs(value);
  if (ms == null) return false;
  const day = new Date(ms).getUTCDay();
  return day === 0 || day === 6;
}

function recentBaseDates(startBasDd, lookbackDays = DEFAULT_REFERENCE_LOOKBACK_DAYS) {
  const first = text(startBasDd || yyyymmddKst());
  const days = Math.max(0, Math.min(30, Number(lookbackDays || DEFAULT_REFERENCE_LOOKBACK_DAYS)));
  return Array.from({ length: days + 1 }, (_, index) => addDaysYyyymmdd(first, -index)).filter(Boolean);
}

function historicalBaseDates(startBasDd, lookbackDays = 365) {
  const first = text(startBasDd || yyyymmddKst());
  const days = Math.max(0, Math.min(550, Number(lookbackDays || 365)));
  return Array.from({ length: days + 1 }, (_, index) => addDaysYyyymmdd(first, -index)).filter(Boolean);
}

export function normalizeDomesticOfficialSymbol(value = '') {
  const raw = text(value).toUpperCase();
  const compact = raw.replace(/[^0-9A-Z]/gu, '');
  const compactMatch = compact.match(/^A?(\d{6})$/u);
  if (compactMatch) return compactMatch[1];
  const match = raw.match(/\b(\d{6})\b/u);
  return match ? match[1] : null;
}

function normalizeMarketName(row = {}) {
  return text(valueOf(row, ['MKT_TP_NM', 'MKT_NM', 'mrktCtg', 'market', 'marketName']), 'UNKNOWN');
}

function normalizeOfficialRow(raw = {}, source = 'unknown') {
  const symbol = normalizeDomesticOfficialSymbol(valueOf(raw, [
    'ISU_SRT_CD',
    'isuSrtCd',
    'srtnCd',
    'stockCode',
    'symbol',
    'code',
  ]));
  if (!symbol) return null;

  const name = text(valueOf(raw, [
    'ISU_ABBRV',
    'ISU_NM',
    'isuAbbrv',
    'isuNm',
    'itmsNm',
    'stockName',
    'name',
  ]), symbol);
  const securityGroup = text(valueOf(raw, ['SECUGRP_NM', 'secugrpNm', 'secuGrpNm', 'securityGroup']));
  const stockCertificateType = text(valueOf(raw, ['KIND_STKCERT_TP_NM', 'kindStkcertTpNm', 'stockCertificateType']));
  const sectorType = text(valueOf(raw, ['SECT_TP_NM', 'sectTpNm', 'sectorType']));
  const market = normalizeMarketName(raw);
  const listedShares = num(valueOf(raw, ['LIST_SHRS', 'lstgStCnt', 'listedShares']), null);
  const price = num(valueOf(raw, ['TDD_CLSPRC', 'clpr', 'closePrice', 'price']), null);
  const open = num(valueOf(raw, ['TDD_OPNPRC', 'mkp', 'openPrice']), null);
  const high = num(valueOf(raw, ['TDD_HGPRC', 'hipr', 'highPrice']), null);
  const low = num(valueOf(raw, ['TDD_LWPRC', 'lopr', 'lowPrice']), null);
  const volume = num(valueOf(raw, ['ACC_TRDVOL', 'trqu', 'volume']), null);
  const turnoverKrw = num(valueOf(raw, ['ACC_TRDVAL', 'trPrc', 'turnoverKrw']), null);
  const marketCap = num(valueOf(raw, ['MKTCAP', 'mrktTotAmt', 'marketCap']), null);
  const changeRate = num(valueOf(raw, ['FLUC_RT', 'fltRt', 'changeRate']), null);
  const baseDate = text(valueOf(raw, ['BAS_DD', 'basDt', 'baseDate']));
  const isin = text(valueOf(raw, ['ISU_CD', 'isinCd', 'isuCd', 'isin']));
  const listedDate = text(valueOf(raw, ['LIST_DD', 'listDd', 'listedDate']));
  const crno = text(valueOf(raw, ['crno', 'CRNO', 'corporateRegistrationNumber']));

  const statusText = [
    valueOf(raw, ['TRD_STOP_YN', 'trdStopYn', 'tradingHalt', 'haltYn']),
    valueOf(raw, ['MNG_ISSUE_YN', 'mngIssueYn', 'adminIssue']),
    valueOf(raw, ['DLST_YN', 'dlstYn', 'delistingYn']),
    valueOf(raw, ['status', 'stockStatus']),
  ].map(text).join(' ');

  return {
    symbol,
    name,
    market,
    isin,
    securityGroup,
    stockCertificateType,
    sectorType,
    listedDate,
    listedShares,
    price,
    open,
    high,
    low,
    volume,
    turnoverKrw,
    marketCap,
    changeRate,
    baseDate,
    crno,
    sources: [source],
    rawRefs: [{ source, row: raw }],
    tradingHalt: /Y|YES|TRUE|거래정지|정지/u.test(statusText),
    adminIssue: /관리|ADMIN|MNG|TRUE|Y/u.test(text(valueOf(raw, ['MNG_ISSUE_YN', 'mngIssueYn', 'adminIssue']))),
    delistingRisk: /상장폐지|정리매매|DLST|DELIST/u.test(statusText),
  };
}

function mergeReferenceRows(prev, next) {
  if (!prev) return next;
  const mergedValues = {};
  for (const [key, value] of Object.entries(next)) {
    if (value == null || value === '') continue;
    if (key === 'name' && prev.name && value === next.symbol) continue;
    if (key === 'market' && prev.market && value === 'UNKNOWN') continue;
    if (key === 'securityGroup' && prev.securityGroup && !value) continue;
    if (key === 'stockCertificateType' && prev.stockCertificateType && !value) continue;
    mergedValues[key] = value;
  }
  return {
    ...prev,
    ...mergedValues,
    sources: unique([...(prev.sources || []), ...(next.sources || [])]),
    rawRefs: [...(prev.rawRefs || []), ...(next.rawRefs || [])].slice(-8),
    tradingHalt: prev.tradingHalt || next.tradingHalt,
    adminIssue: prev.adminIssue || next.adminIssue,
    delistingRisk: prev.delistingRisk || next.delistingRisk,
  };
}

function isPreferredStock(row = {}) {
  const combined = `${row.name || ''} ${row.stockCertificateType || ''}`.toUpperCase();
  return /우선|우$|우B|PREFERRED|PREF/u.test(combined);
}

function isSpac(row = {}) {
  const combined = `${row.name || ''} ${row.securityGroup || ''} ${row.sectorType || ''}`.toUpperCase();
  return /스팩|SPAC/u.test(combined);
}

function securityTypeBlocker(row = {}) {
  const combined = `${row.name || ''} ${row.securityGroup || ''} ${row.stockCertificateType || ''} ${row.sectorType || ''}`.toUpperCase();
  if (/ETF/u.test(combined)) return 'security_type_etf';
  if (/ETN/u.test(combined)) return 'security_type_etn';
  if (/ELW/u.test(combined)) return 'security_type_elw';
  if (/REIT|리츠|부동산투자/u.test(combined)) return 'security_type_reit';
  if (isSpac(row)) return 'security_type_spac';
  if (isPreferredStock(row)) return 'security_type_preferred_stock';
  if (row.securityGroup && !/주권|STOCK|COMMON/u.test(combined)) return 'security_type_not_common_stock';
  if (row.stockCertificateType && !/보통|COMMON/u.test(combined)) return 'security_type_not_common_stock';
  return null;
}

export function classifyDomesticOfficialReferenceRow(row = {}, options = {}) {
  const blockers = [];
  const minTurnoverKrw = Math.max(0, Number(options.minTurnoverKrw ?? process.env.LUNA_DOMESTIC_OFFICIAL_MIN_TURNOVER_KRW ?? DEFAULT_DOMESTIC_OFFICIAL_MIN_TURNOVER_KRW));
  const minListingAgeDays = Math.max(0, Number(options.minListingAgeDays ?? process.env.LUNA_DOMESTIC_OFFICIAL_MIN_LISTING_AGE_DAYS ?? DEFAULT_DOMESTIC_OFFICIAL_MIN_LISTING_AGE_DAYS));
  if (!normalizeDomesticOfficialSymbol(row.symbol)) blockers.push('invalid_domestic_symbol');
  if (row.tradingHalt) blockers.push('trading_halt_or_suspended');
  if (row.adminIssue) blockers.push('admin_issue');
  if (row.delistingRisk) blockers.push('delisting_risk');
  const typeBlocker = securityTypeBlocker(row);
  if (typeBlocker) blockers.push(typeBlocker);
  if (row.turnoverKrw != null && minTurnoverKrw > 0 && Number(row.turnoverKrw || 0) < minTurnoverKrw) {
    blockers.push('turnover_below_official_floor');
  }
  if (row.listedDate && row.listingAgeDays != null && minListingAgeDays > 0 && Number(row.listingAgeDays) < minListingAgeDays) {
    blockers.push('listing_history_too_short');
  }
  return unique(blockers);
}

export function buildDomesticOfficialReference({
  baseInfoRows = [],
  dailyTradeRows = [],
  publicPriceRows = [],
  krxListedInfoRows = [],
  ksdRows = [],
  fetchedAt = new Date().toISOString(),
  baseDate = null,
  source = DOMESTIC_OFFICIAL_REFERENCE_SOURCE,
  fixture = false,
  minTurnoverKrw = DEFAULT_DOMESTIC_OFFICIAL_MIN_TURNOVER_KRW,
  minListingAgeDays = DEFAULT_DOMESTIC_OFFICIAL_MIN_LISTING_AGE_DAYS,
} = {}) {
  const bySymbol = new Map();
  const inputGroups = [
    ['krx_base_info', baseInfoRows],
    ['krx_daily_trade', dailyTradeRows],
    ['data_go_kr_stock_price', publicPriceRows],
    ['data_go_kr_krx_listed_info', krxListedInfoRows],
    ['ksd_stock_info', ksdRows],
  ];

  for (const [groupSource, rows] of inputGroups) {
    for (const raw of Array.isArray(rows) ? rows : []) {
      const normalized = normalizeOfficialRow(raw, groupSource);
      if (!normalized) continue;
      bySymbol.set(normalized.symbol, mergeReferenceRows(bySymbol.get(normalized.symbol), normalized));
    }
  }

  const rows = Array.from(bySymbol.values()).map((row) => {
    const listingAgeDays = daysBetweenYyyymmdd(row.listedDate, row.baseDate || baseDate || yyyymmddKst());
    const enriched = {
      ...row,
      listingAgeDays,
    };
    const blockers = classifyDomesticOfficialReferenceRow(enriched, { minTurnoverKrw, minListingAgeDays });
    return {
      ...enriched,
      officialEligible: blockers.length === 0,
      officialBlockers: blockers,
    };
  });
  const ranked = rows
    .filter((row) => Number(row.turnoverKrw || 0) > 0)
    .sort((a, b) => Number(b.turnoverKrw || 0) - Number(a.turnoverKrw || 0));
  const turnoverRanks = {};
  ranked.forEach((row, index) => {
    turnoverRanks[row.symbol] = index + 1;
  });

  return {
    source,
    fetchedAt,
    baseDate: baseDate || rows.find((row) => row.baseDate)?.baseDate || null,
    fixture,
    available: rows.length > 0,
    fullUniverse: fixture || baseInfoRows.length >= 100 || rows.length >= 100,
    minTurnoverKrw,
    minListingAgeDays,
    rows,
    symbols: rows.map((row) => row.symbol).sort(),
    bySymbol: Object.fromEntries(rows.map((row) => [row.symbol, row])),
    turnoverRanks,
    excluded: {
      ineligibleCount: rows.filter((row) => !row.officialEligible).length,
      byReason: rows.reduce((acc, row) => {
        for (const reason of row.officialBlockers || []) acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {}),
    },
    resources: {
      krxBaseInfoRows: baseInfoRows.length,
      krxDailyTradeRows: dailyTradeRows.length,
      publicPriceRows: publicPriceRows.length,
      krxListedInfoRows: krxListedInfoRows.length,
      ksdRows: ksdRows.length,
    },
  };
}

export function buildUnavailableDomesticOfficialReference(reason = 'official_reference_unavailable') {
  return {
    source: DOMESTIC_OFFICIAL_REFERENCE_SOURCE,
    fetchedAt: new Date().toISOString(),
    baseDate: null,
    fixture: false,
    available: false,
    fullUniverse: false,
    minTurnoverKrw: DEFAULT_DOMESTIC_OFFICIAL_MIN_TURNOVER_KRW,
    minListingAgeDays: DEFAULT_DOMESTIC_OFFICIAL_MIN_LISTING_AGE_DAYS,
    rows: [],
    symbols: [],
    bySymbol: {},
    turnoverRanks: {},
    excluded: { ineligibleCount: 0, byReason: {} },
    resources: {},
    unavailableReason: reason,
  };
}

export function buildFixtureDomesticOfficialReference() {
  return buildDomesticOfficialReference({
    fixture: true,
    baseDate: '20260520',
    baseInfoRows: [
      { ISU_SRT_CD: '005930', ISU_ABBRV: '삼성전자', MKT_TP_NM: 'KOSPI', SECUGRP_NM: '주권', KIND_STKCERT_TP_NM: '보통주', LIST_SHRS: '5969782550' },
      { ISU_SRT_CD: '000660', ISU_ABBRV: 'SK하이닉스', MKT_TP_NM: 'KOSPI', SECUGRP_NM: '주권', KIND_STKCERT_TP_NM: '보통주', LIST_SHRS: '728002365' },
      { ISU_SRT_CD: '069500', ISU_ABBRV: 'KODEX 200', MKT_TP_NM: 'KOSPI', SECUGRP_NM: 'ETF', KIND_STKCERT_TP_NM: '수익증권' },
      { ISU_SRT_CD: '005935', ISU_ABBRV: '삼성전자우', MKT_TP_NM: 'KOSPI', SECUGRP_NM: '주권', KIND_STKCERT_TP_NM: '우선주' },
      { ISU_SRT_CD: '123450', ISU_ABBRV: '테스트스팩', MKT_TP_NM: 'KOSDAQ', SECUGRP_NM: '주권', KIND_STKCERT_TP_NM: '보통주' },
      { ISU_SRT_CD: '000020', ISU_ABBRV: '동화약품', MKT_TP_NM: 'KOSPI', SECUGRP_NM: '주권', KIND_STKCERT_TP_NM: '보통주' },
      { ISU_SRT_CD: '111111', ISU_ABBRV: '거래정지테스트', MKT_TP_NM: 'KOSPI', SECUGRP_NM: '주권', KIND_STKCERT_TP_NM: '보통주', TRD_STOP_YN: 'Y' },
      { ISU_SRT_CD: '477850', ISU_ABBRV: '마키나락스', MKT_TP_NM: 'KOSDAQ', SECUGRP_NM: '주권', SECT_TP_NM: '기술성장기업부', KIND_STKCERT_TP_NM: '보통주', LIST_DD: '20260520', LIST_SHRS: '17541640' },
    ],
    dailyTradeRows: [
      { ISU_SRT_CD: '005930', TDD_CLSPRC: '80000', ACC_TRDVOL: '20000000', ACC_TRDVAL: '1600000000000', FLUC_RT: '1.2' },
      { ISU_SRT_CD: '000660', TDD_CLSPRC: '180000', ACC_TRDVOL: '5000000', ACC_TRDVAL: '900000000000', FLUC_RT: '2.1' },
      { ISU_SRT_CD: '069500', TDD_CLSPRC: '40000', ACC_TRDVOL: '1000000', ACC_TRDVAL: '40000000000', FLUC_RT: '0.3' },
      { ISU_SRT_CD: '005935', TDD_CLSPRC: '65000', ACC_TRDVOL: '1000000', ACC_TRDVAL: '65000000000', FLUC_RT: '0.4' },
      { ISU_SRT_CD: '123450', TDD_CLSPRC: '2100', ACC_TRDVOL: '2000000', ACC_TRDVAL: '4200000000', FLUC_RT: '0.1' },
      { ISU_SRT_CD: '000020', TDD_CLSPRC: '9000', ACC_TRDVOL: '50000', ACC_TRDVAL: '450000000', FLUC_RT: '-0.2' },
      { ISU_SRT_CD: '111111', TDD_CLSPRC: '1000', ACC_TRDVOL: '0', ACC_TRDVAL: '0', FLUC_RT: '0' },
      { ISU_SRT_CD: '477850', TDD_CLSPRC: '60000', ACC_TRDVOL: '569912', ACC_TRDVAL: '34194720000', FLUC_RT: '300' },
    ],
    krxListedInfoRows: [
      { srtnCd: 'A005930', itmsNm: '삼성전자', basDt: '20260520', crno: '1301110006246', corpNm: '삼성전자(주)', mrktCtg: 'KOSPI' },
      { srtnCd: 'A000660', itmsNm: 'SK하이닉스', basDt: '20260520', crno: '1101110006167', corpNm: '에스케이하이닉스(주)', mrktCtg: 'KOSPI' },
      { srtnCd: 'A477850', itmsNm: '마키나락스', basDt: '20260520', crno: '1101116605856', corpNm: '(주)마키나락스', mrktCtg: 'KOSDAQ' },
    ],
  });
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.OutBlock_1)) return payload.OutBlock_1;
  if (Array.isArray(payload.output)) return payload.output;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  const item = payload?.response?.body?.items?.item;
  if (Array.isArray(item)) return item;
  if (item && typeof item === 'object') return [item];
  return [];
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'LunaDomesticOfficialReference/1.0',
        ...(options.headers || {}),
      },
      body: options.body,
    });
    const bodyText = await res.text();
    let payload = null;
    try {
      payload = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const detail = text(payload?.respMsg || payload?.response?.header?.resultMsg || bodyText.slice(0, 120));
      throw new Error(`HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchKrxRows({ endpoint, authKey, basDd, timeoutMs }) {
  const baseUrl = text(process.env.KRX_OPENAPI_BASE_URL || KRX_STOCK_BASE_URL).replace(/\/$/u, '');
  const payload = await fetchJson(`${baseUrl}${endpoint}?basDd=${encodeURIComponent(basDd)}`, {
    method: 'GET',
    timeoutMs,
    headers: {
      'AUTH_KEY': text(authKey),
    },
  });
  return extractRows(payload);
}

async function fetchKrxOfficialReferenceRowsForDate({ authKey, basDd, timeoutMs }) {
  const endpoints = [
    ['/stk_isu_base_info', 'baseInfoRows'],
    ['/ksq_isu_base_info', 'baseInfoRows'],
    ['/knx_isu_base_info', 'baseInfoRows'],
    ['/stk_bydd_trd', 'dailyTradeRows'],
    ['/ksq_bydd_trd', 'dailyTradeRows'],
    ['/knx_bydd_trd', 'dailyTradeRows'],
  ];
  const out = { baseInfoRows: [], dailyTradeRows: [], errors: [] };
  for (const [endpoint, bucket] of endpoints) {
    try {
      const rows = await fetchKrxRows({ endpoint, authKey, basDd, timeoutMs });
      out[bucket].push(...rows);
    } catch (error) {
      out.errors.push(`${endpoint}:${error?.message || error}`);
    }
  }
  return out;
}

async function fetchKrxOfficialReferenceRows({ authKey, basDd, timeoutMs, lookbackDays = DEFAULT_REFERENCE_LOOKBACK_DAYS }) {
  if (!authKey) return { baseInfoRows: [], dailyTradeRows: [], baseDate: basDd, lookbackDays: 0, errors: ['krx_auth_key_missing'] };
  const errors = [];
  const emptyDates = [];
  const dates = recentBaseDates(basDd, lookbackDays);
  for (let index = 0; index < dates.length; index += 1) {
    const candidateBasDd = dates[index];
    const result = await fetchKrxOfficialReferenceRowsForDate({ authKey, basDd: candidateBasDd, timeoutMs });
    errors.push(...(result.errors || []));
    if ((result.baseInfoRows.length + result.dailyTradeRows.length) > 0) {
      return {
        ...result,
        baseDate: candidateBasDd,
        lookbackDays: index,
        emptyDates,
        errors,
      };
    }
    emptyDates.push(candidateBasDd);
  }
  errors.push(...emptyDates.map((date) => `krx_openapi:${date}:empty_result`));
  return { baseInfoRows: [], dailyTradeRows: [], baseDate: basDd, lookbackDays: 0, errors };
}

async function fetchDataGoStockPriceRowsForDate({ serviceKey, basDd, timeoutMs }) {
  const endpoint = text(process.env.DATA_GO_KR_STOCK_PRICE_URL || DATA_GO_STOCK_PRICE_URL);
  const serviceKeyParam = String(serviceKey).includes('%') ? serviceKey : encodeURIComponent(serviceKey);
  const rows = [];
  let totalCount = null;
  let pageNo = 1;
  let pagesFetched = 0;
  const maxPages = Math.max(1, Math.min(20, Number(process.env.LUNA_DOMESTIC_OFFICIAL_REFERENCE_PUBLIC_MAX_PAGES || 10)));
  while (pageNo <= maxPages) {
    const url = `${endpoint}?serviceKey=${serviceKeyParam}&numOfRows=${DATA_GO_STOCK_PRICE_PAGE_SIZE}&pageNo=${pageNo}&resultType=json&basDt=${encodeURIComponent(basDd)}`;
    const payload = await fetchJson(url, { timeoutMs });
    const resultCode = text(payload?.response?.header?.resultCode);
    const resultMsg = text(payload?.response?.header?.resultMsg);
    if (resultCode && resultCode !== '00') {
      throw new Error(`resultCode=${resultCode}${resultMsg ? ` ${resultMsg}` : ''}`);
    }
    const pageRows = extractRows(payload);
    pagesFetched += 1;
    rows.push(...pageRows);
    totalCount = Number(payload?.response?.body?.totalCount ?? rows.length);
    if (!pageRows.length || rows.length >= totalCount) break;
    pageNo += 1;
  }
  return { rows, totalCount: Number(totalCount || rows.length), pagesFetched };
}

async function fetchDataGoStockPriceRows({ serviceKey, basDd, timeoutMs, lookbackDays = DEFAULT_REFERENCE_LOOKBACK_DAYS }) {
  if (!serviceKey) return { publicPriceRows: [], baseDate: basDd, totalCount: 0, pagesFetched: 0, errors: ['data_go_kr_stock_price_service_key_missing'] };
  const errors = [];
  const emptyDates = [];
  const dates = recentBaseDates(basDd, lookbackDays);
  for (let index = 0; index < dates.length; index += 1) {
    const candidateBasDd = dates[index];
    try {
      const result = await fetchDataGoStockPriceRowsForDate({ serviceKey, basDd: candidateBasDd, timeoutMs });
      if (result.rows.length > 0) {
        return {
          publicPriceRows: result.rows,
          baseDate: candidateBasDd,
          lookbackDays: index,
          totalCount: result.totalCount,
          pagesFetched: result.pagesFetched,
          emptyDates,
          errors,
        };
      }
      emptyDates.push(candidateBasDd);
    } catch (error) {
      errors.push(`data_go_kr_stock_price:${candidateBasDd}:${error?.message || error}`);
    }
  }
  errors.push(...emptyDates.map((date) => `data_go_kr_stock_price:${date}:empty_result`));
  return { publicPriceRows: [], baseDate: basDd, totalCount: 0, pagesFetched: 0, errors };
}

export async function fetchDataGoStockPriceHistoryForSymbol(options = {}) {
  const symbol = normalizeDomesticOfficialSymbol(options.symbol);
  if (!symbol) {
    return { ok: false, symbol: String(options.symbol || ''), rows: [], errors: ['invalid_domestic_symbol'] };
  }
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const credentials = await resolveDomesticOfficialReferenceCredentials({ ...options, timeoutMs });
  const serviceKey = secretText(options.serviceKey || credentials.stockPriceServiceKey);
  if (!serviceKey) {
    return { ok: false, symbol, rows: [], errors: ['data_go_kr_stock_price_service_key_missing'] };
  }
  const endpoint = text(process.env.DATA_GO_KR_STOCK_PRICE_URL || DATA_GO_STOCK_PRICE_URL);
  const serviceKeyParam = String(serviceKey).includes('%') ? serviceKey : encodeURIComponent(serviceKey);
  const endBasDt = text(options.endDate || options.baseDate || yyyymmddKst());
  const lookbackDays = Math.max(1, Math.min(550, Number(options.lookbackDays || 365)));
  const maxRows = Math.max(1, Math.min(400, Number(options.maxRows || lookbackDays + 1)));
  const emptyAfterSeenLimit = Math.max(1, Math.min(30, Number(options.emptyAfterSeenLimit || process.env.LUNA_DATA_GO_STOCK_HISTORY_EMPTY_AFTER_SEEN_LIMIT || 10)));
  const errors = [];
  const rows = [];
  let sawRow = false;
  let emptyAfterSeen = 0;
  for (const basDt of historicalBaseDates(endBasDt, lookbackDays)) {
    if (rows.length >= maxRows) break;
    if (options.skipWeekends !== false && isWeekendYyyymmdd(basDt)) continue;
    try {
      const url = `${endpoint}?serviceKey=${serviceKeyParam}&numOfRows=10&pageNo=1&resultType=json&basDt=${encodeURIComponent(basDt)}&likeSrtnCd=${encodeURIComponent(symbol)}`;
      const payload = await fetchJson(url, { timeoutMs });
      const resultCode = text(payload?.response?.header?.resultCode);
      const resultMsg = text(payload?.response?.header?.resultMsg);
      if (resultCode && resultCode !== '00') {
        errors.push(`data_go_kr_stock_price_history:${basDt}:resultCode=${resultCode}${resultMsg ? ` ${resultMsg}` : ''}`);
        continue;
      }
      const exact = extractRows(payload).find((row) => normalizeDomesticOfficialSymbol(row?.srtnCd || row?.ISU_SRT_CD || row?.symbol) === symbol);
      if (exact) {
        rows.push(exact);
        sawRow = true;
        emptyAfterSeen = 0;
      } else if (sawRow) {
        emptyAfterSeen += 1;
        if (emptyAfterSeen >= emptyAfterSeenLimit) break;
      }
    } catch (error) {
      errors.push(`data_go_kr_stock_price_history:${basDt}:${error?.message || error}`);
    }
  }
  rows.sort((a, b) => text(a?.basDt || a?.BAS_DD).localeCompare(text(b?.basDt || b?.BAS_DD)));
  return {
    ok: rows.length > 0,
    symbol,
    rows,
    rowCount: rows.length,
    requestedEndDate: endBasDt,
    lookbackDays,
    source: 'data_go_kr_stock_price_history',
    keySource: credentials.status.stockPriceServiceKeySource || null,
    errors: errors.slice(0, 20),
  };
}

async function fetchDataGoKrxListedInfoRowsForDate({ serviceKey, basDd, timeoutMs }) {
  const endpoint = text(process.env.DATA_GO_KR_KRX_LISTED_INFO_URL || DATA_GO_KRX_LISTED_INFO_URL);
  const serviceKeyParam = String(serviceKey);
  const rows = [];
  let totalCount = null;
  let pageNo = 1;
  let pagesFetched = 0;
  const maxPages = Math.max(1, Math.min(20, Number(process.env.LUNA_DOMESTIC_OFFICIAL_REFERENCE_LISTED_INFO_MAX_PAGES || 10)));
  while (pageNo <= maxPages) {
    const url = `${endpoint}?serviceKey=${serviceKeyParam}&numOfRows=${DATA_GO_KRX_LISTED_INFO_PAGE_SIZE}&pageNo=${pageNo}&resultType=json&basDt=${encodeURIComponent(basDd)}`;
    const payload = await fetchJson(url, { timeoutMs });
    const resultCode = text(payload?.response?.header?.resultCode);
    const resultMsg = text(payload?.response?.header?.resultMsg);
    if (resultCode && resultCode !== '00') {
      throw new Error(`resultCode=${resultCode}${resultMsg ? ` ${resultMsg}` : ''}`);
    }
    const pageRows = extractRows(payload);
    pagesFetched += 1;
    rows.push(...pageRows);
    totalCount = Number(payload?.response?.body?.totalCount ?? rows.length);
    if (!pageRows.length || rows.length >= totalCount) break;
    pageNo += 1;
  }
  return { rows, totalCount: Number(totalCount || rows.length), pagesFetched };
}

async function fetchDataGoKrxListedInfoRows({ serviceKey, basDd, timeoutMs, lookbackDays = DEFAULT_REFERENCE_LOOKBACK_DAYS }) {
  if (!serviceKey) return { krxListedInfoRows: [], baseDate: basDd, totalCount: 0, pagesFetched: 0, errors: ['data_go_kr_krx_listed_info_service_key_missing'] };
  const errors = [];
  const emptyDates = [];
  const dates = recentBaseDates(basDd, lookbackDays);
  for (let index = 0; index < dates.length; index += 1) {
    const candidateBasDd = dates[index];
    try {
      const result = await fetchDataGoKrxListedInfoRowsForDate({ serviceKey, basDd: candidateBasDd, timeoutMs });
      if (result.rows.length > 0) {
        return {
          krxListedInfoRows: result.rows,
          baseDate: candidateBasDd,
          lookbackDays: index,
          totalCount: result.totalCount,
          pagesFetched: result.pagesFetched,
          emptyDates,
          errors,
        };
      }
      emptyDates.push(candidateBasDd);
    } catch (error) {
      errors.push(`data_go_kr_krx_listed_info:${candidateBasDd}:${error?.message || error}`);
    }
  }
  errors.push(...emptyDates.map((date) => `data_go_kr_krx_listed_info:${date}:empty_result`));
  return { krxListedInfoRows: [], baseDate: basDd, totalCount: 0, pagesFetched: 0, errors };
}

async function fetchDataGoCorporateFinanceRows({ serviceKey, crno, bizYear, timeoutMs }) {
  if (!serviceKey) throw new Error('data_go_kr_corporate_finance_service_key_missing');
  const endpoint = text(process.env.DATA_GO_KR_CORPORATE_FINANCE_URL || DATA_GO_CORPORATE_FINANCE_URL);
  const serviceKeyParam = String(serviceKey).includes('%') ? serviceKey : encodeURIComponent(serviceKey);
  const url = `${endpoint}?serviceKey=${serviceKeyParam}&numOfRows=20&pageNo=1&resultType=json&crno=${encodeURIComponent(crno)}&bizYear=${encodeURIComponent(bizYear)}`;
  const payload = await fetchJson(url, { timeoutMs });
  const resultCode = text(payload?.response?.header?.resultCode);
  const resultMsg = text(payload?.response?.header?.resultMsg);
  if (resultCode && resultCode !== '00') {
    throw new Error(`resultCode=${resultCode}${resultMsg ? ` ${resultMsg}` : ''}`);
  }
  return {
    rows: extractRows(payload),
    totalCount: Number(payload?.response?.body?.totalCount ?? 0),
    resultCode: resultCode || null,
    resultMsg: resultMsg || null,
  };
}

export async function probeDataGoCorporateFinance(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const credentials = await resolveDomesticOfficialReferenceCredentials({ ...options, timeoutMs });
  const crno = text(options.crno || process.env.LUNA_CORPORATE_FINANCE_PROBE_CRNO || DEFAULT_CORPORATE_FINANCE_PROBE_CRNO);
  const bizYear = text(options.bizYear || process.env.LUNA_CORPORATE_FINANCE_PROBE_BIZ_YEAR || DEFAULT_CORPORATE_FINANCE_PROBE_BIZ_YEAR);
  const base = {
    configured: Boolean(credentials.corporateFinanceServiceKey),
    healthProbeEnabled: true,
    endpoint: DATA_GO_CORPORATE_FINANCE_URL,
    crno,
    bizYear,
    keySource: credentials.status.corporateFinanceServiceKeySource || null,
  };
  if (!credentials.corporateFinanceServiceKey) {
    return {
      ...base,
      ok: false,
      rows: 0,
      totalCount: 0,
      error: 'data_go_kr_corporate_finance_service_key_missing',
    };
  }
  try {
    const result = await fetchDataGoCorporateFinanceRows({
      serviceKey: credentials.corporateFinanceServiceKey,
      crno,
      bizYear,
      timeoutMs,
    });
    const first = Array.isArray(result.rows) ? result.rows[0] : null;
    return {
      ...base,
      ok: true,
      resultCode: result.resultCode,
      resultMsg: result.resultMsg,
      rows: result.rows.length,
      totalCount: result.totalCount,
      sampleKeys: first ? Object.keys(first).slice(0, 12) : [],
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      rows: 0,
      totalCount: 0,
      error: error?.message || String(error),
    };
  }
}

function pickCorporateFinanceRow(rows = []) {
  const candidates = Array.isArray(rows) ? rows : [];
  return candidates.find((row) => /연결/u.test(text(row?.fnclDcdNm))) || candidates[0] || null;
}

export function summarizeCorporateFinanceRow(row = null) {
  if (!row) return null;
  return {
    baseDate: text(row.basDt),
    crno: text(row.crno),
    bizYear: text(row.bizYear),
    statementType: text(row.fnclDcdNm || row.fnclDcd),
    currency: text(row.curCd || 'KRW'),
    sales: num(row.enpSaleAmt, null),
    operatingProfit: num(row.enpBzopPft, null),
    netIncome: num(row.enpCrtmNpf, null),
    totalAssets: num(row.enpTastAmt, null),
    totalDebt: num(row.enpTdbtAmt, null),
    totalEquity: num(row.enpTcptAmt, null),
    debtRatio: num(row.fnclDebtRto, null),
  };
}

export async function fetchDataGoCorporateFinanceSummary(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const credentials = await resolveDomesticOfficialReferenceCredentials({ ...options, timeoutMs });
  const crno = text(options.crno);
  const bizYear = text(options.bizYear || process.env.LUNA_CORPORATE_FINANCE_BIZ_YEAR || '2024');
  const base = {
    crno,
    bizYear,
    configured: Boolean(credentials.corporateFinanceServiceKey),
    keySource: credentials.status.corporateFinanceServiceKeySource || null,
  };
  if (!crno || crno === '0000000000000') {
    return { ...base, ok: false, rows: 0, totalCount: 0, reason: 'crno_missing' };
  }
  if (!credentials.corporateFinanceServiceKey) {
    return { ...base, ok: false, rows: 0, totalCount: 0, reason: 'data_go_kr_corporate_finance_service_key_missing' };
  }
  try {
    const result = await fetchDataGoCorporateFinanceRows({
      serviceKey: credentials.corporateFinanceServiceKey,
      crno,
      bizYear,
      timeoutMs,
    });
    const summary = summarizeCorporateFinanceRow(pickCorporateFinanceRow(result.rows));
    return {
      ...base,
      ok: true,
      resultCode: result.resultCode,
      resultMsg: result.resultMsg,
      rows: result.rows.length,
      totalCount: result.totalCount,
      summary,
      flags: corporateFinanceFlags(summary),
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      rows: 0,
      totalCount: 0,
      reason: error?.message || String(error),
    };
  }
}

export function corporateFinanceFlags(summary = null) {
  if (!summary) return ['corporate_finance_missing'];
  const flags = [];
  if (summary.sales != null && summary.sales <= 0) flags.push('sales_non_positive');
  if (summary.operatingProfit != null && summary.operatingProfit < 0) flags.push('operating_loss');
  if (summary.netIncome != null && summary.netIncome < 0) flags.push('net_loss');
  if (summary.debtRatio != null && summary.debtRatio >= 300) flags.push('debt_ratio_high');
  if (summary.totalEquity != null && summary.totalEquity <= 0) flags.push('equity_non_positive');
  return flags;
}

function dataGoCompanyBasicUrls() {
  const override = text(process.env.DATA_GO_KR_COMPANY_BASIC_URL || process.env.PUBLIC_DATA_COMPANY_BASIC_URL);
  if (override) return override.split(',').map((item) => text(item)).filter(Boolean);
  return DATA_GO_COMPANY_BASIC_URLS;
}

function normalizeDateDigits(value) {
  const digits = text(value).replace(/\D/gu, '');
  return digits.length >= 8 ? digits.slice(0, 8) : '';
}

async function fetchDataGoCompanyBasicRows({ serviceKey, crno, corpNm, timeoutMs }) {
  if (!serviceKey) throw new Error('data_go_kr_company_basic_service_key_missing');
  const normalizedCrno = text(crno);
  const normalizedCorpNm = text(corpNm);
  if (!normalizedCrno && !normalizedCorpNm) throw new Error('company_basic_identifier_missing');
  const serviceKeyParam = String(serviceKey).includes('%') ? serviceKey : encodeURIComponent(serviceKey);
  const criteria = [
    'numOfRows=10',
    'pageNo=1',
    'resultType=json',
    normalizedCrno ? `crno=${encodeURIComponent(normalizedCrno)}` : '',
    normalizedCorpNm ? `corpNm=${encodeURIComponent(normalizedCorpNm)}` : '',
  ].filter(Boolean).join('&');
  const keyParamNames = unique([
    text(process.env.DATA_GO_KR_COMPANY_BASIC_SERVICE_KEY_PARAM || ''),
    'serviceKey',
    'ServiceKey',
  ]);

  let emptyResult = null;
  const errors = [];
  for (const endpoint of dataGoCompanyBasicUrls()) {
    for (const keyParamName of keyParamNames) {
      try {
        const payload = await fetchJson(`${endpoint}?${keyParamName}=${serviceKeyParam}&${criteria}`, { timeoutMs });
        const resultCode = text(payload?.response?.header?.resultCode);
        const resultMsg = text(payload?.response?.header?.resultMsg);
        if (resultCode && resultCode !== '00') {
          throw new Error(`resultCode=${resultCode}${resultMsg ? ` ${resultMsg}` : ''}`);
        }
        const rows = extractRows(payload);
        const result = {
          rows,
          totalCount: Number(payload?.response?.body?.totalCount ?? rows.length),
          resultCode: resultCode || null,
          resultMsg: resultMsg || null,
          endpoint,
          keyParamName,
        };
        if (rows.length > 0) return result;
        emptyResult = emptyResult || result;
      } catch (error) {
        errors.push(`${endpoint}:${keyParamName}:${error?.message || error}`);
      }
    }
  }
  if (emptyResult) return emptyResult;
  throw new Error(errors.slice(0, 3).join(' | ') || 'company_basic_request_failed');
}

function pickCompanyBasicRow(rows = [], options = {}) {
  const candidates = Array.isArray(rows) ? rows : [];
  const crno = text(options.crno);
  const corpNm = text(options.corpNm);
  const rank = (row) => Number(normalizeDateDigits(row?.lastOpegDt || row?.fstOpegDt || row?.basDt) || 0);
  const sorted = [...candidates].sort((a, b) => rank(b) - rank(a));
  if (crno) {
    const exactCrno = sorted.find((row) => text(row?.crno) === crno);
    if (exactCrno) return exactCrno;
  }
  if (corpNm) {
    const exactName = sorted.find((row) => text(row?.corpNm) === corpNm || text(row?.enpPbanCmpyNm) === corpNm);
    if (exactName) return exactName;
  }
  return sorted[0] || null;
}

export function summarizeCompanyBasicRow(row = null) {
  if (!row) return null;
  const exchangeListedDate = normalizeDateDigits(row.enpXchgLstgDt);
  const kosdaqListedDate = normalizeDateDigits(row.enpKosdaqLstgDt);
  const krxListedDate = normalizeDateDigits(row.enpKrxLstgDt);
  const exchangeDelistedDate = normalizeDateDigits(row.enpXchgLstgAbolDt);
  const kosdaqDelistedDate = normalizeDateDigits(row.enpKosdaqLstgAbolDt);
  const krxDelistedDate = normalizeDateDigits(row.enpKrxLstgAbolDt);
  return {
    baseDate: normalizeDateDigits(row.basDt),
    crno: text(row.crno),
    corpName: text(row.corpNm),
    corpEnglishName: text(row.corpEnsnNm),
    disclosureCompanyName: text(row.enpPbanCmpyNm),
    representativeName: text(row.enpRprFnm),
    businessRegistrationNumber: text(row.bzno),
    marketCode: text(row.corpRegMrktDcd),
    marketName: text(row.corpRegMrktDcdNm),
    corporateTypeCode: text(row.corpDcd),
    corporateTypeName: text(row.corpDcdNm),
    industryCode: text(row.sicNm),
    establishedDate: normalizeDateDigits(row.enpEstbDt),
    settlementMonth: text(row.enpStacMm),
    listedDate: krxListedDate || exchangeListedDate || kosdaqListedDate,
    exchangeListedDate,
    kosdaqListedDate,
    krxListedDate,
    exchangeDelistedDate,
    kosdaqDelistedDate,
    krxDelistedDate,
    smeYn: text(row.smenpYn),
    employeeCount: num(row.enpEmpeCnt, null),
    averageServiceTerm: text(row.empeAvgCnwkTermCtt),
    previousAverageSalary: num(row.enpPn1AvgSlryAmt, null),
    monitorBankName: text(row.enpMntrBnkNm),
    auditorName: text(row.actnAudpnNm),
    auditorOpinion: text(row.audtRptOpnnCtt),
    mainBusiness: text(row.enpMainBizNm),
    homepageUrl: text(row.enpHmpgUrl),
    phone: text(row.enpTlno),
    fax: text(row.enpFxno),
    postalCode: text(row.enpOzpno),
    address: text(row.enpBsadr),
    detailAddress: text(row.enpDtadr),
    fssCorpUniqueNo: text(row.fssCorpUnqNo),
    fssCorpChangedAt: text(row.fssCorpChgDtm),
    firstOpenDate: normalizeDateDigits(row.fstOpegDt),
    lastOpenDate: normalizeDateDigits(row.lastOpegDt),
  };
}

export async function probeDataGoCompanyBasic(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const credentials = await resolveDomesticOfficialReferenceCredentials({ ...options, timeoutMs });
  const crno = text(options.crno || process.env.LUNA_COMPANY_BASIC_PROBE_CRNO || DEFAULT_COMPANY_BASIC_PROBE_CRNO);
  const corpNm = text(options.corpNm || process.env.LUNA_COMPANY_BASIC_PROBE_CORP_NM || '');
  const base = {
    configured: Boolean(credentials.companyBasicServiceKey),
    healthProbeEnabled: true,
    endpoints: dataGoCompanyBasicUrls(),
    crno,
    corpNm,
    keySource: credentials.status.companyBasicServiceKeySource || null,
  };
  if (!credentials.companyBasicServiceKey) {
    return {
      ...base,
      ok: false,
      rows: 0,
      totalCount: 0,
      error: 'data_go_kr_company_basic_service_key_missing',
    };
  }
  try {
    const result = await fetchDataGoCompanyBasicRows({
      serviceKey: credentials.companyBasicServiceKey,
      crno,
      corpNm,
      timeoutMs,
    });
    const first = Array.isArray(result.rows) ? result.rows[0] : null;
    return {
      ...base,
      ok: true,
      endpoint: result.endpoint,
      keyParamName: result.keyParamName,
      resultCode: result.resultCode,
      resultMsg: result.resultMsg,
      rows: result.rows.length,
      totalCount: result.totalCount,
      sampleKeys: first ? Object.keys(first).slice(0, 12) : [],
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      rows: 0,
      totalCount: 0,
      error: error?.message || String(error),
    };
  }
}

export async function fetchDataGoCompanyBasicProfile(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const credentials = await resolveDomesticOfficialReferenceCredentials({ ...options, timeoutMs });
  const crno = text(options.crno);
  const corpNm = text(options.corpNm);
  const base = {
    crno,
    corpNm,
    configured: Boolean(credentials.companyBasicServiceKey),
    keySource: credentials.status.companyBasicServiceKeySource || null,
  };
  if (!crno && !corpNm) {
    return { ...base, ok: false, rows: 0, totalCount: 0, reason: 'company_basic_identifier_missing' };
  }
  if (!credentials.companyBasicServiceKey) {
    return { ...base, ok: false, rows: 0, totalCount: 0, reason: 'data_go_kr_company_basic_service_key_missing' };
  }
  try {
    const result = await fetchDataGoCompanyBasicRows({
      serviceKey: credentials.companyBasicServiceKey,
      crno,
      corpNm,
      timeoutMs,
    });
    const summary = summarizeCompanyBasicRow(pickCompanyBasicRow(result.rows, { crno, corpNm }));
    return {
      ...base,
      ok: true,
      endpoint: result.endpoint,
      keyParamName: result.keyParamName,
      resultCode: result.resultCode,
      resultMsg: result.resultMsg,
      rows: result.rows.length,
      totalCount: result.totalCount,
      summary,
      flags: companyBasicFlags(summary),
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      rows: 0,
      totalCount: 0,
      reason: error?.message || String(error),
    };
  }
}

export function companyBasicFlags(summary = null) {
  if (!summary) return ['company_basic_missing'];
  const flags = [];
  if (!summary.crno) flags.push('company_crno_missing');
  if (!summary.corpName) flags.push('company_name_missing');
  if (!summary.businessRegistrationNumber) flags.push('business_registration_number_missing');
  if (!summary.industryCode) flags.push('industry_code_missing');
  if (!summary.establishedDate) flags.push('established_date_missing');
  if (!summary.listedDate) flags.push('company_listing_date_missing');
  if (summary.exchangeDelistedDate || summary.kosdaqDelistedDate || summary.krxDelistedDate) flags.push('company_delisted_date_present');
  if (summary.employeeCount != null && summary.employeeCount <= 0) flags.push('employee_count_non_positive');
  return flags;
}

export async function fetchDomesticOfficialReference(options = {}) {
  if (options.fixture) return buildFixtureDomesticOfficialReference();
  const basDd = text(options.baseDate || process.env.LUNA_DOMESTIC_OFFICIAL_REFERENCE_BASE_DATE || yyyymmddKst());
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const credentials = await resolveDomesticOfficialReferenceCredentials({ ...options, timeoutMs });

  const lookbackDays = Number(options.lookbackDays ?? process.env.LUNA_DOMESTIC_OFFICIAL_REFERENCE_LOOKBACK_DAYS ?? DEFAULT_REFERENCE_LOOKBACK_DAYS);
  const [krx, publicPrice, krxListedInfo] = await Promise.all([
    fetchKrxOfficialReferenceRows({
      authKey: credentials.krxAuthKey,
      basDd,
      timeoutMs,
      lookbackDays,
    }),
    fetchDataGoStockPriceRows({
      serviceKey: credentials.stockPriceServiceKey,
      basDd,
      timeoutMs,
      lookbackDays,
    }),
    fetchDataGoKrxListedInfoRows({
      serviceKey: credentials.krxListedInfoServiceKey,
      basDd,
      timeoutMs,
      lookbackDays,
    }),
  ]);
  const corporateFinanceProbeEnabled = bool(options.corporateFinanceProbe, bool(process.env.LUNA_CORPORATE_FINANCE_HEALTH_PROBE, false));
  const corporateFinance = corporateFinanceProbeEnabled
    ? await probeDataGoCorporateFinance({ ...options, timeoutMs })
    : {
        configured: Boolean(credentials.corporateFinanceServiceKey),
        healthProbeEnabled: false,
        endpoint: DATA_GO_CORPORATE_FINANCE_URL,
        keySource: credentials.status.corporateFinanceServiceKeySource || null,
        ok: null,
        rows: 0,
        totalCount: 0,
        note: 'health_probe_disabled',
      };
  const companyBasicProbeEnabled = bool(options.companyBasicProbe, bool(process.env.LUNA_COMPANY_BASIC_HEALTH_PROBE, false));
  const companyBasic = companyBasicProbeEnabled
    ? await probeDataGoCompanyBasic({ ...options, timeoutMs })
    : {
        configured: Boolean(credentials.companyBasicServiceKey),
        healthProbeEnabled: false,
        endpoints: dataGoCompanyBasicUrls(),
        keySource: credentials.status.companyBasicServiceKeySource || null,
        ok: null,
        rows: 0,
        totalCount: 0,
        note: 'health_probe_disabled',
      };

  const reference = buildDomesticOfficialReference({
    baseInfoRows: krx.baseInfoRows,
    dailyTradeRows: krx.dailyTradeRows,
    publicPriceRows: publicPrice.publicPriceRows,
    krxListedInfoRows: krxListedInfo.krxListedInfoRows,
    baseDate: krx.baseDate || publicPrice.baseDate || krxListedInfo.baseDate || basDd,
    fetchedAt: new Date().toISOString(),
    minTurnoverKrw: Number(options.minTurnoverKrw || process.env.LUNA_DOMESTIC_OFFICIAL_MIN_TURNOVER_KRW || DEFAULT_DOMESTIC_OFFICIAL_MIN_TURNOVER_KRW),
    minListingAgeDays: Number(options.minListingAgeDays || process.env.LUNA_DOMESTIC_OFFICIAL_MIN_LISTING_AGE_DAYS || DEFAULT_DOMESTIC_OFFICIAL_MIN_LISTING_AGE_DAYS),
  });
  return {
    ...reference,
    credentialStatus: credentials.status,
    dataGoKrStockPrice: {
      requestedBaseDate: basDd,
      resolvedBaseDate: publicPrice.baseDate || basDd,
      lookbackDays: Number(publicPrice.lookbackDays || 0),
      emptyDates: Array.isArray(publicPrice.emptyDates) ? publicPrice.emptyDates : [],
      totalCount: Number(publicPrice.totalCount || publicPrice.publicPriceRows?.length || 0),
      pagesFetched: Number(publicPrice.pagesFetched || 0),
    },
    krxOpenApi: {
      requestedBaseDate: basDd,
      resolvedBaseDate: krx.baseDate || basDd,
      lookbackDays: Number(krx.lookbackDays || 0),
      emptyDates: Array.isArray(krx.emptyDates) ? krx.emptyDates : [],
      baseInfoRows: Number(krx.baseInfoRows?.length || 0),
      dailyTradeRows: Number(krx.dailyTradeRows?.length || 0),
    },
    dataGoKrKrxListedInfo: {
      requestedBaseDate: basDd,
      resolvedBaseDate: krxListedInfo.baseDate || basDd,
      lookbackDays: Number(krxListedInfo.lookbackDays || 0),
      emptyDates: Array.isArray(krxListedInfo.emptyDates) ? krxListedInfo.emptyDates : [],
      totalCount: Number(krxListedInfo.totalCount || krxListedInfo.krxListedInfoRows?.length || 0),
      pagesFetched: Number(krxListedInfo.pagesFetched || 0),
      crnoRows: (Array.isArray(krxListedInfo.krxListedInfoRows) ? krxListedInfo.krxListedInfoRows : [])
        .filter((row) => text(row?.crno) && text(row?.crno) !== '0000000000000')
        .length,
    },
    dataGoKrCorporateFinance: {
      ...corporateFinance,
      integrationMode: krxListedInfo.krxListedInfoRows?.length ? 'health_probe_plus_symbol_crno_mapping_available' : 'health_probe_only_until_symbol_crno_mapping_is_available',
      symbolCrnoMappingRequired: !krxListedInfo.krxListedInfoRows?.length,
      symbolCrnoMappingSource: 'data_go_kr_krx_listed_info_or_equivalent',
    },
    dataGoKrCompanyBasic: {
      ...companyBasic,
      integrationMode: krxListedInfo.krxListedInfoRows?.length ? 'health_probe_plus_symbol_crno_mapping_available' : 'health_probe_only_until_symbol_crno_mapping_is_available',
      symbolCrnoMappingRequired: !krxListedInfo.krxListedInfoRows?.length,
      symbolCrnoMappingSource: 'data_go_kr_krx_listed_info_or_equivalent',
    },
    fetchErrors: [...(krx.errors || []), ...(publicPrice.errors || []), ...(krxListedInfo.errors || [])],
  };
}

export function getDomesticOfficialReferenceCacheFile(options = {}) {
  return resolve(text(options.cacheFile || process.env.LUNA_DOMESTIC_OFFICIAL_REFERENCE_CACHE_FILE || DEFAULT_CACHE_FILE));
}

export function loadDomesticOfficialReferenceCache(options = {}) {
  const cacheFile = getDomesticOfficialReferenceCacheFile(options);
  if (!existsSync(cacheFile)) return null;
  const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
  return parsed?.source ? parsed : null;
}

export function writeDomesticOfficialReferenceCache(reference = {}, options = {}) {
  const cacheFile = getDomesticOfficialReferenceCacheFile(options);
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, `${JSON.stringify(reference, null, 2)}\n`);
  return cacheFile;
}

export function isDomesticOfficialReferenceHardGateEnabled(options = {}) {
  return bool(options.hardGate, bool(process.env.LUNA_DOMESTIC_OFFICIAL_REFERENCE_HARD_GATE, false));
}

export function isDomesticOfficialReferenceNetworkEnabled(options = {}) {
  return bool(options.allowNetwork, bool(process.env.LUNA_DOMESTIC_OFFICIAL_REFERENCE_ENABLED, false));
}

export async function getCachedDomesticOfficialReference(options = {}) {
  if (options.fixture) return buildFixtureDomesticOfficialReference();
  const now = Date.now();
  const ttlMs = Math.max(1000, Number(options.ttlMs || DEFAULT_CACHE_TTL_MS));
  if (!options.refresh && cachedReference && (now - cachedReference.cachedAtMs) < ttlMs) {
    return cachedReference.value;
  }

  let reference = null;
  if (!options.refresh) {
    reference = loadDomesticOfficialReferenceCache(options);
  }
  if (!reference && isDomesticOfficialReferenceNetworkEnabled(options)) {
    reference = await fetchDomesticOfficialReference(options).catch((error) => buildUnavailableDomesticOfficialReference(error?.message || String(error)));
    if (reference?.available && options.writeCache) writeDomesticOfficialReferenceCache(reference, options);
  }
  if (!reference) reference = buildUnavailableDomesticOfficialReference('cache_missing_and_network_disabled');
  cachedReference = { cachedAtMs: now, value: reference };
  return reference;
}

export function evaluateDomesticOfficialReferenceGate(symbol, reference = null, options = {}) {
  const canonical = normalizeDomesticOfficialSymbol(symbol);
  const hardGateEnabled = isDomesticOfficialReferenceHardGateEnabled(options);
  if (!canonical) {
    return {
      ok: false,
      blocked: true,
      wouldBlock: true,
      hardBlocked: hardGateEnabled,
      reason: 'invalid_domestic_symbol',
      code: 'invalid_domestic_symbol',
      symbol: String(symbol || ''),
      canonicalSymbol: null,
      hardGateEnabled,
    };
  }
  if (!reference?.available) {
    return {
      ok: true,
      blocked: false,
      wouldBlock: false,
      hardBlocked: false,
      reason: 'official_reference_unavailable',
      code: 'official_reference_unavailable',
      symbol: canonical,
      canonicalSymbol: canonical,
      hardGateEnabled,
      referenceStatus: 'unavailable',
      source: reference?.source || DOMESTIC_OFFICIAL_REFERENCE_SOURCE,
      fetchedAt: reference?.fetchedAt || null,
    };
  }
  const row = reference.bySymbol?.[canonical] || null;
  const blockers = row
    ? (row.officialBlockers || classifyDomesticOfficialReferenceRow(row, { minTurnoverKrw: reference.minTurnoverKrw }))
    : (reference.fullUniverse ? ['not_in_official_domestic_universe'] : []);
  const wouldBlock = blockers.length > 0;
  return {
    ok: !wouldBlock,
    blocked: wouldBlock,
    wouldBlock,
    hardBlocked: hardGateEnabled && wouldBlock,
    reason: wouldBlock ? blockers[0] : 'in_domestic_official_reference_universe',
    code: wouldBlock ? blockers[0] : 'in_domestic_official_reference_universe',
    symbol: canonical,
    canonicalSymbol: canonical,
    hardGateEnabled,
    referenceStatus: 'available',
    source: reference.source,
    fetchedAt: reference.fetchedAt,
    baseDate: reference.baseDate,
    krxUniverseRank: reference.turnoverRanks?.[canonical] || null,
    row: row ? {
      name: row.name,
      market: row.market,
      securityGroup: row.securityGroup,
      stockCertificateType: row.stockCertificateType,
      listedDate: row.listedDate,
      listingAgeDays: row.listingAgeDays,
      turnoverKrw: row.turnoverKrw,
      volume: row.volume,
      price: row.price,
      crno: row.crno || null,
      officialBlockers: blockers,
    } : null,
  };
}

export function annotateDomesticOfficialReferenceCandidates(candidates = [], reference = null, options = {}) {
  const annotated = [];
  const excluded = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const gate = evaluateDomesticOfficialReferenceGate(candidate?.symbol, reference, options);
    const next = {
      ...candidate,
      officialReferenceStatus: gate.referenceStatus || 'invalid',
      officialReferenceSource: gate.source || DOMESTIC_OFFICIAL_REFERENCE_SOURCE,
      krxUniverseRank: gate.krxUniverseRank || null,
      officialReferenceName: gate.row?.name || null,
      officialReferenceCrno: gate.row?.crno || null,
      officialReferenceMarket: gate.row?.market || null,
      officialReferenceSecurityType: gate.row?.securityGroup || null,
      officialReferenceStockType: gate.row?.stockCertificateType || null,
      officialReferenceListedDate: gate.row?.listedDate || null,
      officialReferenceListingAgeDays: gate.row?.listingAgeDays ?? null,
      officialReferenceTurnoverKrw: gate.row?.turnoverKrw ?? null,
      officialReferenceBlockers: gate.row?.officialBlockers || (gate.blocked ? [gate.reason] : []),
      officialReferenceWouldBlock: gate.wouldBlock,
      officialReferenceHardBlocked: gate.hardBlocked,
      raw: {
        ...(candidate?.raw || {}),
        officialReference: {
          status: gate.referenceStatus || 'invalid',
          source: gate.source || DOMESTIC_OFFICIAL_REFERENCE_SOURCE,
          fetchedAt: gate.fetchedAt || null,
          baseDate: gate.baseDate || null,
          rank: gate.krxUniverseRank || null,
          crno: gate.row?.crno || null,
          listedDate: gate.row?.listedDate || null,
          listingAgeDays: gate.row?.listingAgeDays ?? null,
          blockers: gate.row?.officialBlockers || (gate.blocked ? [gate.reason] : []),
          hardGateEnabled: gate.hardGateEnabled,
        },
      },
    };
    if (gate.hardBlocked) excluded.push(next);
    else annotated.push(next);
  }
  return {
    candidates: annotated,
    excluded,
    hardGateEnabled: isDomesticOfficialReferenceHardGateEnabled(options),
    referenceAvailable: reference?.available === true,
  };
}

export function summarizeDomesticOfficialReference(reference = null) {
  return {
    source: reference?.source || DOMESTIC_OFFICIAL_REFERENCE_SOURCE,
    fetchedAt: reference?.fetchedAt || null,
    baseDate: reference?.baseDate || null,
    available: reference?.available === true,
    fullUniverse: reference?.fullUniverse === true,
    minListingAgeDays: reference?.minListingAgeDays ?? DEFAULT_DOMESTIC_OFFICIAL_MIN_LISTING_AGE_DAYS,
    symbols: Array.isArray(reference?.symbols) ? reference.symbols.length : 0,
    ineligibleCount: Number(reference?.excluded?.ineligibleCount || 0),
    byReason: reference?.excluded?.byReason || {},
    resources: reference?.resources || {},
    krxOpenApi: reference?.krxOpenApi || null,
    dataGoKrStockPrice: reference?.dataGoKrStockPrice || null,
    dataGoKrKrxListedInfo: reference?.dataGoKrKrxListedInfo || null,
    dataGoKrCorporateFinance: reference?.dataGoKrCorporateFinance || null,
    dataGoKrCompanyBasic: reference?.dataGoKrCompanyBasic || null,
    unavailableReason: reference?.unavailableReason || null,
    credentialStatus: reference?.credentialStatus || null,
    fetchErrors: Array.isArray(reference?.fetchErrors) ? reference.fetchErrors.slice(0, 12) : [],
  };
}

export default {
  DOMESTIC_OFFICIAL_REFERENCE_SOURCE,
  DOMESTIC_OFFICIAL_REFERENCE_BLOCK_SOURCE,
  buildDomesticOfficialReference,
  buildFixtureDomesticOfficialReference,
  fetchDomesticOfficialReference,
  fetchDataGoStockPriceHistoryForSymbol,
  probeDataGoCorporateFinance,
  fetchDataGoCorporateFinanceSummary,
  summarizeCorporateFinanceRow,
  corporateFinanceFlags,
  probeDataGoCompanyBasic,
  fetchDataGoCompanyBasicProfile,
  summarizeCompanyBasicRow,
  companyBasicFlags,
  getCachedDomesticOfficialReference,
  evaluateDomesticOfficialReferenceGate,
  annotateDomesticOfficialReferenceCandidates,
  summarizeDomesticOfficialReference,
  writeDomesticOfficialReferenceCache,
};
