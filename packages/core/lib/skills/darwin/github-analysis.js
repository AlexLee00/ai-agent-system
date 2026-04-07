'use strict';

/**
 * GitHub 레포 소스 코드 분석 스킬
 * 다윈팀 scholar가 외부 오픈소스 분석 시 사용
 * 기존 스킬 패턴 준수 (순수 함수, LLM 불필요)
 */

/**
 * 레포 구조 분석 — 핵심 디렉토리/파일 식별
 * @param {any} [input]
 * @returns {{ summary: object, keyDirs: Array<any>, keyFiles: Array<any> }}
 */
function analyzeRepoStructure(input = {}) {
  const tree = Array.isArray(input.tree) ? input.tree : [];
  const files = tree.filter(t => t.type === 'blob');
  const dirs = tree.filter(t => t.type === 'tree');

  const langCount = {};
  for (const f of files) {
    const ext = (f.path.match(/\.(\w+)$/) || [])[1] || 'other';
    langCount[ext] = (langCount[ext] || 0) + 1;
  }

  const importantNames = ['README', 'main', 'index', 'app', 'server', 'engine', 'core', 'config'];
  const keyFiles = files
    .filter(f => {
      const name = f.path.split('/').pop().replace(/\.\w+$/, '').toLowerCase();
      return importantNames.some(n => name.includes(n)) || f.size > 10000;
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, 20)
    .map(f => ({ path: f.path, size: f.size }));

  const topDirs = {};
  for (const f of files) {
    const topDir = f.path.split('/')[0];
    if (!topDirs[topDir]) topDirs[topDir] = { files: 0, totalSize: 0 };
    topDirs[topDir].files++;
    topDirs[topDir].totalSize += f.size || 0;
  }
  const keyDirs = Object.entries(topDirs)
    .sort((a, b) => b[1].files - a[1].files)
    .slice(0, 15)
    .map(([name, stats]) => ({ name, ...stats }));

  return {
    summary: {
      totalFiles: files.length,
      totalDirs: dirs.length,
      totalSize: files.reduce((s, f) => s + (f.size || 0), 0),
      languages: langCount,
    },
    keyDirs,
    keyFiles,
  };
}

/**
 * 소스 코드에서 패턴 추출 — 함수/클래스/export 식별
 * @param {any} [input]
 * @returns {{ path: string, totalLines: number, functions: Array<any>, classes: Array<any>, exports: Array<any>, imports: Array<any>, patterns: any }}
 */
function extractCodePatterns(input = {}) {
  const content = String(input.content || '');
  const path = String(input.path || '');
  const lines = content.split('\n');

  const functions = [];
  const classes = [];
  const exports = [];
  const imports = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Python
    if (/^(async\s+)?def\s+(\w+)/.test(line)) {
      functions.push({ name: line.match(/def\s+(\w+)/)[1], line: i + 1 });
    }
    if (/^class\s+(\w+)/.test(line)) {
      classes.push({ name: line.match(/class\s+(\w+)/)[1], line: i + 1 });
    }
    // JavaScript/TypeScript
    if (/^(export\s+)?(async\s+)?function\s+(\w+)/.test(line)) {
      const m = line.match(/function\s+(\w+)/);
      if (m) functions.push({ name: m[1], line: i + 1 });
    }
    if (/^(export\s+)?class\s+(\w+)/.test(line)) {
      const m = line.match(/class\s+(\w+)/);
      if (m) classes.push({ name: m[1], line: i + 1 });
    }
    // exports
    if (/^module\.exports|^export\s+(default|{)/.test(line)) {
      exports.push({ line: i + 1, text: line.slice(0, 100) });
    }
    // imports
    if (/^(import|from|require)\b/.test(line) || /= require\(/.test(line)) {
      imports.push({ line: i + 1, text: line.slice(0, 100) });
    }
  }

  return {
    path,
    totalLines: lines.length,
    functions: functions.slice(0, 50),
    classes: classes.slice(0, 20),
    exports: exports.slice(0, 20),
    imports: imports.slice(0, 30),
    patterns: {
      hasAsync: content.includes('async '),
      hasTests: /test|spec|describe|it\(/.test(content),
      hasErrorHandling: /try\s*{|catch|except/.test(content),
      hasLogging: /console\.|logging\.|logger\./.test(content),
    },
  };
}

/**
 * 분석 결과 요약 생성 — LLM 프롬프트용
 * @param {any} [input]
 * @returns {{ summary: string }}
 */
function generateAnalysisSummary(input = {}) {
  const info = input.repoInfo || {};
  const struct = input.structure || {};
  const patterns = input.codePatterns || [];

  const lines = [
    `# ${info.name || 'Unknown'} 분석 요약`,
    `⭐ ${info.stars || 0} | 📝 ${info.language || '?'} | 📄 ${info.license || '?'}`,
    `📋 ${info.description || ''}`,
    '',
    `## 구조: ${struct.summary?.totalFiles || 0}파일, ${struct.summary?.totalDirs || 0}디렉토리`,
    '',
    '### 핵심 디렉토리:',
    ...(struct.keyDirs || []).slice(0, 10).map(d => `  ${d.name}/ (${d.files}파일, ${Math.round(d.totalSize / 1024)}KB)`),
    '',
    '### 핵심 파일:',
    ...(struct.keyFiles || []).slice(0, 10).map(f => `  ${f.path} (${Math.round(f.size / 1024)}KB)`),
    '',
    '### 코드 패턴:',
    ...patterns.slice(0, 5).map(p =>
      `  ${p.path}: ${p.functions.length}함수, ${p.classes.length}클래스, ${p.imports.length}imports`
    ),
  ];

  return { summary: lines.join('\n') };
}

module.exports = { analyzeRepoStructure, extractCodePatterns, generateAnalysisSummary };
