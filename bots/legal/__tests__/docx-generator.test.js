'use strict';

const { TextRun, Table, Paragraph } = require('docx');
const {
  parseArgs,
  getReportLabel,
  REPORT_TYPE_LABELS,
  parseInlineRuns,
  markdownToDocxParagraphs,
  buildDocument,
  generateDocxBuffer,
} = require('../lib/docx-generator');

describe('docx-generator', () => {
  describe('parseArgs', () => {
    test('기본값 format=docx', () => {
      expect(parseArgs([])).toEqual({ format: 'docx' });
    });

    test('--case-id 파싱', () => {
      expect(parseArgs(['--case-id', '5']).caseId).toBe(5);
    });

    test('--case 파싱', () => {
      expect(parseArgs(['--case', '서울중앙 2026가합99']).caseNumber).toBe('서울중앙 2026가합99');
    });

    test('--type 파싱', () => {
      expect(parseArgs(['--type', 'final']).reportType).toBe('final');
    });

    test('--input --output 파싱', () => {
      const opts = parseArgs(['--input', '/a/b.md', '--output', '/a/b.docx']);
      expect(opts.inputPath).toBe('/a/b.md');
      expect(opts.outputPath).toBe('/a/b.docx');
    });

    test('--draft 플래그', () => {
      expect(parseArgs(['--draft']).isDraft).toBe(true);
    });

    test('복합 인수', () => {
      const opts = parseArgs(['--case-id', '3', '--type', 'inception_plan', '--draft']);
      expect(opts.caseId).toBe(3);
      expect(opts.reportType).toBe('inception_plan');
      expect(opts.isDraft).toBe(true);
    });
  });

  describe('getReportLabel', () => {
    test.each(Object.entries(REPORT_TYPE_LABELS))(
      '%s → %s',
      (key, label) => {
        expect(getReportLabel(key)).toBe(label);
      }
    );

    test('알 수 없는 유형 → 그대로 반환', () => {
      expect(getReportLabel('unknown_type')).toBe('unknown_type');
    });

    test('null → 기본값', () => {
      expect(getReportLabel(null)).toBe('감정서');
    });

    test('undefined → 기본값', () => {
      expect(getReportLabel(undefined)).toBe('감정서');
    });

    test('빈 문자열 → 기본값', () => {
      expect(getReportLabel('')).toBe('감정서');
    });
  });

  describe('parseInlineRuns', () => {
    test('일반 텍스트 → TextRun 배열 반환', () => {
      const runs = parseInlineRuns('일반 텍스트');
      expect(runs.length).toBeGreaterThan(0);
      expect(runs[0]).toBeInstanceOf(TextRun);
    });

    test('**bold** → 3개 런 반환 (앞/굵게/뒤)', () => {
      const runs = parseInlineRuns('앞 **굵게** 뒤');
      expect(runs).toHaveLength(3);
      runs.forEach(r => expect(r).toBeInstanceOf(TextRun));
    });

    test('*italic* → TextRun 반환', () => {
      const runs = parseInlineRuns('*기울임*');
      expect(runs).toHaveLength(1);
      expect(runs[0]).toBeInstanceOf(TextRun);
    });

    test('`code` → TextRun 반환', () => {
      const runs = parseInlineRuns('`코드`');
      expect(runs).toHaveLength(1);
      expect(runs[0]).toBeInstanceOf(TextRun);
    });

    test('***bold italic*** → TextRun 반환', () => {
      const runs = parseInlineRuns('***굵은기울임***');
      expect(runs).toHaveLength(1);
      expect(runs[0]).toBeInstanceOf(TextRun);
    });

    test('빈 문자열 → TextRun 1개', () => {
      const runs = parseInlineRuns('');
      expect(runs).toHaveLength(1);
      expect(runs[0]).toBeInstanceOf(TextRun);
    });

    test('복합 인라인 → 여러 런', () => {
      const runs = parseInlineRuns('앞 **굵게** 중간 *기울임* 뒤');
      expect(runs.length).toBe(5);
    });
  });

  describe('markdownToDocxParagraphs', () => {
    test('null → 빈 배열', () => {
      expect(markdownToDocxParagraphs(null)).toHaveLength(0);
    });

    test('undefined → 빈 배열', () => {
      expect(markdownToDocxParagraphs(undefined)).toHaveLength(0);
    });

    test('빈 문자열 → 빈 배열', () => {
      expect(markdownToDocxParagraphs('')).toHaveLength(0);
    });

    test('제목 줄 → Paragraph 반환', () => {
      const paras = markdownToDocxParagraphs('# 제목 1');
      expect(paras).toHaveLength(1);
      expect(paras[0]).toBeInstanceOf(Paragraph);
    });

    test('# ~ #### 제목 모두 처리', () => {
      const md = ['# H1', '## H2', '### H3', '#### H4'].join('\n');
      const paras = markdownToDocxParagraphs(md);
      expect(paras).toHaveLength(4);
      paras.forEach(p => expect(p).toBeInstanceOf(Paragraph));
    });

    test('목록(-) → Paragraph 반환', () => {
      const paras = markdownToDocxParagraphs('- 항목 1\n- 항목 2');
      expect(paras).toHaveLength(2);
      paras.forEach(p => expect(p).toBeInstanceOf(Paragraph));
    });

    test('번호 목록 → Paragraph 반환', () => {
      const paras = markdownToDocxParagraphs('1. 첫째\n2. 둘째');
      expect(paras).toHaveLength(2);
    });

    test('코드 블록 → Paragraph 1개', () => {
      const md = '```\nconst x = 1;\n```';
      const paras = markdownToDocxParagraphs(md);
      expect(paras).toHaveLength(1);
      expect(paras[0]).toBeInstanceOf(Paragraph);
    });

    test('HTML 주석 → 제거됨', () => {
      const md = '<!-- 주석 -->\n일반 텍스트';
      const paras = markdownToDocxParagraphs(md);
      // Paragraph의 내부 XML에 "주석" 텍스트가 없어야 함
      const xmlStr = paras.map(p => JSON.stringify(p)).join('');
      expect(xmlStr).not.toContain('주석');
    });

    test('표 → Table 반환', () => {
      const md = '| 열1 | 열2 |\n|---|---|\n| A | B |';
      const paras = markdownToDocxParagraphs(md);
      const hasTable = paras.some(p => p instanceof Table);
      expect(hasTable).toBe(true);
    });

    test('수평선(---) → Paragraph 반환', () => {
      const paras = markdownToDocxParagraphs('---');
      expect(paras).toHaveLength(1);
      expect(paras[0]).toBeInstanceOf(Paragraph);
    });

    test('빈 줄 → Paragraph 반환', () => {
      const paras = markdownToDocxParagraphs('\n\n');
      expect(paras.every(p => p instanceof Paragraph)).toBe(true);
    });
  });

  describe('buildDocument', () => {
    test('Document 객체 반환 (truthy)', () => {
      const doc = buildDocument('# 감정서\n\n본문');
      expect(doc).toBeTruthy();
    });

    test('옵션 없어도 동작', () => {
      expect(() => buildDocument('내용')).not.toThrow();
    });

    test('isDraft=true 포함', () => {
      expect(() =>
        buildDocument('본문', {
          reportLabel: '감정보고서',
          caseNumber: '2026가합1',
          court: '서울',
          isDraft: true,
        })
      ).not.toThrow();
    });

    test('모든 옵션 지정', () => {
      expect(() =>
        buildDocument('## 감정서\n\n내용', {
          reportLabel: '감정보고서',
          caseNumber: '서울중앙지방법원 2026가합12345',
          court: '서울중앙지방법원',
          isDraft: false,
        })
      ).not.toThrow();
    });
  });

  describe('generateDocxBuffer', () => {
    test('Buffer 반환', async () => {
      const buf = await generateDocxBuffer('# 제목\n\n본문');
      expect(Buffer.isBuffer(buf)).toBe(true);
    });

    test('최소 크기 이상 (ZIP 구조 포함)', async () => {
      const buf = await generateDocxBuffer('내용');
      expect(buf.length).toBeGreaterThan(1000);
    });

    test('ZIP 시그니처(PK 헤더) 포함', async () => {
      const buf = await generateDocxBuffer('내용');
      // .docx = ZIP; 첫 2바이트 = 0x50 0x4B ('PK')
      expect(buf[0]).toBe(0x50);
      expect(buf[1]).toBe(0x4b);
    });

    test('한국어 내용 → 오류 없음', async () => {
      const md = '# 감정보고서\n\n## 1. 사건 개요\n\n소프트웨어 저작권 침해 사건입니다.\n\n- 원고: A회사\n- 피고: B회사';
      const buf = await generateDocxBuffer(md, {
        reportLabel: '감정보고서',
        caseNumber: '서울중앙지방법원 2026가합12345',
      });
      expect(buf.length).toBeGreaterThan(5000);
    });

    test('표 포함 → 오류 없음', async () => {
      const md = '## 기능 비교표\n\n| 기능 | 원고 | 피고 |\n|---|---|---|\n| 로그인 | O | O |\n| 결제 | O | X |';
      await expect(generateDocxBuffer(md)).resolves.toBeTruthy();
    });

    test('코드 블록 포함 → 오류 없음', async () => {
      const md = '## 소스코드\n\n```\nfunction login() {\n  return true;\n}\n```';
      await expect(generateDocxBuffer(md)).resolves.toBeTruthy();
    });

    test('초안 옵션 → 오류 없음', async () => {
      await expect(
        generateDocxBuffer('초안 내용', { reportLabel: '감정보고서', isDraft: true })
      ).resolves.toBeTruthy();
    });

    test('빈 내용 → Buffer 반환', async () => {
      const buf = await generateDocxBuffer('');
      expect(Buffer.isBuffer(buf)).toBe(true);
    });
  });
});
