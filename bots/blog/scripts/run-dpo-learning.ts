/**
 * bots/blog/scripts/run-dpo-learning.ts
 * DPO 주간 학습 사이클 실행 스크립트
 *
 * Phase 6: 매주 월요일 03:00 KST launchd 실행
 * Kill Switch: BLOG_DPO_ENABLED=true
 */

const { initHubConfig } = require('../../../packages/core/lib/llm-keys');
const { runDpoLearningCycle } = require('../lib/self-rewarding/marketing-dpo');

async function main() {
  console.log('[run-dpo-learning] 시작');

  try {
    await initHubConfig();
  } catch {
    // Hub 연결 실패해도 계속
  }

  const result = await runDpoLearningCycle();
  console.log(`[run-dpo-learning] 완료 — 선호 쌍: ${result.pairs_built}개, 저장: ${result.pairs_saved}개`);

  process.exit(0);
}

main().catch((err) => {
  console.error('[run-dpo-learning] 치명적 오류:', err.message);
  process.exit(1);
});
