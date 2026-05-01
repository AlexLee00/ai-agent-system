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
const eventLake = require('../../../../packages/core/lib/event-lake');

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
  dry_run?: boolean;
  rules_applied: Array<{
    from: string;
    to: string;
    count: number;
    alarm_ids: number[];
  }>;
  error?: string;
}

interface SeverityDecayOptions {
  dryRun?: boolean;
  db?: typeof pgPool;
  audit?: typeof eventLake;
  fixtureRows?: Array<Record<string, unknown>>;
  now?: Date;
}

function isEnabled(): boolean {
  const raw = String(process.env.HUB_SEVERITY_DECAY_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

async function ensureHubAlarmsTable(db = pgPool): Promise<void> {
  try {
    await db.run('agent', `
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
    await db.run('agent', `
      CREATE INDEX IF NOT EXISTS hub_alarms_fingerprint_idx ON agent.hub_alarms(fingerprint)
    `);
    await db.run('agent', `
      CREATE INDEX IF NOT EXISTS hub_alarms_received_at_idx ON agent.hub_alarms(received_at DESC)
    `);
  } catch {
    // 테이블 이미 존재 — 무시
  }
}

function fixtureRowsForRule(
  rule: DecayRule,
  rows: Array<Record<string, unknown>>,
  now: Date,
): Array<Record<string, unknown>> {
  const cutoffMs = now.getTime() - rule.minAgeHours * 60 * 60 * 1000;
  return rows.filter((row) => {
    const severity = String(row.severity || '').toLowerCase();
    const status = String(row.status || 'new').toLowerCase();
    const receivedAt = new Date(String(row.received_at || row.receivedAt || now.toISOString())).getTime();
    const count = Number(row.fingerprint_count || row.fingerprintCount || 0);
    return severity === rule.fromSeverity
      && !['resolved', 'suppressed'].includes(status)
      && receivedAt <= cutoffMs
      && count < rule.maxFingerprintCount;
  });
}

async function applyDecayRule(
  rule: DecayRule,
  options: Required<Pick<SeverityDecayOptions, 'dryRun' | 'db' | 'now'>> & Pick<SeverityDecayOptions, 'fixtureRows'>,
): Promise<{ count: number; alarm_ids: number[] }> {
  try {
    const rows = options.fixtureRows
      ? fixtureRowsForRule(rule, options.fixtureRows, options.now)
      : await options.db.query('agent', `
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

    if (!options.dryRun && !options.fixtureRows) {
      await options.db.run('agent', `
        UPDATE agent.hub_alarms
        SET severity = $1,
            metadata = COALESCE(metadata, '{}') || jsonb_build_object(
              'severity_decayed_from', $2,
              'severity_decayed_at', NOW()::text,
              'severity_decay_date', $3
            )
        WHERE id = ANY($4::bigint[])
      `, [rule.toSeverity, rule.fromSeverity, today, ids]);
    }

    return { count: ids.length, alarm_ids: ids };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[severity-decay] ${rule.fromSeverity}→${rule.toSeverity} 실패: ${msg}`);
    return { count: 0, alarm_ids: [] };
  }
}

export async function runSeverityDecay(options: SeverityDecayOptions = {}): Promise<DecayResult> {
  if (!isEnabled()) {
    return { ok: true, demoted: 0, skipped: 0, dry_run: !!options.dryRun, rules_applied: [] };
  }

  const db = options.db || pgPool;
  const dryRun = !!options.dryRun;
  const now = options.now || new Date();

  if (!options.fixtureRows) {
    try {
      await ensureHubAlarmsTable(db);
    } catch {
      // 테이블 확인 실패 — 계속
    }
  }

  const result: DecayResult = {
    ok: true,
    demoted: 0,
    skipped: 0,
    dry_run: dryRun,
    rules_applied: [],
  };

  for (const rule of DECAY_RULES) {
    const { count, alarm_ids } = await applyDecayRule(rule, {
      dryRun,
      db,
      now,
      fixtureRows: options.fixtureRows,
    });
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

  if (result.demoted > 0 && !dryRun && !options.fixtureRows) {
    await (options.audit || eventLake).record({
      eventType: 'hub_alarm_severity_decay',
      team: 'hub',
      botName: 'severity-decay',
      severity: 'info',
      title: 'Severity decay applied',
      message: `${result.demoted} alarms decayed`,
      tags: ['hub', 'alarm', 'severity_decay'],
      metadata: {
        demoted: result.demoted,
        rules_applied: result.rules_applied,
      },
    }).catch(() => null);
  }

  return result;
}

module.exports = { runSeverityDecay, isEnabled };
