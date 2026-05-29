'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const { storeReservationResolution } = require('../../../packages/core/lib/reservation-rag');
const { createSkaReadService } = require('./ska-read-service');
const { runManualReservationRegistration } = require('./manual-reservation');
const { runManualReservationCancellation } = require('./manual-cancellation');
const { resolveOpenKioskBlockFollowups } = require('./db');

type HandlerArgs = Record<string, unknown>;

function createSkaCommandHandlers({ pgPool, rag }) {
  const readService = createSkaReadService({ pgPool, rag });
  const uid = process.getuid();

  function ensureLaunchdLoaded(label, plistPath) {
    const service = `gui/${uid}/${label}`;
    try {
      execFileSync('launchctl', ['print', service], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000,
      });
      return;
    } catch (_) {
      if (!fs.existsSync(plistPath)) {
        throw new Error(`launchd plist 없음: ${plistPath}`);
      }
      execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10000,
      });
    }
  }

  async function handleQueryReservations(args: HandlerArgs = {}) {
    return readService.queryReservations(args);
  }

  async function handleQueryTodayStats(args: HandlerArgs = {}) {
    return readService.queryTodayStats(args);
  }

  async function handleQueryAlerts(args: HandlerArgs = {}) {
    return readService.queryAlerts(args);
  }

  async function resolveErrorAlerts(args: HandlerArgs = {}) {
    const phone = args.phone || null;
    const date = args.date || null;
    const start = args.start || args.start_time || null;
    if (phone && date && start) {
      const result = await pgPool.run('reservation', `
        UPDATE alerts
        SET resolved = 1, resolved_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE resolved = 0 AND type = 'error'
          AND phone = $1 AND date = $2 AND start_time = $3
      `, [phone, date, start]);
      return Number(result?.rowCount || 0);
    }

    const result = await pgPool.run('reservation', `
      UPDATE alerts
      SET resolved = 1, resolved_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE resolved = 0 AND type = 'error'
    `, []);
    return Number(result?.rowCount || 0);
  }

  async function handleStoreResolution(args: HandlerArgs = {}) {
    const { issueType = '알람', detail = '', resolution = '처리 완료' } = args;
    try {
      const resolved = await resolveErrorAlerts(args);
      const kioskFollowups = await resolveOpenKioskBlockFollowups(args);
      await storeReservationResolution(rag, {
        issueType,
        detail,
        resolution,
        sourceBot: 'ska-commander',
      });
      return {
        ok: true,
        resolved,
        kioskFollowups: kioskFollowups.length,
        message: resolved > 0
          ? `RAG 저장 완료 / 미해결 오류 알림 ${resolved}건 해결 처리${kioskFollowups.length > 0 ? ` / 네이버 차단 follow-up ${kioskFollowups.length}건 수동 완료 반영` : ''}`
          : (kioskFollowups.length > 0
            ? `RAG 저장 완료 / 네이버 차단 follow-up ${kioskFollowups.length}건 수동 완료 반영`
            : 'RAG 저장 완료 / 미해결 오류 알림 없음'),
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  }

  async function handleRegisterReservation(args: HandlerArgs = {}) {
    return runManualReservationRegistration(args);
  }

  async function handleCancelReservation(args: HandlerArgs = {}) {
    return runManualReservationCancellation(args);
  }

  function handleRestartAndy() {
    try {
      ensureLaunchdLoaded('ai.ska.naver-monitor', `${process.env.HOME}/Library/LaunchAgents/ai.ska.naver-monitor.plist`);
      execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/ai.ska.naver-monitor`], {
        encoding: 'utf8',
        timeout: 30000,
      });
      return { ok: true, message: '앤디 재시작 완료' };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  }

  function handleRestartJimmy() {
    try {
      ensureLaunchdLoaded('ai.ska.kiosk-monitor', `${process.env.HOME}/Library/LaunchAgents/ai.ska.kiosk-monitor.plist`);
      execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/ai.ska.kiosk-monitor`], {
        encoding: 'utf8',
        timeout: 30000,
      });
      return { ok: true, message: '지미 재시작 완료' };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  }

  return {
    query_reservations: handleQueryReservations,
    query_today_stats: handleQueryTodayStats,
    query_alerts: handleQueryAlerts,
    restart_andy: handleRestartAndy,
    restart_jimmy: handleRestartJimmy,
    store_resolution: handleStoreResolution,
    register_reservation: handleRegisterReservation,
    cancel_reservation: handleCancelReservation,
  };
}

module.exports = {
  createSkaCommandHandlers,
};
