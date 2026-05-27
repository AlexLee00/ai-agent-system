// @ts-nocheck
/**
 * shared/luna-agent-evolution.ts — 루나 에이전트 자율 진화 시스템
 *
 * 매주 일요일 06:00 실행:
 *   luna_failure_reflexions 분석 → 패턴 추출 → agent_curriculum_state 갱신
 *   → 다음 주 매매 우선순위 조정
 *
 * 마스터 비전: "매 거래 데이터 = 핵심! 에이전트 스스로 진화!"
 */

import * as db from './db.ts';
import { callLunaLLM } from './luna-hub-llm.ts';
import { extractLossPatterns, getTopLossPatterns } from './loss-pattern-extractor.ts';
import { extractWinPatterns, getTopWinPatterns } from './win-pattern-extractor.ts';

const LOG = '[luna-agent-evolution]';

export interface EvolutionResult {
  week: string;
  lossPatterns: number;
  winPatterns: number;
  curriculumUpdated: boolean;
  priorityAdjustments: PriorityAdjustment[];
  evolutionSummary: string;
  executedAt: string;
}

interface PriorityAdjustment {
  target: string;
  adjustmentType: 'boost' | 'penalize' | 'disable' | 'enable';
  reason: string;
  confidence: number;
  market?: string;
  regime?: string;
}

interface AgentCurriculumState {
  weekId: string;
  avoidPatterns: string[];
  priorityPatterns: string[];
  marketWeights: Record<string, number>;
  regimeWeights: Record<string, number>;
  strategyWeights: Record<string, number>;
  evolutionNotes: string;
  updatedAt: string;
}

export async function runLunaAgentEvolution({
  dryRun = false,
  market = 'all',
  llmEnabled = true,
  lookbackDays = 14,
}: {
  dryRun?: boolean;
  market?: string;
  llmEnabled?: boolean;
  lookbackDays?: number;
} = {}): Promise<EvolutionResult> {
  const week = getWeekId();
  console.log(`${LOG} 진화 시작 week=${week} dryRun=${dryRun}`);

  // 1. 패턴 추출 (손실 + 수익)
  const [lossPatterns, winPatterns] = await Promise.all([
    extractLossPatterns({ market, lookbackDays, llmEnabled }).catch((e) => {
      console.warn(`${LOG} 손실 패턴 추출 실패:`, e?.message);
      return [];
    }),
    extractWinPatterns({ market, lookbackDays, llmEnabled }).catch((e) => {
      console.warn(`${LOG} 수익 패턴 추출 실패:`, e?.message);
      return [];
    }),
  ]);

  console.log(`${LOG} 손실패턴=${lossPatterns.length} 수익패턴=${winPatterns.length}`);

  // 2. 우선순위 조정 계산
  const adjustments = buildPriorityAdjustments(lossPatterns, winPatterns);

  // 3. 커리큘럼 상태 갱신
  let curriculumUpdated = false;
  const topLoss = await getTopLossPatterns({ market, limit: 15 }).catch(() => []);
  const topWin = await getTopWinPatterns({ market, limit: 15 }).catch(() => []);

  const curriculum = buildCurriculumState({ week, topLoss, topWin, adjustments });

  let evolutionSummary = buildRuleBasedSummary({ lossPatterns, winPatterns, adjustments });

  if (llmEnabled) {
    try {
      const llmSummary = await generateEvolutionSummaryWithLLM({
        week, lossPatterns, winPatterns, adjustments,
      });
      if (llmSummary) evolutionSummary = llmSummary;
    } catch (err) {
      console.warn(`${LOG} LLM 요약 실패:`, err?.message);
    }
  }

  curriculum.evolutionNotes = evolutionSummary;

  if (!dryRun) {
    await persistCurriculumState(curriculum);
    await persistEvolutionLog({ week, lossPatterns, winPatterns, adjustments, evolutionSummary });
    curriculumUpdated = true;
    console.log(`${LOG} 커리큘럼 갱신 완료 week=${week}`);
  } else {
    console.log(`${LOG} dryRun 모드 — DB 저장 건너뜀`);
  }

  const result: EvolutionResult = {
    week,
    lossPatterns: lossPatterns.length,
    winPatterns: winPatterns.length,
    curriculumUpdated,
    priorityAdjustments: adjustments,
    evolutionSummary,
    executedAt: new Date().toISOString(),
  };

  console.log(`${LOG} 진화 완료:`, evolutionSummary.slice(0, 120));
  return result;
}

function getWeekId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

function buildPriorityAdjustments(lossPatterns: any[], winPatterns: any[]): PriorityAdjustment[] {
  const adjustments: PriorityAdjustment[] = [];

  for (const lp of lossPatterns.slice(0, 10)) {
    if (lp.totalPenalty >= 0.5 || lp.tradeCount >= 5) {
      adjustments.push({
        target: lp.patternKey,
        adjustmentType: lp.totalPenalty >= 1.0 ? 'disable' : 'penalize',
        reason: `손실 패턴 반복 (penalty=${lp.totalPenalty.toFixed(3)}, count=${lp.tradeCount})`,
        confidence: lp.confidence,
        market: lp.market,
        regime: lp.regime || undefined,
      });
    }
  }

  for (const wp of winPatterns.slice(0, 10)) {
    if (wp.avgWinPct >= 0.03 && wp.tradeCount >= 3) {
      adjustments.push({
        target: wp.patternKey,
        adjustmentType: wp.avgWinPct >= 0.08 ? 'enable' : 'boost',
        reason: `수익 패턴 반복 (avgWin=${(wp.avgWinPct * 100).toFixed(2)}%, count=${wp.tradeCount})`,
        confidence: wp.confidence,
        market: wp.market,
        regime: wp.regime || undefined,
      });
    }
  }

  return adjustments;
}

function buildCurriculumState({ week, topLoss, topWin, adjustments }: {
  week: string;
  topLoss: any[];
  topWin: any[];
  adjustments: PriorityAdjustment[];
}): AgentCurriculumState {
  const avoidPatterns = topLoss
    .filter((lp) => lp.confidence >= 0.6)
    .map((lp) => lp.patternKey);

  const priorityPatterns = topWin
    .filter((wp) => wp.confidence >= 0.6 && wp.avgWinPct >= 0.02)
    .map((wp) => wp.patternKey);

  const marketWeights: Record<string, number> = {};
  const regimeWeights: Record<string, number> = {};
  const strategyWeights: Record<string, number> = {};

  for (const adj of adjustments) {
    const delta = adj.adjustmentType === 'boost' || adj.adjustmentType === 'enable' ? 0.1 : -0.1;
    if (adj.market) {
      marketWeights[adj.market] = (marketWeights[adj.market] || 0) + delta * adj.confidence;
    }
    if (adj.regime) {
      regimeWeights[adj.regime] = (regimeWeights[adj.regime] || 0) + delta * adj.confidence;
    }
  }

  return {
    weekId: week,
    avoidPatterns,
    priorityPatterns,
    marketWeights,
    regimeWeights,
    strategyWeights,
    evolutionNotes: '',
    updatedAt: new Date().toISOString(),
  };
}

function buildRuleBasedSummary({ lossPatterns, winPatterns, adjustments }: {
  lossPatterns: any[];
  winPatterns: any[];
  adjustments: PriorityAdjustment[];
}): string {
  const parts = [];
  if (lossPatterns.length > 0) {
    const topLoss = lossPatterns[0];
    parts.push(`손실 패턴 ${lossPatterns.length}개 감지 (최고: ${topLoss.patternKey} penalty=${topLoss.totalPenalty.toFixed(3)})`);
  }
  if (winPatterns.length > 0) {
    const topWin = winPatterns[0];
    parts.push(`수익 패턴 ${winPatterns.length}개 확인 (최고: ${topWin.patternKey} avg=${(topWin.avgWinPct * 100).toFixed(2)}%)`);
  }
  const penalized = adjustments.filter((a) => a.adjustmentType === 'penalize' || a.adjustmentType === 'disable').length;
  const boosted = adjustments.filter((a) => a.adjustmentType === 'boost' || a.adjustmentType === 'enable').length;
  if (penalized > 0) parts.push(`${penalized}개 패턴 페널티/비활성화`);
  if (boosted > 0) parts.push(`${boosted}개 패턴 우선 활성화`);
  return parts.join(' | ') || '이번 주 유의미한 패턴 변화 없음';
}

async function generateEvolutionSummaryWithLLM({ week, lossPatterns, winPatterns, adjustments }: {
  week: string;
  lossPatterns: any[];
  winPatterns: any[];
  adjustments: PriorityAdjustment[];
}): Promise<string | null> {
  const systemPrompt = '당신은 퀀트 트레이딩 에이전트 진화 분석가입니다. 한국어로 간결하게 답합니다.';
  const topLoss = lossPatterns.slice(0, 3).map((lp) =>
    `${lp.patternKey}: penalty=${lp.totalPenalty.toFixed(3)} count=${lp.tradeCount}`
  );
  const topWin = winPatterns.slice(0, 3).map((wp) =>
    `${wp.patternKey}: avgWin=${(wp.avgWinPct * 100).toFixed(2)}% count=${wp.tradeCount}`
  );
  const userPrompt = `
주차: ${week}
손실 패턴 TOP:
${topLoss.join('\n') || '없음'}
수익 패턴 TOP:
${topWin.join('\n') || '없음'}
조정 수: penalize=${adjustments.filter((a) => a.adjustmentType === 'penalize').length} boost=${adjustments.filter((a) => a.adjustmentType === 'boost').length}

이번 주 에이전트 진화 요약을 3문장 이하로 작성하세요. 다음 주 매매 전략 우선순위를 포함하세요.`;

  const text = await callLunaLLM('luna.agent_evolution', systemPrompt, userPrompt, 300).catch(() => null);
  return text ? String(text).trim() : null;
}

async function persistCurriculumState(state: AgentCurriculumState): Promise<void> {
  await db.run(
    `INSERT INTO investment.agent_curriculum_state
       (week_id, avoid_patterns, priority_patterns, market_weights,
        regime_weights, strategy_weights, evolution_notes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (week_id) DO UPDATE SET
       avoid_patterns    = EXCLUDED.avoid_patterns,
       priority_patterns = EXCLUDED.priority_patterns,
       market_weights    = EXCLUDED.market_weights,
       regime_weights    = EXCLUDED.regime_weights,
       strategy_weights  = EXCLUDED.strategy_weights,
       evolution_notes   = EXCLUDED.evolution_notes,
       updated_at        = EXCLUDED.updated_at`,
    [
      state.weekId,
      JSON.stringify(state.avoidPatterns),
      JSON.stringify(state.priorityPatterns),
      JSON.stringify(state.marketWeights),
      JSON.stringify(state.regimeWeights),
      JSON.stringify(state.strategyWeights),
      state.evolutionNotes,
      state.updatedAt,
    ],
  ).catch((err) => console.error(`${LOG} 커리큘럼 저장 실패:`, err?.message));
}

async function persistEvolutionLog({ week, lossPatterns, winPatterns, adjustments, evolutionSummary }: {
  week: string;
  lossPatterns: any[];
  winPatterns: any[];
  adjustments: PriorityAdjustment[];
  evolutionSummary: string;
}): Promise<void> {
  await db.run(
    `INSERT INTO investment.luna_evolution_log
       (week_id, loss_pattern_count, win_pattern_count,
        adjustment_count, adjustments_json, evolution_summary, logged_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (week_id) DO UPDATE SET
       loss_pattern_count = EXCLUDED.loss_pattern_count,
       win_pattern_count  = EXCLUDED.win_pattern_count,
       adjustment_count   = EXCLUDED.adjustment_count,
       adjustments_json   = EXCLUDED.adjustments_json,
       evolution_summary  = EXCLUDED.evolution_summary`,
    [
      week,
      lossPatterns.length,
      winPatterns.length,
      adjustments.length,
      JSON.stringify(adjustments),
      evolutionSummary,
    ],
  ).catch((err) => console.error(`${LOG} 진화 로그 저장 실패:`, err?.message));
}

export async function getCurrentCurriculumState(weekId?: string): Promise<AgentCurriculumState | null> {
  const targetWeek = weekId || getWeekId();
  const row = await db.get(
    `SELECT week_id, avoid_patterns, priority_patterns, market_weights,
            regime_weights, strategy_weights, evolution_notes, updated_at
       FROM investment.agent_curriculum_state
      WHERE week_id <= $1
      ORDER BY week_id DESC
      LIMIT 1`,
    [targetWeek],
  ).catch(() => null);

  if (!row) return null;
  return {
    weekId: row.week_id,
    avoidPatterns: Array.isArray(row.avoid_patterns) ? row.avoid_patterns : [],
    priorityPatterns: Array.isArray(row.priority_patterns) ? row.priority_patterns : [],
    marketWeights: typeof row.market_weights === 'object' ? row.market_weights : {},
    regimeWeights: typeof row.regime_weights === 'object' ? row.regime_weights : {},
    strategyWeights: typeof row.strategy_weights === 'object' ? row.strategy_weights : {},
    evolutionNotes: row.evolution_notes || '',
    updatedAt: row.updated_at || '',
  };
}

export default { runLunaAgentEvolution, getCurrentCurriculumState };
