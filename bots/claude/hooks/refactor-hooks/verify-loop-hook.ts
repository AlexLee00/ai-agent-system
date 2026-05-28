/**
 * verify-loop-hook: 실패 시 자동 수정 재시도 (Claude Forge /verify-loop 패턴)
 * - 최대 3회 반복
 * - 각 시도에 fix 콜백 실행 후 재검증
 */

import path from 'node:path';

export interface VerifyLoopResult {
  pass: boolean;
  attempts: number;
  maxAttempts: number;
  attemptResults: boolean[];
  message: string;
}

export type VerifyFn = () => boolean | Promise<boolean>;
export type FixFn = (attempt: number) => void | Promise<void>;

export async function runVerifyLoop(
  verifyFn: VerifyFn,
  fixFn?: FixFn,
  maxAttempts = 3
): Promise<VerifyLoopResult> {
  const attemptResults: boolean[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pass = await Promise.resolve(verifyFn());
    attemptResults.push(pass);
    console.log(`[verify-loop-hook] attempt ${attempt}/${maxAttempts}: ${pass ? 'PASS' : 'FAIL'}`);

    if (pass) {
      return { pass: true, attempts: attempt, maxAttempts, attemptResults, message: `검증 통과 (${attempt}/${maxAttempts}번째 시도)` };
    }

    if (fixFn && attempt < maxAttempts) {
      console.log(`[verify-loop-hook] applying fix (attempt ${attempt})...`);
      await Promise.resolve(fixFn(attempt));
    }
  }

  return {
    pass: false,
    attempts: maxAttempts,
    maxAttempts,
    attemptResults,
    message: `${maxAttempts}회 시도 모두 실패 — 수동 개입 필요`,
  };
}

export async function runVerifyLoopWithTypeCheck(
  filePath: string,
  fixFn?: FixFn,
  maxAttempts = 3
): Promise<VerifyLoopResult> {
  const { runTypeCheckHook } = await import('./type-check-hook.ts');

  return runVerifyLoop(
    () => {
      const result = runTypeCheckHook(filePath);
      return result.pass;
    },
    fixFn,
    maxAttempts
  );
}
