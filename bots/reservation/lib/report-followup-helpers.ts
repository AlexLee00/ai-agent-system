import fs from 'fs';
import path from 'path';

type ReservationLike = Record<string, any>;
type PayScanFailure = { entry: ReservationLike; result: Record<string, any> };

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

export function ts(): string {
  return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

export function buildFailureLine(entry: ReservationLike, result: Record<string, any>): string {
  return `- ${entry.date} ${entry.start}~${entry.end} ${entry.room}룸 / ${entry.phone} / ${result.message}`;
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

export function isAlreadyPaidWithoutButton(entry: ReservationLike, result: Record<string, any>): boolean {
  return entry?.pickkoStatus === 'verified'
    && typeof result?.message === 'string'
    && result.message.includes('결제하기 버튼 미발견');
}

export function isExpectedManualFollowup(result: Record<string, any>): boolean {
  const message = typeof result?.message === 'string' ? result.message : '';
  return message.includes('결제하기 버튼 미발견')
    || message.includes('결제대기 예약 미발견');
}

export function buildPayScanAlertMessage(
  successCount: number,
  failureCount: number,
  failures: PayScanFailure[],
  checklistPath: string | null,
): string {
  const lines = [
    '⚠️ pickko-pay-scan 후속 확인 필요',
    `성공 ${successCount}건 / 후속확인 ${failureCount}건`,
    '',
    ...failures.slice(0, 10).map(({ entry, result }) => buildFailureLine(entry, result)),
  ];
  if (checklistPath) lines.push('', `체크리스트: ${checklistPath}`);
  return lines.join('\n');
}
