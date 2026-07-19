import fs from 'fs';
import path from 'path';

type ReservationLike = Record<string, any>;
type PayScanFailure = { entry: ReservationLike; result: Record<string, any> };
type PayScanResolveResult = {
  scannedFiles: number;
  updatedFiles: number;
  removedFiles: number;
  removedEntries: number;
};

export function formatAmount(amount: unknown): string {
  return `${Number(amount || 0).toLocaleString('ko-KR')}원`;
}

export function formatDateHeader(dateStr: unknown): string {
  const date = new Date(`${String(dateStr || '')}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return String(dateStr || '날짜 미상');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  return `${mm}/${dd} (${dayNames[date.getDay()]})`;
}

export function buildRevenueConfirmMessage(result: Record<string, any>, revSummary: Record<string, any>[] = []): string {
  const dateHeader = formatDateHeader(result.date);
  const allAmounts = { ...(result.roomAmounts || {}) } as Record<string, number>;
  if (Number(result.generalRevenue || 0) > 0) allAmounts['일반이용'] = Number(result.generalRevenue || 0);

  const roomLines = Object.entries(allAmounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([room, amount]) => `  ${room}: ${formatAmount(amount)}`)
    .join('\n');

  const roomAmounts = Object.values(result.roomAmounts || {}) as unknown[];
  const roomSubtotal = roomAmounts
    .map((value) => Number(value || 0))
    .reduce((sum, value) => sum + value, 0);
  const expectedTotal = roomSubtotal + Number(result.generalRevenue || 0);
  const grandTotal = Number(result.totalAmount || 0) > 0 ? Number(result.totalAmount || 0) : expectedTotal;

  let message = `✅ 매출 확정 — ${dateHeader}\n\n`;
  message += `${roomLines}\n`;
  message += `  합계: ${formatAmount(grandTotal)}\n`;

  if (revSummary.length > 0) {
    message += `\n📊 스터디룸 누적 매출:\n`;
    for (const row of revSummary) {
      message += `  ${row.room}: ${formatAmount(row.total_amount)} (${row.days}일)\n`;
    }
  }

  return message;
}

export function getArgValue(argv: string[], name: string): string {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

export function parseCsvArg(argv: string[], name: string): string[] {
  return getArgValue(argv, name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isMatchingPickkoReservationUrl(currentUrl: unknown, expectedUrl: unknown): boolean {
  try {
    const current = new URL(String(currentUrl || ''));
    const expected = new URL(String(expectedUrl || ''));
    if (expected.hostname !== 'pickkoadmin.com') return false;
    if (!expected.pathname.includes('/study/view/')) return false;
    current.hash = '';
    expected.hash = '';
    current.searchParams.sort();
    expected.searchParams.sort();
    return current.href === expected.href;
  } catch {
    return false;
  }
}

export function ts(): string {
  return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

export function buildFailureLine(entry: ReservationLike, result: Record<string, any>): string {
  return `- ${entry.date} ${entry.start}~${entry.end} ${entry.room}룸 / ${entry.phone} / ${result.message}`;
}

export function buildPayScanLockDeferralFailures(
  targets: ReservationLike[] = [],
  lockResult: Record<string, any> = {},
): PayScanFailure[] {
  const blockedBy = String(lockResult?.blockedBy || 'unknown');
  const waitedMs = Math.max(0, Number(lockResult?.waitedMs || 0));
  return targets.map((entry) => ({
    entry,
    result: {
      ok: false,
      exitCode: null,
      message: `pickko_lock_wait_timeout: blocked_by=${blockedBy}, waited=${waitedMs}ms`,
      stdout: '',
      stderr: '',
      timedOut: false,
      lockDeferred: true,
    },
  }));
}

function normalizePhone(raw: unknown): string {
  return String(raw || '').replace(/\D+/g, '');
}

type PickkoReservationTextTarget = {
  phoneRaw?: unknown;
  date?: unknown;
  room?: unknown;
  startText?: unknown;
  endText?: unknown;
};

export function matchesExactPickkoReservationText(
  rowText: unknown,
  target: PickkoReservationTextTarget = {},
): boolean {
  const targetPhone = normalizePhone(target.phoneRaw);
  const dateMatch = String(target.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  const room = String(target.room || '').replace(/^스터디룸/u, '').replace(/룸$/u, '').trim().toUpperCase();
  const startText = String(target.startText || '').replace(/\s+/g, ' ').trim();
  const endText = String(target.endText || '').replace(/\s+/g, ' ').trim();
  if (!targetPhone || !dateMatch || !room || !startText || !endText) return false;

  const text = String(rowText || '').replace(/\s+/g, ' ').trim();
  const compactText = text.replace(/\s+/g, '').toUpperCase();
  const phones = text.match(/01[016789][\s-]?\d{3,4}[\s-]?\d{4}/gu) || [];
  const [, year, month, day] = dateMatch;
  const koreanDatePattern = new RegExp(
    `${year}년0?${Number(month)}월0?${Number(day)}일`,
    'u',
  );
  const isoDate = `${year}-${month}-${day}`;

  return phones.some((phone) => normalizePhone(phone) === targetPhone)
    && (koreanDatePattern.test(compactText) || compactText.includes(isoDate))
    && compactText.includes(`스터디룸${room}`)
    && text.includes(startText)
    && text.includes(endText);
}

export function selectExactPickkoReservationHref(
  rows: Array<{ text?: unknown; href?: unknown }> = [],
  target: PickkoReservationTextTarget = {},
): string | null {
  const matches = rows.filter((row) => {
    const href = String(row?.href || '');
    return /\/study\/view\/\d+\.html(?:$|[?#])/u.test(href)
      && matchesExactPickkoReservationText(row?.text, target);
  });
  const uniqueHrefs = [...new Set(matches.map((row) => String(row.href)))];
  return uniqueHrefs.length === 1 ? uniqueHrefs[0] : null;
}

function buildPayScanFollowupKey(entry: ReservationLike): string {
  return [
    String(entry?.date || '').trim(),
    String(entry?.start || '').trim(),
    String(entry?.end || '').trim(),
    String(entry?.room || '').replace(/룸$/u, '').trim().toUpperCase(),
    normalizePhone(entry?.phone),
  ].join('|');
}

function parsePayScanFollowupLine(line: string): string | null {
  const match = String(line || '').match(
    /^-\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})~(\d{2}:\d{2})\s+([A-Za-z0-9가-힣]+)룸\s+\/\s+([0-9-]+)\s+\//u,
  );
  if (!match) return null;
  return [
    match[1],
    match[2],
    match[3],
    String(match[4] || '').replace(/룸$/u, '').trim().toUpperCase(),
    normalizePhone(match[5]),
  ].join('|');
}

function hasPayScanFollowupEntries(lines: string[] = []): boolean {
  return lines.some((line) => parsePayScanFollowupLine(line) !== null);
}

export function writePayScanChecklistFile(baseDir: string, failures: PayScanFailure[]): string | null {
  if (!failures.length) return null;
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(/[-: ]/g, '').slice(0, 13);
  const filePath = path.join(baseDir, `pickko-pay-scan-followup-${stamp}.md`);
  const lines = [
    '# Pickko Pay Scan Follow-up',
    '',
    `생성시각: ${ts()}`,
    '',
    '자동 결제완료 처리 실패 건',
    '',
    ...failures.map(({ entry, result }) => buildFailureLine(entry, result)),
    '',
  ];
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

export function resolvePayScanFollowupFiles(baseDir: string, resolvedEntries: ReservationLike[] = []): PayScanResolveResult {
  const resolvedKeys = new Set(
    (resolvedEntries || [])
      .map((entry) => buildPayScanFollowupKey(entry))
      .filter(Boolean),
  );
  if (resolvedKeys.size === 0) {
    return {
      scannedFiles: 0,
      updatedFiles: 0,
      removedFiles: 0,
      removedEntries: 0,
    };
  }

  const files = fs.existsSync(baseDir)
    ? fs.readdirSync(baseDir)
        .filter((name) => /^pickko-pay-scan-followup-.*\.md$/u.test(name))
        .map((name) => path.join(baseDir, name))
    : [];

  let updatedFiles = 0;
  let removedFiles = 0;
  let removedEntries = 0;

  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    const lines = original.split('\n');
    let changed = false;
    const nextLines = lines.filter((line) => {
      const key = parsePayScanFollowupLine(line);
      if (key && resolvedKeys.has(key)) {
        changed = true;
        removedEntries += 1;
        return false;
      }
      return true;
    });

    const hasRemainingEntries = hasPayScanFollowupEntries(nextLines);
    if (!hasRemainingEntries) {
      fs.unlinkSync(filePath);
      removedFiles += 1;
      continue;
    }

    if (!changed) continue;

    fs.writeFileSync(filePath, nextLines.join('\n'), 'utf8');
    updatedFiles += 1;
  }

  return {
    scannedFiles: files.length,
    updatedFiles,
    removedFiles,
    removedEntries,
  };
}

export function reconcilePayScanFollowupFiles(baseDir: string, activeEntries: ReservationLike[] = []): PayScanResolveResult {
  const activeKeys = new Set(
    (activeEntries || [])
      .map((entry) => buildPayScanFollowupKey(entry))
      .filter(Boolean),
  );

  const files = fs.existsSync(baseDir)
    ? fs.readdirSync(baseDir)
        .filter((name) => /^pickko-pay-scan-followup-.*\.md$/u.test(name))
        .map((name) => path.join(baseDir, name))
    : [];

  let updatedFiles = 0;
  let removedFiles = 0;
  let removedEntries = 0;

  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    const lines = original.split('\n');
    let changed = false;
    const nextLines = lines.filter((line) => {
      const key = parsePayScanFollowupLine(line);
      if (key && !activeKeys.has(key)) {
        changed = true;
        removedEntries += 1;
        return false;
      }
      return true;
    });

    const hasRemainingEntries = hasPayScanFollowupEntries(nextLines);
    if (!hasRemainingEntries) {
      fs.unlinkSync(filePath);
      removedFiles += 1;
      continue;
    }

    if (!changed) continue;

    fs.writeFileSync(filePath, nextLines.join('\n'), 'utf8');
    updatedFiles += 1;
  }

  return {
    scannedFiles: files.length,
    updatedFiles,
    removedFiles,
    removedEntries,
  };
}

export function isAlreadyPaidWithoutButton(entry: ReservationLike, result: Record<string, any>): boolean {
  return result?.ok === true
    && entry?.pickkoStatus === 'verified'
    && typeof result?.message === 'string'
    && result.message.includes('이미 결제완료 상태');
}

export function classifyPickkoPaymentState(bodyText: unknown): {
  isPending: boolean;
  isCompleted: boolean;
  normalizedText: string;
} {
  const normalizedText = String(bodyText ?? '').replace(/\s+/g, ' ').trim();
  return {
    isPending: normalizedText.includes('결제대기'),
    isCompleted: normalizedText.includes('결제완료'),
    normalizedText,
  };
}

function extractPickkoPaymentStatusTexts(bodyText: unknown): string[] {
  return [...new Set(String(bodyText ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .map((line) => {
      if (line === '결제대기' || line === '결제완료') return line;
      return line.match(/^(?:결제\s*상태|상태)\s*[:：-]?\s*(결제대기|결제완료)$/)?.[1] || '';
    })
    .filter(Boolean))];
}

export function extractPickkoPaymentStatusText(bodyText: unknown): string {
  return extractPickkoPaymentStatusTexts(bodyText)[0] || '';
}

export function derivePickkoPaymentStateFromBody(bodyText: unknown): {
  isPending: boolean;
  isCompleted: boolean;
  normalizedText: string;
  statusText: string;
} {
  const statusTexts = extractPickkoPaymentStatusTexts(bodyText);
  const statusText = statusTexts.join(' / ');
  return { ...classifyPickkoPaymentState(statusTexts.join(' ')), statusText };
}

export function isConfirmedPickkoPaymentCompletion(state: Record<string, any> | null | undefined): boolean {
  return state?.isCompleted === true && state?.isPending !== true;
}

export function extractPickkoFinalPaymentAmount(bodyText: unknown): number | null {
  const text = String(bodyText ?? '').replace(/\u00a0/gu, ' ');
  const matches = [
    ...text.matchAll(/(?:최종|총|카드|현금)?\s*결제\s*금액\s*[:：]?\s*([0-9][0-9,\s]*)\s*원/gu),
    ...text.matchAll(/결제완료\s+([0-9][0-9,]*)\s*원/gu),
  ];
  const amounts = matches
    .map((match) => Number(String(match[1] || '').replace(/\D+/g, '')))
    .filter(Number.isFinite);
  return amounts.length > 0 ? Math.max(...amounts) : null;
}

export function isConfirmedExactZeroPickkoPaymentCompletion(
  state: Record<string, any> | null | undefined,
): boolean {
  return isConfirmedPickkoPaymentCompletion(state)
    && state?.identityMatched === true
    && state?.paymentAmountWon === 0;
}

export function classifyPickkoPaymentOutcome(
  submitAttempted: boolean,
  completionConfirmed: boolean,
): 'not_submitted' | 'outcome_unknown' | 'verified_paid' {
  if (!submitAttempted) return 'not_submitted';
  return completionConfirmed ? 'verified_paid' : 'outcome_unknown';
}

export function isExpectedManualFollowup(result: Record<string, any>): boolean {
  const message = typeof result?.message === 'string' ? result.message : '';
  return message.includes('결제하기 버튼 미발견')
    || message.includes('결제대기 예약 미발견');
}

export function buildPayScanAlertMessage(
  successCount: number,
  failureCount: number,
  unexpectedFailureCount: number,
  failures: PayScanFailure[],
  checklistPath: string | null,
): string {
  const expectedOperationalCount = Math.max(0, Number(failureCount || 0) - Number(unexpectedFailureCount || 0));
  const lines = [
    unexpectedFailureCount > 0
      ? '⚠️ pickko-pay-scan 후속 확인 필요'
      : 'ℹ️ pickko-pay-scan 운영 대기 현황',
    `성공 ${successCount}건 / 운영대기 ${expectedOperationalCount}건 / 오류 ${unexpectedFailureCount}건`,
    '',
    ...failures.slice(0, 10).map(({ entry, result }) => buildFailureLine(entry, result)),
  ];
  if (checklistPath) lines.push('', `체크리스트: ${checklistPath}`);
  return lines.join('\n');
}
