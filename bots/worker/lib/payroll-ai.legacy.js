'use strict';

function getKstYearMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value || '0000';
  const month = parts.find((part) => part.type === 'month')?.value || '01';
  return `${year}-${month}`;
}

function shiftYearMonth(yearMonth, diff) {
  const [year, month] = String(yearMonth).split('-').map(Number);
  const base = new Date(Date.UTC(year, month - 1, 1));
  base.setUTCMonth(base.getUTCMonth() + diff);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}`;
}

function inferYearMonth(prompt = '', now = new Date()) {
  const text = String(prompt || '').trim();
  const current = getKstYearMonth(now);

  const explicit = text.match(/(20\d{2})[-/.년 ]\s*(\d{1,2})\s*월?/);
  if (explicit) {
    return `${explicit[1]}-${String(explicit[2]).padStart(2, '0')}`;
  }

  if (/(지난달|저번달|전월)/.test(text)) return shiftYearMonth(current, -1);
  if (/(다음달|내달|익월)/.test(text)) return shiftYearMonth(current, 1);
  return current;
}

function buildSummary(yearMonth) {
  return `${yearMonth} 급여 계산 제안`;
}

function normalizePayrollProposal(proposal = {}) {
  const yearMonth = String(proposal.year_month || proposal.yearMonth || '').trim();
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    throw new Error('급여 대상 월 형식이 올바르지 않습니다. 예: 2026-03');
  }
  return {
    action: 'calculate_payroll',
    action_label: '급여 계산',
    year_month: yearMonth,
    summary: buildSummary(yearMonth),
    confidence: proposal.confidence || 'medium',
    parser_meta: proposal.parser_meta || {},
  };
}

function buildPayrollProposal({ prompt = '', now = new Date() }) {
  const yearMonth = inferYearMonth(prompt, now);
  return normalizePayrollProposal({
    year_month: yearMonth,
    confidence: /20\d{2}[-/.년 ]\s*\d{1,2}/.test(String(prompt || '')) ? 'high' : 'medium',
    parser_meta: {
      parser: 'rule-based-payroll',
      prompt,
      inferred_year_month: yearMonth,
    },
  });
}

module.exports = {
  buildPayrollProposal,
  normalizePayrollProposal,
};
