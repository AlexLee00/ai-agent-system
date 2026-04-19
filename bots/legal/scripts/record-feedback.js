#!/usr/bin/env node
'use strict';

/**
 * record-feedback.js — 법원 판결 수신 후 감정 정확도 피드백 기록 (Phase 6)
 *
 * 사용법:
 *   node scripts/record-feedback.js --case-id 1 --decision "원고 일부 승소" --accuracy accurate
 *   node scripts/record-feedback.js --case 서울중앙지방법원2024가합12345 --decision "피고 승소" --accuracy inaccurate --note "유사도 과대평가"
 *   node scripts/record-feedback.js --case-id 1 --list
 *
 * 정확도 값:
 *   accurate   — 감정 결론이 법원 판결과 일치
 *   partial    — 부분 일치 (일부 쟁점만 맞음)
 *   inaccurate — 감정 결론이 법원 판결과 불일치
 *
 * Phase 6: 피드백 → legal.feedback DB + rag_legal 컬렉션 RAG 저장
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

const ACCURACY_KR = {
  accurate:   '정확 (판결 일치)',
  partial:    '부분 일치',
  inaccurate: '부정확 (판결 불일치)',
};

const ACCURACY_EMOJI = {
  accurate:   '✅',
  partial:    '⚠️',
  inaccurate: '❌',
};

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case-id') result.caseId = parseInt(argv[++i]);
    else if (argv[i] === '--case') result.caseNumber = argv[++i];
    else if (argv[i] === '--decision') result.decision = argv[++i];
    else if (argv[i] === '--accuracy') result.accuracy = argv[++i];
    else if (argv[i] === '--note') result.note = argv[++i];
    else if (argv[i] === '--list') result.action = 'list';
    else if (argv[i] === '--help') result.action = 'help';
    else if (argv[i] === '--no-rag') result.noRag = true;
  }
  return result;
}

function printHelp() {
  console.log(`
법원 판결 피드백 기록 CLI (저스틴팀 Phase 6)

사용법:
  node record-feedback.js --case-id 1 --decision "원고 일부 승소" --accuracy accurate
  node record-feedback.js --case-id 1 --decision "피고 승소" --accuracy inaccurate --note "유사도 과대평가"
  node record-feedback.js --case-id 1 --list
  node record-feedback.js --case-id 1 --decision "..." --accuracy partial --no-rag

정확도 값:
  accurate   — 감정 결론이 법원 판결과 일치
  partial    — 부분 일치
  inaccurate — 감정 결론과 불일치

옵션:
  --no-rag   RAG 저장 건너뜀 (로컬 MLX 미기동 시)
`);
}

async function getCaseRecord(store, opts) {
  if (opts.caseId) return store.getCaseById(opts.caseId);
  if (opts.caseNumber) return store.getCaseByCaseNumber(opts.caseNumber);
  return null;
}

async function storeToRag(caseRecord, feedback) {
  try {
    const rag = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/rag'));
    const content = buildRagContent(caseRecord, feedback);
    const metadata = {
      case_number:  caseRecord.case_number,
      case_type:    caseRecord.case_type,
      court:        caseRecord.court,
      accuracy:     feedback.appraisal_accuracy,
      feedback_id:  feedback.id,
      recorded_at:  new Date().toISOString(),
    };
    const id = await rag.store('rag_legal', content, metadata, 'justin');
    return id;
  } catch (err) {
    console.warn(`[RAG] 저장 실패 (무시): ${err.message}`);
    return null;
  }
}

function buildRagContent(caseRecord, feedback) {
  const accuracyKr = ACCURACY_KR[feedback.appraisal_accuracy] || feedback.appraisal_accuracy;
  return [
    `[법원 감정 피드백]`,
    `사건번호: ${caseRecord.case_number}`,
    `법원: ${caseRecord.court || '미상'}`,
    `사건유형: ${caseRecord.case_type || '미상'}`,
    `법원 판결: ${feedback.court_decision}`,
    `감정 정확도: ${accuracyKr}`,
    feedback.notes ? `메모: ${feedback.notes}` : '',
    ``,
    `[감정 내용 요약]`,
    `원고: ${caseRecord.plaintiff || '미상'} / 피고: ${caseRecord.defendant || '미상'}`,
    caseRecord.notes ? `감정 노트: ${caseRecord.notes}` : '',
  ].filter(line => line !== null).join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.action === 'help' || process.argv.length <= 2) {
    printHelp();
    return;
  }

  const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));
  const pool  = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));

  const caseRecord = await getCaseRecord(store, opts);
  if (!caseRecord) {
    console.error('사건을 찾을 수 없습니다. --case-id 또는 --case 옵션을 확인하세요.');
    process.exit(1);
  }
  const caseId = caseRecord.id;

  // ─── 목록 조회 ──────────────────────────────────────────────────
  if (opts.action === 'list') {
    const rows = await pool.query(
      'SELECT * FROM legal.feedback WHERE case_id = $1 ORDER BY created_at DESC',
      [caseId],
    );
    const items = rows.rows || [];

    if (items.length === 0) {
      console.log(`\n[${caseRecord.case_number}] 기록된 피드백 없음.\n`);
      return;
    }

    console.log(`\n=== 감정 피드백 이력 — ${caseRecord.case_number} ===\n`);
    for (const item of items) {
      const emoji = ACCURACY_EMOJI[item.appraisal_accuracy] || '?';
      const acc   = ACCURACY_KR[item.appraisal_accuracy]   || item.appraisal_accuracy;
      const date  = new Date(item.created_at).toLocaleDateString('ko-KR');
      console.log(`${emoji} [${item.id}] ${date} — ${acc}`);
      console.log(`    판결: ${item.court_decision}`);
      if (item.notes) console.log(`    메모: ${item.notes}`);
      console.log('');
    }
    return;
  }

  // ─── 피드백 등록 ──────────────────────────────────────────────────
  if (!opts.decision) {
    console.error('오류: --decision 옵션이 필요합니다. (법원 판결 요지)');
    process.exit(1);
  }

  const validAccuracies = Object.keys(ACCURACY_KR);
  if (!opts.accuracy || !validAccuracies.includes(opts.accuracy)) {
    console.error(`오류: --accuracy 옵션이 필요합니다. (${validAccuracies.join('|')})`);
    process.exit(1);
  }

  const inserted = await pool.query(
    `INSERT INTO legal.feedback (case_id, court_decision, appraisal_accuracy, notes)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [caseId, opts.decision, opts.accuracy, opts.note || null],
  );
  const feedback = inserted.rows[0];

  const emoji = ACCURACY_EMOJI[opts.accuracy];
  const accKr = ACCURACY_KR[opts.accuracy];

  console.log(`\n✅ 피드백 등록 완료 (id=${feedback.id})`);
  console.log(`   사건번호: ${caseRecord.case_number}`);
  console.log(`   판결 요지: ${opts.decision}`);
  console.log(`   감정 정확도: ${emoji} ${accKr}`);
  if (opts.note) console.log(`   메모: ${opts.note}`);

  // ─── RAG 저장 ──────────────────────────────────────────────────
  if (!opts.noRag) {
    process.stdout.write('\nRAG 저장 중...');
    const ragId = await storeToRag(caseRecord, feedback);
    if (ragId) {
      console.log(` 완료 (rag_legal id=${ragId})`);
    } else {
      console.log(' 건너뜀 (MLX 미기동 또는 연결 실패)');
    }
  }

  // 사건 status를 'submitted'로 업데이트 (판결 수신 = 최종 완료)
  await store.updateCaseStatus(caseId, 'submitted');
  console.log(`\n사건 상태 → submitted (판결 수신 완료)`);
  console.log(`\n이력 조회: node scripts/record-feedback.js --case-id ${caseId} --list\n`);
}

main().catch(err => {
  console.error('[오류]', err.message);
  process.exit(1);
});
