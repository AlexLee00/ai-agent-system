// @ts-nocheck
'use strict';

/**
 * Hugging Face Papers API 클라이언트
 */

const HF_API_URL = 'https://huggingface.co/api';
const REQUEST_TIMEOUT_MS = 10_000;

const HF_KEYWORDS = [
  'multi-agent',
  'self-evolving agent',
  'autonomous research',
  'agent orchestration',
  'RAG agent',
  'tool use agent',
];

function _normalizePaper(paper, source) {
  return {
    arxiv_id: paper.paper?.id || paper.id || '',
    title: paper.paper?.title || paper.title || '',
    summary: (paper.paper?.summary || paper.summary || '').slice(0, 500),
    upvotes: paper.paper?.upvotes || paper.upvotes || 0,
    published: paper.publishedAt || paper.paper?.publishedAt || '',
    source,
    domain: 'frontier',
  };
}

async function fetchTrending() {
  try {
    const res = await fetch(`${HF_API_URL}/daily_papers`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const papers = await res.json();
    return papers.map((paper) => _normalizePaper(paper, 'hf_trending')).filter((paper) => paper.arxiv_id);
  } catch (err) {
    console.warn(`[hf-papers] 트렌딩 수집 실패: ${err.message}`);
    return [];
  }
}

async function searchByKeyword(keyword) {
  try {
    const res = await fetch(
      `${HF_API_URL}/papers?query=${encodeURIComponent(keyword)}&limit=10`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
    );
    if (!res.ok) return [];
    const papers = await res.json();
    return papers
      .map((paper) => ({ ..._normalizePaper(paper, 'hf_search'), keyword }))
      .filter((paper) => paper.arxiv_id);
  } catch (err) {
    console.warn(`[hf-papers] 검색 실패 (${keyword}): ${err.message}`);
    return [];
  }
}

module.exports = {
  fetchTrending,
  searchByKeyword,
  HF_KEYWORDS,
};
