// @ts-nocheck
'use strict';

/**
 * bots/ska/scripts/log-report.ts — 스카팀 일일 로그 리포트
 *
 * 집계 대상 (최근 24시간):
 *   - ska.failure_cases: 에러 유형별 발생 건수
 *   - ska.novel_exceptions: 새 예외 탐지
 *   - ska.selector_history: 셀렉터 변경 이력
 *   - agent.event_lake (team=ska): 주요 이벤트 요약
 *
 * 실행: npx tsx bots/ska/scripts/log-report.ts
 * 자동: PortAgent (SkaSupervisor, 24시간 간격)
 */

import { query } from '../../../packages/core/lib/pg-pool';
import { publishToWebhook } from '../../../packages/core/lib/reporting-hub';
import { fileURLToPath } from 'url';

const BOT_NAME = 'ska-log-report';

interface FailureRow {
  error_type: string;
  agent: string;
  count: number;
  last_seen: string;
  auto_resolved: boolean;
}

interface NovelExceptionRow {
  exception_type: string;
  detected_at: string;
  context: string;
}

interface SelectorChangeRow {
  agent: string;
  selector_key: string;
  changed_at: string;
}

interface EventRow {
  event_type: string;
  alert_level: number;
  title: string;
  created_at: string;
}

async function fetchFailures(): Promise<FailureRow[]> {
  try {
    return await query<FailureRow>('ska', `
      SELECT error_type, agent, count, last_seen, auto_resolved
      FROM ska.failure_cases
      WHERE last_seen > NOW() - INTERVAL '24 hours'
      ORDER BY count DESC
      LIMIT 20
    `);
  } catch {
    return [];
  }
}

async function fetchNovelExceptions(): Promise<NovelExceptionRow[]> {
  try {
    return await query<NovelExceptionRow>('ska', `
      SELECT exception_type, detected_at,
             LEFT(context::text, 80) AS context
      FROM ska.novel_exceptions
      WHERE detected_at > NOW() - INTERVAL '24 hours'
      ORDER BY detected_at DESC
      LIMIT 10
    `);
  } catch {
    return [];
  }
}

async function fetchSelectorChanges(): Promise<SelectorChangeRow[]> {
  try {
    return await query<SelectorChangeRow>('ska', `
      SELECT agent, selector_key, changed_at
      FROM ska.selector_history
      WHERE changed_at > NOW() - INTERVAL '24 hours'
      ORDER BY changed_at DESC
      LIMIT 10
    `);
  } catch {
    return [];
  }
}

async function fetchSkaEvents(): Promise<EventRow[]> {
  try {
    return await query<EventRow>('agent', `
      SELECT event_type, alert_level, LEFT(title, 60) AS title, created_at
      FROM agent.event_lake
      WHERE team = 'ska'
        AND created_at > NOW() - INTERVAL '24 hours'
        AND alert_level >= 2
      ORDER BY alert_level DESC, created_at DESC
      LIMIT 10
    `);
  } catch {
    return [];
  }
}

function buildReportText(
  failures: FailureRow[],
  novel: NovelExceptionRow[],
  selectors: SelectorChangeRow[],
  events: EventRow[],
): string {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const lines: string[] = [`📋 스카팀 일일 로그 리포트 (${now})`];

  // 에러 요약
  const unresolvedFailures = failures.filter((f) => !f.auto_resolved);
  lines.push('');
  lines.push(`🔴 미해결 오류 (24h): ${unresolvedFailures.length}건`);
  if (unresolvedFailures.length > 0) {
    for (const f of unresolvedFailures.slice(0, 5)) {
      lines.push(`  • [${f.agent}] ${f.error_type} × ${f.count}`);
    }
  }

  const resolvedCount = failures.filter((f) => f.auto_resolved).length;
  if (resolvedCount > 0) {
    lines.push(`✅ 자동 복구됨: ${resolvedCount}건`);
  }

  // 새 예외
  lines.push('');
  lines.push(`🆕 새 예외 탐지: ${novel.length}건`);
  for (const n of novel.slice(0, 3)) {
    lines.push(`  • ${n.exception_type}`);
  }

  // 셀렉터 변경
  if (selectors.length > 0) {
    lines.push('');
    lines.push(`🔧 셀렉터 변경: ${selectors.length}건`);
    for (const s of selectors.slice(0, 3)) {
      lines.push(`  • [${s.agent}] ${s.selector_key}`);
    }
  }

  // 주요 이벤트
  const criticalEvents = events.filter((e) => e.alert_level >= 3);
  if (criticalEvents.length > 0) {
    lines.push('');
    lines.push(`🚨 주요 이벤트: ${criticalEvents.length}건`);
    for (const e of criticalEvents.slice(0, 3)) {
      lines.push(`  • ${e.event_type}: ${e.title}`);
    }
  }

  // 종합 판정
  lines.push('');
  const totalIssues = unresolvedFailures.length + novel.length + criticalEvents.length;
  if (totalIssues === 0) {
    lines.push('🎉 24시간 내 주요 이슈 없음 — 정상 운영 중');
  } else {
    lines.push(`⚠️ 총 ${totalIssues}건 확인 필요`);
  }

  return lines.join('\n');
}

async function main() {
  console.log(`[${BOT_NAME}] 시작 — ${new Date().toISOString()}`);

  const [failures, novel, selectors, events] = await Promise.all([
    fetchFailures(),
    fetchNovelExceptions(),
    fetchSelectorChanges(),
    fetchSkaEvents(),
  ]);

  const unresolvedCount = failures.filter((f) => !f.auto_resolved).length;
  const alertLevel = unresolvedCount >= 3 || novel.length >= 2 ? 2 : 1;
  const reportText = buildReportText(failures, novel, selectors, events);

  console.log(reportText);

  await publishToWebhook({
    event: {
      from_bot: BOT_NAME,
      team: 'ska',
      event_type: 'daily_log_report',
      alert_level: alertLevel,
      message: reportText,
    },
  });

  console.log(`[${BOT_NAME}] 완료`);
}

function isDirectExecution() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error(`[${BOT_NAME}] 오류:`, err.message);
    process.exit(1);
  });
}
