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
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
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

function inferType(prompt = '', fallbackType = '') {
  const text = String(prompt || '').trim();
  if (['meeting', 'task', 'event', 'reminder'].includes(fallbackType)) return fallbackType;
  if (/(미팅|회의|업체 미팅)/.test(text)) return 'meeting';
  if (/리마인더/.test(text)) return 'reminder';
  if (/이벤트/.test(text)) return 'event';
  return 'task';
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
  const monthDay = text.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (monthDay) {
    const nowParts = getKstParts(now);
    return `${nowParts.year}-${String(monthDay[1]).padStart(2, '0')}-${String(monthDay[2]).padStart(2, '0')}`;
  }
  return kst.today();
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

function cleanTitle(prompt = '') {
  return String(prompt || '')
    .replace(/(오늘|내일|모레)/g, '')
    .replace(/(\d{1,2}월\s*\d{1,2}일|\d{1,2}:\d{2}|오전|오후|밤|\d{1,2}\s*시(?:\s*\d{1,2}\s*분?)?)/g, '')
    .replace(/(잡아줘|등록해줘|만들어줘|추가해줘|보여줘|정리해줘|일정|미팅|회의|리마인더)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSummary(proposal = {}) {
  if (!proposal.start_time) return proposal.title || '일정 제안';
  const date = new Date(proposal.start_time);
  return `${proposal.title} · ${date.toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function normalizeScheduleProposal(proposal = {}) {
  const type = ['meeting', 'task', 'event', 'reminder'].includes(proposal.type) ? proposal.type : 'task';
  const title = String(proposal.title || '').trim() || '새 일정';
  const description = String(proposal.description || '').trim();
  const location = String(proposal.location || '').trim();
  const startTime = proposal.start_time || proposal.startTime;
  return {
    title,
    description,
    type,
    start_time: startTime,
    end_time: proposal.end_time || null,
    all_day: Boolean(proposal.all_day),
    location,
    attendees: Array.isArray(proposal.attendees) ? proposal.attendees : [],
    recurrence: proposal.recurrence || null,
    reminder: Number.isFinite(Number(proposal.reminder)) ? Number(proposal.reminder) : 30,
    summary: buildSummary({
      title,
      start_time: startTime,
    }),
    confidence: proposal.confidence || 'medium',
    parser_meta: proposal.parser_meta || {},
  };
}

function buildScheduleProposal({ prompt = '', fallbackType = '', now = new Date() }) {
  const type = inferType(prompt, fallbackType);
  const date = inferDate(prompt, now);
  const time = inferTime(prompt, now);
  const title = cleanTitle(prompt) || (type === 'meeting' ? '새 미팅' : type === 'reminder' ? '새 리마인더' : '새 일정');
  return normalizeScheduleProposal({
    title,
    type,
    start_time: buildKstIso(date, time.hour, time.minute),
    end_time: null,
    all_day: false,
    location: '',
    attendees: [],
    recurrence: null,
    reminder: 30,
    confidence: time.explicit ? 'high' : 'medium',
    parser_meta: {
      parser: 'rule-based-schedule',
      prompt,
      explicit_time: time.explicit,
      inferred_date: date,
    },
  });
}

module.exports = {
  buildScheduleProposal,
  normalizeScheduleProposal,
  buildScheduleSummary: buildSummary,
};

