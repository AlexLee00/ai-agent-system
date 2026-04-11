export function normalizeStudyRoomKey(raw: unknown): 'A1' | 'A2' | 'B' | null {
  const text = String(raw || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, '')
    .toUpperCase();

  if (!text) return null;
  if (text.includes('A1')) return 'A1';
  if (text.includes('A2')) return 'A2';
  if (text === 'B' || text.includes('룸B') || text.includes('스터디룸B') || /^B\d*$/.test(text)) return 'B';
  return null;
}

export function timeToMinutes(value: unknown): number {
  if (!value || typeof value !== 'string') return 0;
  const [hours, minutes] = value.split(':').map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function getSlotRate(roomKey: 'A1' | 'A2' | 'B', minuteOfDay: number): number {
  const isRoomB = roomKey === 'B';
  const isEarlyMorning = minuteOfDay >= 0 && minuteOfDay < 9 * 60;
  if (isRoomB) return isEarlyMorning ? 4000 : 6000;
  return isEarlyMorning ? 2500 : 3500;
}

export function calcStudyRoomAmount(entry: { room?: unknown; start?: unknown; end?: unknown } | null | undefined): number {
  const roomKey = normalizeStudyRoomKey(entry?.room);
  if (!roomKey) return 0;

  const startMin = timeToMinutes(entry?.start);
  const rawEndMin = timeToMinutes(entry?.end);
  if (startMin === rawEndMin) return 0;

  const crossesMidnight = rawEndMin <= startMin;
  const endMin = crossesMidnight ? rawEndMin + 24 * 60 : rawEndMin;
  const overnightRate = crossesMidnight ? getSlotRate(roomKey, startMin) : null;

  let total = 0;
  for (let cursor = startMin; cursor < endMin; cursor += 30) {
    total += overnightRate ?? getSlotRate(roomKey, cursor % (24 * 60));
  }
  return total;
}

export function resolveStudyRoomAmount(
  entry: {
    room?: unknown;
    start?: unknown;
    end?: unknown;
    rawAmount?: unknown;
    raw_amount?: unknown;
    amount?: unknown;
    netRevenue?: unknown;
  } | null | undefined,
): number {
  const directAmount = Number(
    entry?.rawAmount ??
    entry?.raw_amount ??
    entry?.amount ??
    entry?.netRevenue ??
    0,
  );
  if (directAmount > 0) return directAmount;
  return calcStudyRoomAmount(entry);
}

export function buildRoomAmountsFromEntries(entries: Array<Record<string, unknown>> = []): Record<string, number> {
  const roomAmounts: Record<string, number> = {};

  for (const entry of entries) {
    const roomKey = normalizeStudyRoomKey(entry?.room);
    if (!roomKey) continue;
    const amount = resolveStudyRoomAmount(entry);
    roomAmounts[roomKey] = (roomAmounts[roomKey] || 0) + amount;
  }

  return roomAmounts;
}
