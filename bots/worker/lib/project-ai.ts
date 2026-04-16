// @ts-nocheck
'use strict';

function inferName(prompt = '') {
  const text = String(prompt || '').trim();
  const patterns = [
    /([가-힣A-Za-z0-9][^,.\n]{1,40}?)\s*프로젝트\s*(만들어줘|생성해줘|등록해줘|추가해줘)/,
    /프로젝트\s*([가-힣A-Za-z0-9][^,.\n]{1,40}?)\s*(만들어줘|생성해줘|등록해줘|추가해줘)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return text
    .replace(/프로젝트/g, '')
    .replace(/(만들어줘|생성해줘|등록해줘|추가해줘|초안|새로운|신규)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferDateRange(prompt = '') {
  const text = String(prompt || '');
  const matches = [...text.matchAll(/(20\d{2})[-/.년 ]\s*(\d{1,2})[-/.월 ]\s*(\d{1,2})/g)];
  const toDate = (match) => `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  return {
    start_date: matches[0] ? toDate(matches[0]) : '',
    end_date: matches[1] ? toDate(matches[1]) : '',
  };
}

function normalizeProjectProposal(proposal = {}) {
  const name = String(proposal.name || '').trim();
  if (!name) {
    throw new Error('프로젝트 이름을 이해하지 못했습니다. 예: "신규 멤버 포털 프로젝트 만들어줘"');
  }
  const description = String(proposal.description || '').trim();
  const startDate = String(proposal.start_date || '').trim();
  const endDate = String(proposal.end_date || '').trim();
  return {
    name,
    description,
    status: ['planning', 'in_progress', 'review', 'completed'].includes(proposal.status) ? proposal.status : 'planning',
    start_date: startDate,
    end_date: endDate,
    summary: `${name} 프로젝트 생성 제안`,
    confidence: proposal.confidence || 'medium',
    parser_meta: proposal.parser_meta || {},
  };
}

function buildProjectProposal({ prompt = '' }) {
  const { start_date, end_date } = inferDateRange(prompt);
  return normalizeProjectProposal({
    name: inferName(prompt),
    description: '',
    status: 'planning',
    start_date,
    end_date,
    confidence: 'medium',
    parser_meta: {
      parser: 'rule-based-project',
      prompt,
    },
  });
}

module.exports = {
  buildProjectProposal,
  normalizeProjectProposal,
};
