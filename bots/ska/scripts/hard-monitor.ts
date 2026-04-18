// @ts-nocheck
'use strict';

import { query } from '../../../packages/core/lib/pg-pool';
import { fileURLToPath } from 'url';

const BOT_NAME = 'ska-hard-monitor';

type EventRow = {
  event_type: string;
  bot_name: string;
  title: string;
  severity: string;
  created_at: string;
};

type DailyRow = {
  event_type: string;
  bot_name: string;
  created_at: string;
};

async function fetchRecentSkaEvents(): Promise<EventRow[]> {
  return query<EventRow>('agent', `
    SELECT event_type, bot_name, title, severity, created_at
    FROM agent.event_lake
    WHERE team = 'ska'
      AND created_at > NOW() - INTERVAL '6 hours'
    ORDER BY created_at DESC
    LIMIT 50
  `);
}

async function fetchDailyBroadcasts(): Promise<DailyRow[]> {
  return query<DailyRow>('agent', `
    SELECT event_type, bot_name, created_at
    FROM agent.event_lake
    WHERE team = 'ska'
      AND event_type IN ('ska_daily_broadcast', 'daily_log_report')
      AND created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC
    LIMIT 10
  `);
}

function formatKst(input: string): string {
  return new Date(input).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

function latestEvent(events: EventRow[], eventType: string, botName?: string): EventRow | null {
  return (
    events.find((event) => event.event_type === eventType && (!botName || event.bot_name === botName)) ||
    null
  );
}

function latestEventAny(events: EventRow[], eventTypes: string[], botName?: string): EventRow | null {
  return (
    events.find(
      (event) => eventTypes.includes(event.event_type) && (!botName || event.bot_name === botName),
    ) || null
  );
}

function buildSection(label: string, row: EventRow | null): string[] {
  if (!row) return [`- ${label}: 최근 이벤트 없음`];
  return [
    `- ${label}: ${row.event_type}`,
    `  ${formatKst(row.created_at)} / ${row.bot_name} / ${row.severity}`,
  ];
}

async function main() {
  const [events, broadcasts] = await Promise.all([fetchRecentSkaEvents(), fetchDailyBroadcasts()]);

  const lines: string[] = [];
  lines.push(`🧪 스카 하드 모니터 (${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })})`);
  lines.push('');

  const etlCompleted =
    latestEvent(events, 'port_agent_completed', 'ska_etl') ||
    latestEventAny(events, ['port_agent_run', 'port_agent_started'], 'ska_etl');
  const logCompleted =
    latestEvent(events, 'port_agent_completed', 'log_report') ||
    latestEventAny(events, ['port_agent_run', 'port_agent_started'], 'log_report');
  const dailyBroadcast = latestEvent(events, 'ska_daily_broadcast', 'orchestrator');
  const failed = events.find((event) => event.severity === 'warn' || event.event_type.includes('failed')) || null;

  lines.push(...buildSection('ETL 완료', etlCompleted));
  lines.push(...buildSection('로그 리포트 완료', logCompleted));
  lines.push(...buildSection('일일 브리핑', dailyBroadcast));
  lines.push(...buildSection('최근 실패 신호', failed));
  lines.push('');

  lines.push(`- 최근 24h 방송/리포트: ${broadcasts.length}건`);
  for (const row of broadcasts.slice(0, 5)) {
    lines.push(`  • ${row.event_type} / ${row.bot_name} / ${formatKst(row.created_at)}`);
  }

  console.log(lines.join('\n'));
}

function isDirectExecution() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(`[${BOT_NAME}] 오류: ${error.message}`);
    process.exit(1);
  });
}
