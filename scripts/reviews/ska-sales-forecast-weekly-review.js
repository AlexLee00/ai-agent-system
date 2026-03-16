#!/usr/bin/env node
'use strict';

const pgPool = require('../../packages/core/lib/pg-pool');
const { getSkaReviewConfig } = require('../../bots/ska/lib/runtime-config.js');
const WEEKLY_REVIEW_CONFIG = getSkaReviewConfig().weekly;

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find(arg => arg.startsWith('--days='));
  const days = Math.max(WEEKLY_REVIEW_CONFIG.minDays, Number(daysArg?.split('=')[1] || WEEKLY_REVIEW_CONFIG.defaultDays));
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

function rate(part, whole) {
  if (!whole) return 0;
  return Number(((Number(part || 0) / Number(whole || 0)) * 100).toFixed(1));
}

function biasLabel(value) {
  if (value > 0) return `과대예측 +${fmt(value)}원`;
  if (value < 0) return `과소예측 ${fmt(value)}원`;
  return '편향 없음';
}

async function loadRows(days) {
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
      (latest.predictions->>'yhat')::int AS predicted_revenue,
      COALESCE((latest.predictions->>'reservation_count')::int, 0) AS predicted_reservations,
      rd.total_reservations AS actual_reservations,
      COALESCE((latest.predictions->>'confidence')::float, 0.0) AS confidence,
      latest.model_version,
      ((latest.predictions->>'yhat')::int - rd.actual_revenue) AS error,
      CASE
        WHEN rd.actual_revenue > 0
        THEN ABS(((latest.predictions->>'yhat')::float - rd.actual_revenue) / rd.actual_revenue) * 100
        ELSE NULL
      END AS mape
    FROM latest
    JOIN revenue_daily rd ON rd.date = latest.forecast_date
    WHERE rd.actual_revenue IS NOT NULL
    ORDER BY latest.forecast_date ASC
  `, [days]);
}

async function loadUpcomingForecasts() {
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
      COALESCE((latest.predictions->>'confidence')::float, 0.0) AS confidence
    FROM latest
    ORDER BY latest.forecast_date ASC
    LIMIT 7
  `);
}

function weekKey(value) {
  const date = new Date(value);
  const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function weekdayKo(value) {
  return ['일', '월', '화', '수', '목', '금', '토'][new Date(value).getDay()];
}

function buildWeeklySummary(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const key = weekKey(row.date);
    if (!buckets.has(key)) {
      buckets.set(key, {
        week: key,
        actualRevenue: 0,
        predictedRevenue: 0,
        totalError: 0,
        mapes: [],
        hit20: 0,
        days: 0,
      });
    }
    const item = buckets.get(key);
    item.actualRevenue += Number(row.actual_revenue || 0);
    item.predictedRevenue += Number(row.predicted_revenue || 0);
    item.totalError += Number(row.error || 0);
    if (row.mape != null) {
      item.mapes.push(Number(row.mape));
      if (Number(row.mape) <= 20) item.hit20 += 1;
    }
    item.days += 1;
  }

  return Array.from(buckets.values()).map(item => ({
    week: item.week,
    actualRevenue: item.actualRevenue,
    predictedRevenue: item.predictedRevenue,
    bias: item.totalError,
    avgMape: item.mapes.length
      ? Number((item.mapes.reduce((sum, value) => sum + value, 0) / item.mapes.length).toFixed(2))
      : null,
    hitRate20: rate(item.hit20, item.mapes.length),
    days: item.days,
  })).sort((a, b) => a.week.localeCompare(b.week));
}

function buildWeekdayBias(rows) {
  const buckets = new Map();
  for (const row of rows) {
    if (row.mape == null) continue;
    const key = weekdayKo(row.date);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return Array.from(buckets.entries()).map(([weekday, items]) => ({
    weekday,
    avgMape: Number((items.reduce((sum, item) => sum + Number(item.mape || 0), 0) / items.length).toFixed(2)),
    avgBias: Math.round(items.reduce((sum, item) => sum + Number(item.error || 0), 0) / items.length),
    count: items.length,
  })).sort((a, b) => b.avgMape - a.avgMape);
}

function buildUpcomingRisk(upcomingRows) {
  return upcomingRows
    .map(row => ({
      date: toDateString(row.date),
      predictedRevenue: Number(row.predicted_revenue || 0),
      predictedReservations: Number(row.predicted_reservations || 0),
      confidence: Number(row.confidence || 0),
    }))
    .sort((a, b) => a.confidence - b.confidence || b.predictedRevenue - a.predictedRevenue)
    .slice(0, 3);
}

function buildRecommendations(weekly, weekdayBias, upcomingRisk) {
  const lines = [];
  const recent = weekly[weekly.length - 1];
  const prev = weekly[weekly.length - 2];

  if (recent) {
    if (recent.avgMape != null && recent.avgMape >= 20) {
      lines.push(`- 최근 주간 평균 MAPE가 ${recent.avgMape}%라서 예측 엔진 보정이 시급합니다.`);
    } else if (recent.avgMape != null && recent.avgMape >= WEEKLY_REVIEW_CONFIG.avgMapeNotice) {
      lines.push(`- 최근 주간 평균 MAPE ${recent.avgMape}%로, 다음 주 보정 실험을 해볼 만합니다.`);
    }
    if (Math.abs(recent.bias) >= WEEKLY_REVIEW_CONFIG.avgBiasWarn) {
      lines.push(`- 최근 주간 편향이 ${biasLabel(recent.bias)} 수준이라 주간 가산/감산 로직을 점검하는 게 좋습니다.`);
    }
  }

  if (recent && prev && recent.avgMape != null && prev.avgMape != null && recent.avgMape > prev.avgMape + 5) {
    lines.push(`- 전주 대비 MAPE가 ${prev.avgMape}% → ${recent.avgMape}%로 악화되어, 최근 데이터/환경 변수 품질을 다시 점검해야 합니다.`);
  }

  if (weekdayBias[0] && weekdayBias[0].avgMape >= WEEKLY_REVIEW_CONFIG.weekdayMapeWarn) {
    lines.push(`- ${weekdayBias[0].weekday}요일 편향이 커서 요일별 보정 계수를 우선 손보는 게 좋습니다.`);
  }

  if (upcomingRisk[0] && upcomingRisk[0].confidence < WEEKLY_REVIEW_CONFIG.confidenceWarn) {
    lines.push(`- ${upcomingRisk[0].date} 예측 확신도가 ${(upcomingRisk[0].confidence * 100).toFixed(0)}%라 수동 검토 우선순위를 올리는 게 좋습니다.`);
  }

  return lines.slice(0, 4);
}

async function main() {
  const { days, json } = parseArgs();
  const [rows, upcomingRows] = await Promise.all([
    loadRows(days),
    loadUpcomingForecasts(WEEKLY_REVIEW_CONFIG.upcomingDays),
  ]);

  const weekly = buildWeeklySummary(rows);
  const weekdayBias = buildWeekdayBias(rows);
  const upcomingRisk = buildUpcomingRisk(upcomingRows);
  const recommendations = buildRecommendations(weekly, weekdayBias, upcomingRisk);

  const report = {
    periodDays: days,
    weekly,
    weekdayBias,
    upcomingRisk,
    recommendations,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push(`📈 스카 매출 예측 주간 리뷰 (${days}일)`);

  if (weekly.length) {
    lines.push('');
    lines.push('주간 추세:');
    for (const row of weekly.slice(-6)) {
      lines.push(`- ${row.week}: 실매출 ${fmt(row.actualRevenue)}원 / 예측 ${fmt(row.predictedRevenue)}원 / 평균 MAPE ${row.avgMape == null ? 'N/A' : `${row.avgMape}%`} / 20% 적중률 ${row.hitRate20}%`);
    }
  }

  if (weekdayBias.length) {
    lines.push('');
    lines.push('요일 편향:');
    for (const row of weekdayBias.slice(0, 4)) {
      lines.push(`- ${row.weekday}요일: 평균 MAPE ${row.avgMape}% / ${biasLabel(row.avgBias)} / ${row.count}건`);
    }
  }

  if (upcomingRisk.length) {
    lines.push('');
    lines.push('다음 주 위험일:');
    for (const row of upcomingRisk) {
      lines.push(`- ${row.date}: ${fmt(row.predictedRevenue)}원 / ${fmt(row.predictedReservations)}건 / 확신도 ${(row.confidence * 100).toFixed(0)}%`);
    }
  }

  lines.push('');
  lines.push('추천:');
  for (const item of recommendations) lines.push(item);

  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
