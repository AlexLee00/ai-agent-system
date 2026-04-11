import { publishReservationAlert } from './alert-client';

type KioskEntry = Record<string, any>;
type TrackerMap = Map<string, number>;

function nowKST(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T') + '+09:00';
}

export function fmtPhone(raw: unknown): string {
  const phone = String(raw || '');
  if (phone.length === 11) return `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
  return phone;
}

export function buildOpsAlertMessage({
  title,
  customer,
  phone,
  date,
  start,
  end,
  room,
  status,
  reason,
  action,
}: Record<string, any>): string {
  let message = `${title}\n`;
  message += '━━━━━━━━━━━━━━━\n';
  if (customer) message += `👤 고객: ${customer}\n`;
  if (phone) message += `📞 번호: ${phone}\n`;
  if (date) message += `📅 날짜: ${date}\n`;
  if (start || end) message += `⏰ 시간: ${start || ''}~${end || ''}\n`;
  if (room) message += `🏛️ 룸: ${room}\n`;
  if (status) message += `📊 상태: ${status}\n`;
  if (reason) message += `ℹ️ 사유: ${reason}\n`;
  message += '━━━━━━━━━━━━━━━\n';
  if (action) message += `✅ 조치: ${action}\n`;
  return message;
}

export function publishRetryableBlockAlert(entry: KioskEntry, reason: string, options: Record<string, any> = {}): void {
  const {
    prefix = '⚠️',
    title = '네이버 차단 지연',
    alertLevel = 2,
    sourceLabel = '키오스크 예약',
    actionLine = '자동 재시도 예정 — kiosk-monitor 후속 사이클을 확인하고, 계속 실패하면 수동 처리',
  } = options;

  publishReservationAlert({
    from_bot: 'jimmy',
    event_type: 'alert',
    alert_level: alertLevel,
    message: buildOpsAlertMessage({
      title: `${prefix} ${title}`,
      customer: entry?.name || '(이름없음)',
      phone: entry?.phoneRaw ? fmtPhone(entry.phoneRaw) : '',
      date: entry?.date || '',
      start: entry?.start || '',
      end: entry?.end || '',
      room: entry?.room || '',
      status: sourceLabel,
      reason,
      action: `${actionLine} (${sourceLabel})`,
    }),
  });
}

export function publishKioskSuccessReport(message: string): void {
  publishReservationAlert({
    from_bot: 'jimmy',
    event_type: 'report',
    alert_level: 1,
    message,
  });
}

export async function journalBlockAttempt(
  entry: KioskEntry,
  result: string,
  reason: string,
  options: Record<string, any> = {},
): Promise<void> {
  if (typeof options.recordKioskBlockAttempt !== 'function') return;
  await options.recordKioskBlockAttempt(entry.phoneRaw, entry.date, entry.start, {
    name: entry.name,
    date: entry.date,
    start: entry.start,
    end: entry.end,
    room: entry.room,
    amount: entry.amount || 0,
    naverBlocked: options.naverBlocked,
    blockedAt: options.blockedAt,
    naverUnblockedAt: options.naverUnblockedAt,
    lastBlockAttemptAt: options.at || nowKST(),
    lastBlockResult: result,
    lastBlockReason: reason,
    incrementRetry: options.incrementRetry === true,
  });
}

export function roundUpToHalfHour(timeStr: unknown): string {
  const [h, m] = String(timeStr || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return String(timeStr || '');
  if (m === 0 || m === 30) return String(timeStr || '');
  const newM = m < 30 ? 30 : 0;
  const newH = m >= 30 ? h + 1 : h;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

export function toClockMinutes(timeStr: unknown): number | null {
  const [h, m] = String(timeStr || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

export function to24Hour(timeText: unknown): string | null {
  const text = String(timeText || '').trim().replace(/\s+/g, ' ');
  const match = text.match(/(오전|오후|자정)\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const [, meridiem, hourStr, minStr] = match;
  let hour = Number(hourStr);
  const minute = Number(minStr);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (meridiem === '자정') hour = 0;
  else if (meridiem === '오전') hour = hour === 12 ? 0 : hour;
  else if (meridiem === '오후') hour = hour === 12 ? 12 : hour + 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function getCustomerOperationGroupKey(entry: KioskEntry): string {
  return `${entry?.phoneRaw || ''}|${entry?.date || ''}`;
}

export function compareEntrySequence(a: KioskEntry, b: KioskEntry): number {
  const aGroup = getCustomerOperationGroupKey(a);
  const bGroup = getCustomerOperationGroupKey(b);
  if (aGroup !== bGroup) return aGroup.localeCompare(bGroup);
  const aStart = String(a?.start || '');
  const bStart = String(b?.start || '');
  if (aStart !== bStart) return aStart.localeCompare(bStart);
  const aEnd = String(a?.end || '');
  const bEnd = String(b?.end || '');
  if (aEnd !== bEnd) return aEnd.localeCompare(bEnd);
  return String(a?.room || '').localeCompare(String(b?.room || ''));
}

export async function waitForCustomerCooldown(
  entry: KioskEntry,
  tracker: TrackerMap,
  operationLabel: string,
  cooldownMs: number,
  wait: (ms: number) => Promise<void>,
  logger: (message: string) => void,
): Promise<void> {
  if (!cooldownMs || cooldownMs <= 0) return;
  const groupKey = getCustomerOperationGroupKey(entry);
  if (!groupKey || groupKey === '|') return;
  const lastAt = tracker.get(groupKey);
  if (!lastAt) return;
  const elapsedMs = Date.now() - lastAt;
  const remainingMs = cooldownMs - elapsedMs;
  if (remainingMs <= 0) return;
  logger(`⏳ 동일 고객 연속 ${operationLabel} cooldown 대기: ${Math.ceil(remainingMs / 1000)}초 (${groupKey})`);
  await wait(remainingMs);
}

export function markCustomerCooldown(entry: KioskEntry, tracker: TrackerMap): void {
  const groupKey = getCustomerOperationGroupKey(entry);
  if (!groupKey || groupKey === '|') return;
  tracker.set(groupKey, Date.now());
}
