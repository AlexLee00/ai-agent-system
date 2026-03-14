'use strict';

const { getPromotionSummary } = require('./intent-store');

async function getPromotionPendingHealth(pgPool, {
  schema,
  pendingWarnThreshold = 5,
  initialDetail = '  인텐트 후보 테이블 없음 (초기 상태)',
  missingReason = '인텐트 후보 상태 조회에 실패했습니다.',
} = {}) {
  try {
    const summary = await getPromotionSummary(pgPool, { schema, filters: {} });
    const pendingCount = Number(summary?.pending_count || 0);
    const appliedCount = Number(summary?.applied_count || 0);
    const hasWarn = pendingCount >= pendingWarnThreshold;
    return {
      pendingCount,
      appliedCount,
      hasWarn,
      detail: `  인텐트 후보 pending ${pendingCount}건 / applied ${appliedCount}건`,
      reasons: hasWarn ? [`${schema} 인텐트 후보가 ${pendingCount}건 쌓여 있어 학습 검토가 필요합니다.`] : [],
    };
  } catch (error) {
    if (/does not exist/i.test(String(error.message || ''))) {
      return {
        pendingCount: 0,
        appliedCount: 0,
        hasWarn: false,
        detail: initialDetail,
        reasons: [],
      };
    }
    return {
      pendingCount: 0,
      appliedCount: 0,
      hasWarn: true,
      detail: `  인텐트 후보 조회 실패: ${error.message}`,
      reasons: [missingReason],
    };
  }
}

async function getPendingCommandHealth(pgPool, {
  dbName,
  table = 'bot_commands',
  toBot,
  pendingWarnThreshold = 3,
  ageWarnThresholdMinutes = 15,
  failureReason = 'pending 명령 상태 조회에 실패했습니다.',
} = {}) {
  try {
    const row = await pgPool.get(dbName, `
      SELECT
        COUNT(*)::int AS pending_count,
        COALESCE(
          MAX(EXTRACT(EPOCH FROM (NOW() - NULLIF(created_at, '')::timestamp)) / 60),
          0
        )::float AS oldest_minutes
      FROM ${table}
      WHERE to_bot = $1 AND status = 'pending'
    `, [toBot]);
    const pendingCount = Number(row?.pending_count || 0);
    const oldestMinutes = Math.round(Number(row?.oldest_minutes || 0));
    const hasWarn = pendingCount >= pendingWarnThreshold || oldestMinutes >= ageWarnThresholdMinutes;
    return {
      pendingCount,
      oldestMinutes,
      hasWarn,
      detail: `  pending 명령 ${pendingCount}건 / oldest ${oldestMinutes}분`,
      reasons: hasWarn ? [`${toBot} pending 명령 ${pendingCount}건이 ${oldestMinutes}분 이상 밀려 있습니다.`] : [],
    };
  } catch (error) {
    return {
      pendingCount: 0,
      oldestMinutes: 0,
      hasWarn: true,
      detail: `  pending 명령 조회 실패: ${error.message}`,
      reasons: [failureReason],
    };
  }
}

module.exports = {
  getPromotionPendingHealth,
  getPendingCommandHealth,
};
