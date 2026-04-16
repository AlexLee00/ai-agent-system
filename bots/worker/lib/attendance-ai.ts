// @ts-nocheck
'use strict';

const path = require('path');
const kst = require(path.join(__dirname, '../../../packages/core/lib/kst'));

function getKstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find(part => part.type === type)?.value || '00';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function shiftKstDate(dateStr, days) {
  const base = new Date(`${dateStr}T12:00:00+09:00`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function buildKstIso(dateStr, hour, minute) {
  return `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
}

function toSummary(occurredAt, actionLabel) {
  const date = new Date(occurredAt);
  return date.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) + ` ${actionLabel}`;
}

function inferAction(prompt = '', fallbackAction = '') {
  const text = String(prompt || '').trim();
  if (fallbackAction === 'checkin' || fallbackAction === 'checkout') return fallbackAction;
  if (/퇴근|퇴근해|퇴근합니다|퇴근할게/.test(text)) return 'checkout';
  if (/출근|출근해|출근했|출근합니다|출근할게/.test(text)) return 'checkin';
  return null;
}

function inferDate(prompt = '', now = new Date()) {
  const text = String(prompt || '');
  if (/모레/.test(text)) return shiftKstDate(kst.today(), 2);
  if (/내일/.test(text)) return shiftKstDate(kst.today(), 1);
  const explicit = text.match(/(20\d{2})[-/.년 ]\s*(\d{1,2})[-/.월 ]\s*(\d{1,2})/);
  if (explicit) {
    const [, year, month, day] = explicit;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return getKstParts(now) && kst.today();
}

function inferTime(prompt = '', now = new Date()) {
  const text = String(prompt || '');
  const nowParts = getKstParts(now);

  let hour = nowParts.hour;
  let minute = nowParts.minute;
  let explicit = false;

  const hhmm = text.match(/(\d{1,2}):(\d{2})/);
  if (hhmm) {
    hour = Number(hhmm[1]);
    minute = Number(hhmm[2]);
    explicit = true;
  } else {
    const kor = text.match(/(오전|오후|밤)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분?)?/);
    if (kor) {
      const meridiem = kor[1] || '';
      hour = Number(kor[2]);
      minute = Number(kor[3] || 0);
      if ((meridiem === '오후' || meridiem === '밤') && hour < 12) hour += 12;
      if (meridiem === '오전' && hour === 12) hour = 0;
      explicit = true;
    }
  }

  return { hour, minute, explicit };
}

function normalizeAttendanceProposal(proposal = {}, employee = {}) {
  const action = proposal.action === 'checkout' ? 'checkout' : 'checkin';
  const actionLabel = action === 'checkout' ? '퇴근' : '출근';
  const occurredAt = proposal.occurred_at || proposal.occurredAt;
  const note = String(proposal.note || '').trim();
  const date = new Date(occurredAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

  return {
    action,
    action_label: actionLabel,
    employee_id: employee.id || proposal.employee_id,
    employee_name: employee.name || proposal.employee_name,
    date,
    occurred_at: occurredAt,
    note,
    summary: toSummary(occurredAt, actionLabel),
    confidence: proposal.confidence || 'medium',
    parser_meta: proposal.parser_meta || {},
  };
}

function buildAttendanceProposal({ prompt = '', fallbackAction = '', employee = {}, now = new Date() }) {
  const action = inferAction(prompt, fallbackAction);
  if (!action) {
    throw new Error('출근 또는 퇴근 요청인지 이해하지 못했습니다. 예: "출근했어요", "퇴근합니다"');
  }

  const date = inferDate(prompt, now);
  const time = inferTime(prompt, now);
  const occurredAt = buildKstIso(date, time.hour, time.minute);
  const actionLabel = action === 'checkout' ? '퇴근' : '출근';

  return normalizeAttendanceProposal({
    action,
    occurred_at: occurredAt,
    note: '',
    confidence: time.explicit ? 'high' : 'medium',
    parser_meta: {
      parser: 'rule-based-attendance',
      prompt,
      explicit_time: time.explicit,
      inferred_date: date,
    },
  }, employee);
}

module.exports = {
  buildAttendanceProposal,
  normalizeAttendanceProposal,
};
