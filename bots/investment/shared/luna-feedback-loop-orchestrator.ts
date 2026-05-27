// @ts-nocheck
/**
 * Luna Feedback Loop Orchestrator
 *
 * 마스터 철학: "끊임없는 분석 → 피드백 → 진화!"
 * - 매 거래 직후: 자동 분석 + 피드백 기록
 * - 매일 06:00: 전략 mutation 생성 + 커리큘럼 갱신
 * - Closed-loop Continuous Learning
 */

import * as db from './db/core.ts';

// ─── 타입 정의 ─────────────────────────────────────────────────

export interface TradeOutcomePayload {
  tradeId: string;
  market: 'crypto' | 'stocks' | 'overseas';
  symbol: string;
  side: 'buy' | 'sell';
  paper: boolean;
  pnlPct?: number;          // 실현 손익률 (청산 시)
  holdingHours?: number;
  analystCalls: AnalystCall[];   // 이 거래에 기여한 분석들
  strategyProfile?: string;
  regime?: string;
}

export interface AnalystCall {
  botName: string;   // aria, sophia, hermes, oracle 등
  prediction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  accurate?: boolean;   // 사후 평가 (청산 후 세팅)
}

export interface FeedbackLoopResult {
  tradeId: string;
  steps: FeedbackStep[];
  mutationSuggested: boolean;
  summary: string;
}

export interface FeedbackStep {
  step: string;
  success: boolean;
  detail?: string;
}

// ─── 핵심: 거래 직후 피드백 루프 ─────────────────────────────

/**
 * 거래 직후 호출 — 5단계 자동 분석
 */
export async function runPostTradeFeedbackLoop(payload: TradeOutcomePayload): Promise<FeedbackLoopResult> {
  const steps: FeedbackStep[] = [];
  let mutationSuggested = false;

  // Step 1: position_signal_history 이벤트 기록
  steps.push(await stepRecordTradeEvent(payload));

  // Step 2: trade_quality_evaluator 호출 (청산 시)
  if (payload.pnlPct !== undefined) {
    steps.push(await stepEvaluateTradeQuality(payload));
  }

  // Step 3: analyst_accuracy 갱신
  if (payload.analystCalls.length > 0 && payload.pnlPct !== undefined) {
    steps.push(await stepUpdateAnalystAccuracy(payload));
  }

  // Step 4: 실패 반성 (손실 거래)
  if (payload.pnlPct !== undefined && payload.pnlPct < -1.0) {
    steps.push(await stepCreateFailureReflexion(payload));
  }

  // Step 5: feedback_to_action_map 갱신
  const feedbackStep = await stepUpdateFeedbackActionMap(payload);
  steps.push(feedbackStep);
  if (feedbackStep.success && feedbackStep.detail?.includes('mutation')) {
    mutationSuggested = true;
  }

  const failedSteps = steps.filter(s => !s.success);
  const summary = failedSteps.length === 0
    ? `피드백 루프 완료 (${steps.length}단계 성공)`
    : `피드백 루프 ${failedSteps.length}단계 실패: ${failedSteps.map(s => s.step).join(', ')}`;

  console.log(`[FeedbackLoop] ${payload.tradeId}: ${summary}`);
  return { tradeId: payload.tradeId, steps, mutationSuggested, summary };
}

// ─── 매일 06:00 — 일간 루프 ──────────────────────────────────

export interface DailyFeedbackResult {
  date: string;
  market: string;
  mutationsGenerated: number;
  curriculumUpdated: number;
  resourceFeedbackAnalyzed: number;
  errors: string[];
}

/**
 * 일간 Closed-loop — 매일 06:00 launchd에서 호출
 */
export async function runDailyFeedbackLoop(market: string): Promise<DailyFeedbackResult> {
  const date = new Date().toISOString().split('T')[0];
  const errors: string[] = [];
  let mutationsGenerated = 0;
  let curriculumUpdated = 0;
  let resourceFeedbackAnalyzed = 0;

  console.log(`[DailyFeedback] ${date} ${market} 시작`);

  // Step 6: strategy_mutation_events 자동 생성
  try {
    mutationsGenerated = await stepGenerateStrategyMutations(market);
    console.log(`[DailyFeedback] 전략 변이 ${mutationsGenerated}건 생성`);
  } catch (err) {
    errors.push(`mutation 생성 실패: ${err?.message}`);
  }

  // Step 7: agent_curriculum_state 갱신
  try {
    curriculumUpdated = await stepUpdateAgentCurriculum(market);
    console.log(`[DailyFeedback] 커리큘럼 ${curriculumUpdated}개 에이전트 갱신`);
  } catch (err) {
    errors.push(`curriculum 갱신 실패: ${err?.message}`);
  }

  // Step 8: resource_feedback_events 분석
  try {
    resourceFeedbackAnalyzed = await stepAnalyzeResourceFeedback(market);
    console.log(`[DailyFeedback] 리소스 피드백 ${resourceFeedbackAnalyzed}건 분석`);
  } catch (err) {
    errors.push(`resource feedback 실패: ${err?.message}`);
  }

  return { date, market, mutationsGenerated, curriculumUpdated, resourceFeedbackAnalyzed, errors };
}

// ─── Step 구현들 ────────────────────────────────────────────

async function stepRecordTradeEvent(p: TradeOutcomePayload): Promise<FeedbackStep> {
  try {
    await db.query(`
      INSERT INTO investment.position_signal_history (
        exchange, symbol, market, trade_mode, source, event_type, confidence, created_at
      ) VALUES ($1, $2, $3, $4, 'feedback-loop', 'trade_closed', 0.8, NOW())
    `, [
      p.market === 'crypto' ? 'BINANCE' : 'KIS',
      p.symbol,
      p.market,
      p.paper ? 'paper' : 'live',
    ]);
    return { step: 'record_trade_event', success: true };
  } catch (err) {
    return { step: 'record_trade_event', success: false, detail: err?.message };
  }
}

async function stepEvaluateTradeQuality(p: TradeOutcomePayload): Promise<FeedbackStep> {
  try {
    const score = calcTradeQualityScore(p);
    await db.query(`
      INSERT INTO investment.trade_quality_evaluations (
        trade_id, market_decision_score, pipeline_quality_score,
        monitoring_score, backtest_utilization_score, overall_score,
        category, rationale, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (trade_id) DO UPDATE SET
        overall_score = EXCLUDED.overall_score,
        updated_at = NOW()
    `, [
      p.tradeId,
      score.marketDecision,
      score.pipelineQuality,
      score.monitoring,
      score.backtestUtil,
      score.overall,
      score.category,
      score.rationale,
    ]);
    return { step: 'evaluate_trade_quality', success: true, detail: `overall=${score.overall.toFixed(2)}` };
  } catch (err) {
    return { step: 'evaluate_trade_quality', success: false, detail: err?.message };
  }
}

async function stepUpdateAnalystAccuracy(p: TradeOutcomePayload): Promise<FeedbackStep> {
  try {
    const profitable = (p.pnlPct ?? 0) > 0;
    for (const call of p.analystCalls) {
      // 예측과 결과가 일치했는지 판단
      const accurate = call.prediction === 'bullish'
        ? profitable
        : call.prediction === 'bearish'
          ? !profitable
          : null;   // neutral은 평가 제외

      if (accurate === null) continue;

      await db.query(`
        INSERT INTO investment.trade_review (
          trade_id, market, ${call.botName}_accurate, created_at
        ) VALUES ($1, $2, $3, NOW())
        ON CONFLICT (trade_id) DO UPDATE SET
          ${call.botName}_accurate = EXCLUDED.${call.botName}_accurate
      `, [p.tradeId, p.market, accurate]);
    }
    return { step: 'update_analyst_accuracy', success: true };
  } catch (err) {
    return { step: 'update_analyst_accuracy', success: false, detail: err?.message };
  }
}

async function stepCreateFailureReflexion(p: TradeOutcomePayload): Promise<FeedbackStep> {
  try {
    const fiveWhy = [
      `Why 1: PnL ${p.pnlPct?.toFixed(2)}% — 목표 미달`,
      `Why 2: 레짐 불일치 — ${p.regime ?? '알 수 없음'} 에서 ${p.side}`,
      `Why 3: 분석 신뢰도 — ${p.analystCalls.map(a => `${a.botName}(${a.confidence.toFixed(2)})`).join(', ')}`,
      `Why 4: 보유 시간 — ${p.holdingHours?.toFixed(1) ?? '?'}h`,
      `Why 5: 전략 프로파일 — ${p.strategyProfile ?? '미확인'}`,
    ];

    await db.query(`
      INSERT INTO investment.luna_failure_reflexions (
        trade_id, five_why, stage_attribution, hindsight, avoid_pattern, created_at
      ) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5::jsonb, NOW())
      ON CONFLICT (trade_id) DO NOTHING
    `, [
      p.tradeId,
      JSON.stringify(fiveWhy),
      JSON.stringify({ pnl_pct: p.pnlPct, regime: p.regime, analysts: p.analystCalls.map(a => a.botName) }),
      `${p.symbol} ${p.side} — PnL ${p.pnlPct?.toFixed(2)}%. 레짐/분석 재검토 필요.`,
      JSON.stringify({ symbol: p.symbol, side: p.side, regime: p.regime }),
    ]);
    return { step: 'create_failure_reflexion', success: true };
  } catch (err) {
    return { step: 'create_failure_reflexion', success: false, detail: err?.message };
  }
}

async function stepUpdateFeedbackActionMap(p: TradeOutcomePayload): Promise<FeedbackStep> {
  try {
    if (p.pnlPct === undefined) return { step: 'update_feedback_action_map', success: true, detail: 'skip (미청산)' };

    const profitable = p.pnlPct > 0;
    const paramName = profitable ? 'confidence_threshold_relax' : 'confidence_threshold_tighten';
    const delta = Math.abs(p.pnlPct) * 0.001;  // 손익률 기반 미세 조정

    await db.query(`
      INSERT INTO investment.feedback_to_action_map (
        source_trade_id, parameter_name, old_value, new_value, reason, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
    `, [
      p.tradeId,
      paramName,
      '0.000',
      delta.toFixed(4),
      `${p.symbol} PnL=${p.pnlPct?.toFixed(2)}% → ${profitable ? '신뢰도 완화' : '신뢰도 강화'} 제안`,
    ]);

    const detail = Math.abs(p.pnlPct) > 3 ? 'mutation 후보 (3% 초과)' : '기록 완료';
    return { step: 'update_feedback_action_map', success: true, detail };
  } catch (err) {
    return { step: 'update_feedback_action_map', success: false, detail: err?.message };
  }
}

async function stepGenerateStrategyMutations(market: string): Promise<number> {
  // 최근 7일 성과가 나쁜 전략 식별 → mutation 후보 생성
  const res = await db.query(`
    SELECT
      sp.position_scope_key,
      sp.setup_type,
      AVG(tqe.overall_score) AS avg_score,
      COUNT(*) AS trade_count
    FROM investment.position_strategy_profiles sp
    JOIN investment.trade_quality_evaluations tqe ON tqe.trade_id = sp.position_scope_key
    WHERE sp.market = $1
      AND sp.created_at >= NOW() - INTERVAL '7 days'
    GROUP BY sp.position_scope_key, sp.setup_type
    HAVING AVG(tqe.overall_score) < 0.5 AND COUNT(*) >= 2
    LIMIT 5
  `, [market]);

  let count = 0;
  for (const row of res.rows) {
    try {
      await db.query(`
        INSERT INTO investment.strategy_mutation_events (
          event_type, lifecycle_phase, position_scope_key,
          old_setup_type, validity_score, predictive_score, created_at
        ) VALUES ('performance_degradation', 'shadow', $1, $2, $3, $3, NOW())
      `, [row.position_scope_key, row.setup_type, Number(row.avg_score)]);
      count++;
    } catch (_err) {
      // 중복 시 skip
    }
  }
  return count;
}

async function stepUpdateAgentCurriculum(market: string): Promise<number> {
  // 최근 30일 성과 기반 에이전트 레벨 갱신
  const agents = ['aria', 'sophia', 'hermes', 'oracle', 'nemesis'];
  let updated = 0;

  for (const agent of agents) {
    try {
      const res = await db.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE ${agent}_accurate = true) AS wins
        FROM investment.trade_review
        WHERE market = $1 AND created_at >= NOW() - INTERVAL '30 days'
          AND ${agent}_accurate IS NOT NULL
      `, [market]);

      const total = Number(res.rows[0]?.total ?? 0);
      if (total < 5) continue;

      const winRate = Number(res.rows[0]?.wins ?? 0) / total;
      const level = winRate >= 0.65 ? 'expert' : winRate >= 0.50 ? 'intermediate' : 'novice';

      await db.query(`
        INSERT INTO investment.agent_curriculum_state (
          agent_name, market, invocation_count, success_count, current_level, updated_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (agent_name, market) DO UPDATE SET
          invocation_count = EXCLUDED.invocation_count,
          success_count = EXCLUDED.success_count,
          current_level = EXCLUDED.current_level,
          updated_at = NOW()
      `, [agent, market, total, Math.round(total * winRate), level]);
      updated++;
    } catch (_err) {
      // 개별 에이전트 실패 시 계속
    }
  }
  return updated;
}

async function stepAnalyzeResourceFeedback(market: string): Promise<number> {
  // mapek_knowledge 에서 posttrade 처리 대기 건수 확인
  try {
    const res = await db.query(`
      SELECT COUNT(*) AS cnt
      FROM investment.mapek_knowledge
      WHERE knowledge_type = 'posttrade' AND market = $1
        AND processed_at IS NULL
    `, [market]);
    return Number(res.rows[0]?.cnt ?? 0);
  } catch (_err) {
    return 0;
  }
}

// ─── 품질 점수 계산 ─────────────────────────────────────────

function calcTradeQualityScore(p: TradeOutcomePayload): {
  marketDecision: number;
  pipelineQuality: number;
  monitoring: number;
  backtestUtil: number;
  overall: number;
  category: string;
  rationale: string;
} {
  const pnl = p.pnlPct ?? 0;
  const analystConsensus = p.analystCalls.length > 0
    ? p.analystCalls.filter(a => a.prediction === 'bullish').length / p.analystCalls.length
    : 0.5;

  const marketDecision = Math.max(0, Math.min(1, 0.5 + pnl * 0.05));
  const pipelineQuality = Math.min(1, 0.5 + analystConsensus * 0.5);
  const monitoring = p.holdingHours ? Math.min(1, 1 - (p.holdingHours > 48 ? 0.3 : 0)) : 0.7;
  const backtestUtil = p.strategyProfile ? 0.8 : 0.5;
  const overall = (marketDecision + pipelineQuality + monitoring + backtestUtil) / 4;

  const category = overall >= 0.7 ? 'excellent' : overall >= 0.5 ? 'good' : 'poor';
  const rationale = `PnL=${pnl.toFixed(2)}%, 분석합의=${(analystConsensus * 100).toFixed(0)}%, overall=${overall.toFixed(2)}`;

  return { marketDecision, pipelineQuality, monitoring, backtestUtil, overall, category, rationale };
}
