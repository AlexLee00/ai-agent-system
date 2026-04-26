#!/usr/bin/env node
/**
 * pickko-query.ts — 예약 조회 CLI
 *
 * 운영 실행 예:
 *   node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --date=today
 *   node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --date=tomorrow
 *   node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --date=2026-03-05
 *   node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --phone=01012345678
 *   node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --name=홍길동
 *   node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-query.js --date=2026-03-05 --room=A1
 *
 * 출력 (stdout JSON):
 *   { success: true, count: N, message: "포맷된 결과", bookings: [...] }
 *   { success: false, message: "오류 내용" }
 */

const fs = require('fs');
const { parseArgs } = require('../../lib/args');
const { fail } = require('../../lib/cli');
const { createAgentMemory } = require('../../../../packages/core/lib/agent-memory');
const { buildReservationCliInsight } = require('../../lib/cli-insight');
const { getReadableReservationRuntimeFile } = require('../../lib/runtime-paths');

const BOOKINGS_FILE = getReadableReservationRuntimeFile('naver-bookings-full.json');

const ARGS = parseArgs(process.argv);
const queryMemory = createAgentMemory({ agentId: 'reservation.pickko-query', team: 'reservation' });

type Booking = {
  date: string;
  start: string;
  end: string;
  room: string;
  phone?: string;
  phoneRaw?: string;
  raw?: {
    name?: string;
  };
};

function buildQueryMemoryQuery(kind: string, extras: string[] = []): string {
  return [
    'reservation pickko query',
    kind,
    ...extras,
  ].filter(Boolean).join(' ');
}

async function buildQueryMemoryHints(memoryQuery: string, order: string[]) {
  const episodicHint = await queryMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 조회',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      result: '결과',
      empty: '없음',
    },
    order,
  }).catch(() => '');
  const semanticHint = await queryMemory.recallHint(`${memoryQuery} consolidated query pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  return { episodicHint, semanticHint };
}

function resolveDate(dateArg: string | undefined): string | null {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  if (!dateArg || dateArg === 'today') {
    return now.toLocaleDateString('en-CA');
  }
  if (dateArg === 'tomorrow') {
    now.setDate(now.getDate() + 1);
    return now.toLocaleDateString('en-CA');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) return dateArg;
  return null;
}

function formatBooking(b: Booking, idx: number): string {
  const name = b.raw?.name || '(이름 없음)';
  const phone = b.phone || b.phoneRaw;
  return `${idx}. ${name} · ${phone}\n   🕐 ${b.start}~${b.end} · ${b.room}룸`;
}

function formatDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getMonth() + 1}월 ${d.getDate()}일(${days[d.getDay()]})`;
}

if (!fs.existsSync(BOOKINGS_FILE)) {
  fail('예약 데이터 없음 (naver-monitor가 실행 중인지 확인해 주세요)');
}

let bookings;
try {
  bookings = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf-8')) as Booking[];
} catch (e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  fail(`예약 데이터 읽기 실패: ${message}`);
}

if (!Array.isArray(bookings)) {
  fail('예약 데이터 형식 오류');
}

let filtered: Booking[] = bookings;
const filterDesc = [];

if (ARGS.date !== undefined) {
  const resolved = resolveDate(ARGS.date);
  if (!resolved) fail(`날짜 형식 오류: ${ARGS.date} (예: today, tomorrow, 2026-03-05)`);
  filtered = filtered.filter((b) => b.date === resolved);
  filterDesc.push(`📅 ${formatDate(resolved)}`);
}

if (ARGS.phone) {
  const phoneRaw = ARGS.phone.replace(/\D/g, '');
  filtered = filtered.filter((b) => (b.phoneRaw || '').includes(phoneRaw) || (b.phone || '').replace(/\D/g, '').includes(phoneRaw));
  filterDesc.push(`📞 ${ARGS.phone}`);
}

if (ARGS.name) {
  filtered = filtered.filter((b) => (b.raw?.name || '').includes(ARGS.name));
  filterDesc.push(`👤 ${ARGS.name}`);
}

if (ARGS.room) {
  const roomNorm = ARGS.room.replace(/룸|room/gi, '').toUpperCase();
  filtered = filtered.filter((b) => b.room.toUpperCase() === roomNorm);
  filterDesc.push(`🏛️ ${ARGS.room}룸`);
}

filtered.sort((a, b) => {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  return a.start.localeCompare(b.start);
});

const filterLabel = filterDesc.length > 0 ? filterDesc.join(' · ') : '전체';

if (filtered.length === 0) {
  const message = `${filterLabel}\n\n예약 없음`;
  (async () => {
    const memoryQuery = buildQueryMemoryQuery('empty', [filterLabel]);
    const { episodicHint, semanticHint } = await buildQueryMemoryHints(memoryQuery, ['empty', 'result']);
    const aiSummary = await buildReservationCliInsight({
      bot: 'pickko-query',
      requestType: 'query-result',
      title: '픽코 예약 조회 결과',
      data: {
        kind: 'empty',
        filterLabel,
        count: 0,
      },
      fallback: '조회 조건에 맞는 예약이 없어 신규 접수 여부나 날짜 조건을 다시 확인하는 편이 좋습니다.',
    });
    process.stdout.write(`${JSON.stringify({
      success: true,
      count: 0,
      message,
      aiSummary,
      bookings: [],
      memoryHints: {
        episodicHint,
        semanticHint,
      },
    })}\n`);
    await queryMemory.remember([
      '픽코 예약 조회',
      `filter: ${filterLabel}`,
      '예약 없음',
    ].join('\n'), 'episodic', {
      importance: 0.58,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: {
        kind: 'empty',
        filterLabel,
        count: 0,
      },
    }).catch(() => {});
    await queryMemory.consolidate({
      olderThanDays: 14,
      limit: 10,
    }).catch(() => {});
    process.exit(0);
  })();
  return;
}

const groups: Record<string, Booking[]> = {};
for (const b of filtered) {
  if (!groups[b.date]) groups[b.date] = [];
  groups[b.date].push(b);
}

let message = `${filterLabel} · 총 ${filtered.length}건\n`;
let idx = 1;
for (const [date, list] of Object.entries(groups).sort()) {
  message += `\n━━ ${formatDate(date)} (${list.length}건) ━━\n`;
  for (const b of list.sort((a, bb) => a.start.localeCompare(bb.start))) {
    message += `${formatBooking(b, idx++)}\n`;
  }
}
message = message.trim();
const memoryQuery = buildQueryMemoryQuery('result', [filterLabel, `${filtered.length}-bookings`]);
(async () => {
  const { episodicHint, semanticHint } = await buildQueryMemoryHints(memoryQuery, ['result', 'empty']);
  const aiSummary = await buildReservationCliInsight({
    bot: 'pickko-query',
    requestType: 'query-result',
    title: '픽코 예약 조회 결과',
    data: {
      kind: 'result',
      filterLabel,
      count: filtered.length,
      groupedDates: Object.keys(groups),
      rooms: Array.from(new Set(filtered.map((item) => item.room))),
    },
    fallback: `조회 결과 ${filtered.length}건이 확인되어 날짜와 룸 기준으로 후속 처리 우선순위를 바로 잡기 좋습니다.`,
  });
  process.stdout.write(`${JSON.stringify({
    success: true,
    count: filtered.length,
    message,
    aiSummary,
    bookings: filtered,
    memoryHints: {
      episodicHint,
      semanticHint,
    },
  })}\n`);
  await queryMemory.remember([
    '픽코 예약 조회',
    `filter: ${filterLabel}`,
    `count: ${filtered.length}`,
    message,
  ].join('\n'), 'episodic', {
    importance: 0.62,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'result',
      filterLabel,
      count: filtered.length,
    },
  }).catch(() => {});
  await queryMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});
  process.exit(0);
})();
