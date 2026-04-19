#!/usr/bin/env node
'use strict';

/**
 * start-appraisal.js — 감정 시작 CLI
 *
 * 사용법:
 *   node scripts/start-appraisal.js --case "서울중앙지방법원 2026가합12345" \
 *     --court "서울중앙지방법원" --plaintiff "원고회사" --defendant "피고회사" \
 *     --type copyright --deadline 2026-06-30 \
 *     --items "소스코드 유사도 분석" "기능 동일성 여부"
 *
 *   node scripts/start-appraisal.js --list
 *   node scripts/start-appraisal.js --status "서울중앙지방법원 2026가합12345"
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');

const args = process.argv.slice(2);

function parseArgs(argv) {
  const result = { items: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--case') result.case = argv[++i];
    else if (key === '--court') result.court = argv[++i];
    else if (key === '--plaintiff') result.plaintiff = argv[++i];
    else if (key === '--defendant') result.defendant = argv[++i];
    else if (key === '--type') result.type = argv[++i];
    else if (key === '--deadline') result.deadline = argv[++i];
    else if (key === '--notes') result.notes = argv[++i];
    else if (key === '--items') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        result.items.push(argv[++i]);
      }
    }
    else if (key === '--list') result.action = 'list';
    else if (key === '--status') { result.action = 'status'; result.case = argv[++i]; }
    else if (key === '--phase') { result.action = 'phase'; result.phase = argv[++i]; result.caseId = parseInt(argv[++i]); }
    else if (key === '--help') result.action = 'help';
  }
  return result;
}

function printHelp() {
  console.log(`
저스틴팀 감정 시작 CLI

사용법:
  # 새 감정 접수
  node start-appraisal.js --case "서울중앙지방법원 2026가합12345" \\
    --court "서울중앙지방법원" --plaintiff "원고회사명" --defendant "피고회사명" \\
    --type copyright --deadline 2026-06-30 \\
    --items "소스코드 유사도" "기능 동일성"

  # 감정 목록 조회
  node start-appraisal.js --list

  # 사건 상태 조회
  node start-appraisal.js --status "서울중앙지방법원 2026가합12345"

  # 단계별 실행
  node start-appraisal.js --phase briefing 1
  node start-appraisal.js --phase lens 1
  node start-appraisal.js --phase report 1

감정 유형:
  copyright    - 저작권 침해
  defect       - 소프트웨어 하자
  contract     - 계약 위반
  trade_secret - 영업비밀 침해
  other        - 기타
`);
}

async function main() {
  const opts = parseArgs(args);

  if (opts.action === 'help' || args.length === 0) {
    printHelp();
    return;
  }

  const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));

  if (opts.action === 'list') {
    const cases = await store.listCases();
    if (cases.length === 0) {
      console.log('등록된 감정 사건이 없습니다.');
      return;
    }
    console.log('\n=== 감정 사건 목록 ===\n');
    for (const c of cases) {
      const deadline = c.deadline ? new Date(c.deadline).toLocaleDateString('ko-KR') : '미설정';
      console.log(`[${c.id}] ${c.case_number}`);
      console.log(`    유형: ${c.case_type} | 상태: ${c.status} | 기한: ${deadline}`);
      console.log(`    원고: ${c.plaintiff || '미상'} / 피고: ${c.defendant || '미상'}`);
      console.log('');
    }
    return;
  }

  if (opts.action === 'status') {
    const c = await store.getCaseByCaseNumber(opts.case);
    if (!c) {
      console.log(`사건을 찾을 수 없습니다: ${opts.case}`);
      return;
    }
    console.log('\n=== 사건 상세 ===\n');
    console.log(`사건번호: ${c.case_number}`);
    console.log(`법원: ${c.court || '미상'}`);
    console.log(`유형: ${c.case_type}`);
    console.log(`원고: ${c.plaintiff} / 피고: ${c.defendant}`);
    console.log(`상태: ${c.status}`);
    console.log(`기한: ${c.deadline ? new Date(c.deadline).toLocaleDateString('ko-KR') : '미설정'}`);
    console.log(`등록일: ${new Date(c.created_at).toLocaleDateString('ko-KR')}`);
    return;
  }

  if (opts.action === 'phase') {
    const caseRecord = await store.getCaseById(opts.caseId);
    if (!caseRecord) {
      console.log(`사건 ID를 찾을 수 없습니다: ${opts.caseId}`);
      return;
    }

    const justin = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/justin'));
    const caseData = {
      ...caseRecord,
      classification: { case_type: caseRecord.case_type },
    };

    switch (opts.phase) {
      case 'briefing':
        await justin.runPhase2(caseRecord.id, caseData);
        break;
      case 'lens':
        await justin.runPhase4_LensAnalysis(caseRecord.id, caseData);
        break;
      case 'report':
        await justin.runPhase12(caseRecord.id, caseData);
        break;
      case 'inception-plan':
        await justin.writeInceptionPlan(caseRecord.id, caseData);
        break;
      case 'query1':
        await justin.writeQueryLetter(caseRecord.id, caseData, 1);
        break;
      case 'query2':
        await justin.writeQueryLetter(caseRecord.id, caseData, 2);
        break;
      default:
        console.log(`알 수 없는 단계: ${opts.phase}`);
    }
    return;
  }

  // 새 감정 접수
  if (!opts.case) {
    console.error('오류: --case 옵션이 필요합니다.');
    printHelp();
    process.exit(1);
  }

  console.log(`\n[저스틴팀] 감정 접수 시작: ${opts.case}\n`);

  const justin = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/justin'));

  const { caseRecord, classification } = await justin.receiveCase({
    case_number: opts.case,
    court: opts.court,
    plaintiff: opts.plaintiff,
    defendant: opts.defendant,
    case_type: opts.type,
    appraisal_items: opts.items,
    deadline: opts.deadline,
    notes: opts.notes,
  });

  console.log(`\n✅ 감정 사건 등록 완료`);
  console.log(`   사건 ID: ${caseRecord.id}`);
  console.log(`   사건번호: ${caseRecord.case_number}`);
  console.log(`   유형: ${caseRecord.case_type} (분류 근거: ${classification.reasoning?.slice(0, 100)})`);
  console.log(`\n다음 단계:`);
  console.log(`  node scripts/start-appraisal.js --phase briefing ${caseRecord.id}`);
  console.log(`  → 사건 디렉토리 생성: bots/legal/cases/${opts.case}/`);
  console.log(`  → source-plaintiff/ 와 source-defendant/ 에 소스코드 복사 후 lens 실행`);
}

main().catch(err => {
  console.error('[오류]', err.message);
  process.exit(1);
});
