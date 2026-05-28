// @ts-nocheck
/**
 * type-check-hook: @ts-nocheck 제거 후 타입 검사
 * - 새 타입 에러 차단
 * - 에러 목록 반환
 */

import { execSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '../../../..');

export interface TypeCheckResult {
  pass: boolean;
  errorCount: number;
  errors: string[];
  message: string;
}

export function runTypeCheckHook(filePath: string, cwd?: string): TypeCheckResult {
  const workDir = cwd || REPO_ROOT;
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(workDir, filePath);

  try {
    const output = execSync(
      `cd "${workDir}" && npx tsc --noEmit --skipLibCheck "${absPath}" 2>&1 || true`,
      { encoding: 'utf8', timeout: 30000 }
    );

    const errorLines = output.split('\n').filter((l) => l.includes('error TS'));
    const errorCount = errorLines.length;

    if (errorCount > 0) {
      console.warn(`[type-check-hook] ${errorCount} type errors in ${path.basename(absPath)}`);
      errorLines.slice(0, 5).forEach((e) => console.warn(`  ${e}`));
    } else {
      console.log(`[type-check-hook] type check pass: ${path.basename(absPath)}`);
    }

    return {
      pass: errorCount === 0,
      errorCount,
      errors: errorLines.slice(0, 10),
      message: errorCount === 0
        ? `타입 에러 없음 ✓`
        : `타입 에러 ${errorCount}개 — 수정 필요`,
    };
  } catch (err) {
    return { pass: false, errorCount: -1, errors: [String(err)], message: 'tsc 실행 실패' };
  }
}
