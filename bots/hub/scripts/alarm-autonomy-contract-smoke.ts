#!/usr/bin/env tsx
'use strict';

const { buildAlarmClusterKey } = require('../lib/alarm/cluster.ts');
const { classifyAlarmTypeWithConfidence } = require('../lib/alarm/policy.ts');
const { resolveAlarmDeliveryTeam, formatAutoRepairResultMessage } = require('../lib/alarm/templates.ts');
const { buildAlarmReadinessSnapshot } = require('../lib/alarm/readiness.ts');
const { buildAlarmNoiseReport } = require('./alarm-noise-report.ts');
const { scanStaleAutoRepair, _testOnly_annotateRows } = require('./alarm-auto-repair-stale-scan.ts');
const { APPLY_CONFIRM_TOKEN, _testOnly_buildBackfillPlan, _testOnly_isApplyConfirmed } = require('./alarm-auto-repair-stale-backfill.ts');
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

    const naverSourceUnavailable = classifyAlarmTypeWithConfidence({
      severity: 'error',
      eventType: 'alert',
      title: 'reservation alarm',
      message: '⚠️ 네이버 원천 분류 불가 — 자동 처리 중단\n📊 상태: Pickko 후보 미분류\nℹ️ 사유: naver-monitor 미실행. 네이버 live 확정 목록 없이 예약불가/해제를 실행하지 않음',
    });
    assert(naverSourceUnavailable.type === 'work', 'naver source-unavailable guard alerts must not route to auto-repair');
    assert(naverSourceUnavailable.confidence >= 0.9, 'naver source-unavailable guard classification must be high confidence');

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
    const completedArchiveDir = path.join(tempRoot, 'codex-completed');
    fs.mkdirSync(completedArchiveDir, { recursive: true });
    fs.writeFileSync(path.join(completedArchiveDir, '2026-06-10__replayed__ALARM_INCIDENT_blog_archive_sample.md'), [
      '---',
      'incident_key: blog:blog-health:archive-sample',
      '---',
      '# completed archive sample',
    ].join('\n'), 'utf8');
    const deadLetterProcessedDir = path.join(tempRoot, 'processed');
    fs.mkdirSync(deadLetterProcessedDir, { recursive: true });
    fs.writeFileSync(path.join(deadLetterProcessedDir, 'ALARM_INCIDENT_blog_dead_letter_sample.deadbeef.md'), [
      '---',
      'incident_key: blog:blog-commenter:dead-letter-sample',
      '---',
      '# dead-letter sample',
    ].join('\n'), 'utf8');
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
      {
        team: 'blog',
        bot_name: 'blog-health',
        severity: 'error',
        title: 'blog alarm',
        message: 'old repair has completed archive document',
        event_type: 'blog_health_error',
        incident_key: 'blog:blog-health:archive-sample',
        auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_blog_archive_sample.md',
      },
      {
        team: 'blog',
        bot_name: 'blog-commenter',
        severity: 'error',
        title: 'blog alarm',
        message: 'transient reply failure archived as operational noise',
        event_type: 'blog-commenter_error',
        incident_key: 'blog:blog-commenter:operational-noise-sample',
        auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_blog_operational_noise_sample.md',
      },
      {
        team: 'reservation',
        bot_name: 'jimmy',
        severity: 'error',
        title: 'reservation alarm',
        message: '⚠️ 네이버 원천 분류 불가 — 자동 처리 중단\n📊 상태: Pickko 후보 미분류\nℹ️ 사유: naver-monitor 미실행. 네이버 live 확정 목록 없이 예약불가/해제를 실행하지 않음',
        event_type: 'alert',
        incident_key: 'reservation:jimmy:alert:source-unavailable-sample',
        auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_reservation_source_unavailable_sample.md',
      },
      {
        team: 'blog',
        bot_name: 'blog-commenter',
        severity: 'error',
        title: 'blog alarm',
        message: 'auto-dev reached its terminal dead-letter state',
        event_type: 'blog-commenter_error',
        incident_key: 'blog:blog-commenter:dead-letter-sample',
        auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_blog_dead_letter_sample.md',
      },
      {
        team: 'blog',
        bot_name: 'blog-commenter',
        severity: 'error',
        title: 'blog alarm',
        message: 'dead-letter manifest without processed evidence',
        event_type: 'blog-commenter_error',
        incident_key: 'blog:blog-commenter:dead-letter-missing',
        auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_blog_dead_letter_missing.md',
      },
    ], {
      manifest: {
        entries: {
          'docs/auto_dev/ALARM_INCIDENT_blog_manifest_sample.md': {
            relPath: 'docs/auto_dev/ALARM_INCIDENT_blog_manifest_sample.md',
            state: 'archived_missing',
            reason: 'resolved_recovery_info_routed_report',
          },
          'docs/auto_dev/ALARM_INCIDENT_blog_operational_noise_sample.md': {
            relPath: 'docs/auto_dev/ALARM_INCIDENT_blog_operational_noise_sample.md',
            state: 'archived_missing',
            reason: 'operational_noise_archived',
          },
          'docs/auto_dev/ALARM_INCIDENT_blog_dead_letter_sample.md': {
            relPath: 'docs/auto_dev/ALARM_INCIDENT_blog_dead_letter_sample.md',
            state: 'dead_letter',
            contentHash: 'deadbeef',
            deadLetteredAt: '2026-07-17T00:00:00.000Z',
          },
          'docs/auto_dev/ALARM_INCIDENT_blog_dead_letter_missing.md': {
            relPath: 'docs/auto_dev/ALARM_INCIDENT_blog_dead_letter_missing.md',
            state: 'dead_letter',
            contentHash: 'missing',
            deadLetteredAt: '2026-07-17T00:00:00.000Z',
          },
        },
      },
      archiveDir: completedArchiveDir,
      processedDir: deadLetterProcessedDir,
    });
    assert(annotatedResolved[0].stale_status === 'resolved_manifest', 'expected completed manifest entry to suppress stale scan');
    assert(annotatedResolved[1].stale_status === 'resolved_current_policy', 'expected current policy downgrade to suppress stale scan');
    assert(annotatedResolved[2].stale_status === 'resolved_manifest', 'expected completed archive document to suppress stale scan');
    assert(annotatedResolved[2].stale_resolution_reason === 'completed_archive_document_matches_incident', 'expected archive evidence reason');
    assert(annotatedResolved[3].stale_status === 'resolved_manifest', 'expected operational-noise manifest reason to suppress stale scan');
    assert(annotatedResolved[4].stale_status === 'resolved_current_policy', 'expected naver source-unavailable guard to suppress stale auto-repair');
    assert(annotatedResolved[5].stale_status === 'terminal_dead_letter', 'expected processed dead-letter result to suppress missing-result stale scan');
    assert(annotatedResolved[6].stale_status === 'active', 'expected dead-letter manifest without processed evidence to stay active');
    const backfillPlan = _testOnly_buildBackfillPlan([
      { id: 11, incident_key: 'blog:sample', team: 'blog', bot_name: 'blog-health', stale_status: 'resolved_manifest', stale_resolution_reason: 'manifest_archived_file_exists' },
      { id: 12, incident_key: 'general:steward:sample', team: 'general', bot_name: 'steward', stale_status: 'resolved_current_policy', stale_resolution_reason: 'current_policy:report' },
      { id: 13, incident_key: 'blog:dead-letter', team: 'blog', bot_name: 'blog-commenter', stale_status: 'terminal_dead_letter', stale_resolution_reason: 'auto_dev_dead_letter_result_recorded' },
    ]);
    assert(backfillPlan[0].mirror_status === 'resolved', 'manifest-resolved stale rows must backfill mirror status to resolved');
    assert(backfillPlan[0].result_status === 'resolved', 'manifest-resolved stale rows must emit resolved repair result');
    assert(backfillPlan[1].mirror_status === 'verified', 'policy-resolved stale rows must backfill mirror status to verified');
    assert(backfillPlan[1].result_status === 'partially_resolved', 'policy-resolved stale rows must emit partial repair result');
    assert(backfillPlan[2].mirror_status === 'exhausted', 'terminal dead-letter rows must backfill mirror status to exhausted');
    assert(backfillPlan[2].result_status === 'unresolved_needs_human', 'terminal dead-letter rows must preserve unresolved result status');
    assert(_testOnly_isApplyConfirmed(APPLY_CONFIRM_TOKEN), 'expected stale backfill apply confirm token to be accepted');
    assert(!_testOnly_isApplyConfirmed(''), 'expected stale backfill apply without confirm token to be rejected');
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
    const unresolvedPatchFollowup = _testOnly_annotateRows([{
      team: 'blog',
      bot_name: 'blog-health',
      severity: 'error',
      title: 'blog alarm',
      message: 'still broken',
      event_type: 'blog_error',
      incident_key: 'blog:sample:unpatched',
      auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_blog_unpatched_sample.md',
    }], {
      manifest: {
        entries: {
          'docs/auto_dev/ALARM_INCIDENT_blog_unpatched_sample.md': {
            relPath: 'docs/auto_dev/ALARM_INCIDENT_blog_unpatched_sample.md',
            state: 'archived_missing',
            reason: 'not_patched_requires_followup',
          },
        },
      },
      archiveDir: path.join(tempRoot, 'missing-archive-dir'),
    });
    assert(unresolvedPatchFollowup[0].stale_status === 'active', 'expected unresolved patch follow-up reason to stay active');
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
