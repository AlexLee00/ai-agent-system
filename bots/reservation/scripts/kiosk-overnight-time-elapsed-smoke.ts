const assert = require('assert');
const {
  getKioskEntryEndDateTime,
  getKioskNaverBlockEntry,
  isKioskEntryEnded,
  normalizeKioskSlotEndTime,
  splitKioskEntryForNaverBlocks,
} = require('../lib/kiosk-monitor-helpers');

const overnightEntry = {
  date: '2026-06-06',
  start: '21:30',
  end: '00:50',
};

const sameDayEntry = {
  date: '2026-06-06',
  start: '19:00',
  end: '21:00',
};

assert.equal(
  getKioskEntryEndDateTime(overnightEntry)?.toISOString(),
  '2026-06-06T15:50:00.000Z',
  'overnight end must resolve to next KST day',
);

assert.equal(
  isKioskEntryEnded(overnightEntry, new Date('2026-06-06T12:30:00.000Z')),
  false,
  '21:30~00:50 must not be elapsed at 21:30 KST',
);

assert.equal(
  isKioskEntryEnded(overnightEntry, new Date('2026-06-06T16:00:00.000Z')),
  true,
  '21:30~00:50 must be elapsed after 00:50 KST next day',
);

assert.equal(
  isKioskEntryEnded(sameDayEntry, new Date('2026-06-06T12:30:00.000Z')),
  true,
  'same-day 19:00~21:00 must be elapsed at 21:30 KST',
);

const splitEntries = splitKioskEntryForNaverBlocks({
  name: '9450',
  phoneRaw: '01040929450',
  date: '2026-06-06',
  start: '21:30',
  end: '00:50',
  room: '스터디룸A1',
});

assert.deepEqual(
  splitEntries.map((entry) => ({
    date: entry.date,
    start: entry.start,
    end: entry.end,
    room: entry.room,
    splitPart: entry.splitPart,
  })),
  [
    {
      date: '2026-06-06',
      start: '21:30',
      end: '24:00',
      room: '스터디룸A1',
      splitPart: 'same_day',
    },
    {
      date: '2026-06-07',
      start: '00:00',
      end: '01:00',
      room: '스터디룸A1',
      splitPart: 'next_day',
    },
  ],
  'overnight kiosk reservation must split into Naver-compatible slot boundary block entries',
);

assert.equal(
  normalizeKioskSlotEndTime('00:50'),
  '01:00',
  'kiosk slot end :50 must round up to a Naver slot boundary',
);

assert.equal(
  normalizeKioskSlotEndTime('23:50'),
  '24:00',
  'same-day overnight split must use 24:00 for the last Naver slot',
);

assert.equal(
  normalizeKioskSlotEndTime('14:55'),
  '15:00',
  'non-slot end times still round up to the next half-hour boundary',
);

const ongoingEntry = {
  name: '5832',
  phoneRaw: '01082305832',
  date: '2026-07-05',
  start: '12:00',
  end: '13:50',
  room: '스터디룸A1',
};

assert.equal(
  getKioskNaverBlockEntry(ongoingEntry, new Date('2026-07-05T02:59:00.000Z'))?.start,
  '12:00',
  'future same-day kiosk block should keep the requested start time',
);

assert.equal(
  getKioskNaverBlockEntry(ongoingEntry, new Date('2026-07-05T03:10:00.000Z'))?.start,
  '12:30',
  'started same-day kiosk block should skip the already started Naver slot',
);

assert.equal(
  getKioskNaverBlockEntry(ongoingEntry, new Date('2026-07-05T03:44:00.000Z'))?.start,
  '13:00',
  'started same-day kiosk block should use the next unopened half-hour slot',
);

assert.equal(
  getKioskNaverBlockEntry(ongoingEntry, new Date('2026-07-05T04:31:00.000Z')),
  null,
  'started same-day kiosk block should skip when no future Naver slot remains',
);

const midnightSplitEntries = splitKioskEntryForNaverBlocks({
  name: '9450',
  phoneRaw: '01040929450',
  date: '2026-06-06',
  start: '21:30',
  end: '00:00',
  room: '스터디룸A1',
});

assert.deepEqual(
  midnightSplitEntries.map((entry) => ({
    date: entry.date,
    start: entry.start,
    end: entry.end,
    splitPart: entry.splitPart,
  })),
  [
    {
      date: '2026-06-06',
      start: '21:30',
      end: '24:00',
      splitPart: 'same_day',
    },
  ],
  'overnight reservation ending at midnight must not create a zero-length next-day block',
);

console.log('kiosk_overnight_time_elapsed_smoke_ok');
