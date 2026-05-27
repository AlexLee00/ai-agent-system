// @ts-nocheck
/**
 * Luna agent evolution loop.
 *
 * Stores weekly policy hints in agent_curriculum_state.config instead of
 * changing live trading behavior directly.
 */

import * as db from './db.ts';
import { extractLossPatterns, getTopLossPatterns } from './loss-pattern-extractor.ts';
import { extractWinPatterns, getTopWinPatterns } from './win-pattern-extractor.ts';

export interface PriorityAdjustment {
  target: string;
  adjustmentType: 'boost' | 'penalize' | 'disable' | 'enable';
  reason: string;
  confidence: number;
  market?: string;
  regime?: string | null;
}

export interface EvolutionResult {
  week: string;
  market: string;
  dryRun: boolean;
  lossPatterns: number;
  winPatterns: number;
  curriculumUpdated: boolean;
  priorityAdjustments: PriorityAdjustment[];
  evolutionSummary: string;
  executedAt: string;
}

function weekId(date = new Date()): string {
  const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const day = Math.floor((date.getTime() - first.getTime()) / 86400000);
  const week = Math.ceil((day + first.getUTCDay() + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function buildPriorityAdjustments(lossPatterns: any[], winPatterns: any[]): PriorityAdjustment[] {
  const adjustments: PriorityAdjustment[] = [];
  for (const pattern of lossPatterns.slice(0, 12)) {
    if (pattern.tradeCount < 2 && pattern.totalPenalty < 0.3) continue;
    adjustments.push({
      target: pattern.patternKey,
      adjustmentType: pattern.totalPenalty >= 1 ? 'disable' : 'penalize',
      reason: pattern.avoidanceGuide,
      confidence: Number(pattern.confidence || 0.5),
      market: pattern.market,
      regime: pattern.regime,
    });
  }
  for (const pattern of winPatterns.slice(0, 12)) {
    if (pattern.tradeCount < 2 && pattern.avgWinPct < 1) continue;
    adjustments.push({
      target: pattern.patternKey,
      adjustmentType: pattern.avgWinPct >= 5 ? 'enable' : 'boost',
      reason: pattern.priorityGuide,
      confidence: Number(pattern.confidence || 0.5),
      market: pattern.market,
      regime: pattern.regime,
    });
  }
  return adjustments.sort((a, b) => b.confidence - a.confidence);
}

function buildSummary(lossPatterns: any[], winPatterns: any[], adjustments: PriorityAdjustment[]): string {
  const penalize = adjustments.filter((a) => a.adjustmentType === 'penalize' || a.adjustmentType === 'disable').length;
  const boost = adjustments.filter((a) => a.adjustmentType === 'boost' || a.adjustmentType === 'enable').length;
  const topLoss = lossPatterns[0]?.patternKey ? `top_loss=${lossPatterns[0].patternKey}` : 'top_loss=none';
  const topWin = winPatterns[0]?.patternKey ? `top_win=${winPatterns[0].patternKey}` : 'top_win=none';
  return `loss_patterns=${lossPatterns.length}, win_patterns=${winPatterns.length}, penalize=${penalize}, boost=${boost}, ${topLoss}, ${topWin}`;
}

async function persistCurriculum({
  market,
  week,
  lossPatterns,
  winPatterns,
  adjustments,
  summary,
}: {
  market: string;
  week: string;
  lossPatterns: any[];
  winPatterns: any[];
  adjustments: PriorityAdjustment[];
  summary: string;
}): Promise<void> {
  const config = {
    week,
    source: 'luna_agent_evolution_v2',
    lossPatterns: lossPatterns.slice(0, 10),
    winPatterns: winPatterns.slice(0, 10),
    priorityAdjustments: adjustments.slice(0, 20),
    summary,
    shadowOnly: true,
    updatedAt: new Date().toISOString(),
  };
  await db.run(
    `INSERT INTO investment.agent_curriculum_state
       (agent_name, market, invocation_count, success_count, failure_count, current_level, config, updated_at)
     VALUES ('luna_evolution_controller', $1, 1, $2, $3, $4, $5::jsonb, NOW())
     ON CONFLICT (agent_name, market) DO UPDATE SET
       invocation_count = investment.agent_curriculum_state.invocation_count + 1,
       success_count = investment.agent_curriculum_state.success_count + EXCLUDED.success_count,
       failure_count = investment.agent_curriculum_state.failure_count + EXCLUDED.failure_count,
       current_level = EXCLUDED.current_level,
       config = COALESCE(investment.agent_curriculum_state.config, '{}'::jsonb) || EXCLUDED.config,
       updated_at = NOW()`,
    [
      market,
      adjustments.length > 0 ? 1 : 0,
      adjustments.length > 0 ? 0 : 1,
      adjustments.length >= 5 ? 'expert' : adjustments.length >= 2 ? 'intermediate' : 'novice',
      JSON.stringify(config),
    ],
  );
}

export async function runLunaAgentEvolution({
  dryRun = true,
  write = false,
  market = 'all',
  lookbackDays = 14,
}: {
  dryRun?: boolean;
  write?: boolean;
  market?: string;
  lookbackDays?: number;
  llmEnabled?: boolean;
} = {}): Promise<EvolutionResult> {
  const week = weekId();
  const effectiveDryRun = dryRun !== false || write !== true;
  const [freshLoss, freshWin] = await Promise.all([
    extractLossPatterns({ market, lookbackDays, minTradeCount: 2, persist: !effectiveDryRun }),
    extractWinPatterns({ market, lookbackDays, minTradeCount: 2, persist: !effectiveDryRun }),
  ]);
  const [topLoss, topWin] = await Promise.all([
    getTopLossPatterns({ market, limit: 12 }).catch(() => freshLoss),
    getTopWinPatterns({ market, limit: 12 }).catch(() => freshWin),
  ]);
  const lossPatterns = freshLoss.length ? freshLoss : topLoss;
  const winPatterns = freshWin.length ? freshWin : topWin;
  const adjustments = buildPriorityAdjustments(lossPatterns, winPatterns);
  const summary = buildSummary(lossPatterns, winPatterns, adjustments);

  if (!effectiveDryRun) {
    await persistCurriculum({ market, week, lossPatterns, winPatterns, adjustments, summary });
  }

  return {
    week,
    market,
    dryRun: effectiveDryRun,
    lossPatterns: lossPatterns.length,
    winPatterns: winPatterns.length,
    curriculumUpdated: !effectiveDryRun,
    priorityAdjustments: adjustments,
    evolutionSummary: summary,
    executedAt: new Date().toISOString(),
  };
}

export async function getCurrentCurriculumState(market = 'all'): Promise<Record<string, unknown> | null> {
  const row = await db.get(
    `SELECT *
       FROM investment.agent_curriculum_state
      WHERE agent_name = 'luna_evolution_controller'
        AND market = $1
      ORDER BY updated_at DESC
      LIMIT 1`,
    [market],
  ).catch(() => null);
  return row?.config || null;
}

export default { runLunaAgentEvolution, getCurrentCurriculumState };
