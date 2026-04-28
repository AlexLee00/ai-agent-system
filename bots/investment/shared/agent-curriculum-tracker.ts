// @ts-nocheck
/**
 * shared/agent-curriculum-tracker.ts — Phase D: Curriculum Learning 상태 추적
 *
 * Voyager 패턴 기반:
 *   novice   (< 100 회):  conservative 프롬프트, confidence 임계 0.7+
 *   intermediate (100~1000): balanced 프롬프트, 임계 0.5+
 *   expert   (1000+ 회):  aggressive 프롬프트, 임계 0.4+
 *
 * Kill Switch:
 *   LUNA_AGENT_CURRICULUM_ENABLED=false → 전체 비활성 (항상 novice 레벨)
 *
 * 사용법:
 *   import { recordInvocation, getCurriculumPromptAdjustment } from './agent-curriculum-tracker.ts';
 *   // LLM 호출 직후:
 *   recordInvocation(agentName, market).catch(() => {}); // 비동기, fire-and-forget
 */

import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
const pgPool = _require('../../../packages/core/lib/pg-pool');

const CURRICULUM_ENABLED = () => process.env.LUNA_AGENT_CURRICULUM_ENABLED !== 'false';

const NOVICE_THRESHOLD = () => parseInt(process.env.LUNA_AGENT_NOVICE_THRESHOLD || '100', 10);
const EXPERT_THRESHOLD = () => parseInt(process.env.LUNA_AGENT_EXPERT_THRESHOLD || '1000', 10);

export type CurriculumLevel = 'novice' | 'intermediate' | 'expert';

export interface CurriculumState {
  level: CurriculumLevel;
  invocationCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
}

/** invocation_count로 레벨 계산 */
function computeLevel(count: number): CurriculumLevel {
  if (count < NOVICE_THRESHOLD()) return 'novice';
  if (count < EXPERT_THRESHOLD()) return 'intermediate';
  return 'expert';
}

/**
 * LLM 호출 1회 기록 — UPSERT to agent_curriculum_state.
 * fire-and-forget 방식으로 호출 (LLM 결과에 영향 없음).
 */
export async function recordInvocation(
  agentName: string,
  market: string = 'any',
): Promise<CurriculumState> {
  if (!CURRICULUM_ENABLED()) {
    return { level: 'novice', invocationCount: 0, successCount: 0, failureCount: 0, successRate: 0 };
  }

  try {
    const result = await pgPool.query(
      `INSERT INTO investment.agent_curriculum_state
         (agent_name, market, invocation_count, success_count, failure_count, current_level, updated_at)
       VALUES ($1, $2, 1, 0, 0, 'novice', NOW())
       ON CONFLICT (agent_name, market)
       DO UPDATE SET
         invocation_count = investment.agent_curriculum_state.invocation_count + 1,
         current_level    = CASE
           WHEN investment.agent_curriculum_state.invocation_count + 1 < $3 THEN 'novice'
           WHEN investment.agent_curriculum_state.invocation_count + 1 < $4 THEN 'intermediate'
           ELSE 'expert'
         END,
         updated_at       = NOW()
       RETURNING invocation_count, success_count, failure_count, current_level`,
      [agentName, market, NOVICE_THRESHOLD(), EXPERT_THRESHOLD()],
    );

    const row = result.rows[0];
    const invocationCount = row?.invocation_count ?? 1;
    const successCount = row?.success_count ?? 0;
    const failureCount = row?.failure_count ?? 0;
    const level: CurriculumLevel = (row?.current_level ?? 'novice') as CurriculumLevel;
    const total = successCount + failureCount;
    const successRate = total > 0 ? successCount / total : 0;

    return { level, invocationCount, successCount, failureCount, successRate };
  } catch {
    return { level: 'novice', invocationCount: 0, successCount: 0, failureCount: 0, successRate: 0 };
  }
}

/**
 * 거래 결과 기록 — success_count 또는 failure_count 증가.
 * Posttrade feedback 또는 weekly-review에서 호출.
 */
export async function recordOutcome(
  agentName: string,
  market: string = 'any',
  success: boolean,
): Promise<void> {
  if (!CURRICULUM_ENABLED()) return;

  try {
    const column = success ? 'success_count' : 'failure_count';
    await pgPool.query(
      `INSERT INTO investment.agent_curriculum_state
         (agent_name, market, invocation_count, success_count, failure_count, current_level, updated_at)
       VALUES ($1, $2, 0, $3, $4, 'novice', NOW())
       ON CONFLICT (agent_name, market)
       DO UPDATE SET
         ${column} = investment.agent_curriculum_state.${column} + 1,
         updated_at = NOW()`,
      [agentName, market, success ? 1 : 0, success ? 0 : 1],
    );
  } catch {
    // fire-and-forget
  }
}

/**
 * 현재 curriculum 상태 조회.
 */
export async function getCurriculumState(
  agentName: string,
  market: string = 'any',
): Promise<CurriculumState> {
  if (!CURRICULUM_ENABLED()) {
    return { level: 'novice', invocationCount: 0, successCount: 0, failureCount: 0, successRate: 0 };
  }

  try {
    const result = await pgPool.query(
      `SELECT invocation_count, success_count, failure_count, current_level
         FROM investment.agent_curriculum_state
        WHERE agent_name = $1 AND market = $2
        LIMIT 1`,
      [agentName, market],
    );

    if (!result.rows.length) {
      return { level: 'novice', invocationCount: 0, successCount: 0, failureCount: 0, successRate: 0 };
    }

    const row = result.rows[0];
    const total = row.success_count + row.failure_count;
    return {
      level: row.current_level as CurriculumLevel,
      invocationCount: row.invocation_count,
      successCount: row.success_count,
      failureCount: row.failure_count,
      successRate: total > 0 ? row.success_count / total : 0,
    };
  } catch {
    return { level: 'novice', invocationCount: 0, successCount: 0, failureCount: 0, successRate: 0 };
  }
}

/**
 * 레벨별 system prompt 추가 지시문 반환.
 * hub-llm-client 또는 agent-memory-orchestrator에서 prefix에 삽입.
 */
export function getCurriculumPromptAdjustment(level: CurriculumLevel): string {
  switch (level) {
    case 'novice':
      return [
        '## 운영 레벨: 초급 (Novice)',
        '- 불확실한 경우 conservative 판단을 우선하라.',
        '- confidence가 0.70 미만이면 진입 보류를 권고하라.',
        '- 새 패턴 시도보다 검증된 패턴을 우선 사용하라.',
      ].join('\n');

    case 'intermediate':
      return [
        '## 운영 레벨: 중급 (Intermediate)',
        '- confidence 0.50 이상이면 진입을 적극 검토하라.',
        '- 새 패턴도 신중하게 시도할 수 있다.',
      ].join('\n');

    case 'expert':
      return [
        '## 운영 레벨: 숙련 (Expert)',
        '- confidence 0.40 이상에서도 진입을 허용한다.',
        '- 새 패턴 발굴을 적극적으로 시도하라.',
        '- 더 큰 포지션 사이즈를 고려할 수 있다.',
      ].join('\n');
  }
}

/**
 * 복수 에이전트 curriculum 현황 조회 (대시보드용).
 */
export async function getAllCurriculumStates(
  market?: string,
): Promise<Array<CurriculumState & { agentName: string; market: string }>> {
  if (!CURRICULUM_ENABLED()) return [];

  try {
    const whereClause = market ? 'WHERE market = $1' : '';
    const params = market ? [market] : [];
    const result = await pgPool.query(
      `SELECT agent_name, market, invocation_count, success_count, failure_count, current_level
         FROM investment.agent_curriculum_state
         ${whereClause}
         ORDER BY invocation_count DESC`,
      params,
    );

    return result.rows.map((row: Record<string, unknown>) => {
      const total = (row.success_count as number) + (row.failure_count as number);
      return {
        agentName: row.agent_name as string,
        market: row.market as string,
        level: row.current_level as CurriculumLevel,
        invocationCount: row.invocation_count as number,
        successCount: row.success_count as number,
        failureCount: row.failure_count as number,
        successRate: total > 0 ? (row.success_count as number) / total : 0,
      };
    });
  } catch {
    return [];
  }
}
