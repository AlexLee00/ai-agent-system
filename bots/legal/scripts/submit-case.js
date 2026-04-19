'use strict';

/**
 * submit-case.js — Phase 13 법원 제출 CLI
 *
 * 감정서 최종 제출: 상태를 submitted로 변경 + rag_legal 아카이브 + 텔레그램 알림
 *
 * 사용법:
 *   node scripts/submit-case.js --case-id 1 --signed-by "Alex Lee" --notes "법원 제출 완료"
 *   node scripts/submit-case.js --case 2026가합12345  (사건번호로 조회)
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
const justin = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/justin'));

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    if (key === '--case-id')   { opts.caseId   = parseInt(val, 10); i++; }
    if (key === '--case')      { opts.caseNum  = val; i++; }
    if (key === '--signed-by') { opts.signedBy = val; i++; }
    if (key === '--notes')     { opts.notes    = val; i++; }
    if (key === '--dry-run')   { opts.dryRun   = true; }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  let caseId = opts.caseId;

  if (!caseId && opts.caseNum) {
    const found = await store.getCaseByCaseNumber(opts.caseNum);
    if (!found) {
      console.error(`오류: 사건번호 '${opts.caseNum}'를 찾을 수 없습니다`);
      process.exit(1);
    }
    caseId = found.id;
  }

  if (!caseId) {
    console.error('오류: --case-id 또는 --case (사건번호) 필수');
    process.exit(1);
  }

  const caseRecord = await store.getCaseById(caseId);
  if (!caseRecord) {
    console.error(`오류: 사건 ID ${caseId} 없음`);
    process.exit(1);
  }

  if (caseRecord.status === 'submitted') {
    console.warn(`⚠️  사건 ${caseRecord.case_number}는 이미 제출 완료 상태입니다.`);
    process.exit(0);
  }

  const report = await store.getLatestReport(caseId, 'final');
  if (!report) {
    console.error(`오류: 최종 감정서(final)가 없습니다. 먼저 Phase 12를 완료하세요.`);
    process.exit(1);
  }

  console.log(`\n📋 제출 확인`);
  console.log(`   사건: ${caseRecord.case_number}`);
  console.log(`   법원: ${caseRecord.court || '-'}`);
  console.log(`   현재 상태: ${caseRecord.status}`);
  console.log(`   감정서 버전: v${report.version} (${report.review_status})`);
  console.log(`   서명인: ${opts.signedBy || '마스터'}`);

  if (opts.dryRun) {
    console.log('\n[드라이런] 실제 제출 없이 종료합니다.');
    process.exit(0);
  }

  const result = await justin.submitCase(caseId, {
    signedBy: opts.signedBy || '마스터',
    notes: opts.notes || '',
  });

  console.log(`\n✅ 법원 제출 완료`);
  console.log(`   사건: ${result.case_number}`);
  console.log(`   상태: ${result.status}`);
  console.log(`   서명인: ${result.signedBy}`);
  console.log(`   RAG 아카이브: rag_legal 컬렉션`);
  console.log(`   텔레그램 알림: legal 토픽`);
}

main().catch(err => {
  console.error('[submit-case] 오류:', err.message);
  process.exit(1);
});
