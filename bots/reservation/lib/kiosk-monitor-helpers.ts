import { publishReservationAlert } from './alert-client';

type KioskEntry = Record<string, any>;
type TrackerMap = Map<string, number>;

const RETRYABLE_BLOCK_DEDUPE_MINUTES = 12 * 60;

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

function normalizeIncidentPart(value: unknown): string {
  return String(value || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

function normalizeRetryableBlockReason(reason: string): string {
  const text = String(reason || '').trim();
  const failedMatch = text.match(/차단 실패\(([^)]+)\)/);
  if (failedMatch?.[1]) return normalizeIncidentPart(failedMatch[1]);
  if (/naver-monitor|미실행/i.test(text)) return 'naver_monitor_unavailable';
  if (/로그인/i.test(text)) return 'naver_login_failed';
  if (/slot_click_failed/i.test(text)) return 'slot_click_failed';
  if (/검증|verify/i.test(text)) return 'verify_failed';
  return normalizeIncidentPart(text);
}

export function buildRetryableBlockIncidentKey(entry: KioskEntry, reason: string, sourceLabel = '키오스크 예약'): string {
  const phoneDigits = String(entry?.phoneRaw || '').replace(/\D/g, '');
  const phoneSuffix = phoneDigits ? phoneDigits.slice(-4) : 'unknown';
  const slot = `${entry?.start || 'unknown'}-${entry?.end || 'unknown'}`.replace(/:/g, '');
  return [
    'reservation',
    'jimmy',
    'naver_block_retry',
    normalizeIncidentPart(sourceLabel),
    normalizeIncidentPart(entry?.date),
    normalizeIncidentPart(entry?.room),
    normalizeIncidentPart(slot),
    normalizeIncidentPart(phoneSuffix),
    normalizeRetryableBlockReason(reason),
  ].join(':');
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
    incident_key: options.incidentKey || buildRetryableBlockIncidentKey(entry, reason, sourceLabel),
    dedupe_minutes: options.dedupe_minutes ?? options.dedupeMinutes ?? RETRYABLE_BLOCK_DEDUPE_MINUTES,
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

export function normalizeKioskSlotEndTime(timeStr: unknown): string {
  // Naver booking only exposes 30-minute slot boundaries in the settings panel.
  // Pickko can show ends such as 00:50/23:50, so block through the containing slot.
  return roundUpToHalfHour(timeStr);
}

export function toClockMinutes(timeStr: unknown): number | null {
  const [h, m] = String(timeStr || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function toClockString(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function getKstDateAndMinutes(now: Date): { date: string; minutes: number } | null {
  const text = now.toLocaleString('sv-SE', {
    timeZone: 'Asia/Seoul',
    hour12: false,
    hourCycle: 'h23',
  });
  const match = text.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
  if (!match) return null;
  const [, date, hourStr, minuteStr] = match;
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return { date, minutes: hour * 60 + minute };
}

export function getKioskNaverBlockEntry(entry: KioskEntry, now: Date = new Date()): KioskEntry | null {
  const date = String(entry?.date || '').trim();
  const startMin = toClockMinutes(entry?.start);
  const endMin = toClockMinutes(normalizeKioskSlotEndTime(entry?.end));
  if (!date || startMin == null || endMin == null) return entry;

  const kstNow = getKstDateAndMinutes(now);
  if (!kstNow || kstNow.date !== date || kstNow.minutes < startMin) return entry;

  const nextBlockableMin = Math.floor(kstNow.minutes / 30) * 30 + 30;
  if (nextBlockableMin >= endMin) return null;

  const adjustedStart = toClockString(nextBlockableMin);
  return {
    ...entry,
    naverBlockOriginalStart: entry.start,
    naverBlockAdjustedStart: adjustedStart,
    naverBlockReason: 'started_slot_not_clickable',
    start: adjustedStart,
  };
}

export function getKioskEntryEndDateTime(entry: KioskEntry): Date | null {
  const date = String(entry?.date || '').trim();
  const startMin = toClockMinutes(entry?.start);
  const endMin = toClockMinutes(entry?.end || '23:59');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || startMin == null || endMin == null) return null;

  const endDateTime = new Date(`${date}T00:00:00+09:00`);
  endDateTime.setMinutes(endMin);
  if (endMin <= startMin) {
    endDateTime.setDate(endDateTime.getDate() + 1);
  }
  return endDateTime;
}

export function isKioskEntryEnded(entry: KioskEntry, now: Date = new Date()): boolean {
  const endDateTime = getKioskEntryEndDateTime(entry);
  if (!endDateTime) return false;
  return now.getTime() >= endDateTime.getTime();
}

export function addKstDays(dateStr: unknown, days: number): string {
  const date = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const kstDate = new Date(`${date}T00:00:00+09:00`);
  kstDate.setDate(kstDate.getDate() + days);
  return kstDate.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

export function splitKioskEntryForNaverBlocks(entry: KioskEntry): KioskEntry[] {
  const startMin = toClockMinutes(entry?.start);
  const endMin = toClockMinutes(entry?.end);
  if (startMin == null || endMin == null || endMin > startMin) return [entry];

  const splitEntries: KioskEntry[] = [
    {
      ...entry,
      end: '24:00',
      splitFromOvernight: true,
      splitPart: 'same_day',
      originalDate: entry.date,
      originalStart: entry.start,
      originalEnd: entry.end,
    },
  ];

  if (endMin > 0) {
    splitEntries.push(
      {
        ...entry,
        date: addKstDays(entry.date, 1),
        start: '00:00',
        end: normalizeKioskSlotEndTime(entry.end),
        splitFromOvernight: true,
        splitPart: 'next_day',
        originalDate: entry.date,
        originalStart: entry.start,
        originalEnd: entry.end,
      },
    );
  }

  return splitEntries;
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
