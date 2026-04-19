'use strict';

/**
 * docx-generator.js — 감정서 마크다운 → Word (.docx) 변환 순수 함수 모음
 * docx v9 API 기반. CLI(scripts/generate-docx.js)와 테스트에서 공용으로 사용.
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  Header,
  Footer,
  PageNumber,
  NumberFormat,
} = require('docx');

const REPORT_TYPE_LABELS = {
  final: '감정보고서',
  inception_plan: '감정착수계획서',
  query1: '1차질의서',
  query2: '2차질의서',
  inspection_plan: '현장실사계획서',
};

const KO_FONT = '맑은 고딕';
const BASE_FONT_SIZE = 22; // half-points (= 11pt)
const HEADING_SIZES = { 1: 32, 2: 28, 3: 24, 4: 22 }; // half-points

function getReportLabel(reportType) {
  return REPORT_TYPE_LABELS[reportType] || reportType || '감정서';
}

function parseArgs(argv) {
  const result = { format: 'docx' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case-id') result.caseId = parseInt(argv[++i]);
    else if (argv[i] === '--case') result.caseNumber = argv[++i];
    else if (argv[i] === '--type') result.reportType = argv[++i];
    else if (argv[i] === '--input') result.inputPath = argv[++i];
    else if (argv[i] === '--output') result.outputPath = argv[++i];
    else if (argv[i] === '--draft') result.isDraft = true;
  }
  return result;
}

// 인라인 마크다운(bold/italic/code)을 TextRun 배열로 변환
function parseInlineRuns(text, baseOptions = {}) {
  const runs = [];
  const regex = /(\*\*\*(.*?)\*\*\*|\*\*(.*?)\*\*|\*(.*?)\*|`(.*?)`)/g;
  let last = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      runs.push(new TextRun({ text: text.slice(last, match.index), font: KO_FONT, ...baseOptions }));
    }
    if (match[2] !== undefined) {
      runs.push(new TextRun({ text: match[2], bold: true, italics: true, font: KO_FONT, ...baseOptions }));
    } else if (match[3] !== undefined) {
      runs.push(new TextRun({ text: match[3], bold: true, font: KO_FONT, ...baseOptions }));
    } else if (match[4] !== undefined) {
      runs.push(new TextRun({ text: match[4], italics: true, font: KO_FONT, ...baseOptions }));
    } else if (match[5] !== undefined) {
      runs.push(new TextRun({ text: match[5], font: 'Courier New', size: BASE_FONT_SIZE - 2, ...baseOptions }));
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    runs.push(new TextRun({ text: text.slice(last), font: KO_FONT, ...baseOptions }));
  }
  if (runs.length === 0) {
    runs.push(new TextRun({ text: text, font: KO_FONT, ...baseOptions }));
  }
  return runs;
}

// 마크다운 → docx 단락/표 배열로 변환
function markdownToDocxParagraphs(md) {
  const children = [];
  if (!md) return children;

  const lines = md.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  let i = 0;
  let inCode = false;
  let codeLines = [];
  let inTable = false;
  let tableRows = [];

  const flushTable = () => {
    if (!tableRows.length) return;
    const rows = tableRows.map((cells, rowIdx) =>
      new TableRow({
        children: cells.map(cellText =>
          new TableCell({
            children: [
              new Paragraph({
                children: parseInlineRuns(cellText.trim(), rowIdx === 0 ? { bold: true, color: 'FFFFFF' } : {}),
                alignment: AlignmentType.LEFT,
              }),
            ],
            shading: rowIdx === 0
              ? { fill: '2C3E50', type: ShadingType.CLEAR, color: '2C3E50' }
              : rowIdx % 2 === 0 ? { fill: 'F9F9F9', type: ShadingType.CLEAR } : undefined,
          })
        ),
      })
    );
    children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    tableRows = [];
    inTable = false;
  };

  while (i < lines.length) {
    const line = lines[i];

    // 코드 블록
    if (line.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeLines = [];
      } else {
        children.push(
          new Paragraph({
            children: codeLines.map((l, idx) => [
              new TextRun({ text: l, font: 'Courier New', size: 18 }),
              idx < codeLines.length - 1 ? new TextRun({ text: '', break: 1 }) : null,
            ].filter(Boolean)).flat(),
            shading: { fill: 'F8F8F8', type: ShadingType.CLEAR },
            spacing: { before: 100, after: 100 },
          })
        );
        inCode = false;
        codeLines = [];
      }
      i++;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      i++;
      continue;
    }

    // 표
    if (line.trim().startsWith('|')) {
      const cells = line.split('|').slice(1, -1);
      // 구분선(---|---|) 이면 건너뜀
      if (!cells.every(c => /^[-:\s]+$/.test(c.trim()))) {
        if (!inTable) inTable = true;
        tableRows.push(cells);
      }
      i++;
      continue;
    } else if (inTable) {
      flushTable();
    }

    // 빈 줄
    if (!line.trim()) {
      children.push(new Paragraph({ text: '' }));
      i++;
      continue;
    }

    // 수평선
    if (/^---+$/.test(line.trim())) {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6 } }, text: '' }));
      i++;
      continue;
    }

    // 제목
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const headingLevels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
      children.push(
        new Paragraph({
          children: [new TextRun({ text, bold: true, font: KO_FONT, size: HEADING_SIZES[level] || BASE_FONT_SIZE })],
          heading: headingLevels[level - 1],
          spacing: { before: 240, after: 120 },
        })
      );
      i++;
      continue;
    }

    // 목록 (-, *, •)
    const listMatch = line.match(/^(\s*)([-*•])\s+(.+)/);
    if (listMatch) {
      const indent = listMatch[1].length;
      const text = listMatch[3];
      children.push(
        new Paragraph({
          children: parseInlineRuns(text),
          bullet: { level: Math.floor(indent / 2) },
          spacing: { before: 60, after: 60 },
        })
      );
      i++;
      continue;
    }

    // 번호 목록
    const numListMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (numListMatch) {
      const indent = numListMatch[1].length;
      const text = numListMatch[2];
      children.push(
        new Paragraph({
          children: parseInlineRuns(text),
          numbering: { reference: 'default-numbering', level: Math.floor(indent / 2) },
          spacing: { before: 60, after: 60 },
        })
      );
      i++;
      continue;
    }

    // 일반 단락
    children.push(
      new Paragraph({
        children: parseInlineRuns(line),
        alignment: AlignmentType.JUSTIFY,
        spacing: { before: 60, after: 60 },
      })
    );
    i++;
  }

  if (inTable) flushTable();
  return children;
}

// 제목 페이지 단락 생성
function buildTitleSection(reportLabel, caseNumber, court, isDraft) {
  const paragraphs = [];

  if (isDraft) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: '[초안]', color: 'CC0000', bold: true, font: KO_FONT, size: 28 })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 120 },
      })
    );
  }

  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: reportLabel, bold: true, font: KO_FONT, size: 40 })],
      alignment: AlignmentType.CENTER,
      heading: HeadingLevel.TITLE,
      spacing: { before: 480, after: 240 },
    })
  );

  if (caseNumber) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: `사건번호: ${caseNumber}`, font: KO_FONT, size: 24 })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 60 },
      })
    );
  }
  if (court) {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: `법원: ${court}`, font: KO_FONT, size: 22 })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 60, after: 60 },
      })
    );
  }

  paragraphs.push(
    new Paragraph({
      children: [new TextRun({ text: `작성일: ${new Date().toLocaleDateString('ko-KR')}`, font: KO_FONT, size: 20 })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 60, after: 480 },
    })
  );

  paragraphs.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 12 } }, text: '' }));

  return paragraphs;
}

// Document 객체 생성
function buildDocument(mdContent, { reportLabel, caseNumber, court, isDraft = false } = {}) {
  const titleParagraphs = buildTitleSection(reportLabel, caseNumber, court, isDraft);
  const bodyParagraphs = markdownToDocxParagraphs(mdContent);

  return new Document({
    numbering: {
      config: [
        {
          reference: 'default-numbering',
          levels: [0, 1, 2].map(level => ({
            level,
            format: NumberFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
          })),
        },
      ],
    },
    sections: [
      {
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: reportLabel || '감정서', font: KO_FONT, size: 18, color: '666666' }),
                  new TextRun({ text: caseNumber ? `  |  ${caseNumber}` : '', font: KO_FONT, size: 18, color: '666666' }),
                ],
                alignment: AlignmentType.RIGHT,
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: '- ', font: KO_FONT, size: 18, color: '666666' }),
                  new TextRun({ children: [PageNumber.CURRENT], font: KO_FONT, size: 18, color: '666666' }),
                  new TextRun({ text: ' -', font: KO_FONT, size: 18, color: '666666' }),
                ],
                alignment: AlignmentType.CENTER,
              }),
            ],
          }),
        },
        properties: {},
        children: [...titleParagraphs, ...bodyParagraphs],
      },
    ],
  });
}

// Buffer 생성 (비동기)
async function generateDocxBuffer(mdContent, options = {}) {
  const doc = buildDocument(mdContent, options);
  return Packer.toBuffer(doc);
}

module.exports = {
  parseArgs,
  getReportLabel,
  REPORT_TYPE_LABELS,
  parseInlineRuns,
  markdownToDocxParagraphs,
  buildDocument,
  generateDocxBuffer,
};
