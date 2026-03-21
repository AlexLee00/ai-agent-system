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

function toInt(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number.parseInt(Number(value).toFixed(0), 10) : fallback;
}

function toNum(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function toBoolInt(value) {
  return value ? 1 : 0;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values) {
  return values.reduce((acc, value) => acc + value, 0);
}

function stddev(values) {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  const variance = values.reduce((acc, value) => acc + ((value - avg) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function writeCsv(outputPath, rows, header) {
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map(key => csvCell(row[key])).join(','));
  }
  fs.writeFileSync(outputPath, lines.join('\n') + '\n', 'utf8');
}

async function loadRows(days) {
  return pgPool.query('ska', `
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
      rds.total_amount,
      rds.pickko_total,
      rds.pickko_study_room,
      rds.general_revenue AS reservation_general_revenue,
      rds.entries_count,
      tf.general_payment_count,
      tf.general_payment_revenue_raw,
      tf.general_payment_morning_count,
      tf.general_payment_afternoon_count,
      tf.general_payment_evening_count,
      tf.general_ticket_single_count,
      tf.general_ticket_hourpack_count,
      tf.general_ticket_period_count,
      tf.study_room_payment_count,
      tf.study_room_payment_revenue_raw,
      tf.study_room_payment_a1_count,
      tf.study_room_payment_a2_count,
      tf.study_room_payment_b_count,
      tf.study_room_use_count,
      tf.study_room_use_policy_revenue,
      tf.study_room_use_booked_hours,
      tf.study_room_use_a1_hours,
      tf.study_room_use_a2_hours,
      tf.study_room_use_b_hours,
      rd.actual_revenue,
      rd.occupancy_rate,
      rd.total_reservations,
      rd.cancellation_count,
      rd.studyroom_revenue,
      rd.general_revenue AS ska_general_revenue,
      (lf.predictions->>'yhat')::int AS predicted_revenue,
      (lf.predictions->>'yhat_prophet')::int AS predicted_prophet,
      (lf.predictions->>'yhat_sarima')::int AS predicted_sarima,
      (lf.predictions->>'yhat_quick')::int AS predicted_quick,
      (lf.predictions->>'yhat_lower')::int AS yhat_lower,
      (lf.predictions->>'yhat_upper')::int AS yhat_upper,
      (lf.predictions->>'reservation_count')::int AS forecast_reservation_count,
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
      ef.bridge_holiday_flag
    FROM date_span ds
    LEFT JOIN latest_forecasts lf
      ON lf.forecast_date = ds.date
     AND lf.rn = 1
    LEFT JOIN environment_factors ef
      ON ef.date = ds.date
    LEFT JOIN revenue_daily rd
      ON rd.date = ds.date
    LEFT JOIN reservation.daily_summary rds
      ON rds.date::date = ds.date
    LEFT JOIN training_feature_daily tf
      ON tf.date = ds.date
    ORDER BY ds.date ASC
  `, [days]);
}

function buildModelRows(rows) {
  const built = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const date = new Date(row.date);
    const isoDate = formatDate(date);
    const weekday = ((date.getDay() + 6) % 7) + 1; // Mon=1..Sun=7
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const isWeekend = weekday >= 6 ? 1 : 0;

    const priorRows = built;
    const lag1 = i >= 1 ? toNum(priorRows[i - 1].target_revenue, 0) : 0;
    const lag7 = i >= 7 ? toNum(priorRows[i - 7].target_revenue, 0) : 0;
    const lag14 = i >= 14 ? toNum(priorRows[i - 14].target_revenue, 0) : 0;
    const last7 = priorRows.slice(Math.max(0, i - 7), i).map(item => toNum(item.target_revenue, 0));
    const last14 = priorRows.slice(Math.max(0, i - 14), i).map(item => toNum(item.target_revenue, 0));
    const dowHistory = priorRows.filter(item => item.weekday === weekday).slice(-4).map(item => toNum(item.target_revenue, 0));

    const actualRevenue = row.actual_revenue == null ? '' : toInt(row.actual_revenue);
    const predictedRevenue = row.predicted_revenue == null ? '' : toInt(row.predicted_revenue);
    const predictedProphet = row.predicted_prophet == null ? '' : toInt(row.predicted_prophet);
    const predictedSarima = row.predicted_sarima == null ? '' : toInt(row.predicted_sarima);
    const predictedQuick = row.predicted_quick == null ? '' : toInt(row.predicted_quick);

    const modelRow = {
      date: isoDate,
      target_revenue: actualRevenue,
      total_amount: row.total_amount == null ? '' : toInt(row.total_amount),
      pickko_total: row.pickko_total == null ? '' : toInt(row.pickko_total),
      pickko_study_room: row.pickko_study_room == null ? '' : toInt(row.pickko_study_room),
      reservation_general_revenue: row.reservation_general_revenue == null ? '' : toInt(row.reservation_general_revenue),
      entries_count: row.entries_count == null ? '' : toInt(row.entries_count),
      general_payment_count: row.general_payment_count == null ? '' : toInt(row.general_payment_count),
      general_payment_revenue_raw: row.general_payment_revenue_raw == null ? '' : toInt(row.general_payment_revenue_raw),
      general_payment_morning_count: row.general_payment_morning_count == null ? '' : toInt(row.general_payment_morning_count),
      general_payment_afternoon_count: row.general_payment_afternoon_count == null ? '' : toInt(row.general_payment_afternoon_count),
      general_payment_evening_count: row.general_payment_evening_count == null ? '' : toInt(row.general_payment_evening_count),
      general_ticket_single_count: row.general_ticket_single_count == null ? '' : toInt(row.general_ticket_single_count),
      general_ticket_hourpack_count: row.general_ticket_hourpack_count == null ? '' : toInt(row.general_ticket_hourpack_count),
      general_ticket_period_count: row.general_ticket_period_count == null ? '' : toInt(row.general_ticket_period_count),
      study_room_payment_count: row.study_room_payment_count == null ? '' : toInt(row.study_room_payment_count),
      study_room_payment_revenue_raw: row.study_room_payment_revenue_raw == null ? '' : toInt(row.study_room_payment_revenue_raw),
      study_room_payment_a1_count: row.study_room_payment_a1_count == null ? '' : toInt(row.study_room_payment_a1_count),
      study_room_payment_a2_count: row.study_room_payment_a2_count == null ? '' : toInt(row.study_room_payment_a2_count),
      study_room_payment_b_count: row.study_room_payment_b_count == null ? '' : toInt(row.study_room_payment_b_count),
      study_room_use_count: row.study_room_use_count == null ? '' : toInt(row.study_room_use_count),
      study_room_use_policy_revenue: row.study_room_use_policy_revenue == null ? '' : toInt(row.study_room_use_policy_revenue),
      study_room_use_booked_hours: row.study_room_use_booked_hours == null ? '' : Number(toNum(row.study_room_use_booked_hours).toFixed(2)),
      study_room_use_a1_hours: row.study_room_use_a1_hours == null ? '' : Number(toNum(row.study_room_use_a1_hours).toFixed(2)),
      study_room_use_a2_hours: row.study_room_use_a2_hours == null ? '' : Number(toNum(row.study_room_use_a2_hours).toFixed(2)),
      study_room_use_b_hours: row.study_room_use_b_hours == null ? '' : Number(toNum(row.study_room_use_b_hours).toFixed(2)),
      occupancy_rate: row.occupancy_rate == null ? '' : Number(toNum(row.occupancy_rate).toFixed(4)),
      total_reservations: row.total_reservations == null ? '' : toInt(row.total_reservations),
      cancellation_count: row.cancellation_count == null ? '' : toInt(row.cancellation_count),
      studyroom_revenue: row.studyroom_revenue == null ? '' : toInt(row.studyroom_revenue),
      ska_general_revenue: row.ska_general_revenue == null ? '' : toInt(row.ska_general_revenue),
      predicted_revenue: predictedRevenue,
      predicted_prophet: predictedProphet,
      predicted_sarima: predictedSarima,
      predicted_quick: predictedQuick,
      yhat_lower: row.yhat_lower == null ? '' : toInt(row.yhat_lower),
      yhat_upper: row.yhat_upper == null ? '' : toInt(row.yhat_upper),
      forecast_reservation_count: row.forecast_reservation_count == null ? '' : toInt(row.forecast_reservation_count),
      forecast_error: (actualRevenue === '' || predictedRevenue === '') ? '' : toInt(actualRevenue - predictedRevenue),
      forecast_abs_error: (actualRevenue === '' || predictedRevenue === '') ? '' : toInt(Math.abs(actualRevenue - predictedRevenue)),
      model_version: row.model_version ?? '',
      mape: row.mape == null ? '' : Number(toNum(row.mape).toFixed(4)),
      holiday_flag: toBoolInt(row.holiday_flag),
      rain_prob: row.rain_prob == null ? '' : Number(toNum(row.rain_prob).toFixed(4)),
      temperature: row.temperature == null ? '' : Number(toNum(row.temperature).toFixed(2)),
      exam_score: row.exam_score == null ? '' : toInt(row.exam_score),
      vacation_flag: toBoolInt(row.vacation_flag),
      festival_flag: toBoolInt(row.festival_flag),
      bridge_holiday_flag: toBoolInt(row.bridge_holiday_flag),
      holiday_name: row.holiday_name ?? '',
      exam_types: row.exam_types ?? '',
      festival_name: row.festival_name ?? '',
      weekday,
      month,
      day_of_month: day,
      is_weekend: isWeekend,
      lag_revenue_1d: lag1,
      lag_revenue_7d: lag7,
      lag_revenue_14d: lag14,
      rolling_mean_7d: Number(mean(last7).toFixed(2)),
      rolling_mean_14d: Number(mean(last14).toFixed(2)),
      rolling_sum_7d: toInt(sum(last7)),
      rolling_std_7d: Number(stddev(last7).toFixed(2)),
      same_weekday_mean_4: Number(mean(dowHistory).toFixed(2)),
      reservation_gap: row.total_reservations == null || row.forecast_reservation_count == null
        ? ''
        : toInt(toNum(row.forecast_reservation_count) - toNum(row.total_reservations)),
      revenue_mix_study_ratio: row.actual_revenue
        ? Number((toNum(row.studyroom_revenue) / Math.max(toNum(row.actual_revenue), 1)).toFixed(4))
        : '',
      revenue_mix_general_ratio: row.actual_revenue
        ? Number((toNum(row.ska_general_revenue) / Math.max(toNum(row.actual_revenue), 1)).toFixed(4))
        : '',
    };

    built.push(modelRow);
  }

  return built;
}

async function main() {
  const days = Number.parseInt(getArg('days') || '100', 10);
  const outDir = getArg('outdir') || path.join(os.homedir(), 'Downloads');
  const prefix = getArg('prefix') || `ska-model-dataset-last-${days}-days`;

  const rows = await loadRows(days);
  const modelRows = buildModelRows(rows);
  const labeledRows = modelRows.filter(row => row.target_revenue !== '');
  const splitIndex = Math.max(1, Math.floor(labeledRows.length * 0.8));
  const trainRows = labeledRows.slice(0, splitIndex);
  const testRows = labeledRows.slice(splitIndex);

  const header = Object.keys(modelRows[0] || { date: '' });

  const fullPath = path.join(outDir, `${prefix}.csv`);
  const trainPath = path.join(outDir, `${prefix}-train.csv`);
  const testPath = path.join(outDir, `${prefix}-test.csv`);

  writeCsv(fullPath, modelRows, header);
  writeCsv(trainPath, trainRows, header);
  writeCsv(testPath, testRows, header);

  console.log(JSON.stringify({
    ok: true,
    output: fullPath,
    train_output: trainPath,
    test_output: testPath,
    rows: modelRows.length,
    labeled_rows: labeledRows.length,
    train_rows: trainRows.length,
    test_rows: testRows.length,
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
