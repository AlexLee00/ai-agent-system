// @ts-nocheck
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const pgPool = require('../../../packages/core/lib/pg-pool');

function getArg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

async function main() {
  const days = Number.parseInt(getArg('days') || '100', 10);
  const outputPath = getArg('output') || path.join(os.homedir(), 'Downloads', 'ska-forecast-env-last-100-days.csv');

  const rows = await pgPool.query('ska', `
    WITH date_span AS (
      SELECT generate_series(
        CURRENT_DATE - ($1::int - 1),
        CURRENT_DATE,
        INTERVAL '1 day'
      )::date AS date
    ),
    latest_forecasts AS (
      SELECT
        fr.forecast_date,
        fr.model_version,
        fr.predictions,
        fr.mape,
        fr.params,
        fr.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY fr.forecast_date
          ORDER BY fr.created_at DESC, fr.id DESC
        ) AS rn
      FROM forecast_results fr
      WHERE fr.forecast_date >= CURRENT_DATE - ($1::int - 1)
    )
    SELECT
      ds.date,
      (lf.predictions->>'yhat')::int AS predicted_revenue,
      (lf.predictions->>'yhat_prophet')::int AS predicted_prophet,
      (lf.predictions->>'yhat_sarima')::int AS predicted_sarima,
      (lf.predictions->>'yhat_quick')::int AS predicted_quick,
      (lf.predictions->>'yhat_lower')::int AS yhat_lower,
      (lf.predictions->>'yhat_upper')::int AS yhat_upper,
      (lf.predictions->>'reservation_count')::int AS reservation_count,
      lf.model_version,
      lf.mape,
      ef.holiday_flag,
      ef.holiday_name,
      ef.rain_prob,
      ef.temperature,
      ef.exam_score,
      ef.exam_types,
      ef.vacation_flag,
      ef.festival_flag,
      ef.festival_name,
      ef.bridge_holiday_flag,
      ef.factors_json,
      rd.actual_revenue,
      rd.occupancy_rate,
      rd.total_reservations,
      rd.cancellation_count,
      rd.studyroom_revenue,
      rd.general_revenue,
      lf.created_at
    FROM date_span ds
    LEFT JOIN latest_forecasts lf
      ON lf.forecast_date = ds.date
     AND lf.rn = 1
    LEFT JOIN environment_factors ef
      ON ef.date = ds.date
    LEFT JOIN revenue_daily rd
      ON rd.date = ds.date
    ORDER BY ds.date DESC
  `, [days]);

  const header = [
    'date',
    'predicted_revenue',
    'predicted_prophet',
    'predicted_sarima',
    'predicted_quick',
    'yhat_lower',
    'yhat_upper',
    'reservation_count',
    'model_version',
    'mape',
    'holiday_flag',
    'holiday_name',
    'rain_prob',
    'temperature',
    'exam_score',
    'exam_types',
    'vacation_flag',
    'festival_flag',
    'festival_name',
    'bridge_holiday_flag',
    'factors_json',
    'actual_revenue',
    'occupancy_rate',
    'total_reservations',
    'cancellation_count',
    'studyroom_revenue',
    'general_revenue',
    'forecast_created_at',
  ];

  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.date,
      row.predicted_revenue,
      row.predicted_prophet,
      row.predicted_sarima,
      row.predicted_quick,
      row.yhat_lower,
      row.yhat_upper,
      row.reservation_count,
      row.model_version,
      row.mape,
      row.holiday_flag,
      row.holiday_name,
      row.rain_prob,
      row.temperature,
      row.exam_score,
      row.exam_types,
      row.vacation_flag,
      row.festival_flag,
      row.festival_name,
      row.bridge_holiday_flag,
      row.factors_json,
      row.actual_revenue,
      row.occupancy_rate,
      row.total_reservations,
      row.cancellation_count,
      row.studyroom_revenue,
      row.general_revenue,
      row.created_at,
    ].map(csvCell).join(','));
  }

  fs.writeFileSync(outputPath, lines.join('\n') + '\n', 'utf8');
  console.log(JSON.stringify({
    ok: true,
    output: outputPath,
    rows: rows.length,
    days,
  }));
}

main().catch(err => {
  console.error(JSON.stringify({
    ok: false,
    error: err.message,
  }));
  process.exit(1);
});
