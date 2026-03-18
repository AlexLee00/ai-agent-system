#!/usr/bin/env node
'use strict';

const pgPool = require('../../packages/core/lib/pg-pool');
const { getSkaReviewConfig, getSkaForecastConfig } = require('../../bots/ska/lib/runtime-config.js');
const DAILY_REVIEW_CONFIG = getSkaReviewConfig().daily;
const FORECAST_CONFIG = getSkaForecastConfig();

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find(arg => arg.startsWith('--days='));
  const days = Math.max(DAILY_REVIEW_CONFIG.minDays, Number(daysArg?.split('=')[1] || DAILY_REVIEW_CONFIG.defaultDays));
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
      (latest.predictions->>'shadow_yhat')::int AS shadow_predicted_revenue,
      COALESCE((latest.predictions->>'shadow_confidence')::float, 0.0) AS shadow_confidence,
      latest.predictions->>'shadow_model_name' AS shadow_model_name,
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

function buildShadowComparison(rows) {
  const valid = rows.filter(row => row.mape != null && row.shadow_predicted_revenue != null);
  if (!valid.length) {
    return {
      availableDays: 0,
      shadowModelName: FORECAST_CONFIG.shadowModelName,
      primaryAvgMape: null,
      shadowAvgMape: null,
      avgMapeGap: null,
      betterModel: null,
    };
  }

  const primaryAvgMape = Number((valid.reduce((sum, row) => sum + Number(row.mape || 0), 0) / valid.length).toFixed(2));
  const shadowAvgMape = Number((valid.reduce((sum, row) => {
    if (!row.actual_revenue) return sum;
    return sum + (Math.abs(Number(row.shadow_predicted_revenue || 0) - Number(row.actual_revenue || 0)) / Number(row.actual_revenue || 1) * 100);
  }, 0) / valid.length).toFixed(2));
  const avgMapeGap = Number((shadowAvgMape - primaryAvgMape).toFixed(2));

  return {
    availableDays: valid.length,
    shadowModelName: valid[0].shadow_model_name || FORECAST_CONFIG.shadowModelName,
    primaryAvgMape,
    shadowAvgMape,
    avgMapeGap,
    betterModel: avgMapeGap < 0 ? 'shadow' : 'primary',
  };
}

function buildShadowDecision(shadowComparison) {
  const requiredDays = 3;
  const gapThreshold = Number(FORECAST_CONFIG.shadowPromotionMapeGap || 0);

  if (shadowComparison.availableDays < requiredDays) {
    return {
      stage: 'collecting',
      label: '데이터 수집 단계',
      requiredDays,
      gapThreshold,
      recommendation: 'actual 누적 후 비교 유지',
      reason: `shadow actual 비교일이 ${shadowComparison.availableDays}일이라 최소 ${requiredDays}일 누적이 더 필요합니다.`,
    };
  }

  if (shadowComparison.avgMapeGap <= -gapThreshold) {
    return {
      stage: 'promotion_candidate',
      label: '앙상블 편입 후보',
      requiredDays,
      gapThreshold,
      recommendation: '다음 운영 사이클에서 앙상블 실험 검토',
      reason: `shadow 평균 MAPE가 기존 대비 ${Math.abs(shadowComparison.avgMapeGap)}%p 개선되었습니다.`,
    };
  }

  if (shadowComparison.avgMapeGap >= gapThreshold) {
    return {
      stage: 'primary_hold',
      label: '기존 엔진 유지',
      requiredDays,
      gapThreshold,
      recommendation: 'shadow 비교만 유지',
      reason: `shadow 평균 MAPE가 기존보다 ${shadowComparison.avgMapeGap}%p 높습니다.`,
    };
  }

  return {
    stage: 'observe',
    label: '비교 관찰 단계',
    requiredDays,
    gapThreshold,
    recommendation: '추가 데이터 관찰',
    reason: `평균 MAPE 차이 ${shadowComparison.avgMapeGap}%p로 승격 판단 기준(${gapThreshold}%p)에 아직 못 미칩니다.`,
  };
}

function buildRecommendations(summary, latest, shadowComparison, shadowDecision) {
  const lines = [];
  if (summary.avgMape == null) {
    return ['- 아직 정확도 누적 데이터가 부족합니다.'];
  }
  if (summary.avgMape >= DAILY_REVIEW_CONFIG.avgMapeWarn) {
    lines.push(`- 최근 평균 MAPE가 ${summary.avgMape}%로 높아 예측 엔진 보정이 필요합니다.`);
  } else if (summary.avgMape >= DAILY_REVIEW_CONFIG.avgMapeNotice) {
    lines.push(`- 최근 평균 MAPE가 ${summary.avgMape}%라서 중간 수준 튜닝 후보입니다.`);
  } else {
    lines.push(`- 최근 평균 MAPE ${summary.avgMape}%로 비교적 안정적입니다.`);
  }

  if (summary.avgBias <= -DAILY_REVIEW_CONFIG.avgBiasWarn) {
    lines.push('- 전반적으로 과소예측 성향이 있어 예약 선행지표 가중치를 조금 키우는 쪽이 좋습니다.');
  } else if (summary.avgBias >= DAILY_REVIEW_CONFIG.avgBiasWarn) {
    lines.push('- 전반적으로 과대예측 성향이 있어 피크일 가산치나 상한 보정을 줄이는 게 좋습니다.');
  }

  if (summary.hitRate20 < DAILY_REVIEW_CONFIG.hitRate20Warn) {
    lines.push(`- 20% 이내 적중률이 ${summary.hitRate20}%로 낮아 요일/환경 변수 가중치 재점검이 필요합니다.`);
  }

  if (summary.avgReservationGap >= DAILY_REVIEW_CONFIG.avgReservationGapWarn) {
    lines.push(`- 예약건수 오차 평균이 ${summary.avgReservationGap}건이라 예약 선행지표 보정이 필요해 보입니다.`);
  }

  if (latest && latest.confidence != null && Number(latest.confidence) < DAILY_REVIEW_CONFIG.confidenceWarn) {
    lines.push(`- 최신 예측 확신도가 ${(Number(latest.confidence) * 100).toFixed(0)}%로 낮아 수동 검토 우선순위를 올리는 게 좋습니다.`);
  }

  if (shadowDecision.stage === 'collecting') {
    lines.push(`- shadow 모델(${shadowComparison.shadowModelName})은 아직 ${shadowComparison.availableDays}일치만 쌓여 ${shadowDecision.recommendation} 상태입니다.`);
  } else if (shadowComparison.availableDays >= 3) {
    if (shadowComparison.avgMapeGap <= -FORECAST_CONFIG.shadowPromotionMapeGap) {
      lines.push(`- shadow 모델(${shadowComparison.shadowModelName})이 평균 MAPE ${Math.abs(shadowComparison.avgMapeGap)}%p 개선되어 앙상블 편입 후보입니다.`);
    } else if (shadowComparison.avgMapeGap >= FORECAST_CONFIG.shadowPromotionMapeGap) {
      lines.push(`- shadow 모델(${shadowComparison.shadowModelName})은 아직 기존 엔진보다 약해 shadow 비교만 유지하는 게 좋습니다.`);
    } else {
      lines.push(`- shadow 모델(${shadowComparison.shadowModelName})은 비교 관찰 단계이며 추가 데이터 누적이 더 필요합니다.`);
    }
  }

  return lines.slice(0, 4);
}

function buildActionItems(summary, latest, shadowComparison, shadowDecision) {
  const items = [];

  if (summary.avgBias <= -DAILY_REVIEW_CONFIG.avgBiasWarn) {
    items.push('bias_tuning: 과소예측 성향이 커서 예약 선행지표 또는 상향 보정 계수를 점검합니다.');
  } else if (summary.avgBias >= DAILY_REVIEW_CONFIG.avgBiasWarn) {
    items.push('bias_tuning: 과대예측 성향이 커서 피크일 가산치 또는 상한 보정 계수를 점검합니다.');
  }

  if (summary.hitRate20 < DAILY_REVIEW_CONFIG.hitRate20Warn) {
    items.push('weekday_tuning: 20% 이내 적중률이 낮아 요일별 계수와 환경 변수 가중치를 재검토합니다.');
  }

  if (latest && latest.confidence != null && Number(latest.confidence) < DAILY_REVIEW_CONFIG.confidenceWarn) {
    items.push('manual_review: 최신 확신도가 낮아 수동 확인 우선순위를 올립니다.');
  }

  items.push(`shadow_readiness: ${shadowDecision.recommendation}`);
  return items.slice(0, 4);
}

async function main() {
  const { days, json } = parseArgs();
  const [accuracyRows, upcomingRows] = await Promise.all([
    loadAccuracyRows(days),
    loadUpcomingForecasts(DAILY_REVIEW_CONFIG.upcomingDays),
  ]);

  const latestActual = accuracyRows[0] || null;
  const summary = buildSummary(accuracyRows);
  const shadowComparison = buildShadowComparison(accuracyRows);
  const shadowDecision = buildShadowDecision(shadowComparison);
  const recommendations = buildRecommendations(summary, upcomingRows[0] || latestActual, shadowComparison, shadowDecision);

  const report = {
    periodDays: days,
    latestActual: latestActual ? {
      date: toDateString(latestActual.date),
      actualRevenue: Number(latestActual.actual_revenue || 0),
      predictedRevenue: Number(latestActual.predicted_revenue || 0),
      shadowPredictedRevenue: latestActual.shadow_predicted_revenue == null ? null : Number(latestActual.shadow_predicted_revenue),
      shadowConfidence: Number(latestActual.shadow_confidence || 0),
      shadowModelName: latestActual.shadow_model_name || '',
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
    shadowComparison,
    shadowDecision,
    actionItems: buildActionItems(summary, upcomingRows[0] || latestActual, shadowComparison, shadowDecision),
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

  lines.push('');
  lines.push('Shadow 판단:');
  lines.push(`- 단계: ${report.shadowDecision.label}`);
  lines.push(`- 권장: ${report.shadowDecision.recommendation}`);
  lines.push(`- 근거: ${report.shadowDecision.reason}`);

  if (report.shadowComparison.availableDays > 0) {
    lines.push('');
    lines.push('Shadow 비교:');
    lines.push(`- 모델: ${report.shadowComparison.shadowModelName}`);
    lines.push(`- 비교일수: ${report.shadowComparison.availableDays}일`);
    lines.push(`- 기존 평균 MAPE: ${report.shadowComparison.primaryAvgMape}%`);
    lines.push(`- shadow 평균 MAPE: ${report.shadowComparison.shadowAvgMape}%`);
    lines.push(`- 차이(shadow-primary): ${report.shadowComparison.avgMapeGap}%p`);
  }

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

  if (report.actionItems.length) {
    lines.push('');
    lines.push('즉시 조치:');
    for (const item of report.actionItems) lines.push(`- ${item}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
