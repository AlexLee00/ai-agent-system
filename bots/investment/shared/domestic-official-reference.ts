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

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_CACHE_FILE = resolve(INVESTMENT_ROOT, 'output', 'luna-domestic-official-reference-cache.json');
const KRX_STOCK_BASE_URL = 'https://data-dbg.krx.co.kr/svc/apis/sto';
const DATA_GO_STOCK_PRICE_URL = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';

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
    const directCategoryEnabled = bool(process.env.LUNA_OFFICIAL_MARKET_REFERENCE_DIRECT_SECRET_CATEGORY, true);
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
  let krxAuthKey = text(options.krxAuthKey || process.env.KRX_OPENAPI_AUTH_KEY || process.env.KRX_OPEN_API_AUTH_KEY || process.env.KRX_AUTH_KEY);
  let stockPriceServiceKey = text(options.dataGoKrStockPriceServiceKey || options.stockPriceServiceKey || process.env.DATA_GO_KR_STOCK_PRICE_SERVICE_KEY || process.env.PUBLIC_DATA_STOCK_PRICE_SERVICE_KEY);
  let corporateFinanceServiceKey = text(options.corporateFinanceServiceKey || process.env.DATA_GO_KR_CORPORATE_FINANCE_SERVICE_KEY || process.env.PUBLIC_DATA_CORPORATE_FINANCE_SERVICE_KEY);
  let krxAuthKeySource = krxAuthKey ? 'env' : null;
  let stockPriceServiceKeySource = stockPriceServiceKey ? 'env' : null;
  let corporateFinanceServiceKeySource = corporateFinanceServiceKey ? 'env' : null;

  if (!krxAuthKey || !stockPriceServiceKey || !corporateFinanceServiceKey) {
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
      krxAuthKey = text(value);
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
      stockPriceServiceKey = text(value);
      stockPriceServiceKeySource = stockPriceServiceKey ? (nestedValueOf(official, ['data_go_kr_stock_price_service_key', 'stock_price_service_key', 'data_go_kr.stock_price_service_key']) ? 'hub:official_market_reference' : 'hub:config/reservation') : null;
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
      corporateFinanceServiceKey = text(value);
      corporateFinanceServiceKeySource = corporateFinanceServiceKey ? (nestedValueOf(official, ['data_go_kr_corporate_finance_service_key', 'corporate_finance_service_key', 'company_finance_service_key', 'data_go_kr.corporate_finance_service_key', 'data_go_kr.company_finance_service_key']) ? 'hub:official_market_reference' : 'hub:config/reservation') : null;
    }
  }

  return {
    krxAuthKey,
    stockPriceServiceKey,
    corporateFinanceServiceKey,
    status: {
      krxConfigured: Boolean(krxAuthKey),
      stockPriceConfigured: Boolean(stockPriceServiceKey),
      corporateFinanceConfigured: Boolean(corporateFinanceServiceKey),
      krxAuthKeySource,
      stockPriceServiceKeySource,
      corporateFinanceServiceKeySource,
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

export function normalizeDomesticOfficialSymbol(value = '') {
  const raw = text(value).toUpperCase();
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
  const combined = `${row.securityGroup || ''} ${row.stockCertificateType || ''} ${row.sectorType || ''}`.toUpperCase();
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
  if (!normalizeDomesticOfficialSymbol(row.symbol)) blockers.push('invalid_domestic_symbol');
  if (row.tradingHalt) blockers.push('trading_halt_or_suspended');
  if (row.adminIssue) blockers.push('admin_issue');
  if (row.delistingRisk) blockers.push('delisting_risk');
  const typeBlocker = securityTypeBlocker(row);
  if (typeBlocker) blockers.push(typeBlocker);
  if (row.turnoverKrw != null && minTurnoverKrw > 0 && Number(row.turnoverKrw || 0) < minTurnoverKrw) {
    blockers.push('turnover_below_official_floor');
  }
  return unique(blockers);
}

export function buildDomesticOfficialReference({
  baseInfoRows = [],
  dailyTradeRows = [],
  publicPriceRows = [],
  ksdRows = [],
  fetchedAt = new Date().toISOString(),
  baseDate = null,
  source = DOMESTIC_OFFICIAL_REFERENCE_SOURCE,
  fixture = false,
  minTurnoverKrw = DEFAULT_DOMESTIC_OFFICIAL_MIN_TURNOVER_KRW,
} = {}) {
  const bySymbol = new Map();
  const inputGroups = [
    ['krx_base_info', baseInfoRows],
    ['krx_daily_trade', dailyTradeRows],
    ['data_go_kr_stock_price', publicPriceRows],
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
    const blockers = classifyDomesticOfficialReferenceRow(row, { minTurnoverKrw });
    return {
      ...row,
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
    ],
    dailyTradeRows: [
      { ISU_SRT_CD: '005930', TDD_CLSPRC: '80000', ACC_TRDVOL: '20000000', ACC_TRDVAL: '1600000000000', FLUC_RT: '1.2' },
      { ISU_SRT_CD: '000660', TDD_CLSPRC: '180000', ACC_TRDVOL: '5000000', ACC_TRDVAL: '900000000000', FLUC_RT: '2.1' },
      { ISU_SRT_CD: '069500', TDD_CLSPRC: '40000', ACC_TRDVOL: '1000000', ACC_TRDVAL: '40000000000', FLUC_RT: '0.3' },
      { ISU_SRT_CD: '005935', TDD_CLSPRC: '65000', ACC_TRDVOL: '1000000', ACC_TRDVAL: '65000000000', FLUC_RT: '0.4' },
      { ISU_SRT_CD: '123450', TDD_CLSPRC: '2100', ACC_TRDVOL: '2000000', ACC_TRDVAL: '4200000000', FLUC_RT: '0.1' },
      { ISU_SRT_CD: '000020', TDD_CLSPRC: '9000', ACC_TRDVOL: '50000', ACC_TRDVAL: '450000000', FLUC_RT: '-0.2' },
      { ISU_SRT_CD: '111111', TDD_CLSPRC: '1000', ACC_TRDVOL: '0', ACC_TRDVAL: '0', FLUC_RT: '0' },
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchKrxRows({ endpoint, authKey, basDd, timeoutMs }) {
  const baseUrl = text(process.env.KRX_OPENAPI_BASE_URL || KRX_STOCK_BASE_URL).replace(/\/$/u, '');
  const payload = await fetchJson(`${baseUrl}${endpoint}`, {
    method: 'POST',
    timeoutMs,
    headers: {
      'AUTH_KEY': text(authKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ basDd }),
  });
  return extractRows(payload);
}

async function fetchKrxOfficialReferenceRows({ authKey, basDd, timeoutMs }) {
  if (!authKey) return { baseInfoRows: [], dailyTradeRows: [], errors: ['krx_auth_key_missing'] };
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

async function fetchDataGoStockPriceRows({ serviceKey, basDd, timeoutMs }) {
  if (!serviceKey) return { publicPriceRows: [], errors: ['data_go_kr_stock_price_service_key_missing'] };
  const endpoint = text(process.env.DATA_GO_KR_STOCK_PRICE_URL || DATA_GO_STOCK_PRICE_URL);
  const serviceKeyParam = String(serviceKey).includes('%') ? serviceKey : encodeURIComponent(serviceKey);
  const url = `${endpoint}?serviceKey=${serviceKeyParam}&numOfRows=1000&pageNo=1&resultType=json&basDt=${encodeURIComponent(basDd)}`;
  try {
    const payload = await fetchJson(url, { timeoutMs });
    return { publicPriceRows: extractRows(payload), errors: [] };
  } catch (error) {
    return { publicPriceRows: [], errors: [`data_go_kr_stock_price:${error?.message || error}`] };
  }
}

export async function fetchDomesticOfficialReference(options = {}) {
  if (options.fixture) return buildFixtureDomesticOfficialReference();
  const basDd = text(options.baseDate || process.env.LUNA_DOMESTIC_OFFICIAL_REFERENCE_BASE_DATE || yyyymmddKst());
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const credentials = await resolveDomesticOfficialReferenceCredentials({ ...options, timeoutMs });

  const [krx, publicPrice] = await Promise.all([
    fetchKrxOfficialReferenceRows({ authKey: credentials.krxAuthKey, basDd, timeoutMs }),
    fetchDataGoStockPriceRows({ serviceKey: credentials.stockPriceServiceKey, basDd, timeoutMs }),
  ]);

  const reference = buildDomesticOfficialReference({
    baseInfoRows: krx.baseInfoRows,
    dailyTradeRows: krx.dailyTradeRows,
    publicPriceRows: publicPrice.publicPriceRows,
    baseDate: basDd,
    fetchedAt: new Date().toISOString(),
    minTurnoverKrw: Number(options.minTurnoverKrw || process.env.LUNA_DOMESTIC_OFFICIAL_MIN_TURNOVER_KRW || DEFAULT_DOMESTIC_OFFICIAL_MIN_TURNOVER_KRW),
  });
  return {
    ...reference,
    credentialStatus: credentials.status,
    fetchErrors: [...(krx.errors || []), ...(publicPrice.errors || [])],
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
      turnoverKrw: row.turnoverKrw,
      volume: row.volume,
      price: row.price,
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
      officialReferenceMarket: gate.row?.market || null,
      officialReferenceSecurityType: gate.row?.securityGroup || null,
      officialReferenceStockType: gate.row?.stockCertificateType || null,
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
    symbols: Array.isArray(reference?.symbols) ? reference.symbols.length : 0,
    ineligibleCount: Number(reference?.excluded?.ineligibleCount || 0),
    byReason: reference?.excluded?.byReason || {},
    resources: reference?.resources || {},
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
  getCachedDomesticOfficialReference,
  evaluateDomesticOfficialReferenceGate,
  annotateDomesticOfficialReferenceCandidates,
  summarizeDomesticOfficialReference,
  writeDomesticOfficialReferenceCache,
};
