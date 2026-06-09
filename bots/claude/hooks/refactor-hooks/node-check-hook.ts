/**
 * node-check-hook: Node raw 실행형 파일 문법 검사
 * - shebang/CommonJS .ts 파일에 인라인 TS 타입 문법이 들어가면 런타임을 깨므로 차단
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '../../../..');

export interface NodeCheckResult {
  pass: boolean;
  skipped?: boolean;
  message: string;
  error: string | null;
}

function isNodeExecutableContent(content: string): boolean {
  const firstLine = String(content || '').split(/\r?\n/, 1)[0] || '';
  return /^#!.*\bnode\b/.test(firstLine)
    || /\brequire\s*\(/.test(content)
    || /\bmodule\.exports\b/.test(content)
    || /\bexports\./.test(content);
}

export function runNodeCheckHook(filePath: string, cwd?: string): NodeCheckResult {
  const workDir = cwd || REPO_ROOT;
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(workDir, filePath);

  const content = fs.readFileSync(absPath, 'utf8');
  if (!String(absPath).endsWith('.ts') || !isNodeExecutableContent(content)) {
    return {
      pass: true,
      skipped: true,
      message: 'node --check 생략 — raw Node 실행형 TypeScript 파일 아님',
      error: null,
    };
  }

  try {
    execFileSync(process.execPath, ['--check', absPath], {
      cwd: workDir,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`[node-check-hook] node --check pass: ${path.basename(absPath)}`);
    return {
      pass: true,
      message: 'node --check 통과 ✓',
      error: null,
    };
  } catch (err) {
    const failure = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const error = String(failure.stderr || failure.stdout || failure.message || err);
    console.warn(`[node-check-hook] node --check failed: ${path.basename(absPath)}`);
    return {
      pass: false,
      message: 'node --check 실패 — raw Node 실행 문법 수정 필요',
      error,
    };
  }
}
