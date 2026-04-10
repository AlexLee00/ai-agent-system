#!/usr/bin/env node
'use strict';

/**
 * collect-pickko-order-raw-range.js
 *
 * 목적:
 *   Pickko raw order 수집을 날짜 범위로 실행하고, 5일 단위 batch마다 적재/검증 결과를 요약
 *
 * 기본 규칙:
 *   - 날짜별 수집은 collect-pickko-order-raw의 단건 수집 로직을 재사용
 *   - batch 기본 크기는 5일
 *   - 각 날짜마다 저장 후 DB 재조회로 건수/합계/축별 상태 검증
 *
 * 사용 예:
 *   PICKKO_HEADLESS=1 node bots/reservation/scripts/collect-pickko-order-raw-range.js --from=2026-03-16 --to=2026-03-20
 *   PICKKO_HEADLESS=1 node bots/reservation/scripts/collect-pickko-order-raw-range.js --from=2025-10-01 --to=2026-03-20 --chunk-days=5 --json
 */

const { getPickkoOrderRawByDate } = require('../lib/db');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const collectorScript = path.join(__dirname, 'collect-pickko-order-raw.js');

function getArg(name) {
  const match = argv.find((item) => item.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

function parseDate(text) {
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  return new Date(date.getTime() + (days * 86400000));
}

function buildDateList(fromDate, toDate) {
  const dates = [];
  for (let cursor = new Date(fromDate); cursor <= toDate; cursor = addDays(cursor, 1)) {
    dates.push(formatDate(cursor));
  }
  return dates;
}

function chunkArray(items, chunkSize) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function summarizeRows(rows) {
  return rows.reduce((acc, row) => {
    acc.totalCount += 1;
    if (row.source_axis === 'payment_day' && row.order_kind === 'general') {
      acc.generalCount += 1;
      acc.generalRevenueRaw += Number(row.raw_amount || 0);
    } else if (row.source_axis === 'use_day' && row.order_kind === 'study_room') {
      acc.useRoomCount += 1;
      acc.useRoomPolicyRevenue += Number(row.raw_amount || 0) > 0
        ? Number(row.raw_amount || 0)
        : Number(row.policy_amount || 0);
    }
    return acc;
  }, {
    totalCount: 0,
    generalCount: 0,
    generalRevenueRaw: 0,
    paymentRoomCount: 0,
    paymentRoomRevenueRaw: 0,
    useRoomCount: 0,
    useRoomPolicyRevenue: 0,
  });
}

function verifyDate(result, storedRows) {
  const storedSummary = summarizeRows(storedRows);
  const expectedSummary = {
    totalCount: result.rows.length,
    generalCount: result.summary.generalCount,
    generalRevenueRaw: Number(result.summary.directGeneralRevenue || 0),
    paymentRoomCount: 0,
    paymentRoomRevenueRaw: 0,
    useRoomCount: result.summary.roomCount,
    useRoomPolicyRevenue: result.rows
      .filter((row) => row.sourceAxis === 'use_day' && row.orderKind === 'study_room')
      .reduce((sum, row) => sum + (Number(row.rawAmount || 0) > 0
        ? Number(row.rawAmount || 0)
        : Number(row.policyAmount || 0)), 0),
  };
  return {
    ok:
      storedSummary.totalCount === expectedSummary.totalCount &&
      storedSummary.generalCount === expectedSummary.generalCount &&
      storedSummary.generalRevenueRaw === expectedSummary.generalRevenueRaw &&
      storedSummary.paymentRoomCount === expectedSummary.paymentRoomCount &&
      storedSummary.paymentRoomRevenueRaw === expectedSummary.paymentRoomRevenueRaw &&
      storedSummary.useRoomCount === expectedSummary.useRoomCount &&
      storedSummary.useRoomPolicyRevenue === expectedSummary.useRoomPolicyRevenue,
    expected: expectedSummary,
    stored: storedSummary,
  };
}

async function runCollectorForDate(date, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [collectorScript, `--date=${date}`, '--json'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `collector exited with code ${code} signal ${signal || 'none'}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`invalid JSON output: ${error.message}`));
      }
    });
  });
}

async function collectOneDate(date, timeoutMs) {
  const result = await runCollectorForDate(date, timeoutMs);
  const storedRows = await getPickkoOrderRawByDate(date);
  const verification = verifyDate(result, storedRows);
  return {
    date,
    ok: verification.ok,
    summary: result.summary,
    storedRowCount: result.storedRowCount,
    verification,
  };
}

async function main() {
  const fromText = getArg('from');
  const toText = getArg('to');
  const asJson = argv.includes('--json');
  const stopOnError = argv.includes('--stop-on-error');
  const chunkDays = Number.parseInt(getArg('chunk-days') || '5', 10);
  const timeoutMs = Number.parseInt(getArg('timeout-ms') || '180000', 10);

  const fromDate = parseDate(fromText);
  const toDate = parseDate(toText);

  if (!fromDate || !toDate) {
    console.error('❌ --from=YYYY-MM-DD 와 --to=YYYY-MM-DD 가 필요합니다.');
    process.exit(1);
  }
  if (fromDate > toDate) {
    console.error('❌ from 날짜는 to 날짜보다 늦을 수 없습니다.');
    process.exit(1);
  }
  if (!Number.isFinite(chunkDays) || chunkDays <= 0) {
    console.error('❌ --chunk-days 는 1 이상의 정수여야 합니다.');
    process.exit(1);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error('❌ --timeout-ms 는 1 이상의 정수여야 합니다.');
    process.exit(1);
  }

  const dates = buildDateList(fromDate, toDate);
  const batches = chunkArray(dates, chunkDays);
  const batchResults = [];

  for (let i = 0; i < batches.length; i += 1) {
    const batchDates = batches[i];
    const batchLabel = `${batchDates[0]} ~ ${batchDates[batchDates.length - 1]}`;
    const dateResults = [];
    const batchSummary = {
      batchIndex: i + 1,
      batchLabel,
      successDates: 0,
      failedDates: 0,
      verificationFailures: 0,
      generalCount: 0,
      paymentRoomCount: 0,
      useRoomCount: 0,
    };

    for (const date of batchDates) {
      try {
        const dateResult = await collectOneDate(date, timeoutMs);
        dateResults.push(dateResult);
        if (dateResult.ok) {
          batchSummary.successDates += 1;
        } else {
          batchSummary.successDates += 1;
          batchSummary.verificationFailures += 1;
        }
        batchSummary.generalCount += Number(dateResult.summary.generalCount || 0);
        batchSummary.paymentRoomCount += Number(dateResult.summary.paymentRoomCount || 0);
        batchSummary.useRoomCount += Number(dateResult.summary.roomCount || 0);
      } catch (error) {
        batchSummary.failedDates += 1;
        dateResults.push({
          date,
          ok: false,
          error: error.message,
        });
        if (stopOnError) {
          batchResults.push({
            ...batchSummary,
            dates: dateResults,
          });
          if (asJson) {
            console.log(JSON.stringify({
              ok: false,
              from: fromText,
              to: toText,
              chunkDays,
              batches: batchResults,
            }, null, 2));
          } else {
            console.log(`📦 Pickko raw order batch 중단 (${batchLabel})`);
            console.log(`  실패 날짜: ${date}`);
            console.log(`  사유: ${error.message}`);
          }
          process.exit(1);
        }
      }
    }

    batchResults.push({
      ...batchSummary,
      dates: dateResults,
    });
  }

  const overall = batchResults.reduce((acc, batch) => {
    acc.batchCount += 1;
    acc.successDates += batch.successDates;
    acc.failedDates += batch.failedDates;
    acc.verificationFailures += batch.verificationFailures;
    acc.generalCount += batch.generalCount;
    acc.paymentRoomCount += batch.paymentRoomCount;
    acc.useRoomCount += batch.useRoomCount;
    return acc;
  }, {
    batchCount: 0,
    successDates: 0,
    failedDates: 0,
    verificationFailures: 0,
    generalCount: 0,
    paymentRoomCount: 0,
    useRoomCount: 0,
  });

  if (asJson) {
    console.log(JSON.stringify({
      ok: overall.failedDates === 0 && overall.verificationFailures === 0,
      from: fromText,
      to: toText,
      chunkDays,
      timeoutMs,
      overall,
      batches: batchResults,
    }, null, 2));
    return;
  }

  console.log(`📦 Pickko raw order range 수집 완료 (${fromText} ~ ${toText})`);
  console.log(`  batch: ${overall.batchCount}개 (${chunkDays}일 간격)`);
  console.log(`  date timeout: ${timeoutMs}ms`);
  console.log(`  성공 날짜: ${overall.successDates}`);
  console.log(`  실패 날짜: ${overall.failedDates}`);
  console.log(`  검증 실패: ${overall.verificationFailures}`);
  console.log(`  일반석(payment): ${overall.generalCount}건`);
  console.log(`  스터디룸(payment): ${overall.paymentRoomCount}건`);
  console.log(`  스터디룸(use): ${overall.useRoomCount}건`);
  for (const batch of batchResults) {
    console.log(`  - ${batch.batchLabel}: 성공 ${batch.successDates}, 실패 ${batch.failedDates}, 검증실패 ${batch.verificationFailures}`);
  }
}

main().catch((error) => {
  console.error(`❌ 범위 수집 실패: ${error.message}`);
  process.exit(1);
});
