#!/usr/bin/env node

/**
 * pickko-alerts-resolve.js — 미해결 오류 알림 수동 해결 처리 CLI
 */

const { parseArgs } = require('../../lib/args');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const { resolveOpenKioskBlockFollowups } = require('../../lib/db');
const { buildReservationCliInsight } = require('../../lib/cli-insight');

const ARGS = parseArgs(process.argv);
const list = !!ARGS.list;
const recent = !!ARGS.recent;
const phone = ARGS.phone || null;
const date = ARGS.date || null;
const start = ARGS.start || null;
const title = ARGS.title || null;

type AlertResolveRow = {
  id: string;
  phone: string | null;
  date: string | null;
  start_time: string | null;
  title: string;
  message: string | null;
  timestamp: string | Date;
};

type RecentCandidateRow = {
  phone: string | null;
  date: string | null;
  start_time: string | null;
  title: string | null;
  latest_timestamp: string | Date;
  alert_count: number | string;
};

type RunResult = {
  rowCount?: number | string | null;
};

let result: RunResult | undefined;

async function listUnresolvedAlerts(): Promise<AlertResolveRow[]> {
  return pgPool.query('reservation', `
    SELECT id, phone, date, start_time, title, message, timestamp
    FROM alerts
    WHERE resolved = 0 AND type = 'error'
    ORDER BY timestamp DESC
    LIMIT 20
  `);
}

async function listRecentAlertCandidates(): Promise<RecentCandidateRow[]> {
  return pgPool.query('reservation', `
    SELECT
      phone,
      date,
      start_time,
      MAX(title) AS title,
      MAX(timestamp) AS latest_timestamp,
      COUNT(*) AS alert_count
    FROM alerts
    WHERE resolved = 0
      AND type = 'error'
      AND date >= to_char(current_date - interval '7 days', 'YYYY-MM-DD')
    GROUP BY phone, date, start_time
    ORDER BY MAX(timestamp) DESC
    LIMIT 5
  `);
}

(async () => {
  if (list) {
    const rows = await listUnresolvedAlerts();
    const aiSummary = await buildReservationCliInsight({
      bot: 'pickko-alerts-resolve',
      requestType: 'alerts-resolve-list',
      title: '미해결 오류 알림 목록',
      data: {
        mode: 'list',
        count: rows.length,
      },
      fallback: rows.length > 0
        ? `미해결 오류 알림 ${rows.length}건이 있어 자동 해제 전에 대상 식별이 먼저 필요합니다.`
        : '미해결 오류 알림이 없어 추가 수동 해제 작업은 필요하지 않습니다.',
    });

    console.log(JSON.stringify({
      success: true,
      listed: rows.length,
      items: rows,
      aiSummary,
      message: rows.length > 0
        ? `미해결 오류 알림 ${rows.length}건 조회 완료`
        : '미해결 오류 알림 없음',
    }));
    return;
  }

  if (recent) {
    const candidates = await listRecentAlertCandidates();

    if (candidates.length === 0) {
      const aiSummary = await buildReservationCliInsight({
        bot: 'pickko-alerts-resolve',
        requestType: 'alerts-resolve-recent',
        title: '최근 미해결 오류 알림 해결 결과',
        data: {
          mode: 'recent',
          candidates: 0,
        },
        fallback: '최근 미해결 오류 알림이 없어 자동 해결할 대상이 없습니다.',
      });
      console.log(JSON.stringify({
        success: true,
        resolved: 0,
        message: '최근 미해결 오류 알림 없음',
        aiSummary,
      }));
      return;
    }

    if (candidates.length > 1) {
      const aiSummary = await buildReservationCliInsight({
        bot: 'pickko-alerts-resolve',
        requestType: 'alerts-resolve-recent',
        title: '최근 미해결 오류 알림 해결 결과',
        data: {
          mode: 'recent',
          candidates: candidates.length,
        },
        fallback: '후보가 여러 건이라 자동 해제보다 phone/date/start를 지정해 좁히는 편이 안전합니다.',
      });
      console.log(JSON.stringify({
        success: false,
        requiresDisambiguation: true,
        message: '최근 미해결 후보가 여러 건이라 자동 해제할 수 없습니다. phone/date/start를 함께 지정해주세요.',
        candidates,
        aiSummary,
      }));
      return;
    }

    const candidate = candidates[0];
    if (candidate.phone && candidate.date && candidate.start_time) {
      result = await pgPool.run('reservation', `
        UPDATE alerts
        SET resolved = 1, resolved_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE resolved = 0 AND type = 'error'
          AND phone = $1 AND date = $2 AND start_time = $3
      `, [candidate.phone, candidate.date, candidate.start_time]);
    } else if (candidate.title) {
      result = await pgPool.run('reservation', `
        UPDATE alerts
        SET resolved = 1, resolved_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE resolved = 0 AND type = 'error'
          AND title = $1
      `, [candidate.title]);
    } else {
      throw new Error('최근 미해결 알림 후보를 식별할 수 없습니다.');
    }

    const followups = (candidate.phone && candidate.date && candidate.start_time)
      ? await resolveOpenKioskBlockFollowups({
          phone: candidate.phone,
          date: candidate.date,
          start: candidate.start_time,
        })
      : [];
    const aiSummary = await buildReservationCliInsight({
      bot: 'pickko-alerts-resolve',
      requestType: 'alerts-resolve-recent',
      title: '최근 미해결 오류 알림 해결 결과',
      data: {
        mode: 'recent',
        resolved: Number(result?.rowCount || 0),
        kioskFollowups: Number(followups?.length || 0),
      },
      fallback: Number(followups?.length || 0) > 0
        ? '최근 오류 알림과 연계된 네이버 차단 후속까지 함께 정리돼 운영 부하가 줄었습니다.'
        : '최근 미해결 오류 알림이 자동 해결되어 후속 점검 범위가 줄었습니다.',
    });

    console.log(JSON.stringify({
      success: true,
      recent: true,
      resolved: Number(result?.rowCount || 0),
      kioskFollowups: Number(followups?.length || 0),
      aiSummary,
      target: {
        phone: candidate.phone,
        date: candidate.date,
        start: candidate.start_time,
        title: candidate.title,
      },
      message: candidate.phone && candidate.date && candidate.start_time
        ? `최근 미해결 오류 알림 자동 해결 완료 (${candidate.phone} ${candidate.date} ${candidate.start_time})`
        : `최근 미해결 시스템 오류 알림 자동 해결 완료 (${candidate.title || 'title unknown'})`,
    }));
    return;
  }

  let followups = [];
  if (title) {
    result = await pgPool.run('reservation', `
      UPDATE alerts
      SET resolved = 1, resolved_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE resolved = 0 AND type = 'error'
        AND title = $1
    `, [title]);
  } else if (phone && date && start) {
    result = await pgPool.run('reservation', `
      UPDATE alerts
      SET resolved = 1, resolved_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE resolved = 0 AND type = 'error'
        AND phone = $1 AND date = $2 AND start_time = $3
    `, [phone, date, start]);
    followups = await resolveOpenKioskBlockFollowups({ phone, date, start });
  } else {
    result = await pgPool.run('reservation', `
      UPDATE alerts
      SET resolved = 1, resolved_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE resolved = 0 AND type = 'error'
    `, []);
    followups = await resolveOpenKioskBlockFollowups({});
  }

  const n = Number(result?.rowCount || 0);
  const followupCount = Number(followups?.length || 0);

  if (n === 0 && followupCount === 0) {
    const aiSummary = await buildReservationCliInsight({
      bot: 'pickko-alerts-resolve',
      requestType: 'alerts-resolve',
      title: '미해결 오류 알림 해결 결과',
      data: {
        mode: title ? 'title' : phone && date && start ? 'targeted' : 'all',
        resolved: 0,
        kioskFollowups: 0,
      },
      fallback: '이미 모두 해결된 상태라 추가 해제 작업은 필요하지 않습니다.',
    });
    console.log(JSON.stringify({
      success: true,
      resolved: 0,
      message: '미해결 오류 알림 없음 (이미 모두 해결됨)',
      aiSummary,
    }));
  } else {
    const aiSummary = await buildReservationCliInsight({
      bot: 'pickko-alerts-resolve',
      requestType: 'alerts-resolve',
      title: '미해결 오류 알림 해결 결과',
      data: {
        mode: title ? 'title' : phone && date && start ? 'targeted' : 'all',
        resolved: n,
        kioskFollowups: followupCount,
      },
      fallback: followupCount > 0
        ? `미해결 오류 ${n}건과 네이버 차단 후속 ${followupCount}건이 함께 정리되어 운영 정합성이 좋아졌습니다.`
        : `미해결 오류 ${n}건이 정리되어 후속 수동 확인 범위가 줄었습니다.`,
    });
    console.log(JSON.stringify({
      success: true,
      resolved: n,
      kioskFollowups: followupCount,
      aiSummary,
      message: followupCount > 0
        ? `✅ 미해결 오류 알림 ${n}건 해결 처리 완료 / 네이버 차단 follow-up ${followupCount}건 수동 완료 반영`
        : `✅ 미해결 오류 알림 ${n}건 해결 처리 완료`,
    }));
  }
})().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.stack || error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
