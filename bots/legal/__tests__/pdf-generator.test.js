'use strict';

const {
  parseArgs,
  escapeHtml,
  inlineMarkdown,
  markdownToHtml,
  buildHtml,
  getReportLabel,
  REPORT_TYPE_LABELS,
} = require('../lib/pdf-generator');

describe('pdf-generator', () => {
  describe('parseArgs', () => {
    test('기본값 format=pdf', () => {
      expect(parseArgs([])).toEqual({ format: 'pdf' });
    });

    test('--case-id 파싱', () => {
      expect(parseArgs(['--case-id', '42']).caseId).toBe(42);
    });

    test('--case 파싱', () => {
      expect(parseArgs(['--case', '서울중앙지방법원 2026가합12345']).caseNumber).toBe(
        '서울중앙지방법원 2026가합12345'
      );
    });

    test('--type 파싱', () => {
      expect(parseArgs(['--type', 'inception_plan']).reportType).toBe('inception_plan');
    });

    test('--input --output --format 파싱', () => {
      const opts = parseArgs(['--input', '/tmp/a.md', '--output', '/tmp/b.pdf', '--format', 'html']);
      expect(opts.inputPath).toBe('/tmp/a.md');
      expect(opts.outputPath).toBe('/tmp/b.pdf');
      expect(opts.format).toBe('html');
    });
  });

  describe('escapeHtml', () => {
    test('& < > 이스케이프', () => {
      expect(escapeHtml('<b>A & B</b>')).toBe('&lt;b&gt;A &amp; B&lt;/b&gt;');
    });

    test('null/undefined → 빈 문자열', () => {
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
    });

    test('안전한 텍스트는 그대로 반환', () => {
      expect(escapeHtml('Hello World')).toBe('Hello World');
    });
  });

  describe('inlineMarkdown', () => {
    test('**굵게** → <strong>', () => {
      expect(inlineMarkdown('**굵게**')).toBe('<strong>굵게</strong>');
    });

    test('*이탤릭* → <em>', () => {
      expect(inlineMarkdown('*이탤릭*')).toBe('<em>이탤릭</em>');
    });

    test('`코드` → <code>', () => {
      expect(inlineMarkdown('`코드`')).toBe('<code>코드</code>');
    });

    test('***굵게이탤릭*** → <strong><em>', () => {
      expect(inlineMarkdown('***텍스트***')).toBe('<strong><em>텍스트</em></strong>');
    });

    test('__굵게__ → <strong>', () => {
      expect(inlineMarkdown('__굵게__')).toBe('<strong>굵게</strong>');
    });

    test('null/undefined → 빈 문자열', () => {
      expect(inlineMarkdown(null)).toBe('');
      expect(inlineMarkdown(undefined)).toBe('');
    });
  });

  describe('markdownToHtml', () => {
    test('# 제목 → <h1>', () => {
      const html = markdownToHtml('# 제목');
      expect(html).toContain('<h1>제목</h1>');
    });

    test('## 소제목 → <h2>', () => {
      expect(markdownToHtml('## 소제목')).toContain('<h2>소제목</h2>');
    });

    test('### ~ ###### 제목 변환', () => {
      expect(markdownToHtml('### H3')).toContain('<h3>H3</h3>');
      expect(markdownToHtml('#### H4')).toContain('<h4>H4</h4>');
      expect(markdownToHtml('##### H5')).toContain('<h5>H5</h5>');
      expect(markdownToHtml('###### H6')).toContain('<h6>H6</h6>');
    });

    test('- 목록 → <li>', () => {
      expect(markdownToHtml('- 항목')).toContain('<li');
      expect(markdownToHtml('- 항목')).toContain('항목');
    });

    test('1. 번호 목록 → <li> decimal', () => {
      const html = markdownToHtml('1. 항목');
      expect(html).toContain('list-style-type:decimal');
    });

    test('--- → <hr>', () => {
      expect(markdownToHtml('---')).toContain('<hr>');
    });

    test('```코드블록``` → <pre><code>', () => {
      const html = markdownToHtml('```\nconst x = 1;\n```');
      expect(html).toContain('<pre><code>');
      expect(html).toContain('</code></pre>');
      expect(html).toContain('const x = 1;');
    });

    test('코드블록 내 HTML 이스케이프', () => {
      const html = markdownToHtml('```\n<div>\n```');
      expect(html).toContain('&lt;div&gt;');
    });

    test('테이블 → <table>', () => {
      const md = `| 이름 | 값 |\n|------|----|\n| A | 1 |`;
      const html = markdownToHtml(md);
      expect(html).toContain('<table>');
      expect(html).toContain('<th>이름</th>');
      expect(html).toContain('<td>A</td>');
    });

    test('HTML 주석 제거', () => {
      const html = markdownToHtml('텍스트 <!-- 주석 --> 남은');
      expect(html).not.toContain('<!-- 주석 -->');
      expect(html).toContain('남은');
    });

    test('빈 입력 → 빈 문자열', () => {
      expect(markdownToHtml('')).toBe('');
      expect(markdownToHtml(null)).toBe('');
    });

    test('일반 단락 → <p>', () => {
      expect(markdownToHtml('일반 텍스트')).toContain('<p>일반 텍스트</p>');
    });
  });

  describe('buildHtml', () => {
    const meta = { court: '서울중앙지방법원', caseNumber: '2026가합12345', date: '2026. 4. 19.', version: 1 };

    test('반환값에 DOCTYPE 포함', () => {
      const html = buildHtml('<p>본문</p>', '감정보고서', meta);
      expect(html).toContain('<!DOCTYPE html>');
    });

    test('제목(title) 이스케이프 포함', () => {
      const html = buildHtml('', '감정 & 보고서', meta);
      expect(html).toContain('감정 &amp; 보고서');
    });

    test('사건번호 출력', () => {
      const html = buildHtml('', '제목', meta);
      expect(html).toContain('2026가합12345');
    });

    test('법원명 출력', () => {
      const html = buildHtml('', '제목', meta);
      expect(html).toContain('서울중앙지방법원');
    });

    test('초안 워터마크 포함', () => {
      const html = buildHtml('', '제목', meta);
      expect(html).toContain('draft-watermark');
      expect(html).toContain('초안');
    });

    test('서명란 포함', () => {
      const html = buildHtml('', '제목', meta);
      expect(html).toContain('signature-section');
      expect(html).toContain('감정인 (마스터 서명란)');
    });

    test('bodyContent 포함', () => {
      const html = buildHtml('<p>감정 내용</p>', '제목', meta);
      expect(html).toContain('<p>감정 내용</p>');
    });
  });

  describe('getReportLabel', () => {
    test.each([
      ['final', '감정보고서'],
      ['inception_plan', '감정착수계획서'],
      ['query1', '1차질의서'],
      ['query2', '2차질의서'],
      ['inspection_plan', '현장실사계획서'],
    ])('%s → %s', (type, label) => {
      expect(getReportLabel(type)).toBe(label);
    });

    test('알 수 없는 유형은 그대로 반환', () => {
      expect(getReportLabel('custom')).toBe('custom');
    });

    test('undefined → 감정서', () => {
      expect(getReportLabel(undefined)).toBe('감정서');
    });
  });

  describe('REPORT_TYPE_LABELS', () => {
    test('5개 유형 정의', () => {
      expect(Object.keys(REPORT_TYPE_LABELS)).toHaveLength(5);
    });
  });
});
