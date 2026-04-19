'use strict';

const fs = require('fs');
const path = require('path');

// ─── 문자열 유사도 (Levenshtein 기반) ─────────────────────────

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function stringSimilarity(a, b) {
  if (!a && !b) return 100;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;
  return Number(((1 - levenshtein(a, b) / maxLen) * 100).toFixed(2));
}

// ─── 라인 단위 유사도 ─────────────────────────────────────────

function lineSimilarity(textA, textB, options = {}) {
  const { ignoreComments = true, ignoreBlankLines = true, ignoreWhitespace = true } = options;

  function normalize(text) {
    let lines = text.split('\n');
    if (ignoreComments) {
      lines = lines.map(l => l.replace(/\/\/.*$/m, '').replace(/\/\*[\s\S]*?\*\//g, ''));
    }
    if (ignoreBlankLines) {
      lines = lines.filter(l => l.trim().length > 0);
    }
    if (ignoreWhitespace) {
      lines = lines.map(l => l.trim().replace(/\s+/g, ' '));
    }
    return lines;
  }

  const linesA = normalize(textA || '');
  const linesB = normalize(textB || '');

  if (linesA.length === 0 && linesB.length === 0) return { score: 100, matched_lines: 0, total_lines: 0 };
  if (linesA.length === 0 || linesB.length === 0) return { score: 0, matched_lines: 0, total_lines: Math.max(linesA.length, linesB.length) };

  const setA = new Set(linesA);
  const setB = new Set(linesB);
  let matched = 0;
  for (const line of setA) {
    if (setB.has(line)) matched++;
  }

  const score = Number(((matched * 2) / (setA.size + setB.size) * 100).toFixed(2));
  return { score, matched_lines: matched, total_lines: Math.max(linesA.length, linesB.length) };
}

// ─── 토큰 유사도 (공백/구분자 기준 토크나이징) ─────────────────

function tokenize(text, options = {}) {
  const { stripIdentifiers = false } = options;
  let tokens = (text || '').split(/[\s,;{}()\[\]<>+=\-*\/&|!^~@#%]+/).filter(Boolean);
  if (stripIdentifiers) {
    // 변수명/함수명으로 추정되는 식별자를 IDENT로 대체
    const keywords = new Set(['if', 'else', 'for', 'while', 'return', 'function', 'class', 'const', 'let', 'var',
      'import', 'export', 'default', 'new', 'this', 'true', 'false', 'null', 'undefined',
      'async', 'await', 'try', 'catch', 'throw', 'void', 'typeof', 'instanceof',
      'public', 'private', 'protected', 'static', 'interface', 'type', 'extends',
      'def', 'self', 'print', 'pass', 'with', 'yield', 'lambda', 'in', 'not', 'and', 'or']);
    tokens = tokens.map(t => (/^[a-zA-Z_]\w*$/.test(t) && !keywords.has(t)) ? 'IDENT' : t);
  }
  return tokens;
}

function tokenSimilarity(textA, textB, options = {}) {
  const tokA = tokenize(textA, options);
  const tokB = tokenize(textB, options);

  if (tokA.length === 0 && tokB.length === 0) return { score: 100, matched_tokens: 0 };
  if (tokA.length === 0 || tokB.length === 0) return { score: 0, matched_tokens: 0 };

  const freq = (tokens) => tokens.reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {});
  const fA = freq(tokA);
  const fB = freq(tokB);

  let intersection = 0;
  for (const [tok, cnt] of Object.entries(fA)) {
    intersection += Math.min(cnt, fB[tok] || 0);
  }

  const score = Number((intersection * 2 / (tokA.length + tokB.length) * 100).toFixed(2));
  return { score, matched_tokens: intersection };
}

// ─── 구조 유사도 (함수/클래스 시그니처 추출) ─────────────────

function extractSignatures(text) {
  const sigs = [];
  // 함수 선언 패턴
  const fnPatterns = [
    /function\s+(\w+)\s*\(([^)]*)\)/g,
    /(?:async\s+)?(\w+)\s*:\s*(?:async\s+)?(?:function)?\s*\(([^)]*)\)/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/g,
    /def\s+(\w+)\s*\(([^)]*)\)/g,           // Python
    /public\s+(?:static\s+)?(?:\w+\s+)?(\w+)\s*\(([^)]*)\)/g,  // Java/C#
  ];

  for (const pattern of fnPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const paramCount = match[2].split(',').filter(p => p.trim()).length;
      sigs.push({ name: match[1], params: paramCount, type: 'function' });
    }
  }

  // 클래스 선언
  const classPattern = /class\s+(\w+)(?:\s+extends\s+(\w+))?/g;
  let m;
  while ((m = classPattern.exec(text)) !== null) {
    sigs.push({ name: m[1], base: m[2] || null, type: 'class' });
  }

  return sigs;
}

function structureSimilarity(textA, textB) {
  const sigsA = extractSignatures(textA || '');
  const sigsB = extractSignatures(textB || '');

  if (sigsA.length === 0 && sigsB.length === 0) return { score: 100, matched_signatures: 0 };
  if (sigsA.length === 0 || sigsB.length === 0) return { score: 0, matched_signatures: 0 };

  const namesA = new Set(sigsA.map(s => s.name.toLowerCase()));
  const namesB = new Set(sigsB.map(s => s.name.toLowerCase()));

  let matched = 0;
  for (const name of namesA) {
    if (namesB.has(name)) matched++;
  }

  const score = Number((matched * 2 / (namesA.size + namesB.size) * 100).toFixed(2));
  return { score, matched_signatures: matched, sigs_a: sigsA.length, sigs_b: sigsB.length };
}

// ─── 종합 유사도 분석 ─────────────────────────────────────────

function analyzeCodeSimilarity(codeA, codeB, options = {}) {
  const { weights = { line: 0.4, token: 0.35, structure: 0.25 } } = options;

  const lineResult = lineSimilarity(codeA, codeB);
  const tokenResult = tokenSimilarity(codeA, codeB);
  const tokenStripResult = tokenSimilarity(codeA, codeB, { stripIdentifiers: true });
  const structResult = structureSimilarity(codeA, codeB);

  const compositeScore = Number((
    lineResult.score * weights.line +
    tokenResult.score * weights.token +
    structResult.score * weights.structure
  ).toFixed(2));

  let copyRisk = 'low';
  if (compositeScore >= 70 && tokenStripResult.score >= 80) {
    copyRisk = 'high';
  } else if (compositeScore >= 50 || tokenStripResult.score >= 65) {
    copyRisk = 'medium';
  }

  return {
    composite_score: compositeScore,
    line_similarity: lineResult.score,
    token_similarity: tokenResult.score,
    token_similarity_stripped: tokenStripResult.score,
    structure_similarity: structResult.score,
    matched_lines: lineResult.matched_lines,
    matched_signatures: structResult.matched_signatures,
    copy_risk: copyRisk,
    detail: { lineResult, tokenResult, tokenStripResult, structResult },
  };
}

// ─── 파일 단위 비교 ───────────────────────────────────────────

function compareFiles(filePathA, filePathB) {
  const codeA = fs.existsSync(filePathA) ? fs.readFileSync(filePathA, 'utf8') : '';
  const codeB = fs.existsSync(filePathB) ? fs.readFileSync(filePathB, 'utf8') : '';
  const result = analyzeCodeSimilarity(codeA, codeB);
  return {
    file_a: path.basename(filePathA),
    file_b: path.basename(filePathB),
    ...result,
  };
}

// ─── 디렉토리 단위 비교 ───────────────────────────────────────

function compareDirectories(dirA, dirB, options = {}) {
  const { extensions = ['.js', '.ts', '.py', '.java', '.cs', '.cpp', '.c', '.php'] } = options;

  function collectFiles(dir, base = '') {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectFiles(path.join(dir, entry.name), rel));
      } else if (extensions.includes(path.extname(entry.name))) {
        files.push(rel);
      }
    }
    return files;
  }

  const filesA = collectFiles(dirA);
  const filesB = collectFiles(dirB);

  const comparisons = [];
  let totalScore = 0;
  let count = 0;

  for (const fa of filesA) {
    const matchingB = filesB.find(fb => path.basename(fa) === path.basename(fb));
    if (matchingB) {
      const result = compareFiles(path.join(dirA, fa), path.join(dirB, matchingB));
      comparisons.push({ file_a: fa, file_b: matchingB, ...result });
      totalScore += result.composite_score;
      count++;
    }
  }

  const avgScore = count > 0 ? Number((totalScore / count).toFixed(2)) : 0;
  const highRiskFiles = comparisons.filter(c => c.copy_risk === 'high');
  const mediumRiskFiles = comparisons.filter(c => c.copy_risk === 'medium');

  return {
    average_similarity: avgScore,
    files_a_total: filesA.length,
    files_b_total: filesB.length,
    files_compared: count,
    high_risk_files: highRiskFiles.length,
    medium_risk_files: mediumRiskFiles.length,
    overall_risk: highRiskFiles.length > 0 ? 'high' : mediumRiskFiles.length > 2 ? 'medium' : 'low',
    comparisons,
  };
}

module.exports = {
  stringSimilarity,
  lineSimilarity,
  tokenSimilarity,
  structureSimilarity,
  analyzeCodeSimilarity,
  compareFiles,
  compareDirectories,
  extractSignatures,
};
