// @ts-nocheck
/**
 * secrets-store-monitor-runner.ts — Stage D2 secrets 모니터 CLI
 *
 * launchd ai.hub.secrets-auto-rotate 가 매일 06:00 KST에 실행.
 * 직접 실행: npm run hub:secrets-monitor
 */

const { runSecretsMonitor } = require('../lib/secrets-store-monitor');

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

(async () => {
  const json = hasFlag('--json');
  if (!json) console.log(`[secrets-monitor-runner] ${new Date().toISOString()} 시작`);
  try {
    const result = await runSecretsMonitor({ dryRun: hasFlag('--dry-run'), silent: json });
    const hasCritical = result.critical > 0 || result.expired > 0;
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[secrets-monitor-runner] 완료: issues=${result.issues.length} critical/expired=${hasCritical ? '⚠️' : '✅'}`);
    }
    process.exit(0);
  } catch (err: any) {
    console.error('[secrets-monitor-runner] 오류:', err.message);
    process.exit(1);
  }
})();
