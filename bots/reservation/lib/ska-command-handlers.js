'use strict';

const { execFileSync } = require('child_process');
const kst = require('../../../packages/core/lib/kst');
const { runWithN8nFallback } = require('../../../packages/core/lib/n8n-runner');

function createSkaCommandHandlers({ pgPool, rag }) {
  const N8N_HEALTH_URL = process.env.N8N_SKA_HEALTH_URL || 'http://localhost:5678/healthz';

  function getCommandWebhookCandidates(command) {
    const scoped = process.env[`N8N_SKA_WEBHOOK_${String(command || '').toUpperCase()}`];
    const shared = process.env.N8N_SKA_COMMAND_WEBHOOK;
    const defaults = [
      'http://localhost:5678/webhook/ska-command',
      'http://localhost:5678/webhook-test/ska-command',
    ];
    return [...new Set([scoped, shared, ...defaults].filter(Boolean))];
  }

  async function runCommandWithN8n(command, args, directRunner) {
    return runWithN8nFallback({
      circuitName: `ska:${command}`,
      webhookCandidates: getCommandWebhookCandidates(command),
      healthUrl: N8N_HEALTH_URL,
      body: {
        team: 'ska',
        command,
        args: args || {},
        source: 'ska-commander',
        requestedAt: new Date().toISOString(),
      },
      directRunner,
      logger: console,
    });
  }

  async function searchPastCases(issueType, detail) {
    try {
      const query = `${issueType} ${detail}`.slice(0, 200);
      const hits = await rag.search('reservations', query, { limit: 3, threshold: 0.6 });
      if (!hits || hits.length === 0) return null;
      return hits.map((hit) => ({
        content: (hit.content || '').slice(0, 150),
        date: hit.created_at ? new Date(hit.created_at).toLocaleDateString('ko-KR') : '',
      }));
    } catch {
      return null;
    }
  }

  async function storeAlertContext(issueType, detail, resolution) {
    try {
      await rag.store(
        'reservations',
        `[알람 처리] ${issueType} | ${detail} | 조치: ${resolution}`,
        { type: issueType, detail, resolution },
        'ska-commander',
      );
    } catch {
      // RAG 저장 실패는 운영 흐름을 막지 않음
    }
  }

  async function runLocalQueryReservations(args = {}) {
    const date = args.date || kst.today();
    try {
      const rows = await pgPool.query('reservation', `
        SELECT name_enc, date, start_time, end_time, room, status
        FROM reservations
        WHERE date = $1
        ORDER BY start_time
      `, [date]);

      if (rows.length === 0) {
        return { ok: true, date, count: 0, message: `${date} 예약 없음` };
      }

      const list = rows.map((row) => `${row.start_time}~${row.end_time} [${row.room}] ${row.status}`);
      return { ok: true, date, count: rows.length, reservations: list };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function handleQueryReservations(args = {}) {
    return runCommandWithN8n('query_reservations', args, () => runLocalQueryReservations(args));
  }

  async function runLocalQueryTodayStats(args = {}) {
    const date = args.date || kst.today();
    try {
      const summary = await pgPool.get('reservation', `
        SELECT total_amount, entries_count FROM daily_summary WHERE date = $1
      `, [date]);

      if (!summary) {
        return { ok: true, date, message: `${date} 매출 데이터 없음` };
      }

      return {
        ok: true,
        date,
        total_amount: summary.total_amount,
        entries_count: summary.entries_count,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function handleQueryTodayStats(args = {}) {
    return runCommandWithN8n('query_today_stats', args, () => runLocalQueryTodayStats(args));
  }

  async function runLocalQueryAlerts(args = {}) {
    try {
      const limit = args.limit || 10;
      const rows = await pgPool.query('reservation', `
        SELECT type, title, message, timestamp
        FROM alerts
        WHERE resolved = 0
        ORDER BY timestamp DESC
        LIMIT $1
      `, [limit]);

      let pastCases = null;
      if (rows.length > 0) {
        pastCases = await searchPastCases(rows[0].type || '알람', rows[0].title || '');
      }

      return { ok: true, count: rows.length, alerts: rows, past_cases: pastCases };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function handleQueryAlerts(args = {}) {
    return runCommandWithN8n('query_alerts', args, () => runLocalQueryAlerts(args));
  }

  async function handleStoreResolution(args = {}) {
    const { issueType = '알람', detail = '', resolution = '처리 완료' } = args;
    try {
      await storeAlertContext(issueType, detail, resolution);
      return { ok: true, message: 'RAG 저장 완료' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function handleRestartAndy() {
    try {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/ai.ska.naver-monitor`], {
        encoding: 'utf8',
        timeout: 30000,
      });
      return { ok: true, message: '앤디 재시작 완료' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function handleRestartJimmy() {
    try {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/ai.ska.kiosk-monitor`], {
        encoding: 'utf8',
        timeout: 30000,
      });
      return { ok: true, message: '지미 재시작 완료' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return {
    query_reservations: handleQueryReservations,
    query_today_stats: handleQueryTodayStats,
    query_alerts: handleQueryAlerts,
    restart_andy: handleRestartAndy,
    restart_jimmy: handleRestartJimmy,
    store_resolution: handleStoreResolution,
  };
}

module.exports = {
  createSkaCommandHandlers,
};
