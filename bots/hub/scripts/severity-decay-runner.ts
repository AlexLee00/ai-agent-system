#!/usr/bin/env tsx
'use strict';

/**
 * severity-decay-runner.ts — Severity Decay 실행기
 *
 * launchd ai.hub.severity-decay (StartInterval: 3600, 매시간)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { runSeverityDecay } = require('../lib/alarm/severity-decay');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const kst = require('../../../packages/core/lib/kst');

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const DRY_RUN = hasFlag('dry-run') || ['1', 'true', 'yes', 'y', 'on'].includes(
  String(process.env.HUB_SEVERITY_DECAY_DRY_RUN || '').trim().toLowerCase(),
);
const JSON_OUTPUT = hasFlag('json');
const FIXTURE_MODE = hasFlag('fixture') || ['1', 'true', 'yes', 'y', 'on'].includes(
  String(process.env.HUB_SEVERITY_DECAY_FIXTURE || '').trim().toLowerCase(),
);

function fixtureRows(): Array<Record<string, unknown>> {
  const now = Date.now();
  return [
    {
      id: 1001,
      severity: 'critical',
      status: 'new',
      fingerprint_count: 2,
      received_at: new Date(now - 26 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 1002,
      severity: 'critical',
      status: 'new',
      fingerprint_count: 8,
      received_at: new Date(now - 30 * 60 * 60 * 1000).toISOString(),
    },
    {
      id: 1003,
      severity: 'error',
      status: 'new',
      fingerprint_count: 1,
      received_at: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ];
}

async function main() {
  console.log('[severity-decay-runner] 시작');
  const result = await runSeverityDecay({
    dryRun: DRY_RUN,
    fixtureRows: FIXTURE_MODE ? fixtureRows() : undefined,
  });

  if (!result.ok) {
    console.error('[severity-decay-runner] 실패:', result.error);
    process.exit(1);
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ ok: true, fixture: FIXTURE_MODE, ...result }, null, 2));
  }

  if (result.demoted === 0) {
    console.log('[severity-decay-runner] 강등 대상 없음 — 종료');
    return;
  }

  // 강등 발생 시 digest 알람 발송
  const today = kst.today ? kst.today() : new Date().toISOString().slice(0, 10);
  const hour = new Date().getHours().toString().padStart(2, '0');
  const lines = [
    `🔽 [Severity Decay] ${result.demoted}건 강등`,
    `시각: ${kst.datetimeStr ? kst.datetimeStr() : new Date().toISOString()} KST`,
    '',
    ...result.rules_applied
      .filter((r) => r.count > 0)
      .map((r) => `  ${r.from} → ${r.to}: ${r.count}건`),
  ];

  const message = lines.join('\n');
  console.log('[severity-decay-runner]', message);

  if (DRY_RUN || FIXTURE_MODE) {
    console.log('[severity-decay-runner] dry-run/fixture — Telegram 발송 스킵');
    return;
  }

  await postAlarm({
    team: 'hub',
    fromBot: 'severity-decay-runner',
    alertLevel: 1,
    alarmType: 'report',
    visibility: 'digest',
    title: `[Severity Decay] ${result.demoted}건 강등`,
    message,
    eventType: 'severity_decay',
    incidentKey: `hub:severity_decay:${today}:${hour}`,
    payload: {
      event_type: 'severity_decay',
      demoted: result.demoted,
      rules_applied: result.rules_applied,
    },
  });

  console.log('[severity-decay-runner] 완료');
}

main().catch((err: Error) => {
  console.error('[severity-decay-runner] 치명적 오류:', err.message);
  process.exit(1);
});
