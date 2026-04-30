#!/usr/bin/env tsx
'use strict';

/**
 * daily-metrics-digest.ts — 매일 09:00 KST 전 팀 지표 통합
 *
 * 통합 전: luna-daily-report, llm-daily-report, sigma-daily, 등 36개 → 1개
 * launchd ai.hub.daily-metrics-digest.plist (매일 09:00 KST)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const kst = require('../../../packages/core/lib/kst');

const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';

interface TeamAlarmStats {
  team: string;
  total: number;
  errors: number;
  criticals: number;
  reports: number;
}

interface TradeStats {
  total_trades: number;
  win_rate: number;
  total_pnl: number;
  markets: string[];
}

async function fetchTeamAlarmStats(hours: number): Promise<TeamAlarmStats[]> {
  try {
    const rows = await pgPool.query('agent', `
      SELECT
        COALESCE(team, 'unknown') AS team,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE metadata->>'alarm_type' = 'error')::int AS errors,
        COUNT(*) FILTER (WHERE metadata->>'alarm_type' = 'critical')::int AS criticals,
        COUNT(*) FILTER (WHERE metadata->>'alarm_type' = 'report')::int AS reports
      FROM agent.event_lake
      WHERE event_type = 'hub_alarm'
        AND created_at >= NOW() - ($1 * INTERVAL '1 hour')
      GROUP BY team
      ORDER BY total DESC
    `, [hours]);
    return rows || [];
  } catch {
    return [];
  }
}

async function fetchTradeStats(hours: number): Promise<TradeStats | null> {
  try {
    const row = await pgPool.get('agent', `
      SELECT
        COUNT(*)::int AS total_trades,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE (metadata->>'pnl')::numeric > 0)
          / NULLIF(COUNT(*), 0), 1
        )::float AS win_rate,
        COALESCE(SUM((metadata->>'pnl')::numeric), 0)::float AS total_pnl,
        array_agg(DISTINCT COALESCE(metadata->>'market', 'unknown'))::text[] AS markets
      FROM agent.event_lake
      WHERE event_type IN ('trade_closed', 'trade_executed', 'position_closed')
        AND created_at >= NOW() - ($1 * INTERVAL '1 hour')
    `, [hours]);
    if (!row || row.total_trades === 0) return null;
    return {
      total_trades: Number(row.total_trades),
      win_rate: Number(row.win_rate || 0),
      total_pnl: Number(row.total_pnl || 0),
      markets: Array.isArray(row.markets) ? row.markets.filter(Boolean) : [],
    };
  } catch {
    return null;
  }
}

async function fetchLLMStats(hours: number): Promise<{ total_calls: number; total_cost: number; success_rate: number } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const resp = await fetch(`${HUB_BASE}/hub/llm/stats?hours=${hours}`, {
      headers: { Authorization: `Bearer ${HUB_TOKEN}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    return {
      total_calls: Number(data?.totals?.total_calls || 0),
      total_cost: Number(data?.totals?.total_cost_usd || 0),
      success_rate: Number(data?.totals?.success_rate || 0),
    };
  } catch {
    return null;
  }
}

function formatDailyMetrics(
  teamStats: TeamAlarmStats[],
  trades: TradeStats | null,
  llm: { total_calls: number; total_cost: number; success_rate: number } | null,
  hours: number,
): string {
  const totalAlarms = teamStats.reduce((s, t) => s + t.total, 0);
  const totalErrors = teamStats.reduce((s, t) => s + t.errors, 0);
  const allOk = totalErrors === 0 && (trades === null || trades.total_trades >= 0);
  const emoji = allOk ? '📊' : '📊⚠️';

  const lines: string[] = [
    `${emoji} [Hub] 일일 메트릭 (최근 ${hours}h) — ${kst.today()} KST`,
    '',
  ];

  if (trades) {
    const pnlSign = trades.total_pnl >= 0 ? '+' : '';
    lines.push(`💰 투자팀 (Luna):  거래 ${trades.total_trades}건 | WR ${trades.win_rate.toFixed(1)}% | PnL ${pnlSign}${trades.total_pnl.toFixed(2)}`);
    if (trades.markets.length > 0) {
      lines.push(`   시장: ${trades.markets.join(', ')}`);
    }
    lines.push('');
  }

  if (llm) {
    lines.push(`🤖 LLM: ${llm.total_calls}회 | $${llm.total_cost.toFixed(4)} | 성공률 ${(llm.success_rate * 100).toFixed(1)}%`);
    lines.push('');
  }

  if (teamStats.length > 0) {
    lines.push(`🔔 알람: 총 ${totalAlarms}건 | 오류 ${totalErrors}건`);
    const errorTeams = teamStats.filter((t) => t.errors > 0);
    if (errorTeams.length > 0) {
      for (const t of errorTeams.slice(0, 5)) {
        lines.push(`  ⚠️ ${t.team}: 오류 ${t.errors}건`);
      }
    }
  }

  return lines.join('\n');
}

async function main() {
  const hours = 24;
  const [teamStats, trades, llm] = await Promise.allSettled([
    fetchTeamAlarmStats(hours),
    fetchTradeStats(hours),
    fetchLLMStats(hours),
  ]);

  const stats = teamStats.status === 'fulfilled' ? teamStats.value : [];
  const tradeData = trades.status === 'fulfilled' ? trades.value : null;
  const llmData = llm.status === 'fulfilled' ? llm.value : null;

  const message = formatDailyMetrics(stats, tradeData, llmData, hours);
  console.log('[daily-metrics-digest]', message);

  const totalErrors = stats.reduce((s, t) => s + t.errors, 0);

  const sent = await postAlarm({
    team: 'hub',
    fromBot: 'daily-metrics-digest',
    alertLevel: totalErrors > 0 ? 2 : 1,
    alarmType: 'report',
    visibility: 'notify',
    title: `일일 메트릭 — ${kst.today()}`,
    message,
    eventType: 'daily_metrics_digest',
    incidentKey: `hub:daily_metrics:${kst.today()}`,
    payload: {
      event_type: 'daily_metrics_digest',
      total_alarms: stats.reduce((s, t) => s + t.total, 0),
      total_errors: totalErrors,
      trade_count: tradeData?.total_trades || 0,
      llm_calls: llmData?.total_calls || 0,
      hours,
    },
  });

  if (!sent?.ok) {
    console.error('[daily-metrics-digest] 알람 발송 실패:', sent?.error);
    process.exit(1);
  }
  console.log('[daily-metrics-digest] 완료');
}

main().catch((err: Error) => {
  console.error('[daily-metrics-digest] 실패:', err.message);
  process.exit(1);
});
