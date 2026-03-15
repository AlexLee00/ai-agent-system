'use strict';

const path = require('path');
const kst = require(path.join(__dirname, '../../../packages/core/lib/kst'));

const CATEGORY_KEYWORDS = {
  계약서: ['계약', '협약', '약정', 'contract'],
  견적서: ['견적', 'quote', 'estimate'],
  세금계산서: ['세금계산서', 'invoice', 'tax'],
  보고서: ['보고서', 'report', '리포트'],
  회의자료: ['회의자료', '회의', '발표', 'ppt'],
  기타: [],
};

function detectDocumentCategory(text = '', fallback = '기타') {
  const normalized = String(text || '').toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => normalized.includes(String(keyword).toLowerCase()))) {
      return category;
    }
  }
  return fallback;
}

function cleanSummary(prompt = '') {
  const cleaned = String(prompt || '')
    .replace(/(문서|파일|자료|업로드|등록|올려줘|업로드해줘|정리해줘|분석해줘|검토해줘)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || String(prompt || '').trim();
}

function buildSummary(proposal = {}) {
  const filename = String(proposal.filename || '').trim();
  const category = String(proposal.category || '기타').trim();
  const summary = String(proposal.request_summary || '').trim();
  if (filename) {
    return `${category} 문서 업로드 · ${filename}`;
  }
  if (summary) {
    return `${category} 문서 업로드 · ${summary.slice(0, 24)}`;
  }
  return `${category} 문서 업로드 제안`;
}

function normalizeDocumentProposal(proposal = {}) {
  const filename = String(proposal.filename || '').trim();
  const category = String(proposal.category || '기타').trim() || '기타';
  const requestSummary = String(proposal.request_summary || proposal.requestSummary || '').trim();
  const analysisGoal = String(proposal.analysis_goal || proposal.analysisGoal || '').trim();

  return {
    filename,
    category,
    request_summary: requestSummary,
    analysis_goal: analysisGoal,
    requested_at: String(proposal.requested_at || proposal.requestedAt || kst.now()).trim(),
    summary: buildSummary({
      filename,
      category,
      request_summary: requestSummary,
    }),
    confidence: proposal.confidence || 'medium',
    parser_meta: proposal.parser_meta || {},
  };
}

function buildDocumentProposal({ prompt = '', filename = '' }) {
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) {
    throw new Error('문서 업로드 요청을 입력해주세요.');
  }
  const inferredCategory = detectDocumentCategory(`${normalizedPrompt} ${filename}`.trim(), '기타');
  const requestSummary = cleanSummary(normalizedPrompt);

  return normalizeDocumentProposal({
    filename: String(filename || '').trim(),
    category: inferredCategory,
    request_summary: requestSummary,
    analysis_goal: /검토|분석|요약/.test(normalizedPrompt) ? requestSummary : '',
    requested_at: kst.now(),
    confidence: filename ? 'high' : 'medium',
    parser_meta: {
      parser: 'rule-based-document',
      prompt: normalizedPrompt,
      filename: String(filename || '').trim(),
      inferred_category: inferredCategory,
    },
  });
}

module.exports = {
  buildDocumentProposal,
  normalizeDocumentProposal,
  detectDocumentCategory,
};
