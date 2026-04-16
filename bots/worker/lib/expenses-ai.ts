// @ts-nocheck
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
  const categories = ['월세', '관리비', '세무기장', '인터넷/전화', '렌탈', '알바', '세금', '키오스크', '기타'];
  const matched = categories.find((item) => text.includes(item));
  return matched || '기타';
}

function inferExpenseType(prompt = '', category = '') {
  const text = `${prompt} ${category}`;
  return /(월세|관리비|세무기장|인터넷\/전화|렌탈)/.test(text) ? 'fixed' : 'variable';
}

function inferItemName(prompt = '') {
  return String(prompt || '')
    .replace(/(\d[\d,]*)\s*만?원/g, '')
    .replace(/(오늘|어제|\d{1,2}월\s*\d{1,2}일|20\d{2}[-/.년 ]\s*\d{1,2}[-/.월 ]\s*\d{1,2})/g, '')
    .replace(/(매입|지출|등록|추가|입력|기록|해줘|로|으로|처리|반영)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeExpenseProposal(proposal = {}) {
  const amount = Number(proposal.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('매입 금액을 이해하지 못했습니다. 예: "오늘 세무기장 88000원 지출 등록해줘"');
  }
  const date = String(proposal.date || '').trim() || kst.today();
  const category = String(proposal.category || '기타').trim() || '기타';
  const itemName = String(proposal.item_name || '').trim();
  const expenseType = ['fixed', 'variable'].includes(String(proposal.expense_type || ''))
    ? String(proposal.expense_type)
    : inferExpenseType('', category);
  return {
    amount,
    category,
    item_name: itemName,
    note: String(proposal.note || '').trim(),
    date,
    expense_type: expenseType,
    summary: `${date} ${category} 매입 ₩${amount.toLocaleString()} 등록 제안`,
    confidence: proposal.confidence || 'medium',
    parser_meta: proposal.parser_meta || {},
  };
}

function buildExpenseProposal({ prompt = '' }) {
  const amount = inferAmount(prompt);
  const category = inferCategory(prompt);
  return normalizeExpenseProposal({
    amount,
    category,
    item_name: inferItemName(prompt),
    note: '',
    date: inferDate(prompt),
    expense_type: inferExpenseType(prompt, category),
    confidence: amount ? 'medium' : 'low',
    parser_meta: {
      parser: 'rule-based-expenses',
      prompt,
    },
  });
}

module.exports = {
  buildExpenseProposal,
  normalizeExpenseProposal,
};
