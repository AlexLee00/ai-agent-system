'use strict';

/**
 * pdf-generator.js — 감정서 PDF/HTML 생성 순수 함수 모음
 * CLI 스크립트(scripts/generate-pdf.js)와 테스트에서 공용으로 사용
 */

const REPORT_TYPE_LABELS = {
  final: '감정보고서',
  inception_plan: '감정착수계획서',
  query1: '1차질의서',
  query2: '2차질의서',
  inspection_plan: '현장실사계획서',
};

function getReportLabel(reportType) {
  return REPORT_TYPE_LABELS[reportType] || reportType || '감정서';
}

function parseArgs(argv) {
  const result = { format: 'pdf' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case-id') result.caseId = parseInt(argv[++i]);
    else if (argv[i] === '--case') result.caseNumber = argv[++i];
    else if (argv[i] === '--type') result.reportType = argv[++i];
    else if (argv[i] === '--input') result.inputPath = argv[++i];
    else if (argv[i] === '--output') result.outputPath = argv[++i];
    else if (argv[i] === '--format') result.format = argv[++i];
  }
  return result;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineMarkdown(text) {
  return String(text || '')
    .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.*?)__/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>');
}

function markdownToHtml(md) {
  let html = String(md || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();

  if (!html) return '';

  const lines = html.split('\n');
  const result = [];
  let inTable = false;
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (!inCode) {
        result.push('<pre><code>');
        inCode = true;
      } else {
        result.push('</code></pre>');
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      result.push(escapeHtml(line));
      continue;
    }

    if (line.includes('|') && line.trim().startsWith('|')) {
      if (!inTable) {
        inTable = true;
        result.push('<table>');
        const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
        result.push('<thead><tr>' + cells.map(c => `<th>${inlineMarkdown(c)}</th>`).join('') + '</tr></thead>');
        result.push('<tbody>');
        i++; // 구분선(---) 건너뜀
        continue;
      }
      const cells = line.trim().slice(1, -1).split('|').map(c => c.trim());
      result.push('<tr>' + cells.map(c => `<td>${inlineMarkdown(c)}</td>`).join('') + '</tr>');
      continue;
    }
    if (inTable) {
      result.push('</tbody></table>');
      inTable = false;
    }

    const h6 = line.match(/^#{6}\s+(.*)/);
    const h5 = line.match(/^#{5}\s+(.*)/);
    const h4 = line.match(/^#{4}\s+(.*)/);
    const h3 = line.match(/^#{3}\s+(.*)/);
    const h2 = line.match(/^#{2}\s+(.*)/);
    const h1 = line.match(/^#{1}\s+(.*)/);

    if (h6) { result.push(`<h6>${inlineMarkdown(h6[1])}</h6>`); continue; }
    if (h5) { result.push(`<h5>${inlineMarkdown(h5[1])}</h5>`); continue; }
    if (h4) { result.push(`<h4>${inlineMarkdown(h4[1])}</h4>`); continue; }
    if (h3) { result.push(`<h3>${inlineMarkdown(h3[1])}</h3>`); continue; }
    if (h2) { result.push(`<h2>${inlineMarkdown(h2[1])}</h2>`); continue; }
    if (h1) { result.push(`<h1>${inlineMarkdown(h1[1])}</h1>`); continue; }

    if (/^[-*_]{3,}$/.test(line.trim())) {
      result.push('<hr>');
      continue;
    }

    const ul = line.match(/^(\s*)[*\-+]\s+(.*)/);
    if (ul) {
      const indent = ul[1].length;
      result.push(`<li style="margin-left:${indent * 16}px">${inlineMarkdown(ul[2])}</li>`);
      continue;
    }

    const ol = line.match(/^(\s*)\d+\.\s+(.*)/);
    if (ol) {
      const indent = ol[1].length;
      result.push(`<li style="margin-left:${indent * 16}px;list-style-type:decimal">${inlineMarkdown(ol[2])}</li>`);
      continue;
    }

    if (line.trim() === '') {
      result.push('<br>');
      continue;
    }

    result.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  if (inTable) result.push('</tbody></table>');
  if (inCode) result.push('</code></pre>');

  return result.join('\n');
}

function buildHtml(bodyContent, title, meta) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700&display=swap');

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Noto Sans KR', 'Malgun Gothic', '맑은 고딕', sans-serif;
      font-size: 11pt;
      line-height: 1.8;
      color: #000;
      background: #fff;
      padding: 0;
    }

    .page {
      max-width: 210mm;
      margin: 0 auto;
      padding: 25mm 20mm 20mm 25mm;
    }

    .draft-watermark {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-30deg);
      font-size: 80pt;
      color: rgba(200, 0, 0, 0.08);
      font-weight: bold;
      z-index: -1;
      white-space: nowrap;
      pointer-events: none;
    }

    .doc-header {
      text-align: center;
      margin-bottom: 24pt;
      padding-bottom: 12pt;
      border-bottom: 2px solid #000;
    }
    .doc-header h1 {
      font-size: 16pt;
      font-weight: bold;
      margin-bottom: 6pt;
    }
    .doc-meta {
      font-size: 9pt;
      color: #444;
    }

    h1 { font-size: 15pt; font-weight: bold; margin: 16pt 0 8pt; }
    h2 { font-size: 13pt; font-weight: bold; margin: 14pt 0 6pt; border-bottom: 1px solid #ccc; padding-bottom: 4pt; }
    h3 { font-size: 12pt; font-weight: bold; margin: 12pt 0 4pt; }
    h4 { font-size: 11pt; font-weight: bold; margin: 10pt 0 4pt; }
    h5, h6 { font-size: 11pt; margin: 8pt 0 4pt; }

    p { margin: 6pt 0; text-align: justify; }
    br { display: block; margin: 4pt 0; }

    li { margin: 4pt 0; }

    pre { background: #f8f8f8; padding: 8pt; border-radius: 3pt; overflow-x: auto; margin: 8pt 0; }
    code { font-family: 'Courier New', monospace; font-size: 9.5pt; background: #f5f5f5; padding: 1pt 3pt; border-radius: 2pt; }
    pre code { background: none; padding: 0; }

    table {
      width: 100%;
      border-collapse: collapse;
      margin: 10pt 0;
      font-size: 10pt;
    }
    th {
      background: #2c3e50;
      color: #fff;
      padding: 6pt 8pt;
      text-align: left;
      font-weight: bold;
    }
    td {
      padding: 5pt 8pt;
      border: 1px solid #ccc;
      vertical-align: top;
    }
    tr:nth-child(even) td { background: #f9f9f9; }

    hr { border: none; border-top: 1px solid #ccc; margin: 12pt 0; }

    .signature-section {
      margin-top: 40pt;
      padding-top: 20pt;
      border-top: 2px solid #000;
    }
    .signature-line {
      display: flex;
      justify-content: space-between;
      margin: 8pt 0;
    }
    .signature-box {
      width: 45%;
      text-align: center;
    }
    .signature-box .label { font-size: 9pt; color: #666; }
    .signature-box .value { font-size: 11pt; border-top: 1px solid #000; margin-top: 30pt; padding-top: 4pt; }

    @media print {
      .page { padding: 0; }
      body { font-size: 10.5pt; }
    }

    @page {
      size: A4;
      margin: 25mm 20mm 20mm 25mm;
    }
  </style>
</head>
<body>
  <div class="draft-watermark">초안</div>
  <div class="page">
    <div class="doc-header">
      <div class="doc-meta">${escapeHtml(meta.court || '')}</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="doc-meta">
        사건번호: ${escapeHtml(meta.caseNumber || '')} &nbsp;|&nbsp;
        생성일: ${escapeHtml(meta.date || '')} &nbsp;|&nbsp;
        버전: v${escapeHtml(String(meta.version || '1'))}
      </div>
    </div>
    <div class="content">
      ${bodyContent}
    </div>
    <div class="signature-section">
      <div class="signature-line">
        <div class="signature-box">
          <div class="label">감정인 (마스터 서명란)</div>
          <div class="value">&nbsp;</div>
        </div>
        <div class="signature-box">
          <div class="label">작성일</div>
          <div class="value">&nbsp;</div>
        </div>
      </div>
      <p style="margin-top:12pt;font-size:9pt;color:#666;">
        ⚠️ 이 문서는 저스틴팀 AI가 생성한 초안입니다. 마스터(감정인)의 최종 검토 및 서명 후 법원에 제출하십시오.
      </p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  parseArgs,
  escapeHtml,
  inlineMarkdown,
  markdownToHtml,
  buildHtml,
  getReportLabel,
  REPORT_TYPE_LABELS,
};
