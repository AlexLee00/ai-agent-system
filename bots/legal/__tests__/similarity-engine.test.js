'use strict';

const engine = require('../lib/similarity-engine');

describe('similarity-engine', () => {
  describe('analyzeCodeSimilarity', () => {
    test('동일 코드 → composite_score 높음', () => {
      const code = 'function add(a, b) { return a + b; }';
      const result = engine.analyzeCodeSimilarity(code, code);
      expect(result.composite_score).toBeGreaterThanOrEqual(80);
    });

    test('완전 다른 코드 → copy_risk low 또는 medium', () => {
      const codeA = 'function foo() { return 1; }';
      const codeB = 'class HttpServer { listen(port) { this.port = port; } }';
      const result = engine.analyzeCodeSimilarity(codeA, codeB);
      expect(['low', 'medium']).toContain(result.copy_risk);
    });

    test('결과 구조 검증 — line/token/structure/composite 포함', () => {
      const result = engine.analyzeCodeSimilarity('const x = 1;', 'const y = 2;');
      expect(result).toHaveProperty('line_similarity');
      expect(result).toHaveProperty('token_similarity');
      expect(result).toHaveProperty('structure_similarity');
      expect(result).toHaveProperty('composite_score');
      expect(result).toHaveProperty('copy_risk');
    });

    test('빈 코드 비교 처리', () => {
      const result = engine.analyzeCodeSimilarity('', '');
      expect(typeof result.composite_score).toBe('number');
    });
  });

  describe('lineSimilarity', () => {
    test('동일 내용 → score 100', () => {
      const code = 'const a = 1;\nconst b = 2;';
      const r = engine.lineSimilarity(code, code);
      expect(r.score).toBe(100);
    });

    test('주석 무시 옵션 — 주석만 다른 코드는 높은 유사도', () => {
      const a = 'const x = 1; // 원고 버전';
      const b = 'const x = 1; // 피고 버전';
      const r = engine.lineSimilarity(a, b, { ignoreComments: true });
      expect(r.score).toBeGreaterThanOrEqual(90);
    });

    test('빈 코드 쌍 처리', () => {
      const r = engine.lineSimilarity('', '');
      expect(r.score).toBe(100);
    });
  });

  describe('extractSignatures', () => {
    test('함수명 추출', () => {
      const code = 'function foo() {}\nconst bar = () => {};\nasync function baz() {}';
      const sigs = engine.extractSignatures(code);
      expect(sigs.length).toBeGreaterThan(0);
    });
  });
});
