// @ts-nocheck
// Read-only Open DART client for Luna Korea public data integration.

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const hubClient = require('../../../../packages/core/lib/hub-client');

export const DEFAULT_OPENDART_BASE_URL = 'https://opendart.fss.or.kr/api';
export const DEFAULT_OPENDART_TIMEOUT_MS = 10_000;
export const DEFAULT_OPENDART_RETRY_CAP = 2;
export const DEFAULT_OPENDART_DAILY_LIMIT = 10_000;

let cachedHubSecrets = null;

function text(value, fallback = '') {
  return String(value ?? fallback ?? '').trim();
}

function secretText(value) {
  const normalized = text(value);
  if (!normalized || /^<[^>]+>$/u.test(normalized) || /^TODO[:_ -]?/iu.test(normalized)) return '';
  return normalized;
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

function num(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const normalized = typeof value === 'string'
    ? value.replace(/[,\s]/g, '').replace(/^[-–]$/u, '')
    : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
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

export function addDaysYyyymmdd(value, deltaDays) {
  const raw = text(value || yyyymmddKst());
  if (!/^\d{8}$/u.test(raw)) return yyyymmddKst();
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day + Number(deltaDays || 0)));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

async function loadHubOpenDartSecrets(timeoutMs = 3000) {
  if (cachedHubSecrets) return cachedHubSecrets;
  try {
    const directCategoryEnabled = String(process.env.LUNA_OPENDART_DIRECT_SECRET_CATEGORY || '').toLowerCase() === 'true';
    const [opendart, config] = await Promise.all([
      directCategoryEnabled ? hubClient.fetchHubSecrets('opendart', timeoutMs).catch(() => null) : Promise.resolve(null),
      hubClient.fetchHubSecrets('config', timeoutMs).catch(() => null),
    ]);
    cachedHubSecrets = { opendart: opendart || {}, config: config || {}, news: {} };
  } catch {
    cachedHubSecrets = { opendart: {}, config: {}, news: {} };
  }
  return cachedHubSecrets;
}

export async function resolveOpenDartCredentials(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_OPENDART_TIMEOUT_MS));
  let apiKey = secretText(
    options.apiKey
    || process.env.OPENDART_API_KEY
    || process.env.OPEN_DART_API_KEY
    || process.env.DART_API_KEY,
  );
  let baseUrl = text(options.baseUrl || process.env.OPENDART_BASE_URL || process.env.OPEN_DART_BASE_URL || DEFAULT_OPENDART_BASE_URL);
  let source = apiKey ? 'env' : null;

  if (!apiKey || !baseUrl) {
    const hub = await loadHubOpenDartSecrets(timeoutMs);
    const direct = hub.opendart || {};
    const config = hub.config || {};
    const news = hub.news || {};
    if (!apiKey) {
      const value = nestedValueOf(direct, ['api_key', 'open_dart_api_key', 'dart_api_key'])
        || nestedValueOf(config, ['opendart.api_key', 'open_dart.api_key', 'news.dart_api_key', 'dart.api_key'])
        || nestedValueOf(news, ['dart_api_key', 'opendart_api_key']);
      apiKey = secretText(value);
      source = apiKey
        ? (nestedValueOf(direct, ['api_key', 'open_dart_api_key', 'dart_api_key']) ? 'hub:opendart' : 'hub:config/news')
        : null;
    }
    const hubBaseUrl = nestedValueOf(direct, ['base_url'])
      || nestedValueOf(config, ['opendart.base_url', 'open_dart.base_url']);
    baseUrl = text(baseUrl || hubBaseUrl || DEFAULT_OPENDART_BASE_URL);
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/u, ''),
    status: {
      configured: Boolean(apiKey),
      apiKeySource: source,
      baseUrl,
      valueRedacted: true,
    },
  };
}

export async function resolveOpenDartCredentialStatus(options = {}) {
  return (await resolveOpenDartCredentials(options)).status;
}

function retryDelayMs(attempt) {
  return Math.min(8_000, 400 * (2 ** Math.max(0, Number(attempt || 0))));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEndpoint(endpoint = '') {
  const raw = text(endpoint);
  if (!raw) return '';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function safeError(value) {
  return text(value).replace(/[A-Za-z0-9_\-]{20,}/gu, '[redacted]');
}

export class OpenDartRateLimiter {
  constructor({ dailyLimit = DEFAULT_OPENDART_DAILY_LIMIT } = {}) {
    this.dailyLimit = Math.max(1, Number(dailyLimit || DEFAULT_OPENDART_DAILY_LIMIT));
    this.day = yyyymmddKst();
    this.count = 0;
  }

  consume() {
    const day = yyyymmddKst();
    if (day !== this.day) {
      this.day = day;
      this.count = 0;
    }
    this.count += 1;
    if (this.count > this.dailyLimit) {
      throw new Error(`opendart_daily_limit_exceeded:${this.dailyLimit}`);
    }
    return { day: this.day, count: this.count, dailyLimit: this.dailyLimit };
  }

  snapshot() {
    return { day: this.day, count: this.count, dailyLimit: this.dailyLimit };
  }
}

export class OpenDartClient {
  constructor(options = {}) {
    this.apiKey = secretText(options.apiKey);
    this.baseUrl = text(options.baseUrl || DEFAULT_OPENDART_BASE_URL).replace(/\/+$/u, '');
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_OPENDART_TIMEOUT_MS));
    this.retryCap = Math.max(0, Number(options.retryCap ?? DEFAULT_OPENDART_RETRY_CAP));
    this.rateLimiter = options.rateLimiter || new OpenDartRateLimiter({ dailyLimit: options.dailyLimit });
  }

  static async fromSecrets(options = {}) {
    const credentials = await resolveOpenDartCredentials(options);
    return new OpenDartClient({ ...options, apiKey: credentials.apiKey, baseUrl: credentials.baseUrl });
  }

  async request(endpoint, params = {}, options = {}) {
    if (!this.apiKey) {
      return { ok: false, endpoint: normalizeEndpoint(endpoint), error: 'missing_opendart_api_key', data: null };
    }
    const normalizedEndpoint = normalizeEndpoint(endpoint);
    const url = new URL(`${this.baseUrl}${normalizedEndpoint}`);
    url.searchParams.set('crtfc_key', this.apiKey);
    for (const [key, value] of Object.entries(params || {})) {
      if (value == null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    let lastError = null;
    const retryCap = Math.max(0, Number(options.retryCap ?? this.retryCap));
    for (let attempt = 0; attempt <= retryCap; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs || this.timeoutMs)));
      try {
        const usage = this.rateLimiter.consume();
        const response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (response.status === 429) {
          const retryAfterMs = Math.max(0, Number(response.headers.get('retry-after') || 0) * 1000);
          throw new Error(`http_429_retry_after_${retryAfterMs || retryDelayMs(attempt)}`);
        }
        if (!response.ok) throw new Error(`http_${response.status}`);
        const data = await response.json();
        const dartStatus = text(data?.status);
        const emptyResultOk = dartStatus === '013' && (options.emptyStatusOk === true || normalizedEndpoint === '/list.json');
        const ok = dartStatus === '' || dartStatus === '000' || emptyResultOk;
        return {
          ok,
          empty: emptyResultOk,
          endpoint: normalizedEndpoint,
          params: { ...params },
          data,
          dartStatus: dartStatus || null,
          message: data?.message || null,
          usage,
          error: ok ? null : safeError(data?.message || `dart_status_${dartStatus}`),
        };
      } catch (error) {
        lastError = error;
        if (attempt < retryCap) await sleep(retryDelayMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    return {
      ok: false,
      endpoint: normalizedEndpoint,
      params: { ...params },
      data: null,
      error: safeError(lastError?.message || lastError || 'opendart_request_failed'),
      usage: this.rateLimiter.snapshot(),
    };
  }

  listDisclosures(params = {}) {
    return this.request('/list.json', {
      bgn_de: params.bgnDe || params.bgn_de || addDaysYyyymmdd(yyyymmddKst(), -1),
      end_de: params.endDe || params.end_de || yyyymmddKst(),
      corp_code: params.corpCode || params.corp_code || undefined,
      corp_cls: params.corpCls || params.corp_cls || undefined,
      pblntf_ty: params.pblntfTy || params.pblntf_ty || undefined,
      page_no: params.pageNo || params.page_no || 1,
      page_count: params.pageCount || params.page_count || 100,
    }, params);
  }

  company(corpCode, options = {}) {
    return this.request('/company.json', { corp_code: corpCode }, options);
  }

  singleFinancialStatementAll(params = {}) {
    return this.request('/fnlttSinglAcntAll.json', {
      corp_code: params.corpCode || params.corp_code,
      bsns_year: params.bsnsYear || params.bsns_year,
      reprt_code: params.reprtCode || params.reprt_code || '11011',
      fs_div: params.fsDiv || params.fs_div || 'CFS',
    }, params);
  }

  multiAccounts(params = {}) {
    return this.request('/fnlttMultiAcnt.json', {
      corp_code: params.corpCodes || params.corp_code || params.corpCode,
      bsns_year: params.bsnsYear || params.bsns_year,
      reprt_code: params.reprtCode || params.reprt_code || '11011',
    }, params);
  }

  executiveStatus(params = {}) {
    return this.request('/exctvSttus.json', {
      corp_code: params.corpCode || params.corp_code,
      bsns_year: params.bsnsYear || params.bsns_year,
      reprt_code: params.reprtCode || params.reprt_code || '11011',
    }, params);
  }

  dividendMatters(params = {}) {
    return this.request('/alotMatter.json', {
      corp_code: params.corpCode || params.corp_code,
      bsns_year: params.bsnsYear || params.bsns_year,
      reprt_code: params.reprtCode || params.reprt_code || '11011',
    }, params);
  }
}

export function normalizeOpenDartDisclosure(row = {}) {
  const reportName = text(row.report_nm || row.reportName);
  const corpName = text(row.corp_name || row.corpName);
  const reportType = classifyDisclosureReport(reportName);
  return {
    corpCode: text(row.corp_code || row.corpCode),
    corpName,
    stockCode: text(row.stock_code || row.stockCode),
    corpCls: text(row.corp_cls || row.corpCls),
    reportName,
    reportType,
    receiptNo: text(row.rcept_no || row.receiptNo),
    receiptDate: text(row.rcept_dt || row.receiptDate),
    submitter: text(row.flr_nm || row.submitter),
    url: row.rcept_no ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(row.rcept_no)}` : null,
    importanceScore: scoreDisclosureImportance({ reportName, corpName }),
    keywords: disclosureKeywords(reportName),
    raw: row,
  };
}

export function normalizeOpenDartFinancialRow(row = {}) {
  return {
    corpCode: text(row.corp_code || row.corpCode),
    bsnsYear: text(row.bsns_year || row.bsnsYear),
    reprtCode: text(row.reprt_code || row.reprtCode),
    fsDiv: text(row.fs_div || row.fsDiv),
    sjDiv: text(row.sj_div || row.sjDiv),
    accountId: text(row.account_id || row.accountId),
    accountName: text(row.account_nm || row.accountName),
    accountDetail: text(row.account_detail || row.accountDetail),
    currentAmount: num(row.thstrm_amount ?? row.currentAmount, null),
    previousAmount: num(row.frmtrm_amount ?? row.previousAmount, null),
    beforePreviousAmount: num(row.bfefrmtrm_amount ?? row.beforePreviousAmount, null),
    ordinal: num(row.ord ?? row.ordinal, null),
    raw: row,
  };
}

export function classifyDisclosureReport(reportName = '') {
  const name = text(reportName);
  if (/분기보고서|반기보고서|사업보고서/u.test(name)) return 'periodic_report';
  if (/잠정|영업\(잠정\)|실적/u.test(name)) return 'earnings';
  if (/유상증자|무상증자|유무상증자|지분증권|전환사채|신주인수권|교환사채/u.test(name)) return 'dilution';
  if (/자기주식|자사주/u.test(name)) return 'shareholder_return';
  if (/합병|분할|영업양수|영업양도|타법인|주요경영사항/u.test(name)) return 'corporate_action';
  if (/소송|횡령|배임|불성실|상장폐지|관리종목/u.test(name)) return 'risk_event';
  if (/최대주주|임원|주식등의대량보유/u.test(name)) return 'ownership';
  return 'general';
}

export function disclosureKeywords(reportName = '') {
  const name = text(reportName);
  const pairs = [
    ['earnings', /잠정|실적|분기보고서|반기보고서|사업보고서/u],
    ['dilution', /유상증자|무상증자|유무상증자|지분증권|전환사채|신주인수권|교환사채/u],
    ['buyback', /자기주식|자사주/u],
    ['ma', /합병|분할|영업양수|영업양도/u],
    ['lawsuit', /소송|횡령|배임/u],
    ['delisting_risk', /상장폐지|관리종목|불성실/u],
    ['ownership', /최대주주|임원|대량보유/u],
  ];
  return pairs.filter(([, pattern]) => pattern.test(name)).map(([keyword]) => keyword);
}

export function scoreDisclosureImportance({ reportName = '', corpName = '' } = {}) {
  const name = `${corpName} ${reportName}`;
  let score = 3;
  if (/소송|횡령|배임|상장폐지|관리종목|불성실/u.test(name)) score = Math.max(score, 9);
  if (/유상증자|무상증자|유무상증자|지분증권|전환사채|신주인수권|교환사채|감자/u.test(name)) score = Math.max(score, 8);
  if (/합병|분할|영업양수|영업양도|타법인/u.test(name)) score = Math.max(score, 8);
  if (/주요경영사항/u.test(name)) score = Math.max(score, 6);
  if (/잠정|실적|매출액|영업이익/u.test(name)) score = Math.max(score, 7);
  if (/자기주식|자사주|배당/u.test(name)) score = Math.max(score, 6);
  if (/분기보고서|반기보고서|사업보고서/u.test(name)) score = Math.max(score, 5);
  return Math.max(1, Math.min(10, score));
}

export function extractOpenDartList(result = {}) {
  const rows = Array.isArray(result?.data?.list) ? result.data.list : Array.isArray(result?.list) ? result.list : [];
  return rows.map(normalizeOpenDartDisclosure);
}

export function extractOpenDartFinancialRows(result = {}) {
  const rows = Array.isArray(result?.data?.list) ? result.data.list : Array.isArray(result?.list) ? result.list : [];
  return rows.map(normalizeOpenDartFinancialRow);
}

export default {
  OpenDartClient,
  OpenDartRateLimiter,
  resolveOpenDartCredentials,
  resolveOpenDartCredentialStatus,
  normalizeOpenDartDisclosure,
  normalizeOpenDartFinancialRow,
  classifyDisclosureReport,
  scoreDisclosureImportance,
  extractOpenDartList,
  extractOpenDartFinancialRows,
};
