/**
 * dependency-hook: 순환 의존성 차단
 * - import 그래프 기반 단순 순환 감지
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface DependencyResult {
  pass: boolean;
  circularPaths: string[][];
  message: string;
}

function extractImports(filePath: string, baseDir: string): string[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf8');
    const imports: string[] = [];
    const importRegex = /from\s+['"](\.[^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRegex.exec(content)) !== null) {
      const resolved = path.resolve(path.dirname(filePath), m[1]);
      const candidates = [resolved, resolved + '.ts', resolved + '/index.ts'];
      for (const c of candidates) {
        if (existsSync(c)) { imports.push(c); break; }
      }
    }
    return imports;
  } catch {
    return [];
  }
}

function detectCycles(startFile: string, baseDir: string): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(file: string): void {
    if (stack.includes(file)) {
      const cycleStart = stack.indexOf(file);
      cycles.push([...stack.slice(cycleStart), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    stack.push(file);
    const deps = extractImports(file, baseDir);
    for (const dep of deps) {
      // 只 팀 내부만 (venv, node_modules 제외)
      if (!dep.includes('node_modules') && !dep.includes('venv') && dep.startsWith(baseDir)) {
        dfs(dep);
      }
    }
    stack.pop();
  }

  dfs(startFile);
  return cycles;
}

export function runDependencyHook(filePath: string, baseDir?: string): DependencyResult {
  const absPath = path.resolve(filePath);
  const base = baseDir || path.dirname(absPath);

  const circularPaths = detectCycles(absPath, base);

  if (circularPaths.length > 0) {
    console.warn(`[dependency-hook] circular dependency detected in ${path.basename(absPath)}`);
    circularPaths.forEach((cycle) =>
      console.warn(`  cycle: ${cycle.map((f) => path.basename(f)).join(' → ')}`)
    );
  } else {
    console.log(`[dependency-hook] no circular dependencies: ${path.basename(absPath)}`);
  }

  return {
    pass: circularPaths.length === 0,
    circularPaths: circularPaths.map((cycle) => cycle.map((f) => path.relative(base, f))),
    message: circularPaths.length === 0
      ? '순환 의존성 없음 ✓'
      : `순환 의존성 ${circularPaths.length}개 발견 — 구조 재검토 필요`,
  };
}
