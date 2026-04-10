#!/usr/bin/env node
'use strict';

/**
 * pickko-pay-scan.js
 *
 * 목적:
 *   completed + manual_pending 상태로 남은 미래 예약을 찾아
 *   pickko-pay-pending.js 로 결제완료 후속 처리를 수행한다.
 *
 * 배경:
 *   TS 전환 이후 launchd 엔트리(ai.ska.pickko-pay-scan)는 남아 있었지만
 *   실제 실행 스크립트가 비어 있어 결제대기 후속 자동화가 공백 상태였다.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { publishToMainBot } = require('../../lib/mainbot-client');
const {
  getManualPendingReservations,
  getVerifiedReservationsForPayScan,
  updateReservation,
  markSeen,
} = require('../../lib/db.legacy.js');

function getArgValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

function parseCsvArg(name) {
  return getArgValue(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function ts() {
  return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

function log(message) {
  process.stdout.write(`[${ts()}] ${message}\n`);
}

function buildFailureLine(entry, result) {
  return `- ${entry.date} ${entry.start}~${entry.end} ${entry.room}룸 / ${entry.phone} / ${result.message}`;
}

function writeChecklistFile(failures) {
  if (!failures.length) return null;
  const dir = path.join(__dirname, '../../manual/reports');
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(/[-: ]/g, '').slice(0, 13);
  const filePath = path.join(dir, `pickko-pay-scan-followup-${stamp}.md`);
  const lines = [
    '# Pickko Pay Scan Follow-up',
    '',
    `생성시각: ${ts()}`,
    '',
    '자동 결제완료 처리 실패 건',
    '',
    ...failures.map(({ entry, result }) => buildFailureLine(entry, result)),
    '',
  ];
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

function isAlreadyPaidWithoutButton(entry, result) {
  return entry?.pickkoStatus === 'verified'
    && typeof result?.message === 'string'
    && result.message.includes('결제하기 버튼 미발견');
}

function isExpectedManualFollowup(result) {
  const message = typeof result?.message === 'string' ? result.message : '';
  return message.includes('결제하기 버튼 미발견')
    || message.includes('결제대기 예약 미발견');
}

function runPayPending(entry) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, '../../manual/reports/pickko-pay-pending.js');
    const args = [
      scriptPath,
      `--phone=${String(entry.phone || '').replace(/\D/g, '')}`,
      `--date=${entry.date}`,
      `--start=${entry.start}`,
      `--end=${entry.end}`,
      `--room=${entry.room}`,
    ];

    const child = spawn('/opt/homebrew/bin/node', args, {
      cwd: path.dirname(scriptPath),
      env: { ...process.env, MODE: 'ops' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });

    child.on('error', (error) => {
      resolve({
        ok: false,
        exitCode: -1,
        message: error.message,
        stdout,
        stderr,
      });
    });

    child.on('close', (code) => {
      let parsed = null;
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed.split('\n').filter(Boolean).at(-1));
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
  const phoneFilters = parseCsvArg('phones').map((phone) => String(phone).replace(/\D/g, ''));
  const dateFilters = parseCsvArg('dates');

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const until = new Date();
  until.setDate(until.getDate() + 14);
  const untilDate = until.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

  const manualPending = await getManualPendingReservations(today);
  const verified = await getVerifiedReservationsForPayScan(today, untilDate);
  const deduped = new Map();
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
  const failures = [];

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
      if (result.ok) {
        log(`✅ 결제완료 처리 성공: ${label}`);
      } else {
        log(`✅ 결제버튼 없음 → 이미 결제완료로 간주: ${label}`);
      }
      continue;
    }

    failureCount += 1;
    if (!isExpectedManualFollowup(result)) {
      unexpectedFailureCount += 1;
    }
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

  const checklistPath = writeChecklistFile(failures);
  if (failureCount > 0) {
    const messageLines = [
      `⚠️ pickko-pay-scan 후속 확인 필요`,
      `성공 ${successCount}건 / 후속확인 ${failureCount}건`,
      '',
      ...failures.slice(0, 10).map(({ entry, result }) => buildFailureLine(entry, result)),
    ];
    if (checklistPath) {
      messageLines.push('', `체크리스트: ${checklistPath}`);
    }
    await publishToMainBot({
      from_bot: 'ska',
      event_type: 'alert',
      alert_level: 2,
      message: messageLines.join('\n'),
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
    }).catch((error) => {
      log(`⚠️ 메인봇 알림 실패: ${error.message}`);
    });
  } else {
    await publishToMainBot({
      from_bot: 'ska',
      event_type: 'report',
      alert_level: 1,
      message: `✅ pickko-pay-scan 완료 — 성공 ${successCount}건 / 실패 0건`,
      payload: { successCount, failureCount: 0 },
    }).catch((error) => {
      log(`⚠️ 메인봇 보고 실패: ${error.message}`);
    });
  }

  if (unexpectedFailureCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  log(`❌ 치명적 오류: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
