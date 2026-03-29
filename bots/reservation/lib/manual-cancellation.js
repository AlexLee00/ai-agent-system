'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const {
  parseDateFromText,
  parseTimeRangeFromText,
  parseRoomFromText,
  parseNameFromText,
} = require('./manual-reservation');
const { transformPhoneNumber } = require('./validation');
const { IS_OPS } = require('../../../packages/core/lib/env');

function parseCancellationName(text) {
  const sanitized = String(text || '')
    .replace(/예약\s*취소해줘|예약\s*취소|취소해줘|취소\s*처리|취소해|취소\s*부탁|환불해줘|환불/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parsed = parseNameFromText(sanitized);
  return parsed === '취소' || parsed === '환불' ? '' : parsed;
}

function parseCancellationCommand(args = {}) {
  const rawText = String(args.raw_text || args.text || '').trim();
  const phone = transformPhoneNumber(args.phone || rawText.match(/01\d[- ]?\d{3,4}[- ]?\d{4}/)?.[0]);
  const date = args.date || parseDateFromText(args.date_text || rawText);
  const parsedRange = parseTimeRangeFromText(rawText);
  const start = args.start || parsedRange.start;
  const end = args.end || parsedRange.end;
  const room = args.room || parseRoomFromText(rawText);
  const name = (args.name || parseCancellationName(rawText) || '').trim();

  const missing = ['phone', 'date', 'start', 'end', 'room'].filter((key) => !({
    phone,
    date,
    start,
    end,
    room,
  })[key]);

  if (missing.length > 0) {
    return {
      ok: false,
      code: 'MISSING_FIELDS',
      error: `예약 취소에 필요한 정보가 부족합니다: ${missing.join(', ')}. 예: "홍길동 3월 29일 오전 9시~11시 A1 예약 취소해줘"`,
      missing,
    };
  }

  return {
    ok: true,
    reservation: {
      phone,
      date,
      start,
      end,
      room,
      name,
      raw_text: rawText,
    },
  };
}

function runManualReservationCancellation(args = {}) {
  const parsed = parseCancellationCommand(args);
  if (!parsed.ok) return parsed;

  const reservation = parsed.reservation;
  const scriptPath = path.join(__dirname, '../manual/reservation/pickko-cancel-cmd.js');
  const childArgs = [
    scriptPath,
    `--phone=${reservation.phone}`,
    `--date=${reservation.date}`,
    `--start=${reservation.start}`,
    `--end=${reservation.end}`,
    `--room=${reservation.room}`,
  ];

  if (reservation.name) {
    childArgs.push(`--name=${reservation.name}`);
  }

  const result = spawnSync('node', childArgs, {
    cwd: path.dirname(scriptPath),
    env: { ...process.env, MODE: IS_OPS ? 'ops' : 'dev' },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 2,
  });

  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const lastLine = stdout.split('\n').map((line) => line.trim()).filter(Boolean).pop() || '';

  if (result.error) {
    return { ok: false, code: 'CANCEL_EXEC_FAILED', error: `예약 취소 실행 실패: ${result.error.message}` };
  }

  let payload = null;
  try { payload = lastLine ? JSON.parse(lastLine) : null; } catch { payload = null; }

  if (!payload) {
    return {
      ok: false,
      code: 'CANCEL_RESULT_PARSE_FAILED',
      error: stderr || stdout || `예약 취소 결과를 해석하지 못했습니다. (exit ${result.status})`,
    };
  }

  return {
    ok: Boolean(payload.success),
    code: payload.success ? null : 'CANCEL_FAILED',
    message: payload.message,
    error: payload.success ? null : payload.message,
    reservation,
    exitCode: result.status,
    stdout,
    stderr,
  };
}

module.exports = {
  parseCancellationCommand,
  runManualReservationCancellation,
};
