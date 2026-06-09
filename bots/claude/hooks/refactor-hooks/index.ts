/**
 * 리팩토링 안전 훅 6계층 (Claude Forge 패턴)
 *
 * 1. pre-refactor  — git tag (롤백 포인트) + 테스트 베이스라인
 * 2. type-check    — @ts-nocheck 제거 후 타입 검사
 * 3. node-check    — Node raw 실행형 파일 문법 검사
 * 4. test-green    — 리팩토링 후 테스트 green + 자동 롤백
 * 5. complexity    — 복잡도 증가 차단
 * 6. dependency    — 순환 의존성 차단
 * 7. verify-loop   — 실패 시 자동 수정 재시도 (최대 3회)
 */

export { runPreRefactorHook } from './pre-refactor-hook.ts';
export type { PreRefactorResult } from './pre-refactor-hook.ts';

export { runTypeCheckHook } from './type-check-hook.ts';
export type { TypeCheckResult } from './type-check-hook.ts';

export { runNodeCheckHook } from './node-check-hook.ts';
export type { NodeCheckResult } from './node-check-hook.ts';

export { runTestGreenHook } from './test-green-hook.ts';
export type { TestGreenResult } from './test-green-hook.ts';

export { runComplexityHook } from './complexity-hook.ts';
export type { ComplexityResult } from './complexity-hook.ts';

export { runDependencyHook } from './dependency-hook.ts';
export type { DependencyResult } from './dependency-hook.ts';

export { runVerifyLoop, runVerifyLoopWithTypeCheck } from './verify-loop-hook.ts';
export type { VerifyLoopResult, VerifyFn, FixFn } from './verify-loop-hook.ts';

import { runPreRefactorHook } from './pre-refactor-hook.ts';
import { runTypeCheckHook } from './type-check-hook.ts';
import { runNodeCheckHook } from './node-check-hook.ts';
import { runTestGreenHook } from './test-green-hook.ts';
import { runComplexityHook } from './complexity-hook.ts';
import { runDependencyHook } from './dependency-hook.ts';

export interface RefactorSafetyReport {
  targetFile: string;
  rollbackTag: string | null;
  typeCheck: ReturnType<typeof runTypeCheckHook>;
  nodeCheck: ReturnType<typeof runNodeCheckHook>;
  complexity: ReturnType<typeof runComplexityHook>;
  dependency: ReturnType<typeof runDependencyHook>;
  allPass: boolean;
}

export function runRefactorSafetyCheck(
  targetFile: string,
  rollbackTag?: string
): RefactorSafetyReport {
  const typeCheck = runTypeCheckHook(targetFile);
  const nodeCheck = runNodeCheckHook(targetFile);
  const complexity = runComplexityHook(targetFile);
  const dependency = runDependencyHook(targetFile);

  const allPass = typeCheck.pass && nodeCheck.pass && complexity.pass && dependency.pass;

  console.log(`[refactor-hooks] safety check: ${allPass ? '✓ PASS' : '✗ FAIL'} — ${targetFile}`);

  return {
    targetFile,
    rollbackTag: rollbackTag || null,
    typeCheck,
    nodeCheck,
    complexity,
    dependency,
    allPass,
  };
}
