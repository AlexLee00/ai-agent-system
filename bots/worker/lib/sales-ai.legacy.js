'use strict';

const kst = require('../../../packages/core/lib/kst');

function inferAmount(prompt = '') {
  const text = String(prompt || '');
  const match = text.match(/(\d[\d,]*)\s*만?원/);
  if (!match) return null;
  const numeric = Number(String(match[1]).replace(/[^\d]/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return /만원/.test(match[0]) ? numeric * 10000 : numeric;
}

function inferDate(prompt = '') {
  const text = String(prompt || '');
  if (/어제/.test(text)) {
    const base = new Date(`${kst.today()}T12:00:00+09:00`);
    base.setUTCDate(base.getUTCDate() - 1);
    return base.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  }
  const explicit = text.match(/(20\d{2})[-/.년 ]\s*(\d{1,2})[-/.월 ]\s*(\d{1,2})/);
  if (explicit) {
    return `${explicit[1]}-${String(explicit[2]).padStart(2, '0')}-${String(explicit[3]).padStart(2, '0')}`;
  }
  const monthDay = text.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (monthDay) {
    const year = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
    }).format(new Date());
    return `${year}-${String(monthDay[1]).padStart(2, '0')}-${String(monthDay[2]).padStart(2, '0')}`;
  }
  return kst.today();
}

function inferCategory(prompt = '') {
  const text = String(prompt || '');
  const categories = ['상품판매', '서비스', '구독', '광고', '컨설팅', '교육', '기타'];
  const matched = categories.find((item) => text.includes(item));
  return matched || '기타';
}

function inferDescription(prompt = '') {
  return String(prompt || '')
    .replace(/(\d[\d,]*)\s*만?원/g, '')
    .replace(/(오늘|어제|\d{1,2}월\s*\d{1,2}일|20\d{2}[-/.년 ]\s*\d{1,2}[-/.월 ]\s*\d{1,2})/g, '')
    .replace(/(매출|등록|추가|입력|기록|해줘|로|으로)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSalesProposal(proposal = {}) {
  const amount = Number(proposal.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('매출 금액을 이해하지 못했습니다. 예: "오늘 상품판매 5만원 매출 등록해줘"');
  }
  const date = String(proposal.date || '').trim() || kst.today();
  return {
    amount,
    category: String(proposal.category || '기타').trim() || '기타',
    description: String(proposal.description || '').trim(),
    date,
    summary: `${date} ${String(proposal.category || '기타').trim() || '기타'} 매출 ₩${amount.toLocaleString()} 등록 제안`,
    confidence: proposal.confidence || 'medium',
    parser_meta: proposal.parser_meta || {},
  };
}

function buildSalesProposal({ prompt = '' }) {
  const amount = inferAmount(prompt);
  return normalizeSalesProposal({
    amount,
    category: inferCategory(prompt),
    description: inferDescription(prompt),
    date: inferDate(prompt),
    confidence: amount ? 'medium' : 'low',
    parser_meta: {
      parser: 'rule-based-sales',
      prompt,
    },
  });
}

module.exports = {
  buildSalesProposal,
  normalizeSalesProposal,
};
