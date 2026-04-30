#!/usr/bin/env tsx
'use strict';

/**
 * weekly-audit-digest.ts — 매주 토요일 22:00 KST 감사/검증 통합
 *
 * 통합 전: validate-trade-review, risk-guard 8종, position-parity-report 등 18개 → 1개
 * launchd ai.hub.weekly-audit-digest.plist (매주 토요일 22:00 KST)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const kst = require('../../../packages/core/lib/kst');

interface RiskGuardRow {
  guard_type: string;
  total: number;
  triggered: number;
  last_at: string | null;
}

interface TradeAuditRow {
  status: string;
  count: number;
}

async function fetchRiskGuardStats(): Promise<RiskGuardRow[]> {
  try {
    return await pgPool.query('agent', `
      SELECT
        COALESCE(metadata->>'guard_type', metadata->>'event_type', 'unknown') AS guard_type,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE metadata->>'triggered' = 'true')::int AS triggered,
        MAX(created_at)::text AS last_at
      FROM agent.event_lake
      WHERE event_type IN (
        'capital_guard', 'circuit_breaker', 'correlation_guard', 'dust_guard',
        'failure_pressure', 'execution_risk_guard', 'crypto_execution_gate',
        'crypto_soft_guard', 'risk_approval', 'order_pressure', 'reentry_pressure'
      )
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY guard_type
      ORDER BY triggered DESC, total DESC
    `, []);
  } catch {
    return [];
  }
}

async function fetchTradeAuditStats(): Promise<TradeAuditRow[]> {
  try {
    return await pgPool.query('agent', `
      SELECT
        COALESCE(metadata->>'audit_status', 'unknown') AS status,
        COUNT(*)::int AS count
      FROM agent.event_lake
      WHERE event_type IN ('trade_audit', 'validate_trade', 'backfill_trade', 'position_parity')
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY status
      ORDER BY count DESC
    `, []);
  } catch {
    return [];
  }
}

async function fetchPositionParityIssues(): Promise<number> {
  try {
    const row = await pgPool.get('agent', `
      SELECT COUNT(*)::int AS cnt
      FROM agent.event_lake
      WHERE event_type = 'position_parity'
        AND metadata->>'has_discrepancy' = 'true'
        AND created_at >= NOW() - INTERVAL '7 days'
    `, []);
    return Number(row?.cnt || 0);
  } catch {
    return 0;
  }
}

function formatAuditDigest(
  guardStats: RiskGuardRow[],
  tradeAudit: TradeAuditRow[],
  parityIssues: number,
): string {
  const totalGuardTriggers = guardStats.reduce((s, r) => s + r.triggered, 0);
  const hasIssues = totalGuardTriggers > 0 || parityIssues > 0;
  const emoji = hasIssues ? '🛡️⚠️' : '🛡️';

  const lines: string[] = [
    `${emoji} [Hub] 주간 감사 리포트 — ${kst.today()} KST`,
    '',
  ];

  if (guardStats.length > 0) {
    lines.push('🔒 Risk Guard 7일:');
    for (const g of guardStats.slice(0, 8)) {
      const trigEmoji = g.triggered > 0 ? '🟡' : '🟢';
      lines.push(`  ${trigEmoji} ${g.guard_type}: 검사 ${g.total}회 | 발동 ${g.triggered}회`);
    }
    lines.push(`  합계: 총 발동 ${totalGuardTriggers}회`);
    lines.push('');
  } else {
    lines.push('🟢 Risk Guard: 이벤트 없음');
    lines.push('');
  }

  if (tradeAudit.length > 0) {
    lines.push('📋 거래 감사:');
    for (const t of tradeAudit) {
      lines.push(`  - ${t.status}: ${t.count}건`);
    }
    lines.push('');
  }

  if (parityIssues > 0) {
    lines.push(`⚠️ 포지션 불일치 감지: ${parityIssues}건`);
  } else {
    lines.push('✅ 포지션 패리티: 정상');
  }

  return lines.join('\n');
}

async function main() {
  const [guardStats, tradeAudit, parityIssues] = await Promise.allSettled([
    fetchRiskGuardStats(),
    fetchTradeAuditStats(),
    fetchPositionParityIssues(),
  ]);

  const guards = guardStats.status === 'fulfilled' ? guardStats.value : [];
  const audit = tradeAudit.status === 'fulfilled' ? tradeAudit.value : [];
  const parity = parityIssues.status === 'fulfilled' ? parityIssues.value : 0;

  const message = formatAuditDigest(guards, audit, parity);
  console.log('[weekly-audit-digest]', message);

  const totalTriggers = guards.reduce((s, r) => s + r.triggered, 0);
  const hasIssues = totalTriggers > 0 || parity > 0;

  const sent = await postAlarm({
    team: 'hub',
    fromBot: 'weekly-audit-digest',
    alertLevel: hasIssues ? 2 : 1,
    alarmType: 'report',
    visibility: hasIssues ? 'notify' : 'digest',
    title: `주간 감사: Guard 발동 ${totalTriggers}회 | 포지션 불일치 ${parity}건`,
    message,
    eventType: 'weekly_audit_digest',
    incidentKey: `hub:weekly_audit:${kst.today()}`,
    payload: {
      event_type: 'weekly_audit_digest',
      guard_triggers: totalTriggers,
      position_parity_issues: parity,
      trade_audit_count: audit.reduce((s, r) => s + r.count, 0),
    },
  });

  if (!sent?.ok) {
    console.error('[weekly-audit-digest] 알람 발송 실패:', sent?.error);
    process.exit(1);
  }
  console.log('[weekly-audit-digest] 완료');
}

main().catch((err: Error) => {
  console.error('[weekly-audit-digest] 실패:', err.message);
  process.exit(1);
});
