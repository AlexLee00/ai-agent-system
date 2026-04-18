type SlotCandidate = {
  start: string;
  end: string;
  slotCount: number;
  durationMin: number;
  reason: string;
};

export function timeToSlots(startTime: string, endTime: string) {
  const [startHour, startMin] = startTime.split(':').map(Number);
  const [endHour, endMin] = endTime.split(':').map(Number);

  const startMinutes = startHour * 60 + startMin;
  let endMinutes = endHour * 60 + endMin;

  if (endMinutes <= startMinutes) {
    endMinutes += 24 * 60;
  }

  const slots: string[] = [];
  for (let min = startMinutes; min <= endMinutes - 1; min += 30) {
    const h = Math.floor(min / 60) % 24;
    const m = min % 60;
    slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return slots;
}

export function buildSlotCandidates(slots: string[]): SlotCandidate[] {
  if (!Array.isArray(slots) || slots.length < 2) return [];

  const candidates: SlotCandidate[] = [];
  const seen = new Set<string>();

  const pushCandidate = (startIdx: number, endIdx: number, reason: string) => {
    if (startIdx < 0 || endIdx >= slots.length || endIdx <= startIdx) return;
    const start = slots[startIdx];
    const end = slots[endIdx];
    const slotCount = endIdx - startIdx + 1;
    const key = `${start}->${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      start,
      end,
      slotCount,
      durationMin: slotCount * 30,
      reason,
    });
  };

  for (let startIdx = 0; startIdx <= slots.length - 2; startIdx++) {
    pushCandidate(startIdx, slots.length - 1, startIdx === 0 ? 'original-window' : 'shift-start-keep-end');
  }

  for (let startIdx = 0; startIdx <= slots.length - 2; startIdx++) {
    for (let endIdx = slots.length - 2; endIdx > startIdx; endIdx--) {
      pushCandidate(startIdx, endIdx, 'shrink-window');
    }
  }

  return candidates.sort((a, b) => {
    if (b.slotCount !== a.slotCount) return b.slotCount - a.slotCount;
    return a.start.localeCompare(b.start);
  });
}

export function getTodayKstString(now = new Date()) {
  const nowKst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return `${nowKst.getFullYear()}-${String(nowKst.getMonth() + 1).padStart(2, '0')}-${String(nowKst.getDate()).padStart(2, '0')}`;
}

export function adjustEffectiveTimeSlots(
  date: string,
  timeSlots: string[],
  now = new Date(),
) {
  const nowKst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const todayStr = getTodayKstString(now);

  let effectiveTimeSlots = timeSlots;
  let skippedCount = 0;
  let nowText = `${String(nowKst.getHours()).padStart(2, '0')}:${String(nowKst.getMinutes()).padStart(2, '0')}`;

  if (date === todayStr && timeSlots.length >= 2) {
    const nowMin = nowKst.getHours() * 60 + nowKst.getMinutes();
    const nextSlotMin = Math.ceil(nowMin / 30) * 30;

    const [fh, fm] = timeSlots[0].split(':').map(Number);
    const firstSlotMin = fh * 60 + fm;

    if (nextSlotMin > firstSlotMin) {
      effectiveTimeSlots = timeSlots.filter((slot) => {
        const [h, m] = slot.split(':').map(Number);
        return h * 60 + m >= nextSlotMin;
      });
      skippedCount = timeSlots.length - effectiveTimeSlots.length;
    }
  }

  return {
    nowKst,
    todayStr,
    nowText,
    effectiveTimeSlots,
    skippedCount,
  };
}
