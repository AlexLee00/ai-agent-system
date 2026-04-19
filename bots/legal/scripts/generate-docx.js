#!/usr/bin/env node
'use strict';

/**
 * generate-docx.js — 감정서 마크다운 → Word (.docx) 변환 CLI
 *
 * 사용법:
 *   node scripts/generate-docx.js --case-id 1 --type inception_plan
 *   node scripts/generate-docx.js --case "서울중앙지방법원 2026가합12345" --type final
 *   node scripts/generate-docx.js --input /path/to/report.md --output /path/to/output.docx
 *   node scripts/generate-docx.js --case-id 1 --draft    ← 초안 워터마크
 */

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');
const {
  parseArgs,
  getReportLabel,
  generateDocxBuffer,
} = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/docx-generator'));

const args = process.argv.slice(2);

async function main() {
  const opts = parseArgs(args);

  let mdContent, caseRecord, report;

  if (opts.inputPath) {
    if (!fs.existsSync(opts.inputPath)) {
      console.error(`파일을 찾을 수 없습니다: ${opts.inputPath}`);
      process.exit(1);
    }
    mdContent = fs.readFileSync(opts.inputPath, 'utf8');
    caseRecord = { case_number: path.basename(opts.inputPath, '.md'), court: '' };
    report = { version: 1 };
  } else {
    if (!opts.caseId && !opts.caseNumber) {
      console.log(`사용법:
  node generate-docx.js --case-id 1 [--type inception_plan] [--draft]
  node generate-docx.js --case "서울중앙지방법원 2026가합12345" [--type final]
  node generate-docx.js --input report.md --output output.docx`);
      process.exit(1);
    }

    const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));

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
    report = await store.getLatestReport(caseRecord.id, reportType);
    if (!report) {
      console.error(`감정서를 찾을 수 없습니다. (유형: ${reportType})`);
      console.log('먼저 저스틴팀을 실행하여 감정서를 생성해 주세요.');
      process.exit(1);
    }

    mdContent = report.content_md || '';
  }

  const reportLabel = getReportLabel(opts.reportType);
  const safeCaseNumber = caseRecord.case_number.replace(/[\s\/\\:*?"<>|]/g, '_');
  const outputDir = opts.outputPath
    ? path.dirname(opts.outputPath)
    : path.join(env.PROJECT_ROOT, 'bots/legal/cases', safeCaseNumber, 'report');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const version = report.version || 1;
  const baseName = `${reportLabel}_v${version}`;

  const docxPath = opts.outputPath || path.join(outputDir, `${baseName}.docx`);

  console.log(`[저스틴팀] Word 생성 중: ${caseRecord.case_number}`);
  console.log(`  유형: ${reportLabel} (v${version})`);

  const buffer = await generateDocxBuffer(mdContent, {
    reportLabel,
    caseNumber: caseRecord.case_number,
    court: caseRecord.court || '',
    isDraft: opts.isDraft || false,
  });

  fs.writeFileSync(docxPath, buffer);

  const sizeKb = Math.round(buffer.length / 1024);
  console.log(`✅ 저장 완료: ${docxPath} (${sizeKb} KB)`);
}

main().catch(err => {
  console.error('[generate-docx] 오류:', err.message);
  process.exit(1);
});
