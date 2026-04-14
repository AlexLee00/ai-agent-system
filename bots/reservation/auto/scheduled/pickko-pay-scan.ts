#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { publishReservationAlert } = require('../../lib/alert-client');
const {
  parseCsvArg,
  ts,
  writePayScanChecklistFile,
  isAlreadyPaidWithoutButton,
  isExpectedManualFollowup,
  buildPayScanAlertMessage,
} = require('../../lib/report-followup-helpers');
const {
  getManualPendingReservations,
  getVerifiedReservationsForPayScan,
  updateReservation,
  markSeen,
} = require('../../lib/db');

function log(message: string) {
  process.stdout.write(`[${ts()}] ${message}\n`);
}

function runPayPending(entry: any) {
  return new Promise<any>((resolve) => {
    const scriptPath = path.join(
      __dirname,
      '../../../../dist/ts-runtime/bots/reservation/manual/reports/pickko-pay-pending.js',
    );
    const nodeBin = process.execPath || 'node';
    const args = [
      scriptPath,
      `--phone=${String(entry.phone || '').replace(/\D/g, '')}`,
      `--date=${entry.date}`,
      `--start=${entry.start}`,
      `--end=${entry.end}`,
      `--room=${entry.room}`,
    ];

    const child = spawn(nodeBin, args, {
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
      successCount += 1;
      if (result.ok) log(`✅ 결제완료 처리 성공: ${label}`);
      else log(`✅ 결제버튼 없음 → 이미 결제완료로 간주: ${label}`);
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

  const checklistPath = writePayScanChecklistFile(path.join(__dirname, '../../manual/reports'), failures);
  if (failureCount > 0) {
    await publishReservationAlert({
      from_bot: 'ska',
      event_type: 'alert',
      alert_level: 2,
      message: buildPayScanAlertMessage(successCount, failureCount, failures, checklistPath),
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
  } else {
    await publishReservationAlert({
      from_bot: 'ska',
      event_type: 'report',
      alert_level: 1,
      message: `✅ pickko-pay-scan 완료 — 성공 ${successCount}건 / 실패 0건`,
      payload: { successCount, failureCount: 0 },
    }).catch((error: any) => {
      log(`⚠️ 메인봇 보고 실패: ${error.message}`);
    });
  }

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
