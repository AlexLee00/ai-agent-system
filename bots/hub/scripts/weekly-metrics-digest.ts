#!/usr/bin/env tsx
'use strict';

/**
 * weekly-metrics-digest.ts — 매주 일요일 18:00 KST 주간 지표 통합
 *
 * 통합 전: luna-weekly-review, weekly-trade-review, sigma-weekly, darwin-weekly 등 8개 → 1개
 * launchd ai.hub.weekly-metrics-digest.plist (매주 일요일 18:00 KST)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const kst = require('../../../packages/core/lib/kst');

interface WeeklyTeamStats {
  team: string;
  total_alarms: number;
  errors: number;
  criticals: number;
}

interface WeeklyTradeStats {
  total_trades: number;
  win_rate: number;
  total_pnl: number;
  best_day_pnl: number;
  worst_day_pnl: number;
}

async function fetchWeeklyTeamStats(): Promise<WeeklyTeamStats[]> {
  try {
    return await pgPool.query('agent', `
      SELECT
        COALESCE(team, 'unknown') AS team,
        COUNT(*)::int AS total_alarms,
        COUNT(*) FILTER (WHERE metadata->>'alarm_type' = 'error')::int AS errors,
        COUNT(*) FILTER (WHERE metadata->>'alarm_type' = 'critical')::int AS criticals
      FROM agent.event_lake
      WHERE event_type = 'hub_alarm'
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY team
      ORDER BY total_alarms DESC
    `, []);
  } catch {
    return [];
  }
}

async function fetchWeeklyTradeStats(): Promise<WeeklyTradeStats | null> {
  try {
    const row = await pgPool.get('agent', `
      SELECT
        COUNT(*)::int AS total_trades,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE (metadata->>'pnl')::numeric > 0)
          / NULLIF(COUNT(*), 0), 1
        )::float AS win_rate,
        COALESCE(SUM((metadata->>'pnl')::numeric), 0)::float AS total_pnl,
        COALESCE(MAX((metadata->>'pnl')::numeric), 0)::float AS best_day_pnl,
        COALESCE(MIN((metadata->>'pnl')::numeric), 0)::float AS worst_day_pnl
      FROM agent.event_lake
      WHERE event_type IN ('trade_closed', 'position_closed')
        AND created_at >= NOW() - INTERVAL '7 days'
    `, []);
    if (!row || row.total_trades === 0) return null;
    return {
      total_trades: Number(row.total_trades),
      win_rate: Number(row.win_rate || 0),
      total_pnl: Number(row.total_pnl || 0),
      best_day_pnl: Number(row.best_day_pnl || 0),
      worst_day_pnl: Number(row.worst_day_pnl || 0),
    };
  } catch {
    return null;
  }
}

async function fetchWeeklyRoundtableStats(): Promise<{ resolved: number; open: number; total: number }> {
  try {
    const row = await pgPool.get('agent', `
      SELECT
        COUNT(*) FILTER (WHERE status IN ('consensus', 'resolved'))::int AS resolved,
        COUNT(*) FILTER (WHERE status IN ('open', 'in_progress'))::int AS open,
        COUNT(*)::int AS total
      FROM agent.alarm_roundtables
      WHERE created_at >= NOW() - INTERVAL '7 days'
    `, []);
    return {
      resolved: Number(row?.resolved || 0),
      open: Number(row?.open || 0),
      total: Number(row?.total || 0),
    };
  } catch {
    return { resolved: 0, open: 0, total: 0 };
  }
}

function formatWeeklyMetrics(
  teamStats: WeeklyTeamStats[],
  trades: WeeklyTradeStats | null,
  roundtables: { resolved: number; open: number; total: number },
): string {
  const totalAlarms = teamStats.reduce((s, t) => s + t.total_alarms, 0);
  const totalErrors = teamStats.reduce((s, t) => s + t.errors, 0);
  const totalCriticals = teamStats.reduce((s, t) => s + t.criticals, 0);
  const hasIssues = roundtables.open > 0 || totalCriticals > 0;
  const emoji = hasIssues ? '📋⚠️' : '📋';

  const lines: string[] = [
    `${emoji} [Hub] 주간 메트릭 — ${kst.today()} KST`,
    '',
  ];

  if (trades) {
    const pnlSign = trades.total_pnl >= 0 ? '+' : '';
    lines.push('💰 투자팀 7일 성과:');
    lines.push(`   거래 ${trades.total_trades}건 | WR ${trades.win_rate.toFixed(1)}% | 총 PnL ${pnlSign}${trades.total_pnl.toFixed(2)}`);
    lines.push(`   최대 단일 거래: ${trades.best_day_pnl >= 0 ? '+' : ''}${trades.best_day_pnl.toFixed(2)} / 최소: ${trades.worst_day_pnl.toFixed(2)}`);
    lines.push('');
  }

  lines.push(`🔔 알람 7일: 총 ${totalAlarms}건 | 오류 ${totalErrors}건 | 긴급 ${totalCriticals}건`);
  if (teamStats.length > 0) {
    const topErrors = teamStats.filter((t) => t.errors > 0).slice(0, 3);
    if (topErrors.length > 0) {
      for (const t of topErrors) {
        lines.push(`  ⚠️ ${t.team}: 오류 ${t.errors}건 / 긴급 ${t.criticals}건`);
      }
    }
  }

  lines.push('');
  lines.push(`🗣️ Roundtable 7일: 총 ${roundtables.total}건 | 완료 ${roundtables.resolved}건 | 미해결 ${roundtables.open}건`);

  return lines.join('\n');
}

async function main() {
  const [teamStats, trades, roundtables] = await Promise.allSettled([
    fetchWeeklyTeamStats(),
    fetchWeeklyTradeStats(),
    fetchWeeklyRoundtableStats(),
  ]);

  const stats = teamStats.status === 'fulfilled' ? teamStats.value : [];
  const tradeData = trades.status === 'fulfilled' ? trades.value : null;
  const rtData = roundtables.status === 'fulfilled' ? roundtables.value : { resolved: 0, open: 0, total: 0 };

  const message = formatWeeklyMetrics(stats, tradeData, rtData);
  console.log('[weekly-metrics-digest]', message);

  const totalErrors = stats.reduce((s, t) => s + t.errors, 0);

  const sent = await postAlarm({
    team: 'hub',
    fromBot: 'weekly-metrics-digest',
    alertLevel: totalErrors > 5 ? 2 : 1,
    alarmType: 'report',
    visibility: 'notify',
    title: `주간 메트릭 — ${kst.today()}`,
    message,
    eventType: 'weekly_metrics_digest',
    incidentKey: `hub:weekly_metrics:${kst.today()}`,
    payload: {
      event_type: 'weekly_metrics_digest',
      total_alarms: stats.reduce((s, t) => s + t.total_alarms, 0),
      total_errors: totalErrors,
      trade_count: tradeData?.total_trades || 0,
      roundtable_total: rtData.total,
      roundtable_open: rtData.open,
    },
  });

  if (!sent?.ok) {
    console.error('[weekly-metrics-digest] 알람 발송 실패:', sent?.error);
    process.exit(1);
  }
  console.log('[weekly-metrics-digest] 완료');
}

main().catch((err: Error) => {
  console.error('[weekly-metrics-digest] 실패:', err.message);
  process.exit(1);
});
