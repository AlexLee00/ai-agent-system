const db = require('../lib/db.ts');

const INCIDENT_START = '2026-06-07 11:02:00';
const INCIDENT_END = '2026-06-07 11:15:00';

type CancelKeyRow = {
  cancel_key: string;
  cancelled_at: string;
};

type AffectedReservation = {
  id: string;
  phone: string;
  date: string;
  start_time: string;
  end_time: string;
  room: string;
  status: string;
  pickko_status: string;
  updated_at: string;
};

function normalizePhone(value: string): string {
  return String(value || '').replace(/\D+/g, '');
}

function parseCancelDoneKey(key: string) {
  const parts = String(key || '').split('|');
  if (parts.length !== 6 || parts[0] !== 'cancel_done') return null;
  return {
    phoneRaw: normalizePhone(parts[1]),
    date: parts[2],
    start: parts[3],
    end: parts[4],
    room: parts[5],
  };
}

async function main() {
  const cancelRows: CancelKeyRow[] = await db.query(
    `
      SELECT cancel_key, cancelled_at
      FROM cancelled_keys
      WHERE cancelled_at >= $1
        AND cancelled_at < $2
        AND (cancel_key LIKE 'cancel_done|%' OR cancel_key LIKE 'cancelid|%')
      ORDER BY cancelled_at ASC, cancel_key ASC
    `,
    [INCIDENT_START, INCIDENT_END],
  );

  const affectedIds = new Set<string>();
  const slotKeys: ReturnType<typeof parseCancelDoneKey>[] = [];

  for (const row of cancelRows) {
    if (row.cancel_key.startsWith('cancelid|')) {
      const id = row.cancel_key.slice('cancelid|'.length);
      if (/^\d+$/.test(id)) affectedIds.add(id);
      continue;
    }
    const parsed = parseCancelDoneKey(row.cancel_key);
    if (parsed) slotKeys.push(parsed);
  }

  const affectedRowsById = new Map<string, AffectedReservation>();

  if (affectedIds.size > 0) {
    const rows: AffectedReservation[] = await db.query(
      `
        SELECT id, phone, date, start_time, end_time, room, status, pickko_status, updated_at
        FROM reservations
        WHERE id = ANY($1::text[])
      `,
      [[...affectedIds]],
    );
    for (const row of rows) affectedRowsById.set(String(row.id), row);
  }

  for (const slot of slotKeys) {
    if (!slot) continue;
    const rows: AffectedReservation[] = await db.query(
      `
        SELECT id, phone, date, start_time, end_time, room, status, pickko_status, updated_at
        FROM reservations
        WHERE regexp_replace(phone, '\\D', '', 'g') = $1
          AND date = $2
          AND start_time = $3
          AND end_time = $4
          AND room = $5
        ORDER BY updated_at DESC NULLS LAST, id DESC
      `,
      [slot.phoneRaw, slot.date, slot.start, slot.end, slot.room],
    );
    for (const row of rows) affectedRowsById.set(String(row.id), row);
  }

  const affectedRows = [...affectedRowsById.values()].sort((a, b) =>
    `${a.date} ${a.start_time} ${a.room} ${a.id}`.localeCompare(`${b.date} ${b.start_time} ${b.room} ${b.id}`),
  );

  console.log(`사고 구간 취소 key: ${cancelRows.length}건`);
  console.log(`정리 대상 예약 row: ${affectedRows.length}건`);

  for (const row of affectedRows) {
    console.log(
      `- ${row.id} ${row.date} ${row.start_time}~${row.end_time} ${row.room} ${row.phone} ` +
      `[${row.status}/${row.pickko_status}]`,
    );
  }

  if (process.env.APPLY !== '1') {
    console.log('\nDRY-RUN: APPLY=1 로 실행하면 DB 정리를 적용합니다.');
    return;
  }

  await db.run(
    `
      DELETE FROM cancelled_keys
      WHERE cancelled_at >= $1
        AND cancelled_at < $2
        AND (cancel_key LIKE 'cancel_done|%' OR cancel_key LIKE 'cancelid|%')
    `,
    [INCIDENT_START, INCIDENT_END],
  );

  for (const row of affectedRows) {
    await db.run(
      `
        UPDATE reservations
        SET status = 'completed',
            pickko_status = 'manual',
            error_reason = CASE
              WHEN error_reason IS NULL OR error_reason = '' THEN 'restored_after_false_cancel:2026-06-07'
              WHEN error_reason LIKE '%restored_after_false_cancel:2026-06-07%' THEN error_reason
              ELSE error_reason || ' | restored_after_false_cancel:2026-06-07'
            END,
            marked_seen = 1,
            seen_only = 0,
            updated_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE id = $1
      `,
      [row.id],
    );
  }

  if (affectedRows.length > 0) {
    await db.run(
      `
        DELETE FROM naver_future_confirmed
        WHERE date >= '2026-06-07'
          AND booking_key = ANY($1::text[])
      `,
      [affectedRows.map((row) => row.id)],
    );
  }

  const remainingCancelKeys = await db.query(
    `
      SELECT COUNT(*)::int AS count
      FROM cancelled_keys
      WHERE cancelled_at >= $1
        AND cancelled_at < $2
        AND (cancel_key LIKE 'cancel_done|%' OR cancel_key LIKE 'cancelid|%')
    `,
    [INCIDENT_START, INCIDENT_END],
  );
  const remainingCancelledRows = await db.query(
    `
      SELECT COUNT(*)::int AS count
      FROM reservations
      WHERE id = ANY($1::text[])
        AND (status = 'cancelled' OR pickko_status = 'cancelled')
    `,
    [[...affectedRowsById.keys()]],
  );

  console.log('\n적용 완료');
  console.log(`남은 사고 구간 취소 key: ${remainingCancelKeys[0]?.count ?? 0}건`);
  console.log(`남은 대상 예약 cancelled row: ${remainingCancelledRows[0]?.count ?? 0}건`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
