#!/usr/bin/env node
'use strict';

/**
 * generate-pdf.js — 감정서 마크다운 → PDF/HTML 변환 CLI
 *
 * 사용법:
 *   node scripts/generate-pdf.js --case-id 1 --type inception_plan
 *   node scripts/generate-pdf.js --case-id 1 --type final --format html
 *   node scripts/generate-pdf.js --input /path/to/report.md --output /path/to/output.pdf
 *
 * 형식:
 *   pdf  (기본) — puppeteer Chromium 기반 PDF 생성
 *   html — HTML 파일만 생성 (PDF 미변환)
 */

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');
const { parseArgs, markdownToHtml, buildHtml, getReportLabel } = require(
  path.join(env.PROJECT_ROOT, 'bots/legal/lib/pdf-generator')
);

const args = process.argv.slice(2);

async function generatePdf(htmlPath, pdfPath) {
  const puppeteer = require(path.join(env.PROJECT_ROOT, 'node_modules/puppeteer'));
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '25mm', right: '20mm', bottom: '20mm', left: '25mm' },
    });

    return true;
  } finally {
    await browser.close();
  }
}

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
  node generate-pdf.js --case-id 1 [--type inception_plan] [--format pdf|html]
  node generate-pdf.js --case "서울중앙지방법원 2026가합12345" [--type final]
  node generate-pdf.js --input report.md --output output.pdf`);
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

  const htmlPath = opts.outputPath
    ? opts.outputPath.replace(/\.pdf$/, '.html')
    : path.join(outputDir, `${baseName}.html`);

  const pdfPath = opts.outputPath && opts.outputPath.endsWith('.pdf')
    ? opts.outputPath
    : path.join(outputDir, `${baseName}.pdf`);

  // 1단계: HTML 생성
  const bodyHtml = markdownToHtml(mdContent);
  const meta = {
    court: caseRecord.court || '',
    caseNumber: caseRecord.case_number || '',
    date: new Date().toLocaleDateString('ko-KR'),
    version,
  };
  const fullHtml = buildHtml(bodyHtml, reportLabel, meta);
  fs.writeFileSync(htmlPath, fullHtml, 'utf8');
  console.log(`\n✅ HTML 생성: ${htmlPath}`);

  if (opts.format === 'html') {
    console.log('\n📄 HTML 파일 생성 완료 (PDF 변환 건너뜀)');
    console.log('⚠️  마스터 검토 후 법원 제출 필수\n');
    return;
  }

  // 2단계: PDF 생성
  console.log('🖨️  PDF 변환 중 (Chromium)...');
  try {
    await generatePdf(htmlPath, pdfPath);
    const stat = fs.statSync(pdfPath);
    console.log(`✅ PDF 생성: ${pdfPath} (${(stat.size / 1024).toFixed(1)}KB)`);
    console.log(`\n⚠️  마스터 검토 후 법원 제출 필수\n`);
  } catch (err) {
    console.error(`❌ PDF 변환 실패: ${err.message}`);
    console.log(`   HTML 파일은 생성됨: ${htmlPath}`);
    console.log('   브라우저에서 열어 PDF로 인쇄하세요.\n');
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('[오류]', err.message);
  process.exit(1);
});
