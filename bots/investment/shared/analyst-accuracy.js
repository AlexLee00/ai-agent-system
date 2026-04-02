'use strict';

/**
 * bots/investment/shared/analyst-accuracy.js — 분석팀 정확도 추적
 *
 * trade_review 테이블의 aria_accurate, sophia_accurate 등을 집계하여
 * 봇별 주간 정확도를 계산하고 가중치 조정 제안을 생성.
 *
 * 가중치 조정 규칙 (전략문서):
 *   주간 정확도 70%+  → 가중치 +0.05 (최대 0.40)
 *   주간 정확도 50-70% → 유지
 *   주간 정확도 50% 미만 → 가중치 -0.05 (최소 0.05)
 *   3주 연속 50% 미만 → 마스터 알림 + 봇 역할 재검토
 *
 * DB: PostgreSQL (investment 스키마 trade_review 테이블)
 *
 * 사용법: (ESM — bots/investment/는 type:module)
 *   import { buildAccuracyReport } from './analyst-accuracy.js';
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pgPool  = require('../../../packages/core/lib/pg-pool');
const kst     = require('../../../packages/core/lib/kst');
const { getAgentsByTeam } = require('../../../packages/core/lib/agent-registry');

const SCHEMA = 'investment';

// ── 분석팀 봇 정의 ─────────────────────────────────────────────────────
const ANALYSTS = [
  { name: 'aria',   label: '아리아',   column: 'aria_accurate',   role: '기술분석',  defaultWeight: 0.30 },
  { name: 'sophia', label: '소피아',   column: 'sophia_accurate', role: '감성분석',  defaultWeight: 0.25 },
  { name: 'oracle', label: '오라클',   column: 'oracle_accurate', role: '온체인',    defaultWeight: 0.30 },
  { name: 'hermes', label: '헤르메스', column: 'hermes_accurate', role: '뉴스분석',  defaultWeight: 0.15 },
];

const WEIGHT_MAX = 0.40;
const WEIGHT_MIN = 0.05;
const WEIGHT_STEP = 0.05;

const THRESHOLD_HIGH = 0.70;  // 70%+ → 가중치 증가
const THRESHOLD_LOW  = 0.50;  // 50%- → 가중치 감소

function _jsonbAnalystKey(botName) {
  if (botName === 'sophia' || botName === 'hermes') return 'sentinel';
  return botName;
}

function _fallbackAnalystMeta(botName) {
  return ANALYSTS.find((a) => a.name === botName) || null;
}

async function getActiveAnalysts() {
  const agents = await getAgentsByTeam('luna');
  const active = agents.filter((agent) =>
    agent.status !== 'archived'
      && ['leader', 'analyst', 'risk', 'executor', 'debater'].includes(agent.role),
  );
  if (active.length === 0) return ANALYSTS;

  const analystPool = active.filter((agent) => agent.name !== 'luna');
  const defaultWeight = analystPool.length > 0 ? _round2(1 / analystPool.length) : 0;
  return analystPool.map((agent) => {
    const fallback = _fallbackAnalystMeta(agent.name);
    return {
      name: agent.name,
      label: agent.display_name || fallback?.label || agent.name,
      role: agent.specialty || fallback?.role || agent.role,
      column: fallback?.column || null,
      defaultWeight: fallback?.defaultWeight ?? defaultWeight,
    };
  });
}

// ── 헬퍼 ──────────────────────────────────────────────────────────────

function _weekCutoff(weeksAgo = 0) {
  const startOfTodayKst = new Date(`${kst.today()}T00:00:00+09:00`);
  const kstDay = startOfTodayKst.getUTCDay();
  return startOfTodayKst.getTime() - (weeksAgo * 7 + kstDay) * 86400000;
}

function _clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function _round2(n) {
  return Math.round(n * 100) / 100;
}

// ── 주간 정확도 조회 ──────────────────────────────────────────────────

/**
 * 특정 봇의 주간 정확도 조회
 * @param {string} botName   'aria'|'sophia'|'oracle'|'hermes'
 * @param {number} weeks     조회할 주 수 (1 = 이번 주)
 * @returns {Promise<{total, accurate, rate, weeks}>}
 */
async function getWeeklyAccuracy(botName, weeks = 1) {
  const analyst = _fallbackAnalystMeta(botName);

  const cutoff = _weekCutoff(weeks - 1);
  const col    = analyst?.column || null;
  const jsonbKey = _jsonbAnalystKey(botName);

  const jsonbRow = await pgPool.get(SCHEMA, `
    SELECT
      COUNT(*) FILTER (WHERE (analyst_accuracy->>$1) IS NOT NULL) AS total,
      COUNT(*) FILTER (WHERE (analyst_accuracy->>$1)::boolean = true) AS accurate
    FROM trade_review
    WHERE reviewed_at > $2
      AND analyst_accuracy != '{}'::jsonb
  `, [jsonbKey, cutoff]);

  const jsonbTotal = Number(jsonbRow?.total ?? 0);
  if (jsonbTotal > 0) {
    const accurate = Number(jsonbRow?.accurate ?? 0);
    return {
      botName,
      total: jsonbTotal,
      accurate,
      rate: jsonbTotal > 0 ? accurate / jsonbTotal : null,
      weeks,
    };
  }

  if (!col) {
    return { botName, total: 0, accurate: 0, rate: null, weeks };
  }

  const row = await pgPool.get(SCHEMA, `
    SELECT
      COUNT(*)                                    AS total,
      SUM(CASE WHEN ${col} = true THEN 1 ELSE 0 END) AS accurate
    FROM trade_review
    WHERE reviewed_at > $1
      AND ${col} IS NOT NULL
  `, [cutoff]);

  const total    = Number(row?.total    ?? 0);
  const accurate = Number(row?.accurate ?? 0);
  const rate     = total > 0 ? accurate / total : null;

  return { botName, total, accurate, rate, weeks };
}

/**
 * 최근 N주 주별 정확도 배열 반환
 * @param {string} botName
 * @param {number} nWeeks
 * @returns {Promise<Array<{week, total, accurate, rate}>>}
 */
async function getWeeklyAccuracyHistory(botName, nWeeks = 4) {
  const analyst = _fallbackAnalystMeta(botName);

  const col = analyst?.column || null;
  const jsonbKey = _jsonbAnalystKey(botName);
  const results = [];

  for (let w = 1; w <= nWeeks; w++) {
    const from = _weekCutoff(w - 1);
    const to   = _weekCutoff(w - 2);

    const jsonbWhereClause = w === 1
      ? `WHERE reviewed_at > $1 AND (analyst_accuracy->>$2) IS NOT NULL`
      : `WHERE reviewed_at > $1 AND reviewed_at <= $2 AND (analyst_accuracy->>$3) IS NOT NULL`;
    const jsonbParams = w === 1 ? [from, jsonbKey] : [from, to, jsonbKey];
    const jsonbRow = await pgPool.get(SCHEMA, `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE (${w === 1 ? "analyst_accuracy->>$2" : "analyst_accuracy->>$3"})::boolean = true) AS accurate
      FROM trade_review
      ${jsonbWhereClause}
    `, jsonbParams);

    const jsonbTotal = Number(jsonbRow?.total ?? 0);
    if (jsonbTotal > 0) {
      const accurate = Number(jsonbRow?.accurate ?? 0);
      results.push({
        week: w,
        total: jsonbTotal,
        accurate,
        rate: jsonbTotal > 0 ? accurate / jsonbTotal : null,
      });
      continue;
    }

    if (!col) {
      results.push({ week: w, total: 0, accurate: 0, rate: null });
      continue;
    }

    let whereClause;
    let params;
    if (w === 1) {
      whereClause = `WHERE reviewed_at > $1 AND ${col} IS NOT NULL`;
      params      = [from];
    } else {
      whereClause = `WHERE reviewed_at > $1 AND reviewed_at <= $2 AND ${col} IS NOT NULL`;
      params      = [from, to];
    }

    const row = await pgPool.get(SCHEMA, `
      SELECT
        COUNT(*)                                        AS total,
        SUM(CASE WHEN ${col} = true THEN 1 ELSE 0 END) AS accurate
      FROM trade_review
      ${whereClause}
    `, params);

    const total    = Number(row?.total    ?? 0);
    const accurate = Number(row?.accurate ?? 0);
    const rate     = total > 0 ? accurate / total : null;

    results.push({ week: w, total, accurate, rate });
  }

  return results;
}

// ── 가중치 조정 계산 ──────────────────────────────────────────────────

/**
 * 정확도 기반 가중치 조정 제안
 * @param {string} botName
 * @param {number} currentWeight   현재 가중치 (0.05 ~ 0.40)
 * @returns {Promise<object>}      조정 제안
 */
async function calculateWeightAdjustment(botName, currentWeight) {
  const { total, accurate, rate } = await getWeeklyAccuracy(botName, 1);

  if (total < 5 || rate === null) {
    return {
      botName,
      accuracy:        null,
      currentWeight,
      suggestedWeight: currentWeight,
      action:          'insufficient_data',
      reason:          `샘플 부족 (${total}건 < 5건)`,
    };
  }

  let action;
  let suggestedWeight;

  if (rate >= THRESHOLD_HIGH) {
    suggestedWeight = _round2(_clamp(currentWeight + WEIGHT_STEP, WEIGHT_MIN, WEIGHT_MAX));
    action = suggestedWeight > currentWeight ? 'increase' : 'maintain';
  } else if (rate < THRESHOLD_LOW) {
    suggestedWeight = _round2(_clamp(currentWeight - WEIGHT_STEP, WEIGHT_MIN, WEIGHT_MAX));
    action = suggestedWeight < currentWeight ? 'decrease' : 'maintain';
  } else {
    suggestedWeight = currentWeight;
    action          = 'maintain';
  }

  // 3주 연속 50% 미만 확인
  const history     = await getWeeklyAccuracyHistory(botName, 3);
  const consecutive = history.filter(h => h.rate !== null && h.rate < THRESHOLD_LOW).length;
  const needsReview = consecutive >= 3;

  return {
    botName,
    accuracy:        rate,
    accuracyPct:     (rate * 100).toFixed(1) + '%',
    sampleCount:     total,
    currentWeight,
    suggestedWeight,
    action,
    needsReview,
    consecutiveLow:  consecutive,
    reason:          action === 'increase'
      ? `정확도 ${(rate * 100).toFixed(1)}% ≥ 70% → 가중치 +${WEIGHT_STEP}`
      : action === 'decrease'
        ? `정확도 ${(rate * 100).toFixed(1)}% < 50% → 가중치 -${WEIGHT_STEP}`
        : `정확도 ${(rate * 100).toFixed(1)}% 유지 구간`,
  };
}

// ── 전체 리포트 ───────────────────────────────────────────────────────

/**
 * 분석팀 주간 성적표 + 가중치 조정 제안 리포트
 * @param {object} currentWeights  { aria: 0.25, sophia: 0.20, ... }
 * @returns {Promise<{text: string, adjustments: Array}>}
 */
async function buildAccuracyReport(currentWeights = {}) {
  const analysts = await getActiveAnalysts();
  const adjustments = [];
  const lines = [
    '📊 분석팀 주간 성적표',
    '════════════════════════',
  ];

  for (const analyst of analysts) {
    const w    = currentWeights[analyst.name] ?? analyst.defaultWeight;
    const adj  = await calculateWeightAdjustment(analyst.name, w);
    adjustments.push(adj);

    const icon = adj.action === 'increase' ? '▲' : adj.action === 'decrease' ? '▼' : '━';
    const accStr = adj.accuracy !== null
      ? `${adj.accuracyPct} (n=${adj.sampleCount})`
      : `데이터 없음 (n=${adj.sampleCount ?? 0})`;

    let line = `${analyst.label}(${analyst.role}): ${accStr} ${icon} → 가중치 ${adj.currentWeight}`;
    if (adj.suggestedWeight !== adj.currentWeight) {
      line += ` → ${adj.suggestedWeight} 제안`;
    } else {
      line += ' 유지';
    }
    if (adj.needsReview) {
      line += ' ⚠️';
    }
    lines.push(line);
  }

  // 경고 항목
  const lowPerformers = adjustments.filter(a => a.needsReview);
  if (lowPerformers.length > 0) {
    lines.push('');
    for (const lp of lowPerformers) {
      const analyst = analysts.find(a => a.name === lp.botName);
      lines.push(`⚠️ ${analyst?.label ?? lp.botName} 3주 연속 50% 미만 — 역할 재검토 필요`);
    }
  }

  // 가중치 합계 확인
  const suggestedWeights = Object.fromEntries(
    adjustments.map(a => [a.botName, a.suggestedWeight])
  );
  const totalWeight = Object.values(suggestedWeights).reduce((s, v) => s + v, 0);
  if (Math.abs(totalWeight - 1.0) > 0.001) {
    lines.push('');
    lines.push(`⚠️ 가중치 합계: ${_round2(totalWeight)} (1.0이 아님 — 정규화 필요)`);
  }

  return {
    text:             lines.join('\n'),
    adjustments,
    suggestedWeights,
    totalWeight:      _round2(totalWeight),
  };
}

/**
 * 가중치 정규화 (합계를 1.0으로 맞춤)
 * @param {object} weights  { aria: 0.30, sophia: 0.20, ... }
 * @returns {object}        정규화된 가중치
 */
function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  if (total === 0) return weights;
  return Object.fromEntries(
    Object.entries(weights).map(([k, v]) => [k, _round2(v / total)])
  );
}

export {
  ANALYSTS,
  getActiveAnalysts,
  getWeeklyAccuracy,
  getWeeklyAccuracyHistory,
  calculateWeightAdjustment,
  buildAccuracyReport,
  normalizeWeights,
};
