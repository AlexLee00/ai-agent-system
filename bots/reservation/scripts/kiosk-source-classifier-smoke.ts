// @ts-nocheck
'use strict';

const assert = require('assert');
const {
  classifyPickkoEntriesByNaver,
  findNaverConfirmedMatch,
  normalizeSourceRoom,
  timeRangesOverlap,
} = require('../lib/reservation-source-classifier');

const naverConfirmed = [
  {
    phoneRaw: '01000000001',
    date: '2026-07-28',
    room: 'A1',
    start: '19:00',
    end: '20:00',
  },
  {
    phoneRaw: '01000000002',
    date: '2026-07-22',
    room: 'A2',
    start: '15:00',
    end: '16:30',
  },
  {
    phoneRaw: '01000000003',
    date: '2026-07-07',
    room: 'A1',
    start: '21:30',
    end: '00:50',
  },
];

const pickkoRows = [
  {
    name: '네이버매칭1',
    phoneRaw: '01000000001',
    date: '2026-07-28',
    room: '스터디룸A1',
    start: '19:00',
    end: '19:50',
    amount: 0,
  },
  {
    name: '네이버매칭2',
    phoneRaw: '01000000002',
    date: '2026-07-22',
    room: 'A2룸',
    start: '15:10',
    end: '16:20',
    amount: 0,
  },
  {
    name: '키오스크수동',
    phoneRaw: '01000000004',
    date: '2026-07-24',
    room: '스터디룸B',
    start: '10:30',
    end: '12:50',
    amount: 0,
  },
  {
    name: '야간같은날',
    phoneRaw: '01000000003',
    date: '2026-07-07',
    room: 'A1',
    start: '21:30',
    end: '24:00',
    amount: 0,
  },
  {
    name: '야간다음날',
    phoneRaw: '01000000003',
    date: '2026-07-08',
    room: 'A1',
    start: '00:00',
    end: '01:00',
    amount: 0,
  },
  {
    name: 'invalid',
    phoneRaw: '',
    date: '2026-07-24',
    room: '스터디룸B',
    start: '10:30',
    end: '12:50',
  },
];

assert.equal(normalizeSourceRoom('스터디룸A1'), 'A1');
assert.equal(normalizeSourceRoom('A2룸 (2인 최적)'), 'A2');
assert.equal(normalizeSourceRoom('Study room B'), 'B');

assert.equal(
  timeRangesOverlap({ start: '19:00', end: '19:50' }, { start: '19:00', end: '20:00' }),
  true,
  'same start overlap should match',
);
assert.equal(
  timeRangesOverlap({ start: '15:10', end: '16:20' }, { start: '15:00', end: '16:30' }),
  true,
  'partial overlap should match, not exact start only',
);
assert.equal(
  timeRangesOverlap({ start: '16:30', end: '17:00' }, { start: '15:00', end: '16:30' }),
  false,
  'touching boundaries are not overlap',
);

assert.ok(
  findNaverConfirmedMatch(pickkoRows[0], naverConfirmed),
  'amount=0 Pickko row matching phone/date/room/overlap must be treated as Naver-origin',
);

const classified = classifyPickkoEntriesByNaver(pickkoRows, naverConfirmed);

assert.deepEqual(
  classified.naverMatched.map((item) => item.pickko.name),
  ['네이버매칭1', '네이버매칭2', '야간같은날', '야간다음날'],
  'Naver matched Pickko rows must be excluded from block targets',
);
assert.deepEqual(
  classified.kioskOrManual.map((item) => item.name),
  ['키오스크수동'],
  'Pickko rows without current Naver confirmed match must become kiosk/manual block targets',
);
assert.deepEqual(
  classified.invalid.map((item) => item.name),
  ['invalid'],
  'invalid rows must not be silently treated as kiosk/manual',
);

console.log('kiosk_source_classifier_smoke_ok');
