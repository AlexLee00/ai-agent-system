#!/usr/bin/env node
'use strict';

const pgPool = require('../../packages/core/lib/pg-pool');

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find(arg => arg.startsWith('--days='));
  const days = Math.max(7, Number(daysArg?.split('=')[1] || 30));
  return { days, json: argv.includes('--json') };
}

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function toDateString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function toRate(part, whole) {
  if (!whole) return 0;
  return Number(((Number(part || 0) / Number(whole || 0)) * 100).toFixed(1));
}

function biasLabel(value) {
  if (value > 0) return `과대예측 +${fmt(value)}원`;
  if (value < 0) return `과소예측 ${fmt(value)}원`;
  return '편향 없음';
}

async function loadAccuracyRows(days) {
  return pgPool.query('ska', `
    WITH latest AS (
      SELECT DISTINCT ON (fr.forecast_date)
        fr.forecast_date,
        fr.predictions,
        fr.model_version,
        fr.created_at
      FROM forecast_results fr
      WHERE fr.forecast_date >= CURRENT_DATE - ($1::int - 1)
      ORDER BY fr.forecast_date, fr.created_at DESC, fr.id DESC
    )
    SELECT
      latest.forecast_date AS date,
      rd.actual_revenue,
      rds.total_amount,
      rds.entries_count,
      (latest.predictions->>'yhat')::int AS predicted_revenue,
      COALESCE((latest.predictions->>'reservation_count')::int, 0) AS predicted_reservations,
      rd.total_reservations AS actual_reservations,
      COALESCE((latest.predictions->>'confidence')::float, 0.0) AS confidence,
      latest.model_version,
      latest.created_at,
      ((latest.predictions->>'yhat')::int - rd.actual_revenue) AS error,
      CASE
        WHEN rd.actual_revenue > 0
        THEN ABS(((latest.predictions->>'yhat')::float - rd.actual_revenue) / rd.actual_revenue) * 100
        ELSE NULL
      END AS mape
    FROM latest
    JOIN revenue_daily rd ON rd.date = latest.forecast_date
    LEFT JOIN reservation.daily_summary rds ON rds.date::date = latest.forecast_date
    WHERE rd.actual_revenue IS NOT NULL
    ORDER BY latest.forecast_date DESC
  `, [days]);
}

async function loadUpcomingForecasts(days = 3) {
  return pgPool.query('ska', `
    WITH latest AS (
      SELECT DISTINCT ON (fr.forecast_date)
        fr.forecast_date,
        fr.predictions,
        fr.model_version,
        fr.created_at
      FROM forecast_results fr
      WHERE fr.forecast_date > CURRENT_DATE
      ORDER BY fr.forecast_date, fr.created_at DESC, fr.id DESC
    )
    SELECT
      latest.forecast_date AS date,
      (latest.predictions->>'yhat')::int AS predicted_revenue,
      COALESCE((latest.predictions->>'reservation_count')::int, 0) AS predicted_reservations,
      COALESCE((latest.predictions->>'confidence')::float, 0.0) AS confidence,
      latest.model_version,
      latest.created_at
    FROM latest
    ORDER BY latest.forecast_date ASC
    LIMIT $1
  `, [days]);
}

function buildSummary(rows) {
  const valid = rows.filter(row => row.mape != null);
  const hit10 = valid.filter(row => Number(row.mape) <= 10).length;
  const hit20 = valid.filter(row => Number(row.mape) <= 20).length;
  const avgMape = valid.length
    ? Number((valid.reduce((sum, row) => sum + Number(row.mape || 0), 0) / valid.length).toFixed(2))
    : null;
  const avgBias = valid.length
    ? Math.round(valid.reduce((sum, row) => sum + Number(row.error || 0), 0) / valid.length)
    : 0;
  const avgReservationGap = valid.length
    ? Number((valid.reduce((sum, row) => sum + Math.abs(Number(row.predicted_reservations || 0) - Number(row.actual_reservations || 0)), 0) / valid.length).toFixed(2))
    : 0;

  return {
    days: rows.length,
    validDays: valid.length,
    avgMape,
    avgBias,
    hitRate10: toRate(hit10, valid.length),
    hitRate20: toRate(hit20, valid.length),
    avgReservationGap,
  };
}

function buildRecommendations(summary, latest) {
  const lines = [];
  if (summary.avgMape == null) {
    return ['- 아직 정확도 누적 데이터가 부족합니다.'];
  }
  if (summary.avgMape >= 20) {
    lines.push(`- 최근 평균 MAPE가 ${summary.avgMape}%로 높아 예측 엔진 보정이 필요합니다.`);
  } else if (summary.avgMape >= 12) {
    lines.push(`- 최근 평균 MAPE가 ${summary.avgMape}%라서 중간 수준 튜닝 후보입니다.`);
  } else {
    lines.push(`- 최근 평균 MAPE ${summary.avgMape}%로 비교적 안정적입니다.`);
  }

  if (summary.avgBias <= -30000) {
    lines.push('- 전반적으로 과소예측 성향이 있어 예약 선행지표 가중치를 조금 키우는 쪽이 좋습니다.');
  } else if (summary.avgBias >= 30000) {
    lines.push('- 전반적으로 과대예측 성향이 있어 피크일 가산치나 상한 보정을 줄이는 게 좋습니다.');
  }

  if (summary.hitRate20 < 70) {
    lines.push(`- 20% 이내 적중률이 ${summary.hitRate20}%로 낮아 요일/환경 변수 가중치 재점검이 필요합니다.`);
  }

  if (summary.avgReservationGap >= 5) {
    lines.push(`- 예약건수 오차 평균이 ${summary.avgReservationGap}건이라 예약 선행지표 보정이 필요해 보입니다.`);
  }

  if (latest && latest.confidence != null && Number(latest.confidence) < 0.4) {
    lines.push(`- 최신 예측 확신도가 ${(Number(latest.confidence) * 100).toFixed(0)}%로 낮아 수동 검토 우선순위를 올리는 게 좋습니다.`);
  }

  return lines.slice(0, 4);
}

async function main() {
  const { days, json } = parseArgs();
  const [accuracyRows, upcomingRows] = await Promise.all([
    loadAccuracyRows(days),
    loadUpcomingForecasts(3),
  ]);

  const latestActual = accuracyRows[0] || null;
  const summary = buildSummary(accuracyRows);
  const recommendations = buildRecommendations(summary, upcomingRows[0] || latestActual);

  const report = {
    periodDays: days,
    latestActual: latestActual ? {
      date: toDateString(latestActual.date),
      actualRevenue: Number(latestActual.actual_revenue || 0),
      predictedRevenue: Number(latestActual.predicted_revenue || 0),
      actualReservations: Number(latestActual.actual_reservations || 0),
      predictedReservations: Number(latestActual.predicted_reservations || 0),
      totalAmount: Number(latestActual.total_amount || 0),
      entriesCount: Number(latestActual.entries_count || 0),
      mape: latestActual.mape == null ? null : Number(Number(latestActual.mape).toFixed(2)),
      bias: Number(latestActual.error || 0),
      confidence: Number(latestActual.confidence || 0),
      modelVersion: latestActual.model_version || '',
    } : null,
    summary,
    upcomingForecasts: upcomingRows.map(row => ({
      date: toDateString(row.date),
      predictedRevenue: Number(row.predicted_revenue || 0),
      predictedReservations: Number(row.predicted_reservations || 0),
      confidence: Number(row.confidence || 0),
      modelVersion: row.model_version || '',
    })),
    recommendations,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push(`📊 스카 매출·예측 일일 리뷰 (${days}일)`);

  if (report.latestActual) {
    lines.push('');
    lines.push(`최근 확정일: ${report.latestActual.date}`);
    lines.push(`- 실매출: ${fmt(report.latestActual.actualRevenue)}원`);
    lines.push(`- 예측매출: ${fmt(report.latestActual.predictedRevenue)}원`);
    lines.push(`- 오차: ${biasLabel(report.latestActual.bias)}`);
    lines.push(`- 적중률(MAPE): ${report.latestActual.mape == null ? 'N/A' : `${report.latestActual.mape}%`}`);
    lines.push(`- 실예약/예측예약: ${fmt(report.latestActual.actualReservations)}건 / ${fmt(report.latestActual.predictedReservations)}건`);
    lines.push(`- total_amount / entries_count: ${fmt(report.latestActual.totalAmount)}원 / ${fmt(report.latestActual.entriesCount)}건`);
  }

  lines.push('');
  lines.push('최근 정확도:');
  lines.push(`- 평균 MAPE: ${report.summary.avgMape == null ? 'N/A' : `${report.summary.avgMape}%`}`);
  lines.push(`- 10% 이내 적중률: ${report.summary.hitRate10}%`);
  lines.push(`- 20% 이내 적중률: ${report.summary.hitRate20}%`);
  lines.push(`- 평균 편향: ${biasLabel(report.summary.avgBias)}`);
  lines.push(`- 예약건수 평균 오차: ${report.summary.avgReservationGap}건`);

  if (report.upcomingForecasts.length) {
    lines.push('');
    lines.push('다가오는 예측:');
    for (const row of report.upcomingForecasts) {
      lines.push(`- ${row.date}: ${fmt(row.predictedRevenue)}원 / ${fmt(row.predictedReservations)}건 / 확신도 ${(row.confidence * 100).toFixed(0)}%`);
    }
  }

  lines.push('');
  lines.push('추천:');
  for (const item of report.recommendations) lines.push(item);

  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
