// @ts-nocheck
'use strict';

const path = require('path');
const kst = require(path.join(__dirname, '../../../packages/core/lib/kst'));

const CATEGORY_MAP = {
  general: '일일업무',
  meeting: '미팅',
  task: '일일업무',
  report: '보고',
  other: '기타',
};

function shiftKstDate(dateStr, days) {
  const base = new Date(`${dateStr}T12:00:00+09:00`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function inferDate(prompt = '') {
  const text = String(prompt || '');
  if (/모레/.test(text)) return shiftKstDate(kst.today(), 2);
  if (/내일/.test(text)) return shiftKstDate(kst.today(), 1);
  const explicit = text.match(/(20\d{2})[-/.년 ]\s*(\d{1,2})[-/.월 ]\s*(\d{1,2})/);
  if (explicit) {
    const [, year, month, day] = explicit;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const monthDay = text.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (monthDay) {
    const year = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }).slice(0, 4);
    return `${year}-${String(monthDay[1]).padStart(2, '0')}-${String(monthDay[2]).padStart(2, '0')}`;
  }
  return kst.today();
}

function inferCategory(prompt = '') {
  const text = String(prompt || '');
  if (/(회의|미팅|콜|업체 미팅)/.test(text)) return 'meeting';
  if (/(보고|리포트|보고서|결과 공유)/.test(text)) return 'report';
  if (/(업무|작업|처리|요청|진행|완료)/.test(text)) return 'general';
  if (/(기타|메모|비고)/.test(text)) return 'other';
  return 'general';
}

function cleanContent(prompt = '') {
  const cleaned = String(prompt || '')
    .replace(/(오늘|내일|모레)/g, '')
    .replace(/(20\d{2})[-/.년 ]\s*\d{1,2}[-/.월 ]\s*\d{1,2}/g, '')
    .replace(/\d{1,2}월\s*\d{1,2}일/g, '')
    .replace(/(업무일지|업무 기록|기록|일지|보고서|보고|정리)/g, '')
    .replace(/(써줘|작성해줘|남겨줘|기록해줘|등록해줘|만들어줘|추가해줘|정리해줘)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || String(prompt || '').trim();
}

function buildSummary(proposal = {}) {
  const categoryLabel = CATEGORY_MAP[proposal.category] || proposal.category || '일반';
  const preview = String(proposal.content || '').trim().slice(0, 28);
  return `${proposal.date || kst.today()} ${categoryLabel} 업무일지${preview ? ` · ${preview}` : ''}`;
}

function normalizeJournalProposal(proposal = {}) {
  const rawCategory = String(proposal.category || '').trim();
  const normalizedCategory = rawCategory === 'task' ? 'general' : rawCategory;
  const category = ['general', 'meeting', 'report', 'other'].includes(normalizedCategory)
    ? normalizedCategory
    : 'general';
  const date = String(proposal.date || kst.today()).slice(0, 10);
  const content = String(proposal.content || '').trim();
  if (!content) {
    throw new Error('업무일지 내용이 비어 있습니다.');
  }
  return {
    date,
    category,
    content,
    summary: buildSummary({ date, category, content }),
    confidence: proposal.confidence || 'medium',
    parser_meta: proposal.parser_meta || {},
  };
}

function buildJournalProposal({ prompt = '' }) {
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) {
    throw new Error('업무일지 내용을 입력해주세요.');
  }
  return normalizeJournalProposal({
    date: inferDate(normalizedPrompt),
    category: inferCategory(normalizedPrompt),
    content: cleanContent(normalizedPrompt),
    confidence: 'medium',
    parser_meta: {
      parser: 'rule-based-journal',
      prompt: normalizedPrompt,
    },
  });
}

module.exports = {
  buildJournalProposal,
  normalizeJournalProposal,
};
