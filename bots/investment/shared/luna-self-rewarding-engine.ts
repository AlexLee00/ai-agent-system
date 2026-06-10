// @ts-nocheck
/**
 * Luna Self-Rewarding Engine
 *
 * 2026 트렌드: Self-Rewarding Mechanism
 * 마스터 철학: "끊임없는 진화! 자기 강화!"
 *
 * - 매매 결과 → 자율 리워드 생성
 * - 리워드 → 전략 mutation 자동 제안
 * - agent_curriculum_state 갱신 (novice→expert)
 * - 주간 리포트 자동 생성
 */

import * as db from './db/core.ts';

// ─── 타입 정의 ─────────────────────────────────────────────────

export interface SelfRewardInput {
  tradeId: string;
  market: 'crypto' | 'stocks' | 'overseas';
  symbol: string;
  pnlPct: number;
  holdingHours: number;
  signalQuality: number;   // 0~1: 신호 품질 (분석 합의도)
  executionSlippage: number; // 실행 미끄러짐 (bps)
  agentsInvolved: string[];
}

export interface SelfReward {
  tradeId: string;
  rawPnlReward: number;       // PnL 기반 기본 리워드
  qualityBonus: number;       // 신호 품질 보너스
  efficiencyBonus: number;    // 보유 효율성 보너스
  executionPenalty: number;   // 실행 패널티
  totalReward: number;        // 합산 리워드 (-1~1)
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  feedback: string;
  mutationSuggestion?: MutationSuggestion;
}

export interface MutationSuggestion {
  paramName: string;
  direction: 'increase' | 'decrease';
  magnitude: 'small' | 'medium' | 'large';
  reason: string;
}

export interface WeeklyLearningReport {
  weekStart: string;
  weekEnd: string;
  market: string;
  totalTrades: number;
  avgReward: number;
  expertAgents: string[];
  noviceAgents: string[];
  topMutation: string | null;
  learningVelocity: number;   // 0~1: 학습 속도
  nextWeekFocus: string;
}

// ─── 리워드 계산 ─────────────────────────────────────────────

/**
 * 자율 리워드 생성 — 단순 PnL을 넘어 다차원 평가
 */
export function calcSelfReward(input: SelfRewardInput): SelfReward {
  // 1. PnL 기반 기본 리워드 (-1~1)
  const rawPnlReward = Math.max(-1, Math.min(1, input.pnlPct * 0.1));

  // 2. 신호 품질 보너스 (좋은 신호로 돈을 벌었으면 보너스)
  const qualityBonus = input.signalQuality > 0.7 && input.pnlPct > 0
    ? (input.signalQuality - 0.7) * 0.5
    : 0;

  // 3. 보유 효율성 (적절한 시간에 청산했는지)
  // 너무 짧게 (< 4h) 또는 너무 길게 (> 72h) 보유 시 패널티
  const optimalHoldMin = 4;
  const optimalHoldMax = 48;
  const efficiencyBonus = input.holdingHours >= optimalHoldMin && input.holdingHours <= optimalHoldMax
    ? 0.05
    : input.holdingHours < optimalHoldMin
      ? -0.10   // 너무 짧은 보유
      : -0.05;  // 너무 긴 보유

  // 4. 실행 패널티 (슬리피지가 크면 패널티)
  const executionPenalty = input.executionSlippage > 20  // 20bps 초과
    ? -Math.min(0.2, input.executionSlippage * 0.005)
    : 0;

  const totalReward = Math.max(-1, Math.min(1,
    rawPnlReward + qualityBonus + efficiencyBonus + executionPenalty
  ));

  const grade = gradeReward(totalReward);
  const feedback = buildFeedback(input, totalReward, qualityBonus, efficiencyBonus, executionPenalty);
  const mutationSuggestion = suggestMutation(input, totalReward);

  return {
    tradeId: input.tradeId,
    rawPnlReward: round(rawPnlReward),
    qualityBonus: round(qualityBonus),
    efficiencyBonus: round(efficiencyBonus),
    executionPenalty: round(executionPenalty),
    totalReward: round(totalReward),
    grade,
    feedback,
    mutationSuggestion,
  };
}

// ─── DB 저장 ────────────────────────────────────────────────

/**
 * 리워드를 DB에 기록 + 에이전트 커리큘럼 갱신
 */
export async function recordSelfReward(reward: SelfReward, market: string, agentsInvolved: string[]): Promise<void> {
  // 1. trade_quality_evaluations 갱신 (self-reward 반영)
  try {
    await db.query(`
      UPDATE investment.trade_quality_evaluations
      SET
        overall_score = GREATEST(overall_score, $2),
        rationale = rationale || ' | self_reward=' || $3,
        updated_at = NOW()
      WHERE trade_id = $1
    `, [reward.tradeId, Math.max(0, (reward.totalReward + 1) / 2), reward.totalReward.toFixed(3)]);
  } catch (_err) {
    // 없으면 skip
  }

  // 2. mutation 제안 기록
  if (reward.mutationSuggestion) {
    try {
      await db.query(`
        INSERT INTO investment.feedback_to_action_map (
          source_trade_id, parameter_name, old_value, new_value, reason, created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())
      `, [
        reward.tradeId,
        reward.mutationSuggestion.paramName,
        reward.mutationSuggestion.direction === 'increase' ? 'current' : 'current',
        reward.mutationSuggestion.direction,
        reward.mutationSuggestion.reason,
      ]);
    } catch (_err) {
      // skip
    }
  }

  // 3. 에이전트 커리큘럼 갱신
  for (const agentName of agentsInvolved) {
    try {
      const successful = reward.totalReward > 0;
      await db.query(`
        INSERT INTO investment.agent_curriculum_state (
          agent_name, market, invocation_count, success_count, current_level, updated_at
        ) VALUES ($1, $2, 1, $3, 'novice', NOW())
        ON CONFLICT (agent_name, market) DO UPDATE SET
          invocation_count = agent_curriculum_state.invocation_count + 1,
          success_count = agent_curriculum_state.success_count + $3,
          current_level = CASE
            WHEN (agent_curriculum_state.success_count + $3)::float /
                 NULLIF(agent_curriculum_state.invocation_count + 1, 0) >= 0.65
             AND agent_curriculum_state.invocation_count >= 19
            THEN 'expert'
            WHEN (agent_curriculum_state.success_count + $3)::float /
                 NULLIF(agent_curriculum_state.invocation_count + 1, 0) >= 0.50
            THEN 'intermediate'
            ELSE 'novice'
          END,
          updated_at = NOW()
      `, [agentName, market, successful ? 1 : 0]);
    } catch (_err) {
      // 개별 에이전트 실패 시 계속
    }
  }
}

// ─── 주간 학습 리포트 ────────────────────────────────────────

export async function buildWeeklyLearningReport(market: string): Promise<WeeklyLearningReport> {
  const weekEnd = new Date();
  const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [tradesRes, agentsRes, mutationRes] = await Promise.allSettled([
    db.query(`
      SELECT COUNT(*) AS cnt, AVG(overall_score) AS avg_score
      FROM investment.trade_quality_evaluations
      WHERE evaluated_at >= $1
    `, [weekStart.toISOString()]),

    db.query(`
      SELECT agent_name, current_level, success_count, invocation_count
      FROM investment.agent_curriculum_state
      WHERE market = $1
      ORDER BY current_level DESC, success_count DESC
    `, [market]),

    db.query(`
      SELECT event_type, COUNT(*) AS cnt
      FROM investment.strategy_mutation_events
      WHERE created_at >= $1
      GROUP BY event_type
      ORDER BY cnt DESC
      LIMIT 1
    `, [weekStart.toISOString()]),
  ]);

  const settledRows = (result: PromiseSettledResult<any>) => {
    if (result.status !== 'fulfilled') return [];
    const value = result.value;
    if (Array.isArray(value)) return value;
    return value?.rows || [];
  };

  const tradeRows = settledRows(tradesRes as PromiseSettledResult<any>);
  const totalTrades = Number(tradeRows[0]?.cnt ?? 0);
  const avgScore = Number(tradeRows[0]?.avg_score ?? 0);
  const avgReward = (avgScore - 0.5) * 2; // 0~1 → -1~1

  const agentRows = settledRows(agentsRes as PromiseSettledResult<any>);
  const expertAgents = agentRows.filter((r: any) => r.current_level === 'expert').map((r: any) => r.agent_name);
  const noviceAgents = agentRows.filter((r: any) => r.current_level === 'novice').map((r: any) => r.agent_name);

  const mutationRows = settledRows(mutationRes as PromiseSettledResult<any>);
  const topMutation = mutationRows[0]?.event_type ?? null;

  // 학습 속도: expert 비율 + 주간 리워드 성장
  const learningVelocity = Math.min(1,
    (expertAgents.length / Math.max(1, agentRows.length)) * 0.6 +
    Math.max(0, avgReward) * 0.4
  );

  const nextWeekFocus = learningVelocity < 0.3
    ? '기초 신호 품질 개선 + 레짐 필터 강화'
    : learningVelocity < 0.6
      ? '에이전트 협업 강화 + 타임프레임 다각화'
      : '고급 전략 실험 + FinRL-X 깊은 학습';

  return {
    weekStart: weekStart.toISOString().split('T')[0],
    weekEnd: weekEnd.toISOString().split('T')[0],
    market,
    totalTrades,
    avgReward: round(avgReward),
    expertAgents,
    noviceAgents,
    topMutation,
    learningVelocity: round(learningVelocity),
    nextWeekFocus,
  };
}

// ─── 내부 헬퍼 ──────────────────────────────────────────────

function gradeReward(r: number): SelfReward['grade'] {
  if (r >= 0.5) return 'S';
  if (r >= 0.2) return 'A';
  if (r >= 0.0) return 'B';
  if (r >= -0.3) return 'C';
  return 'D';
}

function buildFeedback(
  input: SelfRewardInput,
  totalReward: number,
  qualityBonus: number,
  efficiencyBonus: number,
  executionPenalty: number
): string {
  const parts: string[] = [`PnL=${input.pnlPct.toFixed(2)}%`];
  if (qualityBonus > 0) parts.push(`신호품질 보너스 +${qualityBonus.toFixed(3)}`);
  if (efficiencyBonus < 0) parts.push(`보유 비효율 ${efficiencyBonus.toFixed(3)}`);
  if (executionPenalty < 0) parts.push(`실행 슬리피지 패널티 ${executionPenalty.toFixed(3)}`);
  parts.push(`→ 총 리워드 ${totalReward.toFixed(3)}`);
  return parts.join(' | ');
}

function suggestMutation(input: SelfRewardInput, totalReward: number): MutationSuggestion | undefined {
  if (totalReward > 0.2) return undefined; // 잘 하고 있음

  if (input.holdingHours < 4 && input.pnlPct < 0) {
    return {
      paramName: 'min_holding_hours',
      direction: 'increase',
      magnitude: 'medium',
      reason: `${input.symbol} 조기 청산 손실 — 최소 보유 시간 증가 권장`,
    };
  }

  if (input.signalQuality < 0.5 && input.pnlPct < 0) {
    return {
      paramName: 'confidence_threshold',
      direction: 'increase',
      magnitude: 'small',
      reason: `${input.symbol} 저품질 신호 손실 — 진입 신뢰도 임계값 강화`,
    };
  }

  if (input.executionSlippage > 30) {
    return {
      paramName: 'limit_order_preference',
      direction: 'increase',
      magnitude: 'medium',
      reason: `${input.symbol} 슬리피지 ${input.executionSlippage}bps — 지정가 주문 비율 확대`,
    };
  }

  return undefined;
}

function round(v: number, digits = 4): number {
  return Number(v.toFixed(digits));
}
