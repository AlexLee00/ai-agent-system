'use strict';

const kst = require('../../../packages/core/lib/kst');
const { searchReservationCases } = require('../../../packages/core/lib/reservation-rag');

function createSkaReadService({ pgPool, rag = null }) {
  async function queryReservations(args = {}) {
    const date = args.date || kst.today();
    try {
      const rows = await pgPool.query('reservation', `
        SELECT DISTINCT ON (
          regexp_replace(phone, '\\D', '', 'g'),
          date,
          start_time,
          end_time,
          COALESCE(room, '')
        )
          name_enc,
          date,
          start_time,
          end_time,
          room,
          status
        FROM reservations
        WHERE date = $1
          AND seen_only = 0
          AND status NOT IN ('failed')
        ORDER BY
          regexp_replace(phone, '\\D', '', 'g'),
          date,
          start_time,
          end_time,
          COALESCE(room, ''),
          updated_at DESC NULLS LAST,
          id DESC,
          start_time
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
        SELECT
          total_amount,
          entries_count,
          COALESCE(pickko_study_room, 0) AS pickko_study_room,
          COALESCE(general_revenue, 0) AS general_revenue,
          COALESCE(general_revenue, 0) + COALESCE(pickko_study_room, 0) AS combined_revenue
        FROM daily_summary
        WHERE date = $1
      `, [date]);

      if (!summary) {
        return { ok: true, date, message: `${date} 매출 데이터 없음` };
      }

      return {
        ok: true,
        date,
        booking_total_amount: Number(summary.total_amount || 0),
        recognized_total_revenue: Number(summary.combined_revenue || 0),
        total_amount: summary.total_amount,
        combined_revenue: Number(summary.combined_revenue || 0),
        total_revenue: Number(summary.combined_revenue || 0),
        study_room_revenue: Number(summary.pickko_study_room || 0),
        study_cafe_revenue: Number(summary.general_revenue || 0),
        pickko_study_room: Number(summary.pickko_study_room || 0),
        general_revenue: Number(summary.general_revenue || 0),
        entries_count: summary.entries_count,
        revenue_axes: {
          booking_axis: 'total_amount',
          recognized_axis: 'general_revenue + pickko_study_room',
        },
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
