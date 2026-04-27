#!/usr/bin/env tsx
'use strict';

const { buildAlarmClusterKey } = require('../lib/alarm/cluster.ts');
const { resolveAlarmDeliveryTeam, formatAutoRepairResultMessage } = require('../lib/alarm/templates.ts');
const { buildAlarmNoiseReport } = require('./alarm-noise-report.ts');
const { scanStaleAutoRepair } = require('./alarm-auto-repair-stale-scan.ts');

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const originalClassTopics = process.env.HUB_ALARM_USE_CLASS_TOPICS;
  const queryLog: string[] = [];
  const db = {
    query: async (_schema: string, sql: string) => {
      queryLog.push(sql);
      if (String(sql).includes('GROUP BY producer')) {
        return [
          {
            producer: 'luna',
            team: 'luna',
            alarm_type: 'error',
            cluster_key: 'luna|llm_provider_cooldown|abc',
            total: 12,
            escalated: 0,
            latest_at: new Date().toISOString(),
          },
        ];
      }
      if (String(sql).includes('NOT EXISTS')) {
        return [
          {
            id: 1,
            team: 'luna',
            bot_name: 'luna',
            severity: 'error',
            message: 'provider cooldown',
            incident_key: 'luna|llm_provider_cooldown|abc',
            auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_luna_abc.md',
            created_at: new Date().toISOString(),
          },
        ];
      }
      return [];
    },
  };

  try {
    const first = buildAlarmClusterKey({
      team: 'luna',
      fromBot: 'luna',
      eventType: 'llm_error',
      title: 'Provider cooldown',
      message: '사용 가능한 LLM provider가 없어 체인을 건너뜀: openai-oauth provider_cooldown 1777271900000',
      payload: { provider: 'openai-oauth' },
    });
    const second = buildAlarmClusterKey({
      team: 'luna',
      fromBot: 'luna',
      eventType: 'llm_error',
      title: 'Provider cooldown',
      message: '사용 가능한 LLM provider가 없어 체인을 건너뜀: openai-oauth provider_cooldown 1777271999999',
      payload: { provider: 'openai-oauth' },
    });
    assert(first === second, `expected similar provider cooldown errors to cluster together: ${first} vs ${second}`);
    assert(first.includes('llm_provider_cooldown'), 'expected cooldown family in cluster key');

    process.env.HUB_ALARM_USE_CLASS_TOPICS = '1';
    assert(resolveAlarmDeliveryTeam({ alarmType: 'work', visibility: 'notify', team: 'luna' }) === 'ops-work', 'expected work class topic');
    assert(resolveAlarmDeliveryTeam({ alarmType: 'report', visibility: 'notify', team: 'blog' }) === 'ops-reports', 'expected report class topic');
    assert(resolveAlarmDeliveryTeam({ alarmType: 'error', visibility: 'notify', team: 'hub' }) === 'ops-error-resolution', 'expected error-result class topic');
    assert(resolveAlarmDeliveryTeam({ alarmType: 'error', visibility: 'emergency', team: 'hub' }) === 'ops-emergency', 'expected emergency class topic');

    const resultMessage = formatAutoRepairResultMessage({
      team: 'luna',
      status: 'resolved',
      incidentKey: first,
      summary: '자동 복구 완료',
      docPath: 'docs/auto_dev/ALARM_INCIDENT_luna_abc.md',
      changedFiles: ['bots/hub/lib/routes/alarm.ts'],
    });
    assert(resultMessage.includes('오류 처리 결과'), 'expected auto-repair result template');

    const noise = await buildAlarmNoiseReport({ minutes: 60, limit: 5, db });
    assert(noise.rows.length === 1, 'expected one noisy producer row');
    assert(noise.message.includes('알람 다이어트 리포트'), 'expected noise report message');

    const stale = await scanStaleAutoRepair({ staleMinutes: 60, limit: 5, db });
    assert(stale.rows.length === 1, 'expected one stale auto-repair row');
    assert(stale.message.includes('auto-repair 미해결 감시'), 'expected stale scan message');
    assert(queryLog.some((sql) => String(sql).includes('NOT EXISTS')), 'expected stale scan to exclude completed repairs');

    console.log('alarm_autonomy_contract_smoke_ok');
  } finally {
    if (originalClassTopics == null) delete process.env.HUB_ALARM_USE_CLASS_TOPICS;
    else process.env.HUB_ALARM_USE_CLASS_TOPICS = originalClassTopics;
  }
}

main().catch((error: any) => {
  console.error('[alarm-autonomy-contract-smoke] failed:', error?.message || error);
  process.exit(1);
});
