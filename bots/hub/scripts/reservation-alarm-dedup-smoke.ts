#!/usr/bin/env tsx

const fs = require('node:fs');
const path = require('node:path');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function main(): void {
  const reportingHub = readRepoFile('packages/core/lib/reporting-hub.ts');
  const alertClient = readRepoFile('bots/reservation/lib/alert-client.ts');
  const healthCheck = readRepoFile('bots/reservation/scripts/health-check.ts');

  assert(
    reportingHub.includes('dedupe_minutes?: number') &&
      reportingHub.includes('dedupeMinutes?: number') &&
      reportingHub.includes('cooldown_minutes?: number') &&
      reportingHub.includes('cooldownMinutes?: number'),
    'reporting-hub must accept producer dedupe/cooldown aliases',
  );
  assert(
    reportingHub.includes('function normalizeDedupeMinutes') &&
      reportingHub.includes('dedupeMinutes: normalized.dedupe_minutes'),
    'reporting-hub must normalize and forward dedupeMinutes to hub-alarm-client',
  );

  assert(
    alertClient.includes('incident_key?: string') &&
      alertClient.includes('dedupe_minutes?: number') &&
      alertClient.includes('incident_key,') &&
      alertClient.includes('dedupe_minutes: dedupe_minutes ?? dedupeMinutes ?? cooldown_minutes ?? cooldownMinutes'),
    'reservation alert-client must propagate incident_key and dedupe_minutes',
  );

  const kioskMonitorHelpers = readRepoFile('bots/reservation/lib/kiosk-monitor-helpers.ts');
  assert(
    kioskMonitorHelpers.includes('const RETRYABLE_BLOCK_DEDUPE_MINUTES = 12 * 60') &&
      kioskMonitorHelpers.includes('export function buildRetryableBlockIncidentKey') &&
      kioskMonitorHelpers.includes('incident_key: options.incidentKey || buildRetryableBlockIncidentKey(entry, reason, sourceLabel)') &&
      kioskMonitorHelpers.includes('dedupe_minutes: options.dedupe_minutes ?? options.dedupeMinutes ?? RETRYABLE_BLOCK_DEDUPE_MINUTES'),
    'retryable Naver block alerts must use stable incident keys and 12h dedupe',
  );

  assert(
    healthCheck.includes('const TODAY_AUDIT_DEDUPE_MINUTES = 12 * 60') &&
      healthCheck.includes('todayAuditIncidentDate') &&
      healthCheck.includes('reservation:ska:health_check:today_audit_missing') &&
      healthCheck.includes('reservation:ska:health_check:today_audit_partial') &&
      healthCheck.includes('reservation:ska:health_check:today_audit_failed'),
    'health-check today-audit alerts must use stable daily incident keys and 12h dedupe',
  );
  assert(
    healthCheck.includes('dedupe_minutes: dedupeMinutes') &&
      healthCheck.includes("k.startsWith('audit-missing:ai.ska.today-audit:')"),
    'health-check must pass dedupe to publishReservationAlert and clear dated missing keys',
  );
  assert(
    healthCheck.includes('const todayAuditIssue = todayAudit.issue') &&
      healthCheck.includes("todayAuditIssue === 'ok'") &&
      healthCheck.includes("todayAuditIssue === 'partial'") &&
      healthCheck.includes('const selected = latestCompletion') &&
      healthCheck.includes('const hasInternalFailure = isTodayCompletion && Number(summary?.failedCount || 0) > 0') &&
      healthCheck.includes('const hasFailedExit = isTodayCompletion && lastExitCode != null && lastExitCode !== 0') &&
      healthCheck.includes('const isExpectedCompletion = shouldHaveRunToday ? isTodayCompletion : Boolean(selected && isTodayCompletion)') &&
      healthCheck.includes('const recentSuccess = isExpectedCompletion && lastExitCode === 0 && !hasInternalFailure'),
    'health-check must classify only today-scoped today-audit completions before alert/recovery decisions',
  );

  console.log('✅ reservation_alarm_dedup_smoke_ok');
}

main();
