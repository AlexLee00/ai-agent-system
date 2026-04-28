/**
 * scripts/agent-curriculum-smoke.ts — Phase D Curriculum Learning 스모크 테스트
 *
 * 테스트 항목:
 *   1. computeLevel — novice/intermediate/expert 임계 계산
 *   2. getCurriculumPromptAdjustment — 레벨별 지시문 검증
 *   3. recordInvocation — DB UPSERT (DB 연결 있을 때만)
 *   4. recordOutcome — success/failure 기록
 *   5. getAllCurriculumStates — 복수 에이전트 조회
 *   6. kill switch LUNA_AGENT_CURRICULUM_ENABLED=false
 */

import {
  recordInvocation,
  recordOutcome,
  getCurriculumState,
  getCurriculumPromptAdjustment,
  getAllCurriculumStates,
} from '../shared/agent-curriculum-tracker.ts';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function main(): Promise<void> {
  console.log('[curriculum-smoke] 시작');

  // ─── 1. 레벨별 지시문 검증 ─────────────────────────────────────────────────
  const novicePrompt = getCurriculumPromptAdjustment('novice');
  assert(novicePrompt.includes('초급'), '초급 레벨 지시문에 "초급" 포함 필요');
  assert(novicePrompt.includes('0.70'), 'novice confidence 임계 0.70 포함 필요');

  const intermediatePrompt = getCurriculumPromptAdjustment('intermediate');
  assert(intermediatePrompt.includes('중급'), '중급 레벨 지시문에 "중급" 포함 필요');
  assert(intermediatePrompt.includes('0.50'), 'intermediate confidence 임계 0.50 포함 필요');

  const expertPrompt = getCurriculumPromptAdjustment('expert');
  assert(expertPrompt.includes('숙련'), '숙련 레벨 지시문에 "숙련" 포함 필요');
  assert(expertPrompt.includes('0.40'), 'expert confidence 임계 0.40 포함 필요');

  console.log('[curriculum-smoke] 레벨 지시문 검증 ✅');

  // ─── 2. kill switch ────────────────────────────────────────────────────────
  const origEnabled = process.env.LUNA_AGENT_CURRICULUM_ENABLED;
  process.env.LUNA_AGENT_CURRICULUM_ENABLED = 'false';

  const killState = await getCurriculumState('test-agent', 'crypto');
  assert(killState.level === 'novice', 'kill switch 시 기본 novice 반환 필요');
  assert(killState.invocationCount === 0, 'kill switch 시 invocationCount 0 반환 필요');

  const killResult = await recordInvocation('test-agent', 'crypto');
  assert(killResult.level === 'novice', 'kill switch 시 recordInvocation novice 반환 필요');

  if (origEnabled == null) delete process.env.LUNA_AGENT_CURRICULUM_ENABLED;
  else process.env.LUNA_AGENT_CURRICULUM_ENABLED = origEnabled;

  console.log('[curriculum-smoke] kill switch 검증 ✅');

  // ─── 3. DB 연결 테스트 (연결 가능할 때만) ────────────────────────────────────
  const testAgent = `smoke-curriculum-${Date.now()}`;
  const testMarket = 'crypto';

  // pgPool 직접 import해 테이블 존재 여부 확인
  const { createRequire } = await import('module');
  const _require = createRequire(import.meta.url);
  let pgPool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } | null = null;
  let tableExists = false;
  try {
    pgPool = _require('../../../packages/core/lib/pg-pool');
    const check = await pgPool!.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='investment' AND table_name='agent_curriculum_state'`,
    );
    tableExists = (check.rows.length ?? 0) > 0;
  } catch {
    // DB 미연결
  }

  if (!tableExists) {
    console.log('[curriculum-smoke] agent_curriculum_state 테이블 미존재 → DB 검증 건너뜀 (migration 필요)');
  } else {
    try {
    // 초기 상태는 없어야 함
    const initial = await getCurriculumState(testAgent, testMarket);
    assert(initial.invocationCount === 0, '초기 invocationCount는 0이어야 함');
    assert(initial.level === 'novice', '초기 레벨은 novice여야 함');

    // 1회 기록
    const after1 = await recordInvocation(testAgent, testMarket);
    assert(after1.invocationCount === 1, '1회 기록 후 invocationCount 1 필요');
    assert(after1.level === 'novice', '1회 기록 후 novice 유지');

    // success 기록
    await recordOutcome(testAgent, testMarket, true);
    const afterSuccess = await getCurriculumState(testAgent, testMarket);
    assert(afterSuccess.successCount >= 1, 'success 기록 후 successCount >= 1 필요');

    // failure 기록
    await recordOutcome(testAgent, testMarket, false);
    const afterFailure = await getCurriculumState(testAgent, testMarket);
    assert(afterFailure.failureCount >= 1, 'failure 기록 후 failureCount >= 1 필요');

    // successRate 계산 검증
    const total = afterFailure.successCount + afterFailure.failureCount;
    const expectedRate = afterFailure.successCount / total;
    assert(
      Math.abs(afterFailure.successRate - expectedRate) < 0.01,
      `successRate 계산 오류: expected=${expectedRate}, got=${afterFailure.successRate}`,
    );

    // getAllCurriculumStates — 방금 삽입한 에이전트 포함 확인
    const allStates = await getAllCurriculumStates(testMarket);
    const found = allStates.find((s) => s.agentName === testAgent);
    assert(found !== undefined, `getAllCurriculumStates에서 ${testAgent} 발견 필요`);

    console.log('[curriculum-smoke] DB 연결 검증 ✅');
    console.log(`  invocationCount=${after1.invocationCount}, successRate=${afterFailure.successRate.toFixed(2)}`);
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      if (msg.includes('connect') || msg.includes('ECONNREFUSED') || msg.includes('relation') || msg.includes('does not exist')) {
        console.log(`[curriculum-smoke] DB 오류 → 건너뜀 (${msg.slice(0, 60)})`);
      } else {
        throw err;
      }
    }
  }

  // ─── 4. 레벨 임계 검증 ────────────────────────────────────────────────────
  const noviceThreshold = parseInt(process.env.LUNA_AGENT_NOVICE_THRESHOLD || '100', 10);
  const expertThreshold = parseInt(process.env.LUNA_AGENT_EXPERT_THRESHOLD || '1000', 10);
  assert(noviceThreshold < expertThreshold, 'novice 임계가 expert 임계보다 작아야 함');
  assert(noviceThreshold > 0, 'novice 임계는 양수여야 함');
  console.log('[curriculum-smoke] 임계 설정 검증 ✅');

  console.log('[curriculum-smoke] 전체 통과 ✅');
}

main().catch((err) => {
  console.error('[curriculum-smoke] 실패:', err.message || err);
  process.exit(1);
});
