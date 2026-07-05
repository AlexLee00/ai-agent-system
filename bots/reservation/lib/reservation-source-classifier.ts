export type ReservationSourceEntry = Record<string, any>;

export type NaverMatchedSource = {
  pickko: ReservationSourceEntry;
  naver: ReservationSourceEntry;
};

export type ReservationSourceClassification = {
  naverMatched: NaverMatchedSource[];
  kioskOrManual: ReservationSourceEntry[];
  invalid: ReservationSourceEntry[];
};

export function normalizeSourcePhone(value: unknown): string {
  return String(value || '').replace(/\D/g, '');
}

export function normalizeSourceRoom(value: unknown): string {
  const text = String(value || '').toUpperCase().replace(/\s+/g, '');
  const match = text.match(/A1|A2|B/);
  return match ? match[0] : '';
}

export function sourceTimeToMinutes(value: unknown): number | null {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 24 || minute < 0 || minute >= 60) return null;
  if (hour === 24 && minute !== 0) return null;
  return hour * 60 + minute;
}

function sourceDateToDay(value: unknown): number | null {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function sourceDateTimeRange(entry: ReservationSourceEntry): { start: number; end: number } | null {
  const day = sourceDateToDay(entry?.date);
  const start = sourceTimeToMinutes(entry?.start);
  const end = sourceTimeToMinutes(entry?.end);
  if (day == null || start == null || end == null) return null;
  const absoluteStart = day * 1440 + start;
  const absoluteEnd = day * 1440 + (end <= start ? end + 1440 : end);
  return { start: absoluteStart, end: absoluteEnd };
}

export function timeRangesOverlap(
  a: { start?: unknown; end?: unknown },
  b: { start?: unknown; end?: unknown },
): boolean {
  const aStart = sourceTimeToMinutes(a?.start);
  const aEnd = sourceTimeToMinutes(a?.end);
  const bStart = sourceTimeToMinutes(b?.start);
  const bEnd = sourceTimeToMinutes(b?.end);
  if (aStart == null || aEnd == null || bStart == null || bEnd == null) return false;
  return aStart < bEnd && bStart < aEnd;
}

export function sourceDateTimeRangesOverlap(
  a: ReservationSourceEntry,
  b: ReservationSourceEntry,
): boolean {
  const aRange = sourceDateTimeRange(a);
  const bRange = sourceDateTimeRange(b);
  if (!aRange || !bRange) return false;
  return aRange.start < bRange.end && bRange.start < aRange.end;
}

export function isValidSourceEntry(entry: ReservationSourceEntry): boolean {
  return Boolean(
    normalizeSourcePhone(entry?.phoneRaw || entry?.phone)
      && /^\d{4}-\d{2}-\d{2}$/.test(String(entry?.date || ''))
      && normalizeSourceRoom(entry?.room)
      && sourceTimeToMinutes(entry?.start) != null
      && sourceTimeToMinutes(entry?.end) != null,
  );
}

export function findNaverConfirmedMatch(
  pickkoEntry: ReservationSourceEntry,
  naverConfirmedRows: ReservationSourceEntry[],
): ReservationSourceEntry | null {
  if (!isValidSourceEntry(pickkoEntry)) return null;
  const pickkoPhone = normalizeSourcePhone(pickkoEntry.phoneRaw || pickkoEntry.phone);
  const pickkoRoom = normalizeSourceRoom(pickkoEntry.room);

  return naverConfirmedRows.find((naverEntry) => (
    normalizeSourcePhone(naverEntry.phoneRaw || naverEntry.phone) === pickkoPhone
    && normalizeSourceRoom(naverEntry.room) === pickkoRoom
    && sourceDateTimeRangesOverlap(pickkoEntry, naverEntry)
  )) || null;
}

export function classifyPickkoEntriesByNaver(
  pickkoEntries: ReservationSourceEntry[],
  naverConfirmedRows: ReservationSourceEntry[],
): ReservationSourceClassification {
  const classification: ReservationSourceClassification = {
    naverMatched: [],
    kioskOrManual: [],
    invalid: [],
  };

  for (const entry of pickkoEntries) {
    if (!isValidSourceEntry(entry)) {
      classification.invalid.push(entry);
      continue;
    }

    const naverMatch = findNaverConfirmedMatch(entry, naverConfirmedRows);
    if (naverMatch) {
      classification.naverMatched.push({ pickko: entry, naver: naverMatch });
    } else {
      classification.kioskOrManual.push(entry);
    }
  }

  return classification;
}
