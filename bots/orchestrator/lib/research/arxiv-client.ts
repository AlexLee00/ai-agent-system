// @ts-nocheck
'use strict';

/**
 * arXiv API 클라이언트 — 키워드별 최신 논문 수집
 * API: https://info.arxiv.org/help/api/basics.html
 */

const ARXIV_API_URL = 'http://export.arxiv.org/api/query';
const REQUEST_TIMEOUT_MS = 30_000;
const KEYWORD_DELAY_MS = 5_000;
const DOMAIN_DELAY_MS = 5_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 5_000;

const DOMAIN_KEYWORDS = {
  neuron: ['multi-agent system LLM', 'autonomous agent tool use', 'agent orchestration'],
  'gold-r': ['algorithmic trading agent', 'portfolio optimization LLM', 'financial agent'],
  ink: ['content generation SEO', 'blog automation LLM', 'text quality evaluation'],
  gavel: ['legal AI agent', 'software forensics automation', 'court document analysis'],
  'matrix-r': ['data pipeline agent', 'automated data analysis', 'feature engineering LLM'],
  frame: ['video editing AI', 'scene detection agent', 'subtitle generation'],
  gear: ['infrastructure automation agent', 'system monitoring LLM', 'self-healing system'],
  pulse: ['marketing automation AI', 'monetization agent', 'growth optimization'],
  frontier: ['arXiv trending AI 2026', 'latest agent framework', 'MCP protocol agent'],
};

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _shouldRetry(err, status) {
  if (status === 429) return true;
  if ([500, 502, 503, 504].includes(status)) return true;
  if (!err) return false;
  const message = String(err.message || '').toLowerCase();
  return message.includes('timed out')
    || message.includes('timeout')
    || message.includes('aborted')
    || err.name === 'TimeoutError';
}

async function _fetchWithRetry(url, context) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) return res;

      if (!_shouldRetry(null, res.status) || attempt === MAX_RETRIES) {
        console.warn(`[arxiv-client] ${context} 실패: HTTP ${res.status}`);
        return res;
      }

      const delay = RETRY_BASE_DELAY_MS * (2 ** attempt);
      console.warn(`[arxiv-client] ${context} 재시도 예정: HTTP ${res.status} (${attempt + 1}/${MAX_RETRIES})`);
      await _sleep(delay);
    } catch (err) {
      lastError = err;

      if (!_shouldRetry(err) || attempt === MAX_RETRIES) {
        throw err;
      }

      const delay = RETRY_BASE_DELAY_MS * (2 ** attempt);
      console.warn(`[arxiv-client] ${context} 재시도 예정: ${err.message} (${attempt + 1}/${MAX_RETRIES})`);
      await _sleep(delay);
    }
  }

  throw lastError || new Error(`${context} arXiv fetch 실패`);
}

function _buildQuery(keyword) {
  return keyword
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `all:${word}`)
    .join('+AND+');
}

function _parseArxivXml(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const id = (entry.match(/<id>(.*?)<\/id>/) || [])[1] || '';
    const arxivId = id.replace('http://arxiv.org/abs/', '').replace(/v\d+$/, '');
    const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/\s+/g, ' ').trim() || '';
    const summary = (entry.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]?.replace(/\s+/g, ' ').trim() || '';
    const published = (entry.match(/<published>(.*?)<\/published>/) || [])[1] || '';
    const authors = [...entry.matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1]).join(', ');

    if (!arxivId || !title) continue;
    entries.push({
      arxiv_id: arxivId,
      title,
      summary: summary.slice(0, 500),
      authors,
      published,
    });
  }

  return entries;
}

async function searchByDomain(domain, maxResults = 20) {
  const keywords = DOMAIN_KEYWORDS[domain];
  if (!Array.isArray(keywords) || keywords.length === 0) return [];

  const results = [];
  const perKeyword = Math.max(1, Math.ceil(maxResults / keywords.length));

  for (const keyword of keywords) {
    const query = _buildQuery(keyword);
    const url = `${ARXIV_API_URL}?search_query=${query}&start=0&max_results=${perKeyword}&sortBy=submittedDate&sortOrder=descending`;
    const context = `${domain}/${keyword}`;

    try {
      const res = await _fetchWithRetry(url, context);
      if (!res.ok) {
        console.warn(`[arxiv-client] ${context} 실패: HTTP ${res.status}`);
      } else {
        const xml = await res.text();
        const entries = _parseArxivXml(xml);
        entries.forEach((entry) => {
          entry.domain = domain;
          entry.source = 'arxiv';
          entry.keyword = keyword;
        });
        results.push(...entries);
      }
    } catch (err) {
      console.warn(`[arxiv-client] ${context} 실패: ${err.message}`);
    }

    await _sleep(KEYWORD_DELAY_MS);
  }

  await _sleep(DOMAIN_DELAY_MS);

  return results;
}

module.exports = {
  searchByDomain,
  DOMAIN_KEYWORDS,
};
