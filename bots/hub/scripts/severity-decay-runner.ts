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

async function main() {
  console.log('[severity-decay-runner] 시작');
  const result = await runSeverityDecay();

  if (!result.ok) {
    console.error('[severity-decay-runner] 실패:', result.error);
    process.exit(1);
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
