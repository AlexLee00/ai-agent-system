'use strict';

/**
 * arXiv API 클라이언트 — 키워드별 최신 논문 수집
 * API: https://info.arxiv.org/help/api/basics.html
 */

const ARXIV_API_URL = 'http://export.arxiv.org/api/query';
const REQUEST_TIMEOUT_MS = _readPositiveIntEnv('DARWIN_ARXIV_REQUEST_TIMEOUT_MS', 20_000, { min: 5_000, max: 120_000 });
const KEYWORD_DELAY_MS = _readPositiveIntEnv('DARWIN_ARXIV_KEYWORD_DELAY_MS', 1_000, { min: 500, max: 60_000 });
const DOMAIN_DELAY_MS = _readPositiveIntEnv('DARWIN_ARXIV_DOMAIN_DELAY_MS', 1_000, { min: 500, max: 60_000 });
const MAX_RETRIES = _readPositiveIntEnv('DARWIN_ARXIV_MAX_RETRIES', 2, { min: 0, max: 5 });
const RETRY_BASE_DELAY_MS = _readPositiveIntEnv('DARWIN_ARXIV_RETRY_BASE_DELAY_MS', 1_000, { min: 500, max: 60_000 });

type DarwinDomain =
  | 'neuron'
  | 'gold-r'
  | 'ink'
  | 'gavel'
  | 'matrix-r'
  | 'frame'
  | 'gear'
  | 'pulse'
  | 'frontier';

interface ArxivEntry {
  arxiv_id: string;
  title: string;
  summary: string;
  authors: string;
  published: string;
  domain?: DarwinDomain;
  source?: 'arxiv';
  keyword?: string;
}

const DOMAIN_KEYWORDS: Record<DarwinDomain, string[]> = {
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

function _readPositiveIntEnv(name: string, fallback: number, options: { min?: number; max?: number } = {}): number {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;

  const min = Number.isFinite(options.min) ? Number(options.min) : 1;
  const max = Number.isFinite(options.max) ? Number(options.max) : Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, value));
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _shouldRetry(err?: unknown, status?: number): boolean {
  if (status === 429) return true;
  if (status !== undefined && [500, 502, 503, 504].includes(status)) return true;
  if (!err) return false;
  const message =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message?: unknown }).message || '').toLowerCase()
      : '';
  return message.includes('timed out')
    || message.includes('timeout')
    || message.includes('aborted')
    || (typeof err === 'object' && err !== null && 'name' in err && (err as { name?: unknown }).name === 'TimeoutError');
}

async function _fetchWithRetry(url: string, context: string): Promise<Response> {
  let lastError: unknown = null;

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
        const errorMessage =
          typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message?: unknown }).message || 'unknown error')
            : String(err || 'unknown error');
        console.warn(`[arxiv-client] ${context} 재시도 예정: ${errorMessage} (${attempt + 1}/${MAX_RETRIES})`);
        await _sleep(delay);
      }
    }

  throw lastError || new Error(`${context} arXiv fetch 실패`);
}

function _buildQuery(keyword: string): string {
  return keyword
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `all:${word}`)
    .join('+AND+');
}

function _parseArxivXml(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

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

async function searchByDomain(domain: DarwinDomain, maxResults = 20): Promise<ArxivEntry[]> {
  const keywords = DOMAIN_KEYWORDS[domain];
  if (!Array.isArray(keywords) || keywords.length === 0) return [];

  const results: ArxivEntry[] = [];
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
      const errorMessage =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message?: unknown }).message || 'unknown error')
          : String(err || 'unknown error');
      console.warn(`[arxiv-client] ${context} 실패: ${errorMessage}`);
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
