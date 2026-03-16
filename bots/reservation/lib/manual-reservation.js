'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const kst = require('../../../packages/core/lib/kst');
const { transformPhoneNumber, transformRoom, validateTimeRange } = require('./validation');

function formatKstDate(date) {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function addKstDays(baseDateStr, days) {
  const base = new Date(`${baseDateStr}T00:00:00+09:00`);
  base.setUTCDate(base.getUTCDate() + days);
  return formatKstDate(base);
}

function parseDateFromText(text) {
  const raw = String(text || '');
  if (/모레/.test(raw)) return addKstDays(kst.today(), 2);
  if (/내일/.test(raw)) return addKstDays(kst.today(), 1);
  if (/오늘/.test(raw)) return kst.today();

  const iso = raw.match(/(20\d{2})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}-${String(Number(iso[3])).padStart(2, '0')}`;
  }

  const monthDay = raw.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (monthDay) {
    const year = Number(kst.today().slice(0, 4));
    return `${year}-${String(Number(monthDay[1])).padStart(2, '0')}-${String(Number(monthDay[2])).padStart(2, '0')}`;
  }

  return null;
}

function parseTimeToken(token) {
  const value = String(token || '').trim().replace(/\s+/g, '');
  if (!value) return null;

  const hhmm = value.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const hour = Number(hhmm[1]);
    const minute = Number(hhmm[2]);
    if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  const korean = value.match(/^(오전|오후)?(\d{1,2})시(?:(\d{1,2})분?)?$/);
  if (!korean) return null;

  const period = korean[1] || '';
  const hour = Number(korean[2]);
  const minute = Number(korean[3] || 0);
  let converted = hour;

  if (period === '오전') converted = hour === 12 ? 0 : hour;
  if (period === '오후') converted = hour === 12 ? 12 : hour + 12;

  if (!period && hour === 24 && minute === 0) {
    return '24:00';
  }

  if (converted < 0 || converted > 23 || minute < 0 || minute > 59) return null;
  return `${String(converted).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseTimeRangeFromText(text) {
  const normalized = String(text || '')
    .replace(/부터/g, '~')
    .replace(/까지/g, '')
    .replace(/-/g, '~')
    .replace(/\s+~\s+/g, '~');

  const rawTokens = [...normalized.matchAll(/(?:오전|오후)?\s*\d{1,2}시(?:\s*\d{1,2}분?)?|\d{1,2}:\d{2}/g)]
    .map(match => String(match[0] || '').trim())
    .filter(Boolean);

  const inheritedTokens = rawTokens.map((token, index) => {
    if (index === 0) return token;
    if (/^\d{1,2}:\d{2}$/.test(token)) return token;
    if (/^(오전|오후)/.test(token)) return token;
    const prev = rawTokens[index - 1] || '';
    const period = prev.match(/^(오전|오후)/)?.[1];
    if (period === '오전' && /^12시/.test(token)) {
      return token;
    }
    return period ? `${period} ${token}` : token;
  });

  const tokens = inheritedTokens.map(parseTimeToken).filter(Boolean);

  if (tokens.length < 2) return { start: null, end: null };
  return { start: tokens[0], end: tokens[1] };
}

function parseRoomFromText(text) {
  const roomMatch = String(text || '').match(/\b(A1|A2|B)\b\s*룸?|\b(A1|A2|B룸?)\b/i);
  if (!roomMatch) return null;
  const raw = roomMatch[1] || roomMatch[2] || '';
  return transformRoom(raw.replace(/룸/gi, ''));
}

function parseNameFromText(text) {
  const cleaned = String(text || '')
    .replace(/01\d[- ]?\d{3,4}[- ]?\d{4}/g, ' ')
    .replace(/20\d{2}[./-]\s*\d{1,2}[./-]\s*\d{1,2}/g, ' ')
    .replace(/\d{1,2}월\s*\d{1,2}일/g, ' ')
    .replace(/(?:오전|오후)?\s*\d{1,2}시(?:\s*\d{1,2}분?)?/g, ' ')
    .replace(/\d{1,2}:\d{2}/g, ' ')
    .replace(/\b(A1|A2|B)\b\s*룸?/gi, ' ')
    .replace(/\d+\s*건/g, ' ')
    .replace(/픽코|예약|등록|결제|차단|네이버|수동|대리예약|잡아줘|해줘|넣어줘|부탁해|처리해줘|요청/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const matches = cleaned.match(/[가-힣]{2,10}/g) || [];
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

function parseBatchCount(text, explicitCount) {
  if (Number.isFinite(Number(explicitCount)) && Number(explicitCount) > 0) {
    return Number(explicitCount);
  }
  const matched = String(text || '').match(/(\d+)\s*건/);
  return matched ? Number(matched[1]) : 1;
}

function parseReservationRequest(args = {}) {
  const rawText = String(args.raw_text || args.text || '').trim();
  const batchCount = parseBatchCount(rawText, args.batch_count);

  if (batchCount > 1) {
    return {
      ok: false,
      code: 'BATCH_NOT_SUPPORTED',
      error: `다건 예약 등록은 아직 지원하지 않습니다. 지금은 단건만 가능합니다. (${batchCount}건 감지)`,
    };
  }

  const reservation = {
    date: parseDateFromText(rawText),
    room: parseRoomFromText(rawText),
    phone: transformPhoneNumber(args.phone || rawText.match(/01\d[- ]?\d{3,4}[- ]?\d{4}/)?.[0]),
    name: (args.name || parseNameFromText(rawText) || '고객').trim(),
    ...parseTimeRangeFromText(rawText),
  };

  const missing = ['date', 'start', 'end', 'room', 'phone'].filter(key => !reservation[key]);
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'MISSING_FIELDS',
      error: `예약 등록에 필요한 정보가 부족합니다: ${missing.join(', ')}. 예: "내일 오후 3시~5시 A1 010-1234-5678 홍길동 예약해줘"`,
      missing,
    };
  }

  const timeCheck = validateTimeRange(reservation.start, reservation.end);
  if (!timeCheck.ok) {
    return {
      ok: false,
      code: 'INVALID_TIME_RANGE',
      error: timeCheck.error,
    };
  }

  return { ok: true, reservation };
}

function runManualReservationRegistration(args = {}) {
  const parsed = parseReservationRequest(args);
  if (!parsed.ok) return parsed;

  const scriptPath = path.join(__dirname, '../manual/reservation/pickko-register.js');
  const reservation = parsed.reservation;
  const childArgs = [
    scriptPath,
    `--date=${reservation.date}`,
    `--start=${reservation.start}`,
    `--end=${reservation.end}`,
    `--room=${reservation.room}`,
    `--phone=${reservation.phone}`,
    `--name=${reservation.name}`,
  ];

  const result = spawnSync('node', childArgs, {
    cwd: path.dirname(scriptPath),
    env: { ...process.env, MODE: process.env.MODE || 'ops' },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 2,
  });

  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const lastLine = stdout.split('\n').map(line => line.trim()).filter(Boolean).pop() || '';

  if (result.error) {
    return { ok: false, error: `픽코 예약 등록 실행 실패: ${result.error.message}` };
  }

  let payload = null;
  try { payload = lastLine ? JSON.parse(lastLine) : null; } catch { payload = null; }

  if (!payload) {
    return {
      ok: false,
      error: stderr || stdout || `픽코 예약 등록 결과를 해석하지 못했습니다. (exit ${result.status})`,
    };
  }

  return {
    ok: Boolean(payload.success),
    message: payload.message,
    reservation,
    exitCode: result.status,
    stdout,
    stderr,
  };
}

module.exports = {
  parseReservationRequest,
  runManualReservationRegistration,
};
