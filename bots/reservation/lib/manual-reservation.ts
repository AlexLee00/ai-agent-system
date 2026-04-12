'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const kst = require('../../../packages/core/lib/kst');
const { IS_OPS } = require('../../../packages/core/lib/env');
const { transformPhoneNumber, transformRoom, validateTimeRange } = require('./validation');

const MANUAL_REGISTRATION_TIMEOUT_MS = 180_000;

type ReservationRequest = {
  date: string | null;
  start: string | null;
  end: string | null;
  room: string | null;
  phone: string | null;
  name: string;
  raw_line?: string;
};

type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; error: string; missing?: string[] };

type SingleReservationResult = {
  ok: boolean;
  code?: string;
  error?: string;
  message?: string;
  reservation?: ReservationRequest;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
};

type ParseReservationRequestResult =
  | { ok: true; reservation: ReservationRequest }
  | { ok: false; code: string; error: string; missing?: string[] };

type ParseReservationCommandResult =
  | { ok: true; mode: 'single'; reservation: ReservationRequest }
  | { ok: true; mode: 'batch'; reservations: ReservationRequest[] }
  | { ok: false; code: string; error: string; missing?: string[] };

function formatKstDate(date: Date): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function addKstDays(baseDateStr: string, days: number): string {
  const base = new Date(`${baseDateStr}T00:00:00+09:00`);
  base.setUTCDate(base.getUTCDate() + days);
  return formatKstDate(base);
}

function parseDateFromText(text: unknown): string | null {
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

function parseTimeToken(token: unknown): string | null {
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

function parseTimeRangeFromText(text: unknown): { start: string | null; end: string | null } {
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

function parseRoomFromText(text: unknown): string | null {
  const roomMatch = String(text || '').match(/\b(A1|A2|B)\b\s*룸?|\b(A1|A2|B룸?)\b/i);
  if (!roomMatch) return null;
  const raw = roomMatch[1] || roomMatch[2] || '';
  return transformRoom(raw.replace(/룸/gi, ''));
}

function parseNameFromText(text: unknown): string | null {
  const cleaned = String(text || '')
    .replace(/01\d[- ]?\d{3,4}[- ]?\d{4}/g, ' ')
    .replace(/20\d{2}[./-]\s*\d{1,2}[./-]\s*\d{1,2}/g, ' ')
    .replace(/\d{1,2}월\s*\d{1,2}일/g, ' ')
    .replace(/(?:오전|오후)?\s*\d{1,2}시(?:\s*\d{1,2}분?)?/g, ' ')
    .replace(/\d{1,2}:\d{2}/g, ' ')
    .replace(/\b(A1|A2|B)\b\s*룸?/gi, ' ')
    .replace(/\d+\s*건/g, ' ')
    .replace(/픽코|예약|등록|결제|차단|네이버|수동|대리예약|잡아줘|해줘|넣어줘|부탁해|처리해줘|요청|다시|재등록|재시도|재처리/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const matches = cleaned.match(/[가-힣]{2,10}/g) || [];
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

function parseSharedName(text: unknown): string | null {
  const raw = String(text || '').trim();
  const phoneMatch = raw.match(/01\d[- ]?\d{3,4}[- ]?\d{4}/);
  if (phoneMatch) {
    const beforePhone = raw.slice(0, phoneMatch.index).trim();
    const directName = (beforePhone.match(/[가-힣]{2,10}/g) || []).pop();
    if (directName) return directName;
  }
  return parseNameFromText(raw);
}

function parseBatchCount(text: unknown, explicitCount: unknown): number {
  if (Number.isFinite(Number(explicitCount)) && Number(explicitCount) > 0) {
    return Number(explicitCount);
  }
  const matched = String(text || '').match(/(\d+)\s*건/);
  return matched ? Number(matched[1]) : 1;
}

function isRetryRegistrationRequest(args: Record<string, unknown> = {}): boolean {
  const rawText = String(args.raw_text || args.text || '').trim();
  if (args.manual_retry === true || args.manual_retry === 'true') return true;
  return /다시\s*등록|재등록|다시\s*해봐|다시\s*시도|반영이\s*되(지\s*않|지않)|실패했|실패했어|재처리/.test(rawText);
}

function extractBatchReservations(args: Record<string, unknown> = {}): ReservationRequest[] {
  const rawText = String(args.raw_text || args.text || '').trim();
  const lines = rawText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const sharedPhone = transformPhoneNumber(args.phone || rawText.match(/01\d[- ]?\d{3,4}[- ]?\d{4}/)?.[0]);
  const identityLine = lines.find((line) => /01\d[- ]?\d{3,4}[- ]?\d{4}/.test(line)) || rawText;
  const sharedName = String(args.name || parseSharedName(identityLine) || parseSharedName(rawText) || '고객').trim();
  const allExplicitDates = lines
    .map((line) => parseDateFromText(line))
    .filter(Boolean);
  const fallbackDate = allExplicitDates.length === 1 ? allExplicitDates[0] : null;

  let currentDate = fallbackDate;
  const reservations = [];

  for (const line of lines) {
    const explicitDate = parseDateFromText(line);
    if (explicitDate) currentDate = explicitDate;

    const { start, end } = parseTimeRangeFromText(line);
    const room = parseRoomFromText(line);

    if (!start || !end) {
      continue;
    }

    const reservation = {
      date: explicitDate || currentDate || fallbackDate,
      start,
      end,
      room,
      phone: sharedPhone,
      name: sharedName,
      raw_line: line,
    };
    reservations.push(reservation);
  }

  if (reservations.length > 1) {
    return reservations;
  }

  // OpenClaw/Telegram 경로에서 여러 줄이 한 줄로 합쳐질 수 있으므로,
  // 날짜+시간+룸 패턴을 전체 문장 기준으로 다시 추출한다.
  const normalized = rawText
    .replace(/\s+/g, ' ')
    .replace(/\b(a1|a2|b)\b/gi, (m) => m.toUpperCase());

  const pattern = /((?:20\d{2}[./-]\s*\d{1,2}[./-]\s*\d{1,2})|(?:\d{1,2}월\s*\d{1,2}일)|오늘|내일|모레)\s+((?:오전|오후)?\s*\d{1,2}(?::\d{2}|시(?:\s*\d{1,2}분?)?)\s*(?:~|-)\s*(?:오전|오후)?\s*\d{1,2}(?::\d{2}|시(?:\s*\d{1,2}분?)?))\s+(A1|A2|B)\b/gi;

  const extracted = [];
  let match;
  while ((match = pattern.exec(normalized)) !== null) {
    const fragment = `${match[1]} ${match[2]} ${match[3]}`;
    const { start, end } = parseTimeRangeFromText(match[2]);
    extracted.push({
      date: parseDateFromText(match[1]),
      start,
      end,
      room: parseRoomFromText(match[3]),
      phone: sharedPhone,
      name: sharedName,
      raw_line: fragment,
    });
  }

  return extracted.length > reservations.length ? extracted : reservations;
}

function validateReservation(reservation: ReservationRequest): ValidationResult {
  const missing = ['date', 'start', 'end', 'room', 'phone'].filter((key) => !reservation[key]);
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'MISSING_FIELDS',
      error: `예약 등록에 필요한 정보가 부족합니다: ${missing.join(', ')}.`,
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

  return { ok: true };
}

function parseReservationCommand(args: Record<string, unknown> = {}): ParseReservationCommandResult {
  const rawText = String(args.raw_text || args.text || '').trim();
  const explicitBatchCount = parseBatchCount(rawText, args.batch_count);
  const extractedReservations = extractBatchReservations(args);
  const shouldTreatAsBatch = explicitBatchCount > 1 || extractedReservations.length > 1;

  if (shouldTreatAsBatch) {
    if (extractedReservations.length === 0) {
      return {
        ok: false,
        code: 'MISSING_FIELDS',
        error: '다건 예약 등록 형식을 해석하지 못했습니다. 예: "민경수 010-2792-2221\\n3월 20일 12:00-14:00 A1\\n3월 20일 14:00-15:00 A1\\n예약 추가해줘"',
      };
    }

    const invalid = extractedReservations
      .map((reservation, index) => ({ index, reservation, check: validateReservation(reservation) }))
      .filter((entry) => !entry.check.ok);

    if (invalid.length > 0) {
      const first = invalid[0];
      const failedCheck = first.check as Exclude<ValidationResult, { ok: true }>;
      const missing = failedCheck.missing?.length ? failedCheck.missing.join(', ') : failedCheck.error;
      return {
        ok: false,
        code: failedCheck.code || 'MISSING_FIELDS',
        error: `${first.index + 1}번째 예약 정보가 부족합니다: ${missing}. 예: "민경수 010-2792-2221\\n3월 20일 12:00-14:00 A1\\n3월 20일 14:00-15:00 A1\\n예약 추가해줘"`,
      };
    }

    return {
      ok: true,
      mode: 'batch',
      reservations: extractedReservations,
    };
  }

  const single = parseReservationRequest(args);
  if (!single.ok) {
    const failedSingle = single as Exclude<ParseReservationRequestResult, { ok: true }>;
    return {
      ok: false,
      code: failedSingle.code,
      error: failedSingle.error,
      missing: failedSingle.missing,
    };
  }
  return {
    ok: true,
    mode: 'single',
    reservation: single.reservation,
  };
}

function parseReservationRequest(args: Record<string, unknown> = {}): ParseReservationRequestResult {
  const rawText = String(args.raw_text || args.text || '').trim();

  const reservation = {
    date: parseDateFromText(rawText),
    room: parseRoomFromText(rawText),
    phone: transformPhoneNumber(args.phone || rawText.match(/01\d[- ]?\d{3,4}[- ]?\d{4}/)?.[0]),
    name: String(args.name || parseSharedName(rawText) || parseNameFromText(rawText) || '고객').trim(),
    ...parseTimeRangeFromText(rawText),
  };

  const check = validateReservation(reservation);
  if (!check.ok) {
    const failedCheck = check as Exclude<ValidationResult, { ok: true }>;
    return {
      ...failedCheck,
      error: failedCheck.code === 'MISSING_FIELDS'
        ? `예약 등록에 필요한 정보가 부족합니다: ${failedCheck.missing?.join(', ')}. 예: "내일 오후 3시~5시 A1 010-1234-5678 홍길동 예약해줘"`
        : failedCheck.error,
    };
  }

  return { ok: true, reservation };
}

function runSingleReservationRegistration(
  reservation: ReservationRequest,
  options: { manualRetry?: boolean } = {},
): SingleReservationResult {
  const scriptPath = path.join(__dirname, '../manual/reservation/pickko-register.js');
  const childArgs = [
    scriptPath,
    `--date=${reservation.date}`,
    `--start=${reservation.start}`,
    `--end=${reservation.end}`,
    `--room=${reservation.room}`,
    `--phone=${reservation.phone}`,
    `--name=${reservation.name}`,
  ];

  if (options.manualRetry) {
    childArgs.push('--manual-retry');
    childArgs.push('--skip-name-sync');
    childArgs.push('--skip-naver-block');
  }

  const result = spawnSync('node', childArgs, {
    cwd: path.dirname(scriptPath),
    env: { ...process.env, MODE: IS_OPS ? 'ops' : 'dev' },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 2,
    timeout: MANUAL_REGISTRATION_TIMEOUT_MS,
  });

  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const lastLine = stdout.split('\n').map(line => line.trim()).filter(Boolean).pop() || '';

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      return {
        ok: false,
        code: 'TIMEOUT',
        error: `픽코 예약 등록 시간 초과 (${Math.round(MANUAL_REGISTRATION_TIMEOUT_MS / 1000)}초)`,
      };
    }
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

function runManualReservationRegistration(args: Record<string, unknown> = {}) {
  const parsed = parseReservationCommand(args);
  if (!parsed.ok) return parsed;
  const manualRetry = isRetryRegistrationRequest(args);

  if (parsed.mode === 'single') {
    return runSingleReservationRegistration(parsed.reservation, { manualRetry });
  }

  const results = parsed.reservations.map((reservation, index) => {
    const result = runSingleReservationRegistration(reservation, { manualRetry });
    return {
      index: index + 1,
      reservation,
      ok: Boolean(result.ok),
      message: result.message || result.error || '',
      code: result.code || null,
      error: result.error || null,
      exitCode: result.exitCode,
    };
  });

  const successCount = results.filter((item) => item.ok).length;
  const failureCount = results.length - successCount;
  const summary = results
    .map((item) => {
      const label = `${item.reservation.date} ${item.reservation.start}~${item.reservation.end} ${item.reservation.room}`;
      return `${item.ok ? '✅' : '❌'} ${item.index}. ${label}${item.message ? ` — ${item.message}` : ''}`;
    })
    .join('\n');

  return {
    ok: failureCount === 0,
    code: failureCount > 0 && successCount > 0 ? 'PARTIAL_SUCCESS' : failureCount > 0 ? 'BATCH_FAILED' : null,
    batch: true,
    manualRetry,
    successCount,
    failureCount,
    totalCount: results.length,
    message: `다중예약 처리 완료 (${successCount}/${results.length} 성공)`,
    summary,
    results,
  };
}

module.exports = {
  parseDateFromText,
  parseTimeRangeFromText,
  parseRoomFromText,
  parseNameFromText,
  isRetryRegistrationRequest,
  parseReservationCommand,
  parseReservationRequest,
  runManualReservationRegistration,
};
