'use strict';

/**
 * scripts/audit-duplicate-slots.ts
 *
 * 목적:
 *   - reservation duplicate slot group을 운영자가 직접 검토할 수 있도록 상세 분류한다.
 *   - health-report는 count/summary만 보여주고, 이 스크립트는 실제 row detail과 조치 우선순위를 보여준다.
 *
 * 사용:
 *   node dist/ts-runtime/bots/reservation/scripts/audit-duplicate-slots.js
 *   node dist/ts-runtime/bots/reservation/scripts/audit-duplicate-slots.js --json
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { buildReservationCliInsight } = require('../lib/cli-insight');

type ReservationRow = {
  id: number;
  phone: string;
  date: string;
  start_time: string;
  end_time: string;
  room: string;
  status: string;
  pickko_status: string;
  updated_at: string | null;
  composite_key: string | null;
};

type DuplicateGroup = {
  phone: string;
  date: string;
  start_time: string;
  end_time: string;
  room: string;
  row_count: number;
  rows: ReservationRow[];
  classification?: GroupClassification;
};

type GroupClassification = {
  severity: 'risky' | 'historical' | 'unknown';
  reason: string;
  recommendedAction: string;
};

function normalizeStatus(value) {
  return String(value || '').trim() || 'unknown';
}

function classifyGroup(group: DuplicateGroup): GroupClassification {
  const statuses = (group.rows || []).map((row) => normalizeStatus(row.status));
  const activeRows = group.rows.filter((row) => normalizeStatus(row.status) !== 'cancelled');
  const cancelledRows = group.rows.filter((row) => normalizeStatus(row.status) === 'cancelled');
  const activeCount = activeRows.length;

  if (activeCount > 1) {
    return {
      severity: 'risky',
      reason: `non-cancelled row ${activeCount}건`,
      recommendedAction: '운영 화면 기준 canonical row 1건만 남기고 나머지 상태 정합성 복구 필요',
    };
  }

  if (activeCount === 0) {
    return {
      severity: 'historical',
      reason: 'cancelled + cancelled 잔여 이력',
      recommendedAction: '즉시 정리 불필요, 장기 cleanup 후보로만 유지',
    };
  }

  if (activeCount === 1 && cancelledRows.length >= 1) {
    const hasCompleted = statuses.includes('completed');
    return {
      severity: 'historical',
      reason: hasCompleted ? 'completed + cancelled 과거 재예약/취소 이력' : 'active + cancelled 이력',
      recommendedAction: '즉시 정리 불필요, historical audit 대상으로 유지',
    };
  }

  return {
    severity: 'unknown',
    reason: '자동 분류 불가',
    recommendedAction: '운영 화면과 DB를 함께 확인',
  };
}

function formatGroupLine(group: DuplicateGroup): string {
  const ids = group.rows.map((row) => row.id).join(', ');
  const statuses = group.rows.map((row) => `${normalizeStatus(row.status)}/${normalizeStatus(row.pickko_status)}`).join(', ');
  return [
    `${group.date} ${group.start_time}~${group.end_time} ${group.room} ${group.phone}`,
    `  분류: ${group.classification.severity} (${group.classification.reason})`,
    `  row ids: ${ids}`,
    `  statuses: ${statuses}`,
    `  권장 조치: ${group.classification.recommendedAction}`,
  ].join('\n');
}

async function loadDuplicateGroups() {
  const groups = await pgPool.query('reservation', `
    SELECT
      phone,
      date,
      start_time,
      end_time,
      room,
      COUNT(*) AS row_count
    FROM reservations
    WHERE seen_only = 0
      AND phone IS NOT NULL
      AND date IS NOT NULL
      AND start_time IS NOT NULL
      AND room IS NOT NULL
    GROUP BY phone, date, start_time, end_time, room
    HAVING COUNT(*) > 1
    ORDER BY date DESC, start_time DESC
    LIMIT 100
  `);

  const detailed = [];
  for (const group of groups) {
    const rows = await pgPool.query('reservation', `
      SELECT
        id,
        phone,
        date,
        start_time,
        end_time,
        room,
        status,
        pickko_status,
        updated_at,
        composite_key
      FROM reservations
      WHERE seen_only = 0
        AND phone = $1
        AND date = $2
        AND start_time = $3
        AND end_time = $4
        AND room = $5
      ORDER BY updated_at DESC NULLS LAST, id DESC
    `, [group.phone, group.date, group.start_time, group.end_time, group.room]);

    const normalizedGroup: DuplicateGroup = {
      phone: group.phone,
      date: group.date,
      start_time: group.start_time,
      end_time: group.end_time,
      room: group.room,
      row_count: Number(group.row_count || 0),
      rows,
    };
    normalizedGroup.classification = classifyGroup(normalizedGroup);
    detailed.push(normalizedGroup);
  }

  return detailed;
}

function buildReport(groups) {
  const risky = groups.filter((group) => group.classification.severity === 'risky');
  const historical = groups.filter((group) => group.classification.severity === 'historical');
  const unknown = groups.filter((group) => group.classification.severity === 'unknown');

  return {
    generatedAt: new Date().toISOString(),
    totalGroups: groups.length,
    riskyCount: risky.length,
    historicalCount: historical.length,
    unknownCount: unknown.length,
    risky,
    historical,
    unknown,
  };
}

function printText(report) {
  console.log('=== reservation duplicate slot audit ===');
  console.log(`generatedAt: ${report.generatedAt}`);
  console.log(`totalGroups: ${report.totalGroups}`);
  console.log(`riskyCount: ${report.riskyCount}`);
  console.log(`historicalCount: ${report.historicalCount}`);
  console.log(`unknownCount: ${report.unknownCount}`);
  if (report.aiSummary) {
    console.log(`🔍 AI: ${report.aiSummary}`);
  }
  console.log('');

  if (report.risky.length === 0) {
    console.log('[risky] 없음');
  } else {
    console.log('[risky]');
    for (const group of report.risky) {
      console.log(formatGroupLine(group));
      console.log('');
    }
  }

  if (report.historical.length === 0) {
    console.log('[historical] 없음');
  } else {
    console.log('[historical]');
    for (const group of report.historical) {
      console.log(formatGroupLine(group));
      console.log('');
    }
  }

  if (report.unknown.length > 0) {
    console.log('[unknown]');
    for (const group of report.unknown) {
      console.log(formatGroupLine(group));
      console.log('');
    }
  }
}

async function main() {
  const jsonMode = process.argv.includes('--json');
  const groups = await loadDuplicateGroups();
  const report = buildReport(groups);
  report.aiSummary = await buildReservationCliInsight({
    bot: 'audit-duplicate-slots',
    requestType: 'duplicate-slot-audit',
    title: '예약 duplicate slot audit 결과',
    data: {
      totalGroups: report.totalGroups,
      riskyCount: report.riskyCount,
      historicalCount: report.historicalCount,
      unknownCount: report.unknownCount,
    },
    fallback: report.riskyCount > 0
      ? `중복 슬롯 위험군 ${report.riskyCount}건이 있어 canonical row 정리가 우선입니다.`
      : report.totalGroups > 0
        ? `현재 중복 슬롯은 주로 historical 이력이라 즉시 복구보다 관찰 유지가 적절합니다.`
        : '중복 슬롯 위험군이 없어 예약 정합성은 비교적 안정적입니다.',
  });

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printText(report);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[audit-duplicate-slots] 실패:', message);
  process.exit(1);
});
