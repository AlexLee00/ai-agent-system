'use strict';

/**
 * scripts/health-report.js — 스카팀 운영자용 헬스 리포트
 *
 * 목적:
 *   - launchd 서비스 상태와 naver-monitor 로그 활동성을 사람이 읽기 쉽게 요약
 *   - 공용 health-core 포맷을 사용하는 운영 리포트
 *
 * 실행:
 *   node bots/reservation/scripts/health-report.js [--json]
 */

const {
  buildHealthReport,
  buildHealthDecision,
  buildHealthCountSection,
  buildHealthSampleSection,
  buildHealthDecisionSection,
} = require('../../../packages/core/lib/health-core');
const { runHealthCli } = require('../../../packages/core/lib/health-runner');
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
  buildFileActivityHealth,
  buildResolvedWebhookHealth,
} = require('../../../packages/core/lib/health-provider');
const pgPool = require('../../../packages/core/lib/pg-pool');

const CONTINUOUS = ['ai.ska.naver-monitor', 'ai.ska.commander'];
const CORE_SERVICES = [
  'ai.ska.commander',
  'ai.ska.naver-monitor',
  'ai.ska.kiosk-monitor',
  'ai.ska.health-check',
];
const SCHEDULED_SERVICES = [
  'ai.ska.pickko-verify',
  'ai.ska.pickko-daily-audit',
  'ai.ska.pickko-daily-summary',
  'ai.ska.log-report',
  'ai.ska.db-backup',
  'ai.ska.log-rotate',
];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const NAVER_LOG = '/tmp/naver-ops-mode.log';
const LOG_STALE_MS = 15 * 60 * 1000;
const N8N_HEALTH_URL = process.env.N8N_HEALTH_URL || 'http://127.0.0.1:5678/healthz';
const DEFAULT_N8N_WEBHOOK_URL = process.env.SKA_N8N_WEBHOOK_URL || 'http://127.0.0.1:5678/webhook/ska-command';
const CANCEL_COUNTER_DRIFT_TITLE = '🚨 네이버 취소 카운터 증가 이상';

function sumRoomAmounts(roomAmountsJson) {
  if (!roomAmountsJson) return 0;

  let parsed = roomAmountsJson;
  if (typeof roomAmountsJson === 'string') {
    try {
      parsed = JSON.parse(roomAmountsJson);
    } catch (_) {
      return 0;
    }
  }

  if (!parsed || typeof parsed !== 'object') return 0;

  return Object.values(parsed).reduce((sum, value) => sum + Number(value || 0), 0);
}

function buildMonitorHealth() {
  return buildFileActivityHealth({
    label: 'naver-monitor 로그',
    filePath: NAVER_LOG,
    staleMs: LOG_STALE_MS,
    missingText: '  naver-monitor 로그: 파일 없음',
    staleText: (state) => `  naver-monitor 로그: ${state.minutesAgo}분 무활동`,
    okText: (state) => `  naver-monitor 로그: 최근 ${state.minutesAgo}분 이내 활동`,
  });
}

async function buildN8nCommandHealth() {
  return buildResolvedWebhookHealth({
    workflowName: '스카팀 읽기 명령 intake',
    pathSuffix: 'ska-command',
    healthUrl: N8N_HEALTH_URL,
    defaultWebhookUrl: DEFAULT_N8N_WEBHOOK_URL,
    probeBody: {
      command: 'query_today_stats',
      args: { date: new Date().toISOString().slice(0, 10) },
    },
    okLabel: 'ska command webhook',
    warnLabel: 'ska command webhook',
  });
}

async function buildDailySummaryIntegrityHealth() {
  try {
    const todayKst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rows = await pgPool.query('reservation', `
      SELECT date::text, total_amount, room_amounts_json, pickko_study_room, general_revenue
      FROM daily_summary
      ORDER BY date DESC
      LIMIT 400
    `);

    const issues = [];
    for (const row of rows) {
      const date = String(row.date || '').slice(0, 10);
      const roomTotal = sumRoomAmounts(row.room_amounts_json);
      const pickkoStudyRoom = Number(row.pickko_study_room || 0);

      if (date < todayKst && roomTotal > 0 && pickkoStudyRoom <= 0) {
        issues.push(`${date}: room_amounts_json ${roomTotal}원인데 pickko_study_room=0`);
        continue;
      }

      if (roomTotal !== pickkoStudyRoom) {
        issues.push(`${date}: room_amounts_json ${roomTotal}원 != pickko_study_room ${pickkoStudyRoom}원`);
      }
    }

    if (issues.length > 0) {
      return {
        ok: [],
        warn: [
          `  daily_summary 무결성: 경고 ${issues.length}건`,
          ...issues.slice(0, 5).map((line) => `    - ${line}`),
        ],
        issueCount: issues.length,
      };
    }

    return {
      ok: ['  daily_summary 무결성: 스터디룸 산출식과 저장값이 일치'],
      warn: [],
      issueCount: 0,
    };
  } catch (error) {
    return {
      ok: [],
      warn: [`  daily_summary 무결성: 확인 실패 (${error.message})`],
      issueCount: 1,
      policyDivergenceCount: 0,
      policyDivergenceSamples: [],
    };
  }
}

async function buildCancelCounterDriftHealth() {
  try {
    const rows = await pgPool.query('reservation', `
      SELECT timestamp, resolved, title, message, date, start_time
      FROM alerts
      WHERE title = $1
        AND timestamp >= to_char(now() - interval '24 hours', 'YYYY-MM-DD HH24:MI:SS')
      ORDER BY timestamp DESC
      LIMIT 20
    `, [CANCEL_COUNTER_DRIFT_TITLE]);

    const unresolved = rows.filter((row) => Number(row.resolved || 0) === 0);
    const latest = rows[0] || null;
    const samples = rows.slice(0, 3).map((row) => {
      const timestamp = row.timestamp || '시각 미상';
      const message = String(row.message || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      return `  ${timestamp} — ${message || '상세 메시지 없음'}`;
    });

    if (rows.length === 0) {
      return {
        ok: ['  취소 카운터 드리프트: 최근 24시간 경고 없음'],
        warn: [],
        samples: [],
        totalCount: 0,
        unresolvedCount: 0,
        latestTimestamp: null,
      };
    }

    const warn = [
      `  취소 카운터 드리프트: 최근 24시간 ${rows.length}건`,
      `  미해결: ${unresolved.length}건`,
    ];
    if (latest?.timestamp) {
      warn.push(`  최신 감지: ${latest.timestamp}`);
    }

    return {
      ok: [],
      warn,
      samples,
      totalCount: rows.length,
      unresolvedCount: unresolved.length,
      latestTimestamp: latest?.timestamp || null,
    };
  } catch (error) {
    return {
      ok: [],
      warn: [`  취소 카운터 드리프트: 확인 실패 (${error.message})`],
      samples: [],
      totalCount: 0,
      unresolvedCount: 0,
      latestTimestamp: null,
    };
  }
}

async function buildDuplicateSlotHealth() {
  try {
    const rows = await pgPool.query('reservation', `
      SELECT
        phone,
        date,
        start_time,
        room,
        COUNT(*) AS row_count,
        COUNT(*) FILTER (WHERE COALESCE(status, '') <> 'cancelled') AS non_cancelled_count,
        ARRAY_AGG(id ORDER BY updated_at DESC NULLS LAST) AS ids,
        ARRAY_AGG(COALESCE(status, '') ORDER BY updated_at DESC NULLS LAST) AS statuses
      FROM reservations
      WHERE seen_only = 0
        AND phone IS NOT NULL
        AND date IS NOT NULL
        AND start_time IS NOT NULL
        AND room IS NOT NULL
      GROUP BY phone, date, start_time, room
      HAVING COUNT(*) > 1
      ORDER BY date DESC, start_time DESC
      LIMIT 50
    `);

    const risky = rows.filter((row) => Number(row.non_cancelled_count || 0) > 1);
    const historical = rows.filter((row) => Number(row.non_cancelled_count || 0) <= 1);

    if (risky.length === 0) {
      const ok = ['  duplicate slot audit: 위험 group 없음'];
      if (historical.length > 0) {
        ok.push(`  참고: 과거 재예약/취소 이력으로 보이는 historical duplicate ${historical.length}건`);
      }
      return {
        ok,
        warn: [],
        riskyCount: 0,
        historicalCount: historical.length,
        samples: [],
      };
    }

    const samples = risky.slice(0, 3).map((row) => {
      const statuses = Array.isArray(row.statuses) ? row.statuses.join(', ') : String(row.statuses || '');
      return `  ${row.date} ${row.start_time} ${row.room} ${row.phone} — rows=${row.row_count}, active=${row.non_cancelled_count}, statuses=[${statuses}]`;
    });

    return {
      ok: [],
      warn: [
        `  duplicate slot audit: 위험 group ${risky.length}건`,
        `  historical duplicate: ${historical.length}건`,
      ],
      riskyCount: risky.length,
      historicalCount: historical.length,
      samples,
    };
  } catch (error) {
    return {
      ok: [],
      warn: [`  duplicate slot audit: 확인 실패 (${error.message})`],
      riskyCount: 0,
      historicalCount: 0,
      samples: [],
    };
  }
}

function buildDecision(coreServiceRows, monitorHealth, n8nCommandHealth, dailySummaryIntegrityHealth, cancelCounterDriftHealth, duplicateSlotHealth) {
  return buildHealthDecision({
    warnings: [
      {
        active: coreServiceRows.warn.length > 0,
        level: 'high',
        reason: `핵심 스카 서비스 경고 ${coreServiceRows.warn.length}건이 있어 점검이 필요합니다.`,
      },
      {
        active: monitorHealth.warn.length > 0,
        level: 'medium',
        reason: 'naver-monitor 로그 활동성이 멈춰 크래시루프 가능성을 확인해야 합니다.',
      },
      {
        active: !n8nCommandHealth.n8nHealthy,
        level: 'medium',
        reason: 'n8n healthz 응답이 없어 스카 command 노드 경로를 사용할 수 없습니다.',
      },
      {
        active: n8nCommandHealth.n8nHealthy && !n8nCommandHealth.webhookRegistered,
        level: 'medium',
        reason: `n8n은 살아 있지만 ska command webhook이 미등록 상태입니다 (${n8nCommandHealth.webhookReason}).`,
      },
      {
        active: dailySummaryIntegrityHealth.warn.length > 0,
        level: 'medium',
        reason: `daily_summary 저장값 경고 ${dailySummaryIntegrityHealth.warn.length}건이 있어 스카 매출 저장 구조를 점검해야 합니다.`,
      },
      {
        active: cancelCounterDriftHealth.warn.length > 0,
        level: cancelCounterDriftHealth.unresolvedCount > 0 ? 'high' : 'medium',
        reason: cancelCounterDriftHealth.unresolvedCount > 0
          ? `취소 카운터 드리프트 미해결 경고 ${cancelCounterDriftHealth.unresolvedCount}건이 있어 취소 누락을 점검해야 합니다.`
          : `최근 24시간 취소 카운터 드리프트 경고 ${cancelCounterDriftHealth.totalCount}건이 있어 로그/취소 탭 추적이 필요합니다.`,
      },
      {
        active: duplicateSlotHealth.riskyCount > 0,
        level: 'medium',
        reason: `같은 슬롯의 non-cancelled duplicate group ${duplicateSlotHealth.riskyCount}건이 있어 중복 예약 상태를 점검해야 합니다.`,
      },
    ],
    okReason: '스카 서비스와 naver-monitor 로그 활동성이 현재는 안정 구간입니다.',
  });
}

function formatText(report) {
  return buildHealthReport({
    title: '📅 스카 운영 헬스 리포트',
    sections: [
      buildHealthCountSection('■ 핵심 서비스 상태', report.coreServiceHealth),
      buildHealthSampleSection('■ 핵심 서비스 샘플', report.coreServiceHealth),
      buildHealthCountSection('■ 스케줄 작업 상태', report.scheduledServiceHealth),
      buildHealthCountSection('■ 모니터 상태', report.monitorHealth, { okLimit: 3 }),
      buildHealthCountSection('■ n8n 명령 경로', report.n8nCommandHealth, { okLimit: 2 }),
      buildHealthCountSection('■ 취소 카운터 드리프트', report.cancelCounterDriftHealth, { okLimit: 2, warnLimit: 4 }),
      buildHealthSampleSection('■ 취소 카운터 드리프트 샘플', {
        ok: report.cancelCounterDriftHealth.samples || [],
      }, 3),
      buildHealthCountSection('■ duplicate slot audit', report.duplicateSlotHealth, { okLimit: 2, warnLimit: 4 }),
      buildHealthSampleSection('■ duplicate slot 샘플', {
        ok: report.duplicateSlotHealth.samples || [],
      }, 3),
      buildHealthCountSection('■ daily_summary 무결성', report.dailySummaryIntegrityHealth, { okLimit: 3, warnLimit: 6 }),
      buildHealthSampleSection('■ 픽코합계 vs 운영산출 차이 샘플', {
        ok: report.dailySummaryIntegrityHealth.policyDivergenceSamples || [],
      }, 5),
      {
        title: null,
        lines: buildHealthDecisionSection({
          title: '■ 운영 판단',
          recommended: report.decision.recommended,
          level: report.decision.level,
          reasons: report.decision.reasons,
          okText: '현재는 추가 조치보다 관찰 유지',
        }),
      },
    ].filter(Boolean),
    footer: ['실행: node bots/reservation/scripts/health-report.js --json'],
  });
}

async function buildReport() {
  const status = getLaunchctlStatus([...CORE_SERVICES, ...SCHEDULED_SERVICES]);
  const coreServiceRows = buildServiceRows(status, {
    labels: CORE_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => label.replace('ai.ska.', ''),
  });
  const scheduledServiceRows = buildServiceRows(status, {
    labels: SCHEDULED_SERVICES,
    continuous: [],
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => label.replace('ai.ska.', ''),
    treatMissingAsOk: true,
    missingOkText: (name) => `  ${name}: 대기 (다음 스케줄 실행 전)`,
  });
  const monitorHealth = buildMonitorHealth();
  const n8nCommandHealth = await buildN8nCommandHealth();
  const cancelCounterDriftHealth = await buildCancelCounterDriftHealth();
  const duplicateSlotHealth = await buildDuplicateSlotHealth();
  const dailySummaryIntegrityHealth = await buildDailySummaryIntegrityHealth();
  const decision = buildDecision(coreServiceRows, monitorHealth, n8nCommandHealth, dailySummaryIntegrityHealth, cancelCounterDriftHealth, duplicateSlotHealth);

  const report = {
    coreServiceHealth: {
      okCount: coreServiceRows.ok.length,
      warnCount: coreServiceRows.warn.length,
      ok: coreServiceRows.ok,
      warn: coreServiceRows.warn,
    },
    scheduledServiceHealth: {
      okCount: scheduledServiceRows.ok.length,
      warnCount: scheduledServiceRows.warn.length,
      ok: scheduledServiceRows.ok,
      warn: scheduledServiceRows.warn,
    },
    monitorHealth: {
      okCount: monitorHealth.ok.length,
      warnCount: monitorHealth.warn.length,
      ok: monitorHealth.ok,
      warn: monitorHealth.warn,
      minutesAgo: monitorHealth.minutesAgo,
    },
    n8nCommandHealth: {
      okCount: n8nCommandHealth.ok.length,
      warnCount: n8nCommandHealth.warn.length,
      ok: n8nCommandHealth.ok,
      warn: n8nCommandHealth.warn,
      n8nHealthy: n8nCommandHealth.n8nHealthy,
      webhookRegistered: n8nCommandHealth.webhookRegistered,
      webhookReason: n8nCommandHealth.webhookReason,
      webhookStatus: n8nCommandHealth.webhookStatus,
      webhookUrl: n8nCommandHealth.webhookUrl,
      resolvedWebhookUrl: n8nCommandHealth.resolvedWebhookUrl,
    },
    cancelCounterDriftHealth: {
      okCount: cancelCounterDriftHealth.ok.length,
      warnCount: cancelCounterDriftHealth.warn.length,
      ok: cancelCounterDriftHealth.ok,
      warn: cancelCounterDriftHealth.warn,
      samples: cancelCounterDriftHealth.samples || [],
      totalCount: cancelCounterDriftHealth.totalCount,
      unresolvedCount: cancelCounterDriftHealth.unresolvedCount,
      latestTimestamp: cancelCounterDriftHealth.latestTimestamp,
    },
    duplicateSlotHealth: {
      okCount: duplicateSlotHealth.ok.length,
      warnCount: duplicateSlotHealth.warn.length,
      ok: duplicateSlotHealth.ok,
      warn: duplicateSlotHealth.warn,
      samples: duplicateSlotHealth.samples || [],
      riskyCount: duplicateSlotHealth.riskyCount,
      historicalCount: duplicateSlotHealth.historicalCount,
    },
    dailySummaryIntegrityHealth: {
      okCount: dailySummaryIntegrityHealth.ok.length,
      warnCount: dailySummaryIntegrityHealth.warn.length,
      ok: dailySummaryIntegrityHealth.ok,
      warn: dailySummaryIntegrityHealth.warn,
      issueCount: dailySummaryIntegrityHealth.issueCount,
      policyDivergenceCount: dailySummaryIntegrityHealth.policyDivergenceCount || 0,
      policyDivergenceSamples: dailySummaryIntegrityHealth.policyDivergenceSamples || [],
    },
    decision,
  };
  return report;
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[스카 운영 헬스 리포트]',
});
