// @ts-nocheck
'use strict';

const path = require('path');
const kst = require(path.join(__dirname, '../../../packages/core/lib/kst'));

function shiftKstDate(dateStr, days) {
  const base = new Date(`${dateStr}T12:00:00+09:00`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function inferLeaveDate(prompt = '') {
  const text = String(prompt || '').trim();
  if (/모레/.test(text)) return shiftKstDate(kst.today(), 2);
  if (/내일/.test(text)) return shiftKstDate(kst.today(), 1);
  if (/오늘/.test(text)) return kst.today();
  const explicit = text.match(/(20\d{2})[-/.년 ]\s*(\d{1,2})[-/.월 ]\s*(\d{1,2})/);
  if (explicit) {
    const [, year, month, day] = explicit;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return kst.today();
}

function inferLeaveType(prompt = '') {
  const text = String(prompt || '').trim();
  if (/반차/.test(text)) return 'half_day';
  if (/외근/.test(text)) return 'field_work';
  return 'annual_leave';
}

function inferLeaveReason(prompt = '') {
  const text = String(prompt || '').trim();
  return text
    .replace(/(오늘|내일|모레|반차|연차|휴가|외근|신청|낼게요|내고 싶어요|쓰고 싶어요|올려줘|등록해줘|해줘)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function leaveTypeLabel(type) {
  if (type === 'half_day') return '반차';
  if (type === 'field_work') return '외근';
  return '연차';
}

function buildLeaveSummary({ leaveDate, leaveType, employeeName }) {
  const label = leaveTypeLabel(leaveType);
  return `${leaveDate} ${label} 신청`;
}

function normalizeLeaveProposal(proposal = {}, employee = {}) {
  const leaveDate = proposal.leave_date || proposal.leaveDate || kst.today();
  const leaveType = proposal.leave_type || proposal.leaveType || 'annual_leave';
  const reason = String(proposal.reason || '').trim();

  return {
    leave_date: leaveDate,
    leave_type: leaveType,
    leave_type_label: leaveTypeLabel(leaveType),
    reason,
    employee_id: employee.id || proposal.employee_id,
    employee_name: employee.name || proposal.employee_name,
    summary: buildLeaveSummary({
      leaveDate,
      leaveType,
      employeeName: employee.name || proposal.employee_name,
    }),
    confidence: proposal.confidence || 'medium',
    parser_meta: proposal.parser_meta || {},
  };
}

function buildLeaveProposal({ prompt = '', employee = {} }) {
  if (!/(휴가|연차|반차|외근)/.test(prompt)) {
    throw new Error('휴가, 반차, 외근 요청인지 이해하지 못했습니다. 예: "내일 연차 신청", "오늘 오후 반차 신청"');
  }

  const leaveDate = inferLeaveDate(prompt);
  const leaveType = inferLeaveType(prompt);
  const reason = inferLeaveReason(prompt);

  return normalizeLeaveProposal({
    leave_date: leaveDate,
    leave_type: leaveType,
    reason,
    confidence: reason ? 'high' : 'medium',
    parser_meta: {
      parser: 'rule-based-leave',
      prompt,
      leave_date: leaveDate,
      leave_type: leaveType,
    },
  }, employee);
}

module.exports = {
  buildLeaveProposal,
  normalizeLeaveProposal,
};
