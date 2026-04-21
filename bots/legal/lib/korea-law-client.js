'use strict';

const { resolveKoreaLawCredentials } = require('../../../packages/core/lib/legal-credentials.js');

const DEFAULT_BASE_URL = 'https://www.law.go.kr';

function stripTrailingSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function buildUrl(baseUrl, pathname, params) {
  const url = new URL(pathname, `${stripTrailingSlash(baseUrl || DEFAULT_BASE_URL)}/`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });
  return url;
}

async function fetchJson(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ai-agent-system/justin-korea-law-client',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function getAuth() {
  const credentials = await resolveKoreaLawCredentials();
  if (!credentials?.oc) {
    throw new Error('korea law credentials not configured');
  }
  return {
    oc: credentials.oc,
    baseUrl: credentials.baseUrl || DEFAULT_BASE_URL,
    userId: credentials.userId || '',
    userName: credentials.userName || '',
  };
}

function normalizeLawRows(rows = []) {
  const list = Array.isArray(rows) ? rows : [rows];
  return list.map((row) => ({
    id: row.법령ID || row.LSID || '',
    mst: row.법령일련번호 || row.MST || '',
    nameKo: row.법령명한글 || row.법령명_한글 || row.LM || '',
    nameAlias: row.법령약칭명 || row.법령명약칭 || '',
    ministry: row.소관부처명 || row.소관부처 || '',
    kind: row.법령구분명 || row.법종구분 || '',
    promulgationDate: row.공포일자 || '',
    effectiveDate: row.시행일자 || '',
    detailLink: row.법령상세링크 || '',
  }));
}

function normalizePrecedentRows(rows = []) {
  const list = Array.isArray(rows) ? rows : [rows];
  return list.map((row) => ({
    id: row.판례일련번호 || row.판례정보일련번호 || row.ID || '',
    caseNumber: row.사건번호 || '',
    caseName: row.사건명 || '',
    court: row.법원명 || '',
    courtTypeCode: row.법원종류코드 || '',
    decisionDate: row.선고일자 || '',
    caseType: row.사건종류명 || '',
    decisionType: row.판결유형 || '',
    detailLink: row.판례상세링크 || '',
    summary: row.판결요지 || row.판시사항 || '',
  }));
}

async function searchLaws(query, { display = 10, page = 1, search = 1, timeoutMs = 20000 } = {}) {
  const auth = await getAuth();
  const url = buildUrl(auth.baseUrl, '/DRF/lawSearch.do', {
    OC: auth.oc,
    target: 'law',
    type: 'JSON',
    query,
    display,
    page,
    search,
  });
  const payload = await fetchJson(url, { timeoutMs });
  const root = payload?.LawSearch || {};
  return {
    keyword: root.키워드 || query,
    total: Number(root.totalCnt || 0),
    page: Number(root.page || page),
    items: normalizeLawRows(root.law || []),
  };
}

async function fetchLawDetail({ id = '', mst = '', jo = '', timeoutMs = 20000 } = {}) {
  const auth = await getAuth();
  const url = buildUrl(auth.baseUrl, '/DRF/lawService.do', {
    OC: auth.oc,
    target: 'law',
    type: 'JSON',
    ID: id,
    MST: mst,
    JO: jo,
  });
  return fetchJson(url, { timeoutMs });
}

async function searchPrecedents(query, { display = 10, page = 1, timeoutMs = 20000 } = {}) {
  const auth = await getAuth();
  const url = buildUrl(auth.baseUrl, '/DRF/lawSearch.do', {
    OC: auth.oc,
    target: 'prec',
    type: 'JSON',
    query,
    display,
    page,
  });
  const payload = await fetchJson(url, { timeoutMs });
  const root = payload?.PrecSearch || {};
  return {
    keyword: root.키워드 || query,
    total: Number(root.totalCnt || 0),
    page: Number(root.page || page),
    items: normalizePrecedentRows(root.prec || []),
  };
}

async function fetchPrecedentDetail(id, { timeoutMs = 20000 } = {}) {
  const auth = await getAuth();
  const url = buildUrl(auth.baseUrl, '/DRF/lawService.do', {
    OC: auth.oc,
    target: 'prec',
    type: 'JSON',
    ID: id,
  });
  return fetchJson(url, { timeoutMs });
}

module.exports = {
  searchLaws,
  fetchLawDetail,
  searchPrecedents,
  fetchPrecedentDetail,
};
