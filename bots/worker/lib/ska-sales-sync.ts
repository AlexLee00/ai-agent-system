// @ts-nocheck
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');

const WORKER_SCHEMA = 'worker';
const RESERVATION_SCHEMA = 'reservation';
const SKA_MIRRORED_COMPANIES = new Set(['test-company']);

function isSkaMirroredSalesCompany(companyId) {
  return SKA_MIRRORED_COMPANIES.has(String(companyId || '').trim());
}

function buildSkaSalesDescription(kind, date) {
  return kind === 'general'
    ? `스카 일반석 매출 (${date})`
    : `스카 스터디룸 매출 (${date})`;
}

function sumRoomAmounts(roomAmountsJson) {
  if (!roomAmountsJson) return 0;

  let parsed = roomAmountsJson;
  if (typeof roomAmountsJson === 'string') {
    try {
      parsed = JSON.parse(roomAmountsJson);
    } catch (_) {
      return 0;
    }
  }

  if (!parsed || typeof parsed !== 'object') return 0;

  return Object.values(parsed).reduce((sum, value) => sum + Number(value || 0), 0);
}

function buildExpectedSalesRows(rows) {
  const expected = [];

  for (const row of rows) {
    const date = String(row.date || '').slice(0, 10);
    if (!date) continue;

    const totalAmount = Number(row.total_amount || 0);
    const pickkoStudyRoom = Number(row.pickko_study_room || 0);
    const generalRevenue = Number(row.general_revenue || 0);
    const roomAmountTotal = sumRoomAmounts(row.room_amounts_json);
    const studyRoomRevenue = pickkoStudyRoom > 0
      ? pickkoStudyRoom
      : roomAmountTotal > 0
        ? roomAmountTotal
      : totalAmount;

    if (generalRevenue > 0) {
      expected.push({
        date,
        amount: generalRevenue,
        category: '일반석',
        description: buildSkaSalesDescription('general', date),
      });
    }

    if (studyRoomRevenue > 0) {
      expected.push({
        date,
        amount: studyRoomRevenue,
        category: '스터디룸',
        description: buildSkaSalesDescription('studyroom', date),
      });
    }
  }

  return expected;
}

async function syncSkaSalesToWorker(companyId) {
  if (!isSkaMirroredSalesCompany(companyId)) {
    return { ok: true, skipped: true, companyId };
  }

  const dailyRows = await pgPool.query(RESERVATION_SCHEMA, `
    SELECT date::text, total_amount, room_amounts_json, pickko_study_room, general_revenue
    FROM daily_summary
    ORDER BY date
  `);

  const expectedRows = buildExpectedSalesRows(dailyRows);
  const expectedByDescription = new Map(expectedRows.map((row) => [row.description, row]));

  const existingRows = await pgPool.query(WORKER_SCHEMA, `
    SELECT id, TO_CHAR(date, 'YYYY-MM-DD') AS date, amount, category, description
    FROM worker.sales
    WHERE company_id = $1
      AND deleted_at IS NULL
      AND (
        description LIKE '스카 일반석 매출 (%)'
        OR description LIKE '스카 스터디룸 매출 (%)'
      )
  `, [companyId]);

  const existingByDescription = new Map();
  const duplicateExistingIds = [];
  for (const row of existingRows) {
    if (!existingByDescription.has(row.description)) {
      existingByDescription.set(row.description, row);
      continue;
    }
    duplicateExistingIds.push(row.id);
  }

  let inserted = 0;
  let updated = 0;
  let deleted = 0;

  await pgPool.transaction(WORKER_SCHEMA, async (client) => {
    for (const duplicateId of duplicateExistingIds) {
      await client.query(`
        UPDATE worker.sales
        SET deleted_at = NOW()
        WHERE id = $1
      `, [duplicateId]);
      deleted += 1;
    }

    for (const row of expectedRows) {
      const existing = existingByDescription.get(row.description);
      if (!existing) {
        await client.query(`
          INSERT INTO worker.sales
            (company_id, date, amount, category, description, registered_by, created_at)
          VALUES ($1, $2, $3, $4, $5, NULL, ($2::date + TIME '12:00:00'))
        `, [companyId, row.date, row.amount, row.category, row.description]);
        inserted += 1;
        continue;
      }

      if (
        existing.date !== row.date
        || Number(existing.amount || 0) !== row.amount
        || String(existing.category || '') !== row.category
      ) {
        await client.query(`
          UPDATE worker.sales
          SET date = $1,
              amount = $2,
              category = $3,
              description = $4,
              deleted_at = NULL
          WHERE id = $5
        `, [row.date, row.amount, row.category, row.description, existing.id]);
        updated += 1;
      }
    }

    for (const existing of existingRows) {
      if (expectedByDescription.has(existing.description)) continue;
      await client.query(`
        UPDATE worker.sales
        SET deleted_at = NOW()
        WHERE id = $1
      `, [existing.id]);
      deleted += 1;
    }
  });

  return {
    ok: true,
    companyId,
    inserted,
    updated,
    deleted,
    expectedRows: expectedRows.length,
  };
}

module.exports = {
  isSkaMirroredSalesCompany,
  syncSkaSalesToWorker,
};
