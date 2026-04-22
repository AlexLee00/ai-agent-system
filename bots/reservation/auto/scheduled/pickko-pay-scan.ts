#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { publishReservationAlert } = require('../../lib/alert-client');
const { createAgentMemory } = require('../../../../packages/core/lib/agent-memory');
const {
  parseCsvArg,
  ts,
  writePayScanChecklistFile,
  resolvePayScanFollowupFiles,
  isAlreadyPaidWithoutButton,
  isExpectedManualFollowup,
  buildPayScanAlertMessage,
} = require('../../lib/report-followup-helpers');
const {
  getManualPendingReservations,
  getVerifiedReservationsForPayScan,
  getReservationsBySlot,
  hideDuplicateReservationsForSlot,
  updateReservation,
  markSeen,
} = require('../../lib/db');
const {
  chooseCanonicalReservationIdForSlot,
} = require('../../lib/naver-monitor-helpers');
const payScanMemory = createAgentMemory({ agentId: 'reservation.pickko-pay-scan', team: 'reservation' });

function log(message: string) {
  process.stdout.write(`[${ts()}] ${message}\n`);
}

function buildPayScanMemoryQuery(successCount: number, failureCount: number, unexpectedFailureCount: number) {
  return [
    'reservation pickko pay scan',
    failureCount > 0 ? 'has-failure' : 'all-success',
    unexpectedFailureCount > 0 ? 'unexpected-failure' : 'expected-only',
    `success-${successCount}`,
    `failure-${failureCount}`,
  ].filter(Boolean).join(' ');
}

function runPayPending(entry: any) {
  return new Promise<any>((resolve) => {
    const scriptPath = path.join(
      __dirname,
      '../../../../bots/reservation/manual/reports/pickko-pay-pending.ts',
    );
    const tsxBin = path.join(__dirname, '../../../../node_modules/.bin/tsx');
    const args = [
      scriptPath,
      `--phone=${String(entry.phone || '').replace(/\D/g, '')}`,
      `--date=${entry.date}`,
      `--start=${entry.start}`,
      `--end=${entry.end}`,
      `--room=${entry.room}`,
    ];

    const child = spawn(tsxBin, args, {
      cwd: path.dirname(scriptPath),
      env: { ...process.env, MODE: 'ops' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: any) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: any) => { stderr += String(chunk); });

    child.on('error', (error: any) => {
      resolve({ ok: false, exitCode: -1, message: error.message, stdout, stderr });
    });

    child.on('close', (code: number) => {
      let parsed = null;
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed.split('\n').filter(Boolean).at(-1) as string);
        } catch {}
      }
      resolve({
        ok: code === 0 && !!parsed?.success,
        exitCode: code,
        message: parsed?.message || `exit=${code}`,
        stdout,
        stderr,
      });
    });
  });
}

async function reconcileSlotDuplicatesAfterPayScan(entry: any) {
  const slotRows = await getReservationsBySlot(
    entry.phoneRaw || entry.phone,
    entry.date,
    entry.start,
    entry.room,
  ).catch(() => []);

  if (!Array.isArray(slotRows) || slotRows.length <= 1) {
    return { canonicalId: entry.id ? String(entry.id) : null, hiddenCount: 0 };
  }

  const canonicalId = chooseCanonicalReservationIdForSlot(slotRows, entry.id);
  const hiddenCount = canonicalId
    ? await hideDuplicateReservationsForSlot(
        canonicalId,
        entry.phoneRaw || entry.phone,
        entry.date,
        entry.start,
        entry.room,
      ).catch(() => 0)
    : 0;

  return { canonicalId, hiddenCount };
}

async function main() {
  const phoneFilters = parseCsvArg(process.argv, 'phones').map((phone: string) => String(phone).replace(/\D/g, ''));
  const dateFilters = parseCsvArg(process.argv, 'dates');

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const until = new Date();
  until.setDate(until.getDate() + 14);
  const untilDate = until.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

  const manualPending = await getManualPendingReservations(today);
  const verified = await getVerifiedReservationsForPayScan(today, untilDate);
  const deduped = new Map<string, any>();
  for (const entry of [...manualPending, ...verified]) {
    if (!entry?.id) continue;
    if (!deduped.has(entry.id)) deduped.set(entry.id, entry);
  }
  let targets = Array.from(deduped.values());

  if (phoneFilters.length > 0) {
    targets = targets.filter((entry) => phoneFilters.includes(String(entry.phone || '').replace(/\D/g, '')));
  }
  if (dateFilters.length > 0) {
    targets = targets.filter((entry) => dateFilters.includes(entry.date));
  }

  if (targets.length === 0) {
    log('✅ pay-scan 대상 없음');
    return;
  }

  log(`📋 pay-scan 대상 ${targets.length}건 (manual_pending=${manualPending.length}, verified=${verified.length})`);
  if (phoneFilters.length > 0) log(`🔎 phone filter: ${phoneFilters.join(', ')}`);
  if (dateFilters.length > 0) log(`🔎 date filter: ${dateFilters.join(', ')}`);

  let successCount = 0;
  let failureCount = 0;
  let unexpectedFailureCount = 0;
  const failures: any[] = [];
  const resolvedEntries: any[] = [];

  for (const entry of targets) {
    const label = `${entry.date} ${entry.start}~${entry.end} ${entry.room} ${entry.phone}`;
    log(`🚀 결제완료 처리 시작: ${label}`);
    const result = await runPayPending(entry);

    if (result.ok || isAlreadyPaidWithoutButton(entry, result)) {
      await updateReservation(entry.id, {
        pickkoStatus: 'manual',
        errorReason: null,
        pickkoCompleteTime: ts(),
      });
      await markSeen(entry.id);
      const dedupe = await reconcileSlotDuplicatesAfterPayScan(entry).catch(() => null);
      successCount += 1;
      if (result.ok) log(`✅ 결제완료 처리 성공: ${label}`);
      else log(`✅ 결제버튼 없음 → 이미 결제완료로 간주: ${label}`);
      if (dedupe?.hiddenCount > 0) {
        log(`🧹 duplicate slot 정리: canonical=${dedupe.canonicalId} hidden=${dedupe.hiddenCount} (${label})`);
      }
      resolvedEntries.push(entry);
      continue;
    }

    failureCount += 1;
    if (!isExpectedManualFollowup(result)) unexpectedFailureCount += 1;
    await updateReservation(entry.id, {
      errorReason: `pay_scan_failed: ${result.message}`,
    });
    failures.push({ entry, result });
    log(`❌ 결제완료 처리 실패: ${label} (${result.message})`);
    if (result.stderr.trim()) {
      log(`stderr: ${result.stderr.trim().slice(0, 500)}`);
    }
  }

  log(`📊 완료: 성공 ${successCount}건 / 실패 ${failureCount}건`);

  const followupResolution = resolvePayScanFollowupFiles(
    path.join(__dirname, '../../manual/reports'),
    resolvedEntries,
  );
  if (followupResolution.removedEntries > 0) {
    log(
      `🧹 기존 pay-scan follow-up 정리: 항목 ${followupResolution.removedEntries}건 / 파일 수정 ${followupResolution.updatedFiles}건 / 파일 삭제 ${followupResolution.removedFiles}건`,
    );
  }

  const checklistPath = writePayScanChecklistFile(path.join(__dirname, '../../manual/reports'), failures);
  const memoryQuery = buildPayScanMemoryQuery(successCount, failureCount, unexpectedFailureCount);
  const episodicHint = await payScanMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 후속처리',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      alert: '실패',
      report: '정상',
    },
    order: ['alert', 'report'],
  }).catch(() => '');
  const semanticHint = await payScanMemory.recallHint(`${memoryQuery} consolidated pay scan pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');

  if (failureCount > 0) {
    const message = `${buildPayScanAlertMessage(successCount, failureCount, failures, checklistPath)}${episodicHint}${semanticHint}`;
    await publishReservationAlert({
      from_bot: 'ska',
      event_type: 'alert',
      alert_level: 2,
      message,
      payload: {
        successCount,
        failureCount,
        unexpectedFailureCount,
        failures: failures.map(({ entry, result }) => ({
          id: entry.id,
          phone: entry.phone,
          date: entry.date,
          start: entry.start,
          end: entry.end,
          room: entry.room,
          reason: result.message,
        })),
      },
    }).catch((error: any) => {
      log(`⚠️ 메인봇 알림 실패: ${error.message}`);
    });
    await payScanMemory.remember(message, 'episodic', {
      importance: unexpectedFailureCount > 0 ? 0.82 : 0.72,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: {
        kind: 'alert',
        successCount,
        failureCount,
        unexpectedFailureCount,
      },
    }).catch(() => {});
  } else {
    const message = `✅ pickko-pay-scan 완료 — 성공 ${successCount}건 / 실패 0건${episodicHint}${semanticHint}`;
    await publishReservationAlert({
      from_bot: 'ska',
      event_type: 'report',
      alert_level: 1,
      message,
      payload: { successCount, failureCount: 0 },
    }).catch((error: any) => {
      log(`⚠️ 메인봇 보고 실패: ${error.message}`);
    });
    await payScanMemory.remember(message, 'episodic', {
      importance: 0.64,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: {
        kind: 'report',
        successCount,
        failureCount: 0,
        unexpectedFailureCount: 0,
      },
    }).catch(() => {});
  }

  await payScanMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});

  if (unexpectedFailureCount > 0) process.exitCode = 1;
}

module.exports = {
  log,
  runPayPending,
  main,
};

main().catch((error: any) => {
  log(`❌ 치명적 오류: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
