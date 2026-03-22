'use strict';

function normalizeStudyRoomKey(raw) {
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

function timeToMinutes(value) {
  if (!value || typeof value !== 'string') return 0;
  const [h, m] = value.split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function getSlotRate(roomKey, minuteOfDay) {
  const isRoomB = roomKey === 'B';
  const isEarlyMorning = minuteOfDay >= 0 && minuteOfDay < 9 * 60;
  if (isRoomB) return isEarlyMorning ? 4000 : 6000;
  return 3500;
}

function calcStudyRoomAmount(entry) {
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

function buildRoomAmountsFromEntries(entries = []) {
  const roomAmounts = {};

  for (const entry of entries) {
    const roomKey = normalizeStudyRoomKey(entry?.room);
    if (!roomKey) continue;
    const amount = calcStudyRoomAmount(entry);
    roomAmounts[roomKey] = (roomAmounts[roomKey] || 0) + amount;
  }

  return roomAmounts;
}

module.exports = {
  normalizeStudyRoomKey,
  timeToMinutes,
  calcStudyRoomAmount,
  buildRoomAmountsFromEntries,
};
