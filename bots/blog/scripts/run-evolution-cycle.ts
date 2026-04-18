/**
 * bots/blog/scripts/run-evolution-cycle.ts
 * 자율진화 루프 실행 스크립트
 *
 * Phase 3: 매일 23:00 KST launchd 실행
 * Kill Switch: BLOG_EVOLUTION_CYCLE_ENABLED=true
 */

const { initHubConfig } = require('../../../packages/core/lib/llm-keys');
const { runEvolutionCycle } = require('../lib/evolution-cycle');

async function main() {
  console.log('[run-evolution-cycle] 시작');

  try {
    await initHubConfig();
  } catch {
    // Hub 연결 실패해도 계속
  }

  const result = await runEvolutionCycle();
  if (result) {
    console.log(`[run-evolution-cycle] 완료 — cycle_id: ${result.cycle_id}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[run-evolution-cycle] 치명적 오류:', err.message);
  process.exit(1);
});
