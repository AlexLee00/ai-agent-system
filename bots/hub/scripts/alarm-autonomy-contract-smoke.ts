#!/usr/bin/env tsx
'use strict';

const { buildAlarmClusterKey } = require('../lib/alarm/cluster.ts');
const { resolveAlarmDeliveryTeam, formatAutoRepairResultMessage } = require('../lib/alarm/templates.ts');
const { buildAlarmReadinessSnapshot } = require('../lib/alarm/readiness.ts');
const { buildAlarmNoiseReport } = require('./alarm-noise-report.ts');
const { scanStaleAutoRepair, _testOnly_annotateRows } = require('./alarm-auto-repair-stale-scan.ts');
const {
  applyAlarmSuppressionProposals,
  buildAlarmSuppressionProposals,
} = require('./alarm-suppression-proposals.ts');
const {
  findMatchingAlarmSuppressionRule,
  loadAlarmSuppressionRules,
} = require('../lib/alarm/suppression-rules.ts');
const fs = require('fs');
const os = require('os');
const path = require('path');

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const originalClassTopics = process.env.HUB_ALARM_USE_CLASS_TOPICS;
  const originalTopicEnv = {
    TELEGRAM_TOPIC_OPS_WORK: process.env.TELEGRAM_TOPIC_OPS_WORK,
    TELEGRAM_TOPIC_OPS_REPORTS: process.env.TELEGRAM_TOPIC_OPS_REPORTS,
    TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION: process.env.TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION,
    TELEGRAM_TOPIC_OPS_EMERGENCY: process.env.TELEGRAM_TOPIC_OPS_EMERGENCY,
  };
  const originalRulesPath = process.env.HUB_ALARM_SUPPRESSION_RULES_PATH;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-alarm-autonomy-'));
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
    assert(stale.stale_minutes === 60, `expected explicit stale minutes to be preserved, got ${stale.stale_minutes}`);
    assert(stale.limit === 5, `expected explicit limit to be preserved, got ${stale.limit}`);
    const staleDefault = await scanStaleAutoRepair({ db });
    assert(staleDefault.stale_minutes === 120, `expected default stale minutes=120, got ${staleDefault.stale_minutes}`);
    assert(staleDefault.limit === 20, `expected default limit=20, got ${staleDefault.limit}`);
    const annotatedResolved = _testOnly_annotateRows([
      {
        team: 'blog',
        bot_name: 'blog-health',
        severity: 'info',
        title: 'blog alarm',
        message: '✅ [블로그 헬스] engagement 자동화 회복',
        event_type: 'blog_health_check',
        incident_key: 'blog:blog-health:sample',
        auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_blog_manifest_sample.md',
      },
      {
        team: 'general',
        bot_name: 'steward',
        severity: 'info',
        title: 'general alarm',
        message: '📋 스튜어드 일일 요약 (2026-06-07)\n\n⚠️ git 위생: 의심 파일 1건',
        event_type: 'steward_error',
        incident_key: 'general:steward:steward_error:sample',
        auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_general_policy_sample.md',
      },
    ], {
      manifest: {
        entries: {
          'docs/auto_dev/ALARM_INCIDENT_blog_manifest_sample.md': {
            relPath: 'docs/auto_dev/ALARM_INCIDENT_blog_manifest_sample.md',
            state: 'archived_missing',
            reason: 'resolved_recovery_info_routed_report',
          },
        },
      },
    });
    assert(annotatedResolved[0].stale_status === 'resolved_manifest', 'expected completed manifest entry to suppress stale scan');
    assert(annotatedResolved[1].stale_status === 'resolved_current_policy', 'expected current policy downgrade to suppress stale scan');
    const lowConfidencePolicy = _testOnly_annotateRows([{
      team: 'unknown',
      bot_name: 'unknown',
      severity: 'info',
      title: 'unclassified alarm',
      message: 'needs review',
      event_type: 'misc',
      incident_key: 'unknown:sample',
      auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_unknown_policy_sample.md',
    }], { manifest: { entries: {} } });
    assert(lowConfidencePolicy[0].stale_status === 'active', 'expected low-confidence default work classification to stay active');
    assert(queryLog.some((sql) => String(sql).includes('FROM agent.hub_alarms')), 'expected stale scan to use hub_alarms state table');
    assert(queryLog.some((sql) => String(sql).includes("hub_alarm_auto_repair_enqueued")), 'expected stale scan to require an auto-repair enqueue event');
    assert(queryLog.some((sql) => String(sql).includes("auto_repair_shadow_skipped")), 'expected stale scan to exclude shadow-skipped repairs');
    assert(queryLog.some((sql) => String(sql).includes("NOT LIKE 'auto_dev_%'")), 'expected stale scan to exclude auto-dev self-generated stage alarms');
    assert(queryLog.some((sql) => String(sql).includes('DISTINCT ON (incident_key)')), 'expected stale scan to dedupe duplicate mirror rows by incident');
    assert(queryLog.some((sql) => String(sql).includes('ORDER BY enqueued_at DESC')), 'expected stale scan to prioritize recently enqueued stale repairs');
    assert(queryLog.some((sql) => String(sql).includes('NOT EXISTS')), 'expected stale scan to exclude completed repairs');

    const proposals = await buildAlarmSuppressionProposals({ minutes: 60, limit: 5, minTotal: 5, db });
    assert(proposals.proposals.length === 1, 'expected one suppression proposal');
    assert(proposals.proposals[0].action === 'route_to_digest', 'expected digest proposal for non-escalated noise');
    process.env.HUB_ALARM_SUPPRESSION_RULES_PATH = path.join(tempRoot, 'rules.json');
    const applied = await applyAlarmSuppressionProposals({ minutes: 60, limit: 5, minTotal: 5, db });
    assert(applied.apply_result.applied_count === 1, 'expected one applied suppression rule');
    assert(loadAlarmSuppressionRules().length === 1, 'expected persisted suppression rule');
    const matched = findMatchingAlarmSuppressionRule({
      team: 'luna',
      fromBot: 'luna',
      alarmType: 'error',
      clusterKey: 'luna|llm_provider_cooldown|abc',
      incidentKey: 'luna|llm_provider_cooldown|abc',
    });
    assert(matched?.action === 'route_to_digest', 'expected suppression rule match');

    process.env.TELEGRAM_TOPIC_OPS_WORK = '11';
    process.env.TELEGRAM_TOPIC_OPS_REPORTS = '12';
    process.env.TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION = '13';
    process.env.TELEGRAM_TOPIC_OPS_EMERGENCY = '14';
    const readiness = buildAlarmReadinessSnapshot();
    assert(readiness.class_topics.ready === true, 'expected class topic readiness with env topic ids');
    assert(readiness.monitors.scripts.suppression_proposals === true, 'expected suppression proposal script readiness');
    assert(readiness.monitors.runtime_launchd?.stale_auto_repair?.label === 'ai.hub.alarm-stale-auto-repair', 'expected stale auto-repair runtime launchd readiness');
    assert(Array.isArray(readiness.monitors.operational_missing), 'expected operational monitor readiness gaps to be explicit');

    console.log('alarm_autonomy_contract_smoke_ok');
  } finally {
    if (originalClassTopics == null) delete process.env.HUB_ALARM_USE_CLASS_TOPICS;
    else process.env.HUB_ALARM_USE_CLASS_TOPICS = originalClassTopics;
    for (const [key, value] of Object.entries(originalTopicEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalRulesPath == null) delete process.env.HUB_ALARM_SUPPRESSION_RULES_PATH;
    else process.env.HUB_ALARM_SUPPRESSION_RULES_PATH = originalRulesPath;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error: any) => {
  console.error('[alarm-autonomy-contract-smoke] failed:', error?.message || error);
  process.exit(1);
});
