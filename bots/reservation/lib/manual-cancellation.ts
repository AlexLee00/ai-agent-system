import path from 'path';
import { spawnSync } from 'child_process';
const NODE_BIN = process.execPath || '/opt/homebrew/bin/node';
const {
  parseDateFromText,
  parseTimeRangeFromText,
  parseRoomFromText,
  parseNameFromText,
} = require('./manual-reservation');
import { transformPhoneNumber } from './validation';
const { IS_OPS } = require('../../../packages/core/lib/env');

export interface ParsedCancellationReservation {
  phone: string;
  date: string;
  start: string;
  end: string;
  room: string;
  name: string;
  raw_text: string;
}

export interface CancellationParseFailure {
  ok: false;
  code: 'MISSING_FIELDS';
  error: string;
  missing: string[];
}

export interface CancellationParseSuccess {
  ok: true;
  reservation: ParsedCancellationReservation;
}

export type CancellationParseResult = CancellationParseFailure | CancellationParseSuccess;

export interface ManualCancellationArgs {
  raw_text?: string;
  text?: string;
  phone?: string;
  date?: string;
  date_text?: string;
  start?: string;
  end?: string;
  room?: string;
  name?: string;
}

function parseCancellationName(text: unknown): string {
  const sanitized = String(text || '')
    .replace(/예약\s*취소해줘|예약\s*취소|취소해줘|취소\s*처리|취소해|취소\s*부탁|환불해줘|환불/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parsed = parseNameFromText(sanitized);
  return parsed === '취소' || parsed === '환불' ? '' : parsed;
}

export function parseCancellationCommand(args: ManualCancellationArgs = {}): CancellationParseResult {
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
  } as Record<string, unknown>)[key]);

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
      phone: String(phone),
      date: String(date),
      start: String(start),
      end: String(end),
      room: String(room),
      name,
      raw_text: rawText,
    },
  };
}

export function runManualReservationCancellation(args: ManualCancellationArgs = {}) {
  const parsed = parseCancellationCommand(args);
  if (!parsed.ok) return parsed;

  const reservation = parsed.reservation;
  const scriptPath = path.join(
    __dirname,
    '../manual/reservation/pickko-cancel-cmd.js',
  );
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

  const result = spawnSync(NODE_BIN, childArgs, {
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

  let payload: Record<string, any> | null = null;
  try {
    payload = lastLine ? JSON.parse(lastLine) : null;
  } catch {
    payload = null;
  }

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
