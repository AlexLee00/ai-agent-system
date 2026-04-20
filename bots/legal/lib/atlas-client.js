'use strict';

const DEFAULT_BASE_URL = 'https://www.courtlistener.com';

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
        'User-Agent': 'ai-agent-system/justin-atlas-client',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeOpinion(row = {}) {
  const opinion = Array.isArray(row.opinions) && row.opinions.length ? row.opinions[0] : {};
  return {
    id: String(row.cluster_id || opinion.id || ''),
    caseName: row.caseNameFull || row.caseName || '',
    citation: Array.isArray(row.citation) ? row.citation.join('; ') : (row.citation || ''),
    court: row.court || row.court_citation_string || '',
    docketNumber: row.docketNumber || '',
    dateFiled: row.dateFiled || '',
    absoluteUrl: row.absolute_url ? `${DEFAULT_BASE_URL}${row.absolute_url}` : '',
    snippet: opinion.snippet || '',
    judge: row.judge || '',
    score: Number(row?.meta?.score?.bm25 || 0),
  };
}

async function searchUsOpinions(query, { limit = 5, orderBy = 'score desc', timeoutMs = 20000 } = {}) {
  const url = buildUrl(DEFAULT_BASE_URL, '/api/rest/v4/search/', {
    q: query,
    type: 'o',
    order_by: orderBy,
  });
  const payload = await fetchJson(url, { timeoutMs });
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return {
    total: Number(payload?.count || 0),
    items: results.slice(0, limit).map(normalizeOpinion),
  };
}

module.exports = {
  searchUsOpinions,
};
