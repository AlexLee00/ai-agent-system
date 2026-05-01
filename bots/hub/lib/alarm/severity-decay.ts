'use strict';

/**
 * severity-decay.ts — 미해결 알람 severity 자동 강등
 *
 * 매시간 실행 (launchd ai.hub.severity-decay)
 *
 * 규칙:
 *   - 24h+ 미해결 critical, fingerprint_count < 5 → error 강등
 *   - 7일+ 미해결 error, fingerprint_count < 3 → work 강등
 *   - fingerprint_count >= 임계치면 유지 (반복 발생 — 강등 X)
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');
const kst = require('../../../../packages/core/lib/kst');

interface DecayRule {
  fromSeverity: string;
  toSeverity: string;
  minAgeHours: number;
  maxFingerprintCount: number;
}

const DECAY_RULES: DecayRule[] = [
  {
    fromSeverity: 'critical',
    toSeverity: 'error',
    minAgeHours: Number(process.env.HUB_SEVERITY_DECAY_CRITICAL_HOURS || 24) || 24,
    maxFingerprintCount: 5,
  },
  {
    fromSeverity: 'error',
    toSeverity: 'work',
    minAgeHours: (Number(process.env.HUB_SEVERITY_DECAY_ERROR_DAYS || 7) || 7) * 24,
    maxFingerprintCount: 3,
  },
];

export interface DecayResult {
  ok: boolean;
  demoted: number;
  skipped: number;
  rules_applied: Array<{
    from: string;
    to: string;
    count: number;
    alarm_ids: number[];
  }>;
  error?: string;
}

function isEnabled(): boolean {
  const raw = String(process.env.HUB_SEVERITY_DECAY_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

async function ensureHubAlarmsTable(): Promise<void> {
  try {
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS agent.hub_alarms (
        id BIGSERIAL PRIMARY KEY,
        team TEXT,
        bot_name TEXT,
        severity TEXT,
        alarm_type TEXT,
        title TEXT,
        message TEXT,
        fingerprint TEXT,
        fingerprint_count INT DEFAULT 1,
        visibility TEXT,
        actionability TEXT,
        status TEXT DEFAULT 'new',
        metadata JSONB,
        received_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      )
    `);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS hub_alarms_fingerprint_idx ON agent.hub_alarms(fingerprint)
    `);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS hub_alarms_received_at_idx ON agent.hub_alarms(received_at DESC)
    `);
  } catch {
    // 테이블 이미 존재 — 무시
  }
}

async function applyDecayRule(rule: DecayRule): Promise<{ count: number; alarm_ids: number[] }> {
  try {
    const rows = await pgPool.query('agent', `
      SELECT id, severity, fingerprint_count, received_at
      FROM agent.hub_alarms
      WHERE severity = $1
        AND status NOT IN ('resolved', 'suppressed')
        AND received_at <= NOW() - ($2 * INTERVAL '1 hour')
        AND (fingerprint_count IS NULL OR fingerprint_count < $3)
      ORDER BY received_at ASC
      LIMIT 200
    `, [rule.fromSeverity, rule.minAgeHours, rule.maxFingerprintCount]);

    if (!rows || rows.length === 0) return { count: 0, alarm_ids: [] };

    const ids: number[] = rows.map((r: Record<string, unknown>) => Number(r.id));
    const today = kst.today ? kst.today() : new Date().toISOString().slice(0, 10);

    await pgPool.run('agent', `
      UPDATE agent.hub_alarms
      SET severity = $1,
          metadata = COALESCE(metadata, '{}') || jsonb_build_object(
            'severity_decayed_from', $2,
            'severity_decayed_at', NOW()::text,
            'severity_decay_date', $3
          )
      WHERE id = ANY($4::bigint[])
    `, [rule.toSeverity, rule.fromSeverity, today, ids]);

    return { count: ids.length, alarm_ids: ids };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[severity-decay] ${rule.fromSeverity}→${rule.toSeverity} 실패: ${msg}`);
    return { count: 0, alarm_ids: [] };
  }
}

export async function runSeverityDecay(): Promise<DecayResult> {
  if (!isEnabled()) {
    return { ok: true, demoted: 0, skipped: 0, rules_applied: [] };
  }

  try {
    await ensureHubAlarmsTable();
  } catch {
    // 테이블 확인 실패 — 계속
  }

  const result: DecayResult = {
    ok: true,
    demoted: 0,
    skipped: 0,
    rules_applied: [],
  };

  for (const rule of DECAY_RULES) {
    const { count, alarm_ids } = await applyDecayRule(rule);
    result.demoted += count;
    result.rules_applied.push({
      from: rule.fromSeverity,
      to: rule.toSeverity,
      count,
      alarm_ids: alarm_ids.slice(0, 10), // 로그용 최대 10개
    });
    if (count > 0) {
      console.log(`[severity-decay] ${rule.fromSeverity}→${rule.toSeverity}: ${count}건 강등`);
    }
  }

  return result;
}

module.exports = { runSeverityDecay, isEnabled };
