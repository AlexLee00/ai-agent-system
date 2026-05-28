/**
 * test-green-hook: 리팩토링 후 테스트 green 확인
 * - 실패 시 자동 롤백 (rollbackTag 제공 시)
 */

import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '../../../..');

export interface TestGreenResult {
  pass: boolean;
  output: string;
  rolledBack: boolean;
  message: string;
}

export function runTestGreenHook(
  testCommand: string,
  rollbackTag?: string,
  cwd?: string
): TestGreenResult {
  const workDir = cwd || REPO_ROOT;

  const result = spawnSync('sh', ['-c', testCommand], {
    cwd: workDir,
    timeout: 120000,
    encoding: 'utf8',
  });

  const pass = result.status === 0;
  const output = (result.stdout || '') + (result.stderr || '');

  if (!pass) {
    console.error(`[test-green-hook] tests FAILED`);
    if (rollbackTag) {
      try {
        execSync(`git checkout "${rollbackTag}" -- .`, { cwd: workDir, stdio: 'pipe' });
        console.warn(`[test-green-hook] rolled back to ${rollbackTag}`);
        return { pass: false, output, rolledBack: true, message: `테스트 실패 → 자동 롤백: ${rollbackTag}` };
      } catch (err) {
        console.error(`[test-green-hook] rollback failed: ${err}`);
      }
    }
    return { pass: false, output: output.slice(0, 1000), rolledBack: false, message: '테스트 실패 — 수동 롤백 필요' };
  }

  console.log(`[test-green-hook] tests PASS ✓`);
  return { pass: true, output: output.slice(0, 500), rolledBack: false, message: '테스트 green ✓' };
}
