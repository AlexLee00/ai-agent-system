// @ts-nocheck
import * as db from './db.ts';

export function buildAgentBusStatsFromRows(rows = [], { generatedAt = new Date().toISOString() } = {}) {
  const summary = {
    totalMessages: 0,
    window24hMessages: 0,
    window7dMessages: 0,
    pendingMessages: 0,
    byAgent: {},
    byType: {},
    topPairs: [],
  };
  const pairMap = new Map();
  for (const row of rows || []) {
    const count = Number(row.cnt ?? row.count ?? 1) || 0;
    const from = String(row.from_agent || row.fromAgent || 'unknown');
    const to = String(row.to_agent || row.toAgent || 'unknown');
    const type = String(row.message_type || row.messageType || 'query');
    const windowName = String(row.window || row.window_name || 'total');
    summary.totalMessages += count;
    if (windowName === '24h') summary.window24hMessages += count;
    if (windowName === '7d') summary.window7dMessages += count;
    if (row.responded_at == null && row.pending !== false) summary.pendingMessages += Number(row.pending_count ?? 0) || 0;
    summary.byType[type] = (summary.byType[type] || 0) + count;
    summary.byAgent[from] = summary.byAgent[from] || { sent: 0, received: 0 };
    summary.byAgent[to] = summary.byAgent[to] || { sent: 0, received: 0 };
    summary.byAgent[from].sent += count;
    summary.byAgent[to].received += count;
    const pairKey = `${from}->${to}`;
    pairMap.set(pairKey, (pairMap.get(pairKey) || 0) + count);
  }
  summary.topPairs = [...pairMap.entries()]
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair))
    .slice(0, 10);
  return {
    ok: true,
    generatedAt,
    ...summary,
  };
}

export async function collectAgentBusStats({ days = 7 } = {}) {
  const [aggregateRows, pendingRow] = await Promise.all([
    db.query(
      `SELECT
         CASE
           WHEN created_at >= NOW() - INTERVAL '24 hours' THEN '24h'
           WHEN created_at >= NOW() - ($1::int * INTERVAL '1 day') THEN '7d'
           ELSE 'older'
         END AS window,
         from_agent,
         to_agent,
         message_type,
         COUNT(*)::int AS cnt
       FROM investment.agent_messages
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY window, from_agent, to_agent, message_type`,
      [days],
    ).catch(() => []),
    db.get(
      `SELECT COUNT(*)::int AS cnt
         FROM investment.agent_messages
        WHERE responded_at IS NULL
          AND message_type IN ('query', 'broadcast')`,
      [],
    ).catch(() => null),
  ]);
  const stats = buildAgentBusStatsFromRows(aggregateRows);
  stats.pendingMessages = Number(pendingRow?.cnt || 0);
  return stats;
}

export function renderAgentBusStatsMarkdown(stats) {
  const lines = [];
  lines.push('# Luna Cross-Agent Bus Stats');
  lines.push('');
  lines.push(`- generatedAt: ${stats.generatedAt}`);
  lines.push(`- 24h messages: ${stats.window24hMessages}`);
  lines.push(`- 7d messages: ${stats.window7dMessages}`);
  lines.push(`- pending: ${stats.pendingMessages}`);
  lines.push('');
  lines.push('## Message Types');
  for (const [type, count] of Object.entries(stats.byType || {}).sort()) {
    lines.push(`- ${type}: ${count}`);
  }
  lines.push('');
  lines.push('## Top Pairs');
  for (const pair of stats.topPairs || []) {
    lines.push(`- ${pair.pair}: ${pair.count}`);
  }
  return lines.join('\n');
}

export default {
  buildAgentBusStatsFromRows,
  collectAgentBusStats,
  renderAgentBusStatsMarkdown,
};
