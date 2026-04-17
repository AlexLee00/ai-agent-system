// @ts-nocheck
/**
 * bots/sigma/shared/cost-tracker.ts — 시그마 LLM 비용 추적
 *
 * 일/월 예산 대비 추적.
 * DB 테이블: sigma_llm_cost_tracking
 * 환경변수: SIGMA_LLM_DAILY_BUDGET_USD (기본 10.0)
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let _pgPool: any = null;
try {
  _pgPool = require('../../../packages/core/lib/pg-pool');
} catch {
  // pgPool 없는 환경에서는 DB 기록 비활성화
}

interface CostEntry {
  timestamp: Date;
  agent: string;
  model: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

// USD per token
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7':           { input: 1.5e-5, output: 7.5e-5 },
  'claude-sonnet-4-6':         { input: 3.0e-6, output: 1.5e-5 },
  'claude-haiku-4-5-20251001': { input: 8.0e-7, output: 4.0e-6 },
  // Ollama 로컬 = $0 (기본값)
};

function calcCost(model: string, tokensIn: number, tokensOut: number): number {
  const costs = MODEL_COSTS[model] || { input: 0, output: 0 };
  return tokensIn * costs.input + tokensOut * costs.output;
}

export function trackTokens(entry: Omit<CostEntry, 'timestamp' | 'cost_usd'>) {
  const cost_usd = calcCost(entry.model, entry.tokens_in, entry.tokens_out);
  const full: CostEntry = { ...entry, timestamp: new Date(), cost_usd };

  if (_pgPool) {
    _pgPool.query(
      `INSERT INTO sigma_llm_cost_tracking
        (timestamp, agent, model, provider, tokens_in, tokens_out, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [full.timestamp, full.agent, full.model, full.provider, full.tokens_in, full.tokens_out, full.cost_usd],
    ).catch(() => { /* 비용 추적 실패 시 무음 처리 */ });
  }

  return full;
}

export async function getDailyCost(): Promise<number> {
  if (!_pgPool) return 0;
  try {
    const { rows } = await _pgPool.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM sigma_llm_cost_tracking
       WHERE timestamp::date = CURRENT_DATE`,
    );
    return parseFloat(rows[0]?.total || '0');
  } catch {
    return 0;
  }
}

export async function checkBudget(): Promise<{ daily: number; limit: number; ok: boolean }> {
  const daily = await getDailyCost();
  const limit = parseFloat(process.env.SIGMA_LLM_DAILY_BUDGET_USD || '10');
  return { daily, limit, ok: daily < limit };
}
