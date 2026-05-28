// @ts-nocheck
/**
 * pre-refactor-hook: 리팩토링 시작 전 실행
 * - git tag 자동 생성 (롤백 포인트)
 * - 현재 테스트 베이스라인 측정
 */

import { execSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '../../../..');

export interface PreRefactorResult {
  ok: boolean;
  tagCreated: string | null;
  testsBaselinePassed: boolean | null;
  message: string;
}

export function runPreRefactorHook(targetName: string, cwd?: string): PreRefactorResult {
  const workDir = cwd || REPO_ROOT;
  const tagName = `refactor-${targetName}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16)}`;

  // git tag 생성
  let tagCreated: string | null = null;
  try {
    execSync(`git tag "${tagName}"`, { cwd: workDir, stdio: 'pipe' });
    tagCreated = tagName;
    console.log(`[pre-refactor-hook] rollback tag: ${tagName}`);
  } catch (err) {
    console.warn(`[pre-refactor-hook] tag creation failed: ${err}`);
  }

  // 테스트 베이스라인 (빠른 smoke pass/fail만)
  let testsBaselinePassed: boolean | null = null;
  try {
    const result = execSync(`cd "${workDir}" && npx jest --passWithNoTests --silent 2>&1 | tail -3`, {
      encoding: 'utf8',
      timeout: 60000,
    });
    testsBaselinePassed = !result.includes('FAIL') && !result.includes('failed');
    console.log(`[pre-refactor-hook] baseline tests: ${testsBaselinePassed ? 'pass' : 'fail'}`);
  } catch {
    testsBaselinePassed = null;
  }

  return {
    ok: true,
    tagCreated,
    testsBaselinePassed,
    message: tagCreated
      ? `롤백 포인트 생성: ${tagCreated}`
      : 'git tag 생성 실패 — 수동 태그 후 진행 권장',
  };
}
