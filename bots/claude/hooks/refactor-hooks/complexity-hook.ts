// @ts-nocheck
/**
 * complexity-hook: 복잡도 증가 차단
 * - 함수 수, 중첩 깊이, 파일 크기 기준으로 복잡도 측정
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface ComplexityResult {
  pass: boolean;
  lineCount: number;
  functionCount: number;
  maxNestDepth: number;
  score: number;
  message: string;
}

function estimateFunctionCount(content: string): number {
  const matches = content.match(/\bfunction\b|\=>\s*\{/g);
  return matches ? matches.length : 0;
}

function estimateMaxNestDepth(content: string): number {
  let maxDepth = 0;
  let depth = 0;
  for (const ch of content) {
    if (ch === '{') { depth++; maxDepth = Math.max(maxDepth, depth); }
    else if (ch === '}') { depth = Math.max(0, depth - 1); }
  }
  return maxDepth;
}

export function runComplexityHook(filePath: string, maxLines = 500, maxFunctions = 30, maxDepth = 8): ComplexityResult {
  if (!existsSync(filePath)) {
    return { pass: false, lineCount: 0, functionCount: 0, maxNestDepth: 0, score: 0, message: `file not found: ${filePath}` };
  }

  const content = readFileSync(filePath, 'utf8');
  const lineCount = content.split('\n').length;
  const functionCount = estimateFunctionCount(content);
  const maxNestDepth = estimateMaxNestDepth(content);

  // 0-100 점수 (낮을수록 복잡)
  const lineScore = Math.max(0, 100 - Math.max(0, lineCount - maxLines) / 10);
  const funcScore = Math.max(0, 100 - Math.max(0, functionCount - maxFunctions) * 3);
  const depthScore = Math.max(0, 100 - Math.max(0, maxNestDepth - maxDepth) * 10);
  const score = Math.round((lineScore + funcScore + depthScore) / 3);

  const pass = score >= 60;

  if (!pass) {
    console.warn(`[complexity-hook] complexity score: ${score}/100 — ${path.basename(filePath)}`);
  } else {
    console.log(`[complexity-hook] complexity ok: ${score}/100 — ${path.basename(filePath)}`);
  }

  return {
    pass,
    lineCount,
    functionCount,
    maxNestDepth,
    score,
    message: pass
      ? `복잡도 허용 범위 (${score}/100)`
      : `복잡도 초과 (${score}/100) — 분할 권장 (lines:${lineCount}, funcs:${functionCount}, depth:${maxNestDepth})`,
  };
}
