#!/usr/bin/env node
'use strict';

/**
 * generate-report.js — 감정서 파일 생성 CLI
 *
 * 사용법:
 *   node scripts/generate-report.js --case-id 1 --type final
 *   node scripts/generate-report.js --case "서울중앙지방법원 2026가합12345"
 */

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');

const args = process.argv.slice(2);

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case-id') result.caseId = parseInt(argv[++i]);
    else if (argv[i] === '--case') result.caseNumber = argv[++i];
    else if (argv[i] === '--type') result.reportType = argv[++i];
    else if (argv[i] === '--output') result.outputPath = argv[++i];
  }
  return result;
}

async function main() {
  const opts = parseArgs(args);

  if (!opts.caseId && !opts.caseNumber) {
    console.log('사용법: node generate-report.js --case-id 1 [--type final]');
    process.exit(1);
  }

  const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));

  let caseRecord;
  if (opts.caseId) {
    caseRecord = await store.getCaseById(opts.caseId);
  } else {
    caseRecord = await store.getCaseByCaseNumber(opts.caseNumber);
  }

  if (!caseRecord) {
    console.error('사건을 찾을 수 없습니다.');
    process.exit(1);
  }

  const reportType = opts.reportType || 'final';
  const report = await store.getLatestReport(caseRecord.id, reportType);

  if (!report) {
    console.error(`감정서를 찾을 수 없습니다. (유형: ${reportType})`);
    console.log('먼저 저스틴팀을 실행하여 감정서를 생성해 주세요.');
    process.exit(1);
  }

  const reportTypeLabel = {
    final: '감정보고서',
    inception_plan: '감정착수계획서',
    query1: '1차질의서',
    query2: '2차질의서',
    inspection_plan: '현장실사계획서',
  };

  const safeCaseNumber = caseRecord.case_number.replace(/[\s\/\\:*?"<>|]/g, '_');
  const defaultOutput = path.join(
    env.PROJECT_ROOT, 'bots/legal/cases', safeCaseNumber,
    'report', `${reportTypeLabel[reportType] || reportType}_v${report.version}.md`
  );

  const outputPath = opts.outputPath || defaultOutput;
  const outputDir = path.dirname(outputPath);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const header = `<!--
  ${reportTypeLabel[reportType] || reportType} — ${caseRecord.case_number}
  생성일: ${new Date().toLocaleDateString('ko-KR')}
  버전: v${report.version}
  상태: ${report.review_status}

  ⚠️ 이 문서는 저스틴팀이 생성한 초안입니다.
  마스터(감정인)의 최종 검토 및 수정 후 법원에 제출하십시오.
-->

`;

  fs.writeFileSync(outputPath, header + (report.content_md || ''), 'utf8');

  console.log(`\n✅ 감정서 파일 생성 완료`);
  console.log(`   경로: ${outputPath}`);
  console.log(`   버전: v${report.version}`);
  console.log(`   상태: ${report.review_status}`);
  console.log(`\n⚠️  마스터 검토 후 법원 제출 필수`);
}

main().catch(err => {
  console.error('[오류]', err.message);
  process.exit(1);
});
