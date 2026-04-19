#!/usr/bin/env node
'use strict';

/**
 * scripts/health-report.ts — 예약팀 운영자용 헬스 리포트
 *
 * 목적:
 *   - 예약 운영 backing 서비스와 데이터 무결성을 사람이 읽기 쉽게 요약
 *   - 공용 health-core 포맷을 사용하는 운영 리포트
 *
 * 실행:
 *   node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/scripts/health-report.js [--json]
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
const fs = require('node:fs');

const CONTINUOUS = ['ai.ska.naver-monitor', 'ai.ska.commander'];
const CORE_SERVICES = [
  'ai.ska.commander',
  'ai.ska.naver-monitor',
  'ai.ska.kiosk-monitor',
  'ai.ska.health-check',
];
const SCHEDULED_SERVICES = [
  'ai.ska.today-audit',
  'ai.ska.pickko-verify',
  'ai.ska.pickko-daily-audit',
  'ai.ska.pickko-daily-summary',
  'ai.ska.db-backup',
  'ai.ska.log-rotate',
];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const NAVER_LOG = '/tmp/naver-ops-mode.log';
const PICKKO_LOG = '/tmp/pickko-kiosk-monitor.log';
const TODAY_AUDIT_LOG = '/tmp/today-audit.log';
const LOG_STALE_MS = 15 * 60 * 1000;
const N8N_HEALTH_URL = process.env.N8N_HEALTH_URL || 'http://127.0.0.1:5678/healthz';
const DEFAULT_N8N_WEBHOOK_URL = process.env.SKA_N8N_WEBHOOK_URL || 'http://127.0.0.1:5678/webhook/ska-command';
const RESERVATION_COMMAND_WORKFLOW_NAME =
  process.env.RESERVATION_COMMAND_WORKFLOW_NAME || '스카팀 읽기 명령 intake';
const CANCEL_COUNTER_DRIFT_TITLE = '🚨 네이버 취소 카운터 증가 이상';

function getCurrentKstParts() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return {
    isoDate: now.toISOString().slice(0, 10),
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
  };
}

function reservationServiceLabel(label) {
  const mapped = {
    'ai.ska.commander': 'reservation-commander',
    'ai.ska.naver-monitor': 'booking-monitor',
    'ai.ska.kiosk-monitor': 'kiosk-monitor',
    'ai.ska.health-check': 'reservation-health-check',
    'ai.ska.today-audit': 'today-audit',
    'ai.ska.pickko-verify': 'pickko-verify',
    'ai.ska.pickko-daily-audit': 'pickko-daily-audit',
    'ai.ska.pickko-daily-summary': 'pickko-daily-summary',
    'ai.ska.db-backup': 'reservation-db-backup',
    'ai.ska.log-rotate': 'reservation-log-rotate',
  };
  return mapped[label] || label.replace('ai.ska.', '');
}

function sumRoomAmounts(roomAmountsJson): number {
  if (!roomAmountsJson) return 0;

  let parsed: Record<string, unknown> | string = roomAmountsJson;
  if (typeof roomAmountsJson === 'string') {
    try {
      parsed = JSON.parse(roomAmountsJson) as Record<string, unknown>;
    } catch (_) {
      return 0;
    }
  }

  if (!parsed || typeof parsed !== 'object') return 0;

  return Object.values(parsed as Record<string, unknown>).reduce<number>(
    (sum, value) => sum + Number(value || 0),
    0,
  );
}

function buildMonitorHealth() {
  const base = buildFileActivityHealth({
    label: 'naver-monitor 로그',
    filePath: NAVER_LOG,
    staleMs: LOG_STALE_MS,
    missingText: '  naver-monitor 로그: 파일 없음',
    staleText: (state) => `  naver-monitor 로그: ${state.minutesAgo}분 무활동`,
    okText: (state) => `  naver-monitor 로그: 최근 ${state.minutesAgo}분 이내 활동`,
  });

  try {
    if (!fs.existsSync(NAVER_LOG)) return base;

    const text = fs.readFileSync(NAVER_LOG, 'utf8');
    const lines = text.split('\n').slice(-200);
    const errorPatterns = [
      /⏹ naver-monitor 종료 \(exit:\s*1/i,
      /Attempted to use detached Frame/i,
      /Cannot find module '\.\/reservation-rag\.legacy\.js'/i,
      /로그인\/페이지 로드 실패/i,
    ];
    const healthyPatterns = [
      /✅ 페이지 로드 완료/i,
      /📍 확인 #/i,
      /예약현황 새로고침/i,
      /실행 후보 없음/i,
      /오늘 확정/i,
    ];

    let lastErrorIndex = -1;
    let lastHealthyIndex = -1;
    let matchedError = '';

    lines.forEach((line, index) => {
      if (healthyPatterns.some((pattern) => pattern.test(line))) {
        lastHealthyIndex = index;
      }
      if (errorPatterns.some((pattern) => pattern.test(line))) {
        lastErrorIndex = index;
        matchedError = line.trim();
      }
    });

    const recentExitFailures = lines.filter((line) => /⏹ naver-monitor 종료 \(exit:\s*1/i.test(line)).length;
    const likelyCrashLoop =
      recentExitFailures >= 2 ||
      (lastErrorIndex >= 0 && lastErrorIndex > lastHealthyIndex);

    if (!likelyCrashLoop) return base;

    const warn = Array.isArray(base.warn) ? [...base.warn] : [];
    const ok = Array.isArray(base.ok) ? [] : [];
    const reason =
      matchedError ||
      `최근 naver-monitor 비정상 종료 ${recentExitFailures}회 감지`;
    warn.unshift(`  naver-monitor 로그: 최근 크래시 루프 징후 감지 (${reason.slice(0, 140)})`);

    return {
      ...base,
      ok,
      warn,
      crashLoopDetected: true,
      crashLoopReason: reason,
    };
  } catch (error) {
    return {
      ...base,
      ok: [],
      warn: [`  naver-monitor 로그 분석 실패 (${error.message})`],
      crashLoopDetected: false,
      crashLoopReason: null,
    };
  }
}

function buildKioskMonitorHealth() {
  const base = buildFileActivityHealth({
    label: 'kiosk-monitor 로그',
    filePath: PICKKO_LOG,
    staleMs: 30 * 60 * 1000,
    missingText: '  kiosk-monitor 로그: 파일 없음',
    staleText: (state) => `  kiosk-monitor 로그: ${state.minutesAgo}분 무활동`,
    okText: (state) => `  kiosk-monitor 로그: 최근 ${state.minutesAgo}분 이내 활동`,
  });

  try {
    if (!fs.existsSync(PICKKO_LOG)) return base;

    const text = fs.readFileSync(PICKKO_LOG, 'utf8');
    const lines = text.split('\n').slice(-200);
    const errorPatterns = [
      /⏹ pickko-kiosk-monitor 완료 \(exit:\s*1\)/i,
      /Cannot find module/i,
      /❌ 치명 오류/i,
      /로그인\/조회 실패/i,
    ];
    const healthyPatterns = [
      /⏹ pickko-kiosk-monitor 완료 \(exit:\s*0\)/i,
      /✅ 신규 예약 없음, 재시도 없음, 취소 없음\. 종료/i,
      /✅ 픽코 로그인 완료/i,
      /🗑 픽코 취소 감지:/i,
    ];

    let lastErrorIndex = -1;
    let lastHealthyIndex = -1;
    let matchedError = '';

    lines.forEach((line, index) => {
      if (healthyPatterns.some((pattern) => pattern.test(line))) {
        lastHealthyIndex = index;
      }
      if (errorPatterns.some((pattern) => pattern.test(line))) {
        lastErrorIndex = index;
        matchedError = line.trim();
      }
    });

    const recentExitFailures = lines.filter((line) => /⏹ pickko-kiosk-monitor 완료 \(exit:\s*1\)/i.test(line)).length;
    const likelyCrashLoop =
      recentExitFailures >= 2 ||
      (lastErrorIndex >= 0 && lastErrorIndex > lastHealthyIndex);

    if (!likelyCrashLoop) return base;

    return {
      ...base,
      ok: [],
      warn: [
        `  kiosk-monitor 로그: 최근 크래시 루프 징후 감지 (${(matchedError || `최근 pickko-kiosk-monitor 비정상 종료 ${recentExitFailures}회`).slice(0, 140)})`,
      ],
      crashLoopDetected: true,
      crashLoopReason: matchedError || null,
    };
  } catch (error) {
    return {
      ...base,
      ok: [],
      warn: [`  kiosk-monitor 로그 분석 실패 (${error.message})`],
      crashLoopDetected: false,
      crashLoopReason: null,
    };
  }
}

function buildCombinedMonitorHealth() {
  const naverMonitor = buildMonitorHealth();
  const kioskMonitor = buildKioskMonitorHealth();
  return {
    ok: [...(naverMonitor.ok || []), ...(kioskMonitor.ok || [])],
    warn: [...(naverMonitor.warn || []), ...(kioskMonitor.warn || [])],
    minutesAgo: naverMonitor.minutesAgo,
    naverMonitor,
    kioskMonitor,
  };
}

function buildTodayAuditHealth() {
  if (!fs.existsSync(TODAY_AUDIT_LOG)) {
    return {
      ok: [],
      warn: ['  today-audit 로그: 파일 없음'],
      samples: [],
      lastExitCode: null,
      lastCompletedAt: null,
      lastStartedAt: null,
      recentSuccess: false,
    };
  }

  try {
    const text = fs.readFileSync(TODAY_AUDIT_LOG, 'utf8');
    const lines = text.split('\n').map((line) => line.trimEnd()).filter(Boolean);
    const recentLines = lines.slice(-200);
    const completionIndex = recentLines.map((line, index) => ({ line, index }))
      .filter((row) => row.line.includes('⏹ today-audit 완료'))
      .slice(-1)[0]?.index ?? -1;
    const lastCompleted = completionIndex >= 0 ? recentLines[completionIndex] : null;
    const candidateLines = completionIndex >= 0 ? recentLines.slice(0, completionIndex + 1) : recentLines;
    const lastAuditStarted = [...candidateLines].reverse().find((line) => line.includes('📋 [오늘 예약 검증]')) || null;
    const lastWrapperStarted = [...candidateLines].reverse().find((line) => line.includes('▶ today-audit 시작')) || null;
    const lastStarted = lastAuditStarted || lastWrapperStarted;
    const exitMatch = lastCompleted ? lastCompleted.match(/exit:\s*(\d+)/i) : null;
    const lastExitCode = exitMatch ? Number(exitMatch[1]) : null;
    const recentSuccess = lastExitCode === 0;
    const lastAuditDate = lastAuditStarted?.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || null;
    const kst = getCurrentKstParts();
    const shouldHaveRunToday = kst.hour > 9 || (kst.hour === 9 && kst.minute >= 0);
    const missingTodayRun = shouldHaveRunToday && lastAuditDate !== kst.isoDate;
    const samples = completionIndex >= 0
      ? recentLines.slice(Math.max(0, completionIndex - 4), completionIndex + 1).map((line) => `  ${line}`)
      : recentLines.slice(-5).map((line) => `  ${line}`);

    if (recentSuccess && !missingTodayRun) {
      return {
        ok: [
          '  today-audit 로그: 최근 실행 성공',
          ...(lastCompleted ? [`  latest completion: ${lastCompleted}`] : []),
        ],
        warn: [],
        samples,
        lastExitCode,
        lastCompletedAt: lastCompleted,
        lastStartedAt: lastStarted,
        lastWrapperStartedAt: lastWrapperStarted,
        lastAuditDate,
        missingTodayRun,
        recentSuccess,
      };
    }

    return {
      ok: lastStarted ? [`  latest start: ${lastStarted}`] : [],
      warn: [
        missingTodayRun
          ? `  today-audit 로그: 오늘(${kst.isoDate}) 성공 이력 없음`
          : `  today-audit 로그: 최근 실행 실패${lastExitCode != null ? ` (exit ${lastExitCode})` : ''}`,
        ...(lastCompleted ? [`  latest completion: ${lastCompleted}`] : []),
      ],
      samples,
      lastExitCode,
      lastCompletedAt: lastCompleted,
      lastStartedAt: lastStarted,
      lastWrapperStartedAt: lastWrapperStarted,
      lastAuditDate,
      missingTodayRun,
      recentSuccess,
    };
  } catch (error) {
    return {
      ok: [],
      warn: [`  today-audit 로그 분석 실패 (${error.message})`],
      samples: [],
      lastExitCode: null,
      lastCompletedAt: null,
      lastStartedAt: null,
      lastWrapperStartedAt: null,
      lastAuditDate: null,
      missingTodayRun: false,
      recentSuccess: false,
    };
  }
}

async function buildN8nCommandHealth() {
  return buildResolvedWebhookHealth({
    // Keep the operator-facing wording as "예약팀" while resolving against the
    // current n8n workflow name that is still registered under the legacy Ska label.
    workflowName: RESERVATION_COMMAND_WORKFLOW_NAME,
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
    const policyDivergences = [];
    for (const row of rows) {
      const date = String(row.date || '').slice(0, 10);
      const totalAmount = Number(row.total_amount || 0);
      const roomTotal = sumRoomAmounts(row.room_amounts_json);
      const pickkoStudyRoom = Number(row.pickko_study_room || 0);
      const generalRevenue = Number(row.general_revenue || 0);
      const combinedRevenue = generalRevenue + pickkoStudyRoom;

      if (date >= todayKst) {
        continue;
      }

      if (totalAmount > 0 && combinedRevenue > 0 && totalAmount !== combinedRevenue) {
        if (roomTotal !== pickkoStudyRoom) {
          policyDivergences.push(
            `${date}: booking-axis ${totalAmount}원 vs recognized-axis ${combinedRevenue}원 (room_amounts_json ${roomTotal}원 / pickko_study_room ${pickkoStudyRoom}원)`,
          );
        }
        continue;
      }

      if (roomTotal > 0 && pickkoStudyRoom <= 0) {
        issues.push(`${date}: room_amounts_json ${roomTotal}원인데 pickko_study_room=0`);
        continue;
      }

      if (roomTotal !== pickkoStudyRoom) {
        issues.push(`${date}: room_amounts_json ${roomTotal}원 != pickko_study_room ${pickkoStudyRoom}원`);
      }
    }

    if (issues.length > 0) {
      return {
        ok: policyDivergences.length > 0
          ? [`  정책 차이 관찰 ${policyDivergences.length}건 (booking-axis vs recognized-axis, 운영상 정상)`]
          : [],
        warn: [
          `  daily_summary 무결성(스터디룸 축): 경고 ${issues.length}건`,
          ...issues.slice(0, 5).map((line) => `    - ${line}`),
        ],
        issueCount: issues.length,
        policyDivergenceCount: policyDivergences.length,
        policyDivergenceSamples: policyDivergences.slice(0, 5).map((line) => `  ${line}`),
      };
    }

    return {
      ok: [
        '  daily_summary 무결성(스터디룸 축): 스터디룸 산출식과 저장값이 일치',
        ...(policyDivergences.length > 0
          ? [`  정책 차이 관찰 ${policyDivergences.length}건 (booking-axis vs recognized-axis, 운영상 정상)`]
          : []),
      ],
      warn: [],
      issueCount: 0,
      policyDivergenceCount: policyDivergences.length,
      policyDivergenceSamples: policyDivergences.slice(0, 5).map((line) => `  ${line}`),
    };
  } catch (error) {
    return {
      ok: [],
      warn: [`  daily_summary 무결성(스터디룸 축): 확인 실패 (${error.message})`],
      issueCount: 1,
      policyDivergenceCount: 0,
      policyDivergenceSamples: [],
    };
  }
}

async function buildCancelCounterDriftHealth() {
  try {
    const [rows, unresolvedRawRows] = await Promise.all([
      pgPool.query('reservation', `
        SELECT timestamp, resolved, title, message, date, start_time
        FROM alerts
        WHERE title = $1
          AND timestamp >= to_char(now() - interval '24 hours', 'YYYY-MM-DD HH24:MI:SS')
        ORDER BY timestamp DESC
        LIMIT 20
      `, [CANCEL_COUNTER_DRIFT_TITLE]),
      pgPool.query('reservation', `
        SELECT ck.cancelled_at, r.id, r.date, r.start_time, r.end_time, r.room, r.phone
        FROM cancelled_keys ck
        JOIN reservations r
          ON ck.cancel_key = 'cancelid|' || r.id::text
        WHERE r.status = 'completed'
          AND r.date > to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')
          AND ck.cancelled_at::timestamp > NOW() - INTERVAL '7 days'
        ORDER BY ck.cancelled_at DESC
        LIMIT 20
      `),
    ]);

    const unresolvedAlerts = rows.filter((row) => Number(row.resolved || 0) === 0);
    const latest = rows[0] || null;
    const alertSamples = rows.slice(0, 3).map((row) => {
      const timestamp = row.timestamp || '시각 미상';
      const message = String(row.message || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      return `  ${timestamp} — ${message || '상세 메시지 없음'}`;
    });
    const rawSamples = unresolvedRawRows.slice(0, 3).map((row) =>
      `  ${row.phone} ${row.date} ${row.start_time}~${row.end_time} ${row.room} — 네이버 취소됐으나 Picco 미반영`,
    );

    if (rows.length === 0 && unresolvedRawRows.length === 0) {
      return {
        ok: ['  취소 카운터 드리프트: 최근 24시간 경고 없음'],
        warn: [],
        samples: [],
        totalCount: 0,
        unresolvedCount: 0,
        latestTimestamp: null,
      };
    }

    if (unresolvedAlerts.length === 0 && unresolvedRawRows.length === 0) {
      const ok = [`  취소 카운터 드리프트: 최근 24시간 resolved 이력 ${rows.length}건`];
      if (latest?.timestamp) {
        ok.push(`  최신 resolved 감지: ${latest.timestamp}`);
      }
      return {
        ok,
        warn: [],
        samples: alertSamples,
        totalCount: rows.length,
        unresolvedCount: 0,
        latestTimestamp: latest?.timestamp || null,
      };
    }

    const warn = [
      `  취소 카운터 드리프트: 최근 24시간 알림 ${rows.length}건`,
      `  미해결 알림: ${unresolvedAlerts.length}건`,
    ];
    if (unresolvedRawRows.length > 0) {
      warn.push(`  실예약 기준 미반영 취소: ${unresolvedRawRows.length}건`);
    }
    if (latest?.timestamp) {
      warn.push(`  최신 감지: ${latest.timestamp}`);
    }

    return {
      ok: [],
      warn,
      samples: rawSamples.length > 0 ? rawSamples : alertSamples,
      totalCount: rows.length,
      unresolvedCount: unresolvedAlerts.length + unresolvedRawRows.length,
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

function buildDecision(coreServiceRows, monitorHealth, n8nCommandHealth, dailySummaryIntegrityHealth, cancelCounterDriftHealth, duplicateSlotHealth, todayAuditHealth) {
  return buildHealthDecision({
    warnings: [
      {
        active: coreServiceRows.warn.length > 0,
        level: 'high',
        reason: `핵심 예약 운영 서비스 경고 ${coreServiceRows.warn.length}건이 있어 점검이 필요합니다.`,
      },
      {
        active: monitorHealth.warn.length > 0,
        level: 'medium',
        reason: 'naver-monitor 로그 활동성이 멈춰 크래시루프 가능성을 확인해야 합니다.',
      },
      {
        active: !n8nCommandHealth.n8nHealthy,
        level: 'medium',
        reason: 'n8n healthz 응답이 없어 예약 command 노드 경로를 사용할 수 없습니다.',
      },
      {
        active: n8nCommandHealth.n8nHealthy && !n8nCommandHealth.webhookRegistered,
        level: 'medium',
        reason: `n8n은 살아 있지만 reservation command webhook이 미등록 상태입니다 (${n8nCommandHealth.webhookReason}).`,
      },
      {
        active: dailySummaryIntegrityHealth.warn.length > 0,
        level: 'medium',
        reason: `daily_summary 저장값 경고 ${dailySummaryIntegrityHealth.warn.length}건이 있어 예약 매출 저장 구조를 점검해야 합니다.`,
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
      {
        active: todayAuditHealth.warn.length > 0,
        level: 'medium',
        reason: todayAuditHealth.missingTodayRun
          ? 'today-audit가 오늘 예정 실행 이후에도 성공 이력이 없어 당일 예약 검증 누락 여부를 확인해야 합니다.'
          : `today-audit 최근 실행이 비정상 상태라 당일 예약 검증 로그를 확인해야 합니다.${todayAuditHealth.lastExitCode != null ? ` (exit ${todayAuditHealth.lastExitCode})` : ''}`,
      },
    ],
    okReason: '예약 운영 서비스와 booking monitor 로그 활동성이 현재는 안정 구간입니다.',
  });
}

function formatText(report) {
  return buildHealthReport({
    title: '📅 예약 운영 헬스 리포트',
    sections: [
      buildHealthCountSection('■ 핵심 서비스 상태', report.coreServiceHealth),
      buildHealthSampleSection('■ 핵심 서비스 샘플', report.coreServiceHealth),
      buildHealthCountSection('■ 스케줄 작업 상태', report.scheduledServiceHealth),
      buildHealthCountSection('■ today-audit 상태', report.todayAuditHealth, { okLimit: 2, warnLimit: 3 }),
      buildHealthSampleSection('■ today-audit 최근 로그', {
        ok: report.todayAuditHealth.samples || [],
      }, 5),
      buildHealthCountSection('■ 모니터 상태', report.monitorHealth, { okLimit: 3 }),
      buildHealthCountSection('■ n8n 예약 명령 경로', report.n8nCommandHealth, { okLimit: 2 }),
      buildHealthCountSection('■ 취소 카운터 드리프트', report.cancelCounterDriftHealth, { okLimit: 2, warnLimit: 4 }),
      buildHealthSampleSection('■ 취소 카운터 드리프트 샘플', {
        ok: report.cancelCounterDriftHealth.samples || [],
      }, 3),
      buildHealthCountSection('■ duplicate slot audit', report.duplicateSlotHealth, { okLimit: 2, warnLimit: 4 }),
      buildHealthSampleSection('■ duplicate slot 샘플', {
        ok: report.duplicateSlotHealth.samples || [],
      }, 3),
      buildHealthCountSection('■ daily_summary 무결성', report.dailySummaryIntegrityHealth, { okLimit: 3, warnLimit: 6 }),
      buildHealthSampleSection('■ booking-axis vs recognized-axis 샘플', {
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
    footer: ['실행: node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/scripts/health-report.js --json'],
  });
}

async function buildReport() {
  const status = getLaunchctlStatus([...CORE_SERVICES, ...SCHEDULED_SERVICES]);
  const coreServiceRows = buildServiceRows(status, {
    labels: CORE_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: reservationServiceLabel,
  });
  const scheduledServiceRows = buildServiceRows(status, {
    labels: SCHEDULED_SERVICES,
    continuous: [],
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: reservationServiceLabel,
    treatMissingAsOk: true,
    missingOkText: (name) => `  ${name}: 대기 (다음 스케줄 실행 전)`,
  });
  const monitorHealth = buildCombinedMonitorHealth();
  const n8nCommandHealth = await buildN8nCommandHealth();
  const cancelCounterDriftHealth = await buildCancelCounterDriftHealth();
  const duplicateSlotHealth = await buildDuplicateSlotHealth();
  const dailySummaryIntegrityHealth = await buildDailySummaryIntegrityHealth();
  const todayAuditHealth = buildTodayAuditHealth();
  const decision = buildDecision(coreServiceRows, monitorHealth, n8nCommandHealth, dailySummaryIntegrityHealth, cancelCounterDriftHealth, duplicateSlotHealth, todayAuditHealth);

  return {
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
    todayAuditHealth: {
      okCount: todayAuditHealth.ok.length,
      warnCount: todayAuditHealth.warn.length,
      ok: todayAuditHealth.ok,
      warn: todayAuditHealth.warn,
      samples: todayAuditHealth.samples || [],
      lastExitCode: todayAuditHealth.lastExitCode,
      lastCompletedAt: todayAuditHealth.lastCompletedAt,
      lastStartedAt: todayAuditHealth.lastStartedAt,
      lastWrapperStartedAt: todayAuditHealth.lastWrapperStartedAt,
      lastAuditDate: todayAuditHealth.lastAuditDate,
      missingTodayRun: todayAuditHealth.missingTodayRun,
      recentSuccess: todayAuditHealth.recentSuccess,
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
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[예약 운영 헬스 리포트]',
});
