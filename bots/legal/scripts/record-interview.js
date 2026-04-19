'use strict';

/**
 * record-interview.js — 인터뷰 기록 CLI (Phase 7·9)
 *
 * 사용법:
 *   node scripts/record-interview.js \
 *     --case-id 1 --round 1 \
 *     --question "로그인 기능 구현 방식" \
 *     --response "Spring Security 기반 JWT" \
 *     --analysis "원고 주장과 일치" \
 *     --interviewer "Alex Lee" \
 *     --notes "녹취록 cases/2026-001/interview1/ 보관"
 *
 *   node scripts/record-interview.js --list 1
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    if (key === '--case-id')    { opts.caseId    = parseInt(val, 10); i++; }
    if (key === '--round')      { opts.round     = parseInt(val, 10); i++; }
    if (key === '--question')   { opts.question  = val; i++; }
    if (key === '--response')   { opts.response  = val; i++; }
    if (key === '--analysis')   { opts.analysis  = val; i++; }
    if (key === '--interviewer'){ opts.interviewer = val; i++; }
    if (key === '--notes')      { opts.notes     = val; i++; }
    if (key === '--list')       { opts.list      = parseInt(val, 10); i++; }
  }
  return opts;
}

function printTable(rows) {
  if (!rows || rows.length === 0) {
    console.log('(인터뷰 기록 없음)');
    return;
  }
  console.log(`\n인터뷰 기록 (${rows.length}건):`);
  console.log('─'.repeat(70));
  for (const r of rows) {
    console.log(`[${r.id}] 유형: ${r.interview_type} | 담당: ${r.interviewer || '-'}`);
    console.log(`  질문: ${(r.content || '').slice(0, 80)}`);
    console.log(`  답변: ${(r.response || '').slice(0, 80)}`);
    console.log(`  분석: ${(r.analysis || '').slice(0, 80)}`);
    console.log(`  일시: ${r.conducted_at || r.created_at}`);
    console.log('─'.repeat(70));
  }
}

async function main() {
  const opts = parseArgs();

  if (opts.list) {
    const rows = await store.getInterviews(opts.list);
    printTable(rows);
    process.exit(0);
  }

  if (!opts.caseId) { console.error('오류: --case-id 필수'); process.exit(1); }
  if (!opts.round)  { console.error('오류: --round 필수 (1 또는 2)'); process.exit(1); }
  if (opts.round !== 1 && opts.round !== 2) {
    console.error('오류: --round 값은 1 또는 2만 허용');
    process.exit(1);
  }

  const caseRecord = await store.getCaseById(opts.caseId);
  if (!caseRecord) {
    console.error(`오류: 사건 ID ${opts.caseId} 없음`);
    process.exit(1);
  }

  const statusMap = { 1: 'interview1', 2: 'interview2' };
  const newStatus = statusMap[opts.round];

  const record = await store.saveInterview({
    case_id: opts.caseId,
    interview_type: `query${opts.round}_interview`,
    interviewer: opts.interviewer || '저스틴',
    content: opts.question || '',
    response: opts.response || '',
    analysis: opts.analysis || (opts.notes || ''),
    conducted_at: new Date(),
  });

  await store.updateCaseStatus(opts.caseId, newStatus);

  console.log(`✅ ${opts.round}차 인터뷰 기록 완료`);
  console.log(`   사건: ${caseRecord.case_number} (ID: ${opts.caseId})`);
  console.log(`   기록 ID: ${record.id}`);
  console.log(`   상태: ${caseRecord.status} → ${newStatus}`);
}

main().catch(err => {
  console.error('[record-interview] 오류:', err.message);
  process.exit(1);
});
