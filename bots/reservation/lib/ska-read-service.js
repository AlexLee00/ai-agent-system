'use strict';

const kst = require('../../../packages/core/lib/kst');
const { searchReservationCases } = require('../../../packages/core/lib/reservation-rag');

function createSkaReadService({ pgPool, rag = null }) {
  async function queryReservations(args = {}) {
    const date = args.date || kst.today();
    try {
      const rows = await pgPool.query('reservation', `
        SELECT name_enc, date, start_time, end_time, room, status
        FROM reservations
        WHERE date = $1
        ORDER BY start_time
      `, [date]);

      if (rows.length === 0) {
        return { ok: true, date, count: 0, message: `${date} 예약 없음` };
      }

      const reservations = rows.map((row) => `${row.start_time}~${row.end_time} [${row.room}] ${row.status}`);
      return { ok: true, date, count: rows.length, reservations };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function queryTodayStats(args = {}) {
    const date = args.date || kst.today();
    try {
      const summary = await pgPool.get('reservation', `
        SELECT total_amount, entries_count
        FROM daily_summary
        WHERE date = $1
      `, [date]);

      if (!summary) {
        return { ok: true, date, message: `${date} 매출 데이터 없음` };
      }

      return {
        ok: true,
        date,
        total_amount: summary.total_amount,
        entries_count: summary.entries_count,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function queryAlerts(args = {}) {
    try {
      const limit = args.limit || 10;
      const rows = await pgPool.query('reservation', `
        SELECT type, title, message, timestamp
        FROM alerts
        WHERE resolved = 0
        ORDER BY timestamp DESC
        LIMIT $1
      `, [limit]);

      let pastCases = null;
      if (rag && rows.length > 0) {
        pastCases = await searchReservationCases(rag, rows[0].type || '알람', rows[0].title || '');
      }

      return { ok: true, count: rows.length, alerts: rows, past_cases: pastCases };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return {
    queryReservations,
    queryTodayStats,
    queryAlerts,
  };
}

module.exports = {
  createSkaReadService,
};
