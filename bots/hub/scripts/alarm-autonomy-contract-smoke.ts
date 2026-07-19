#!/usr/bin/env tsx
'use strict';

const { buildAlarmClusterKey } = require('../lib/alarm/cluster.ts');
const { classifyAlarmTypeWithConfidence } = require('../lib/alarm/policy.ts');
const { resolveAlarmDeliveryTeam, formatAutoRepairResultMessage } = require('../lib/alarm/templates.ts');
const { buildAlarmReadinessSnapshot } = require('../lib/alarm/readiness.ts');
const { buildAlarmNoiseReport } = require('./alarm-noise-report.ts');
const {
  scanStaleAutoRepair,
  _testOnly_annotateRows,
  _testOnly_buildActiveIncidentFingerprint,
  _testOnly_buildStaleAlarmInput,
  _testOnly_isResolvedManifestReason,
  _testOnly_resolveRowsByCurrentState,
} = require('./alarm-auto-repair-stale-scan.ts');
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

    const promotionGateReady = classifyAlarmTypeWithConfidence({
      severity: 'warn',
      eventType: 'telegram_send',
      title: 'ops-error-resolution alarm',
      message: [
        '🚀 [루나] 하이브리드 승급 게이트 — 마스터 검토 요청',
        'Phase 1~10 Shadow 검증 통과:',
        '상태: luna_hybrid_promotion_gate_ready_for_master_review',
        '⚠️ 자동 LIVE 전환 없음 — gate는 read-only, 마스터 승인 runbook 필요',
      ].join('\n'),
    });
    assert(promotionGateReady.type === 'report', 'read-only promotion-gate readiness must not route to auto-repair');
    assert(promotionGateReady.confidence >= 0.9, 'promotion-gate readiness classification must be high confidence');

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
    const fingerprintA = _testOnly_buildActiveIncidentFingerprint([
      { incident_key: 'incident:b', enqueue_event_id: 2 },
      { incident_key: 'incident:a', enqueue_event_id: 1 },
    ]);
    const fingerprintB = _testOnly_buildActiveIncidentFingerprint([
      { incident_key: 'incident:a', enqueue_event_id: 1 },
      { incident_key: 'incident:b', enqueue_event_id: 2 },
    ]);
    const fingerprintChanged = _testOnly_buildActiveIncidentFingerprint([
      { incident_key: 'incident:a', enqueue_event_id: 1 },
      { incident_key: 'incident:c', enqueue_event_id: 3 },
    ]);
    assert(fingerprintA === fingerprintB, 'active incident fingerprint must be order independent');
    assert(fingerprintA !== fingerprintChanged, 'active incident fingerprint must change with membership');
    const staleAlarmInput = _testOnly_buildStaleAlarmInput({
      ...stale,
      active_count: stale.rows.length,
      active_fingerprint: fingerprintA,
    });
    assert(staleAlarmInput.incidentKey.endsWith(fingerprintA.slice(0, 16)), 'stale alarm key must follow active set fingerprint');
    assert(staleAlarmInput.dedupeMinutes === 1440, 'unchanged stale set must notify at most once per day');
    assert(_testOnly_isResolvedManifestReason('completed') === true, 'completed must remain a resolved manifest reason');
    assert(_testOnly_isResolvedManifestReason('implementation_not_completed_requires_followup') === false, 'negative completion reasons must remain active');
    assert(_testOnly_isResolvedManifestReason('manual_review_required') === false, 'manual review must remain active');
    assert(_testOnly_isResolvedManifestReason('manual_action_needed') === false, 'manual action must remain active');
    const completedArchiveDir = path.join(tempRoot, 'codex-completed');
    const nestedCompletedArchiveDir = path.join(completedArchiveDir, 'root-stale', '2026-06-10');
    fs.mkdirSync(nestedCompletedArchiveDir, { recursive: true });
    fs.writeFileSync(path.join(nestedCompletedArchiveDir, '2026-06-10__replayed__ALARM_INCIDENT_blog_archive_sample.md'), [
      '---',
      'incident_key: blog:blog-health:archive-sample',
      '- event_id: 4242',
      '---',
      '# completed archive sample',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(nestedCompletedArchiveDir, '2026-06-10__replayed__ALARM_INCIDENT_blog_generation_sample.md'), [
      '---',
      'incident_key: blog:blog-health:generation-sample',
      'event_id: old-generation',
      '---',
      '# completed old generation sample',
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
        alarm_event_id: '4242',
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
      {
        team: 'blog',
        bot_name: 'blog-health',
        severity: 'error',
        title: 'blog alarm',
        message: 'new generation remains unresolved',
        event_type: 'blog_health_error',
        incident_key: 'blog:blog-health:generation-sample',
        alarm_event_id: 'new-generation',
        auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_blog_generation_sample.md',
      },
      {
        team: 'blog',
        bot_name: 'blog-health',
        severity: 'error',
        title: 'blog alarm',
        message: 'manifest without generation remains unresolved',
        event_type: 'blog_health_error',
        incident_key: 'blog:blog-health:manifest-generation-sample',
        alarm_event_id: 'manifest-new-generation',
        auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_blog_manifest_generation_sample.md',
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
          'docs/auto_dev/ALARM_INCIDENT_blog_manifest_generation_sample.md': {
            relPath: 'docs/auto_dev/ALARM_INCIDENT_blog_manifest_generation_sample.md',
            state: 'archived_missing',
            reason: 'completed',
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
    assert(annotatedResolved[7].stale_status === 'active', 'an archive from an older alarm generation must not resolve a newer generation');
    assert(annotatedResolved[8].stale_status === 'active', 'a manifest without generation evidence must not resolve a generation-bound alarm');

    const fixturePhone = ['010', '1111', '2222'].join('-');
    const differentFixturePhone = ['010', '9999', '0000'].join('-');
    const completedReservationAlarm = {
      team: 'reservation',
      bot_name: 'andy',
      severity: 'error',
      message: [
        '❌ 픽코 예약 실패',
        `📞 번호: ${fixturePhone}`,
        '📅 날짜: 2026-07-20',
        '⏰ 시간: 19:00~20:00',
        '🏛️ 룸: A1',
      ].join('\n'),
      event_type: 'alert',
      incident_key: 'reservation:andy:alert:completion-sample',
      enqueued_at: '2026-07-19T02:00:00.000Z',
      stale_status: 'active',
    };
    const completionDb = {
      query: async (schema: string, sql: string, params: unknown[]) => {
        assert(schema === 'reservation', 'reservation completion resolver must use the reservation schema');
        assert(String(sql).includes('FROM reservation.reservations'), 'reservation completion resolver must query current reservations');
        assert(/updated_at\s*>\s*to_char/.test(String(sql)), 'reservation completion resolver must fail closed on same-second evidence');
        assert(params[0] === '2026-07-20' && params[1] === '19:00' && params[2] === '20:00', 'reservation completion resolver must preserve the exact slot');
        assert(Array.isArray(params[4]) && params[4].includes('paid'), 'normal completed/paid evidence must resolve stale reservation alarms');
        return [{
          id: '1296595063',
          phone: fixturePhone,
          room: 'A1',
          status: 'completed',
          pickko_status: 'manual_retry',
          pickko_order_id: '23776596',
          updated_after_alarm: true,
        }];
      },
    };
    const resolvedReservation = await _testOnly_resolveRowsByCurrentState([completedReservationAlarm], completionDb);
    assert(resolvedReservation[0].stale_status === 'resolved_current_state', 'exact post-alarm reservation completion must resolve stale state');

    const wrongCustomerDb = {
      query: async () => [{
        id: 'other-customer',
        phone: differentFixturePhone,
        room: 'A1',
        status: 'completed',
        pickko_status: 'manual_retry',
        pickko_order_id: 'other-order',
        updated_after_alarm: true,
      }],
    };
    const wrongCustomer = await _testOnly_resolveRowsByCurrentState([completedReservationAlarm], wrongCustomerDb);
    assert(wrongCustomer[0].stale_status === 'active', 'a different customer in the same slot must not resolve stale state');

    const oldEvidenceDb = {
      query: async () => [{
        id: 'old-evidence',
        phone: fixturePhone,
        room: 'A1',
        status: 'completed',
        pickko_status: 'manual_retry',
        pickko_order_id: 'old-order',
        updated_after_alarm: false,
      }],
    };
    const oldEvidence = await _testOnly_resolveRowsByCurrentState([completedReservationAlarm], oldEvidenceDb);
    assert(oldEvidence[0].stale_status === 'active', 'completion evidence older than the alarm must not resolve stale state');

    const failedResolver = await _testOnly_resolveRowsByCurrentState([completedReservationAlarm], {
      query: async () => { throw new Error('db unavailable'); },
    });
    assert(failedResolver[0].stale_status === 'active', 'current-state lookup failure must fail closed');
    assert(failedResolver[0].current_state_resolution_error === 'db unavailable', 'current-state lookup failure must remain observable');
    const backfillPlan = _testOnly_buildBackfillPlan([
      { id: 11, alarm_event_id: '1011', incident_key: 'blog:sample', team: 'blog', bot_name: 'blog-health', stale_status: 'resolved_manifest', stale_resolution_reason: 'manifest_archived_file_exists' },
      { id: 12, alarm_event_id: '1012', incident_key: 'general:steward:sample', team: 'general', bot_name: 'steward', stale_status: 'resolved_current_policy', stale_resolution_reason: 'current_policy:report' },
      { id: 13, alarm_event_id: '1013', incident_key: 'blog:dead-letter', team: 'blog', bot_name: 'blog-commenter', stale_status: 'terminal_dead_letter', stale_resolution_reason: 'auto_dev_dead_letter_result_recorded' },
    ]);
    assert(backfillPlan[0].mirror_status === 'resolved', 'manifest-resolved stale rows must backfill mirror status to resolved');
    assert(backfillPlan[0].result_status === 'resolved', 'manifest-resolved stale rows must emit resolved repair result');
    assert(backfillPlan[1].mirror_status === 'verified', 'policy-resolved stale rows must backfill mirror status to verified');
    assert(backfillPlan[1].result_status === 'partially_resolved', 'policy-resolved stale rows must emit partial repair result');
    assert(backfillPlan[2].mirror_status === 'exhausted', 'terminal dead-letter rows must backfill mirror status to exhausted');
    assert(backfillPlan[2].result_status === 'unresolved_needs_human', 'terminal dead-letter rows must preserve unresolved result status');
    assert(backfillPlan[0].alarm_event_id === '1011', 'backfill must preserve the exact alarm generation');
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
    assert(
      queryLog.some((sql) => String(sql).includes('ORDER BY incident_key, created_at DESC, enqueued_at DESC NULLS LAST')),
      'expected stale scan to select the latest mirror generation before enqueue filtering',
    );
    assert(queryLog.some((sql) => String(sql).includes('NOT EXISTS')), 'expected stale scan to exclude completed repairs');
    assert(queryLog.some((sql) => String(sql).includes("COALESCE(event.metadata->>'created', 'true') = 'true'")), 'expected stale generation to ignore created=false re-enqueues');
    assert(queryLog.some((sql) => String(sql).includes("event.metadata->>'alarm_event_id' = alarm.metadata->>'event_id'")), 'expected stale generation to stay bound to the alarm that created the document');
    assert(queryLog.some((sql) => String(sql).includes("result.metadata->>'alarm_event_id' = latest_by_incident.alarm_event_id")), 'expected repair results to stay bound to the same alarm generation');
    assert(queryLog.some((sql) => String(sql).includes("result.metadata->>'callback_committed' = 'true'")), 'expected stale scan to ignore uncommitted callback results');
    assert(
      queryLog.some((sql) => {
        const text = String(sql);
        return text.indexOf('latest_by_incident AS') < text.indexOf("enqueued_at < NOW() - ($1::int * INTERVAL '1 minute')");
      }),
      'expected stale age filtering to happen after selecting the latest incident generation',
    );
    assert(
      queryLog.some((sql) => {
        const text = String(sql);
        const latestGeneration = text.indexOf('latest_by_incident AS');
        const terminalFilter = text.indexOf("COALESCE(alarm_status, '') IN ('repairing', 'correlating')");
        const resultFilter = text.indexOf('AND NOT EXISTS');
        return latestGeneration >= 0
          && latestGeneration < terminalFilter
          && latestGeneration < resultFilter;
      }),
      'expected terminal/result filtering to happen after selecting the latest incident generation',
    );
    assert(queryLog.some((sql) => String(sql).includes('enqueued_at < NOW()')), 'expected stale age to start at the latest enqueue time');

    const pagedManifestEntries: Record<string, Record<string, string>> = {};
    for (let index = 0; index < 100; index += 1) {
      pagedManifestEntries[`docs/auto_dev/ALARM_INCIDENT_resolved_${index}.md`] = {
        relPath: `docs/auto_dev/ALARM_INCIDENT_resolved_${index}.md`,
        state: 'archived_missing',
        reason: 'completed',
      };
    }
    let candidatePageQueries = 0;
    const pagedDb = {
      query: async (schema: string, sql: string, params: unknown[] = []) => {
        if (schema !== 'agent' || !String(sql).includes('FROM agent.hub_alarms')) return [];
        candidatePageQueries += 1;
        const pageSize = Number(params[1] || 1);
        const offset = Number(params[2] || 0);
        if (offset === 0) {
          return Array.from({ length: pageSize }, (_, index) => ({
            id: index + 1,
            team: 'blog',
            bot_name: 'blog-health',
            severity: 'error',
            message: 'resolved fixture',
            incident_key: `resolved:${index}`,
            enqueue_event_id: index + 100,
            auto_dev_path: `docs/auto_dev/ALARM_INCIDENT_resolved_${index}.md`,
            created_at: new Date().toISOString(),
            enqueued_at: new Date().toISOString(),
          }));
        }
        if (offset === pageSize) {
          return [{
            id: 999,
            team: 'darwin',
            bot_name: 'implementor',
            severity: 'error',
            message: 'still active',
            incident_key: 'darwin:active:after-resolved-page',
            enqueue_event_id: 999,
            auto_dev_path: 'docs/auto_dev/ALARM_INCIDENT_active_after_page.md',
            created_at: new Date().toISOString(),
            enqueued_at: new Date().toISOString(),
          }];
        }
        return [];
      },
    };
    const pagedStale = await scanStaleAutoRepair({
      limit: 1,
      db: pagedDb,
      manifest: { entries: pagedManifestEntries },
      archiveDir: path.join(tempRoot, 'missing-paged-archive'),
    });
    assert(pagedStale.rows.length === 1, 'resolved candidates must not consume the active row limit');
    assert(pagedStale.rows[0].incident_key === 'darwin:active:after-resolved-page', 'later active candidate must be discovered');
    assert(candidatePageQueries >= 2, 'stale scan must page beyond resolved candidates');

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
