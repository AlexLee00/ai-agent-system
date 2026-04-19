#!/usr/bin/env node
'use strict';

/**
 * inspect-sw.js — 현장실사 SW 기능 분류 CLI
 *
 * 사용법:
 *   node scripts/inspect-sw.js --case-id 1 --feature "로그인 기능" --status working
 *   node scripts/inspect-sw.js --case-id 1 --feature "결제 모듈" --status partial --note "60% 기능 동작"
 *   node scripts/inspect-sw.js --case-id 1 --list
 *   node scripts/inspect-sw.js --case-id 1 --summary
 *
 * 상태값:
 *   working  — 가동 (정상 동작)
 *   partial  — 부분가동 (일부 기능만 동작)
 *   broken   — 불가동 (동작 불가)
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

const args = process.argv.slice(2);

const STATUS_KR = {
  working: '가동',
  partial: '부분가동',
  broken:  '불가동',
};

const STATUS_EMOJI = {
  working: '✅',
  partial: '⚠️',
  broken:  '❌',
};

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case-id') result.caseId = parseInt(argv[++i]);
    else if (argv[i] === '--case') result.caseNumber = argv[++i];
    else if (argv[i] === '--feature') result.feature = argv[++i];
    else if (argv[i] === '--status') result.status = argv[++i];
    else if (argv[i] === '--note') result.note = argv[++i];
    else if (argv[i] === '--list') result.action = 'list';
    else if (argv[i] === '--summary') result.action = 'summary';
    else if (argv[i] === '--delete') { result.action = 'delete'; result.featureToDelete = argv[++i]; }
    else if (argv[i] === '--help') result.action = 'help';
  }
  return result;
}

function printHelp() {
  console.log(`
현장실사 SW 기능 분류 CLI (저스틴팀)

사용법:
  # SW 기능 분류 등록
  node inspect-sw.js --case-id 1 --feature "로그인 기능" --status working
  node inspect-sw.js --case-id 1 --feature "결제 모듈" --status partial --note "로그 저장 불가"
  node inspect-sw.js --case-id 1 --feature "리포트 출력" --status broken

  # 목록 조회
  node inspect-sw.js --case-id 1 --list

  # 요약 통계 (가동/부분/불가 비율)
  node inspect-sw.js --case-id 1 --summary

상태값:
  working  — 가동   (정상 동작)
  partial  — 부분가동 (일부 기능만 동작)
  broken   — 불가동  (동작 불가)
`);
}

async function getCaseRecord(store, opts) {
  if (opts.caseId) return store.getCaseById(opts.caseId);
  if (opts.caseNumber) return store.getCaseByCaseNumber(opts.caseNumber);
  return null;
}

async function main() {
  const opts = parseArgs(args);

  if (opts.action === 'help' || args.length === 0) {
    printHelp();
    return;
  }

  const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
  const pool  = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));

  // 사건 조회
  const caseRecord = await getCaseRecord(store, opts);
  if (!caseRecord) {
    console.error('사건을 찾을 수 없습니다. --case-id 또는 --case 옵션을 확인하세요.');
    process.exit(1);
  }

  const caseId = caseRecord.id;

  // ─── 목록 조회 ──────────────────────────────────────────────────
  if (opts.action === 'list') {
    const rows = await pool.query(
      'SELECT * FROM legal.sw_functions WHERE case_id = $1 ORDER BY created_at DESC',
      [caseId],
    );
    const items = rows.rows || [];

    if (items.length === 0) {
      console.log('\n등록된 SW 기능이 없습니다.');
      console.log(`  node scripts/inspect-sw.js --case-id ${caseId} --feature "기능명" --status working\n`);
      return;
    }

    console.log(`\n=== SW 기능 현황 — ${caseRecord.case_number} ===\n`);
    for (const item of items) {
      const status = STATUS_KR[item.status] || item.status;
      const emoji  = STATUS_EMOJI[item.status] || '?';
      const date   = new Date(item.created_at).toLocaleDateString('ko-KR');
      console.log(`${emoji} [${item.id}] ${item.feature_name}`);
      console.log(`    상태: ${status} | 등록일: ${date}`);
      if (item.notes) console.log(`    비고: ${item.notes}`);
      console.log('');
    }
    return;
  }

  // ─── 요약 통계 ──────────────────────────────────────────────────
  if (opts.action === 'summary') {
    const rows = await pool.query(
      `SELECT status, COUNT(*) AS cnt
       FROM legal.sw_functions WHERE case_id = $1 GROUP BY status`,
      [caseId],
    );
    const counts = { working: 0, partial: 0, broken: 0 };
    for (const row of (rows.rows || [])) {
      counts[row.status] = parseInt(row.cnt) || 0;
    }
    const total = counts.working + counts.partial + counts.broken;

    console.log(`\n=== SW 기능 현황 요약 — ${caseRecord.case_number} ===\n`);
    console.log(`총 기능 수: ${total}개`);
    console.log(`  ✅ 가동:     ${counts.working}개 (${total ? ((counts.working / total) * 100).toFixed(1) : 0}%)`);
    console.log(`  ⚠️  부분가동:  ${counts.partial}개 (${total ? ((counts.partial / total) * 100).toFixed(1) : 0}%)`);
    console.log(`  ❌ 불가동:   ${counts.broken}개 (${total ? ((counts.broken / total) * 100).toFixed(1) : 0}%)`);

    if (total > 0) {
      const completionRate = ((counts.working + counts.partial * 0.5) / total * 100).toFixed(1);
      console.log(`\n기능 이행률 (가동 + 부분가동×0.5): ${completionRate}%`);
    }
    console.log('');
    return;
  }

  // ─── 기능 등록 ──────────────────────────────────────────────────
  if (!opts.feature) {
    console.error('오류: --feature 옵션이 필요합니다.');
    printHelp();
    process.exit(1);
  }

  const validStatuses = ['working', 'partial', 'broken'];
  if (!opts.status || !validStatuses.includes(opts.status)) {
    console.error(`오류: --status 옵션이 필요합니다. (${validStatuses.join('|')})`);
    process.exit(1);
  }

  // 기존 항목이 있으면 UPDATE, 없으면 INSERT
  const existing = await pool.query(
    'SELECT id FROM legal.sw_functions WHERE case_id = $1 AND feature_name = $2',
    [caseId, opts.feature],
  );

  let resultId;
  if (existing.rows && existing.rows.length > 0) {
    const updated = await pool.query(
      `UPDATE legal.sw_functions
       SET status = $1, notes = $2, created_at = NOW()
       WHERE case_id = $3 AND feature_name = $4
       RETURNING id`,
      [opts.status, opts.note || null, caseId, opts.feature],
    );
    resultId = updated.rows[0]?.id;
    console.log(`\n✅ SW 기능 업데이트 완료 (id=${resultId})`);
  } else {
    const inserted = await pool.query(
      `INSERT INTO legal.sw_functions (case_id, feature_name, status, notes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [caseId, opts.feature, opts.status, opts.note || null],
    );
    resultId = inserted.rows[0]?.id;
    console.log(`\n✅ SW 기능 등록 완료 (id=${resultId})`);
  }

  const statusKr  = STATUS_KR[opts.status];
  const statusEmoji = STATUS_EMOJI[opts.status];
  console.log(`   사건번호: ${caseRecord.case_number}`);
  console.log(`   기능명: ${opts.feature}`);
  console.log(`   상태: ${statusEmoji} ${statusKr}`);
  if (opts.note) console.log(`   비고: ${opts.note}`);

  console.log(`\n목록 조회: node scripts/inspect-sw.js --case-id ${caseId} --list`);
  console.log(`요약 통계: node scripts/inspect-sw.js --case-id ${caseId} --summary\n`);
}

main().catch(err => {
  console.error('[오류]', err.message);
  process.exit(1);
});
