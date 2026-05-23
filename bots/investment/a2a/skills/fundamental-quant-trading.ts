// @ts-nocheck

import { query as defaultQuery } from '../../shared/db.ts';
import {
  buildFundamentalQuantRecommendation,
  rankCorpFundamentals,
} from '../../lib/korea-data/corp-fundamental.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

async function loadFundamentals(queryFn, params = {}) {
  if (params.fundamental) return [params.fundamental];
  const limit = Math.max(1, Number(params.limit || 20));
  const rows = await Promise.resolve(queryFn(
    `WITH latest AS (
       SELECT DISTINCT ON (stock_code)
              stock_code AS "stockCode",
              company_name AS "companyName",
              bsns_year AS "bsnsYear",
              reprt_code AS "reprtCode",
              per, pbr, roe, roa,
              debt_ratio AS "debtRatio",
              current_ratio AS "currentRatio",
              revenue_growth AS "revenueGrowth",
              operating_income_growth AS "operatingIncomeGrowth",
              market_cap AS "marketCap",
              updated_at AS "updatedAt"
         FROM investment.corp_fundamentals
        WHERE ($1::text IS NULL OR stock_code = $1)
        ORDER BY stock_code, bsns_year DESC NULLS LAST, updated_at DESC
     )
     SELECT *
       FROM latest
      ORDER BY "updatedAt" DESC
      LIMIT $2`,
    [params.symbol || params.stockCode || null, limit],
  )).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

export function createFundamentalQuantTradingHandler({ queryFn = defaultQuery, skillId = 'fundamental-quant-trading' } = {}) {
  return async function fundamentalQuantTrading(params = {}) {
    const rows = await loadFundamentals(queryFn, params);
    const ranked = rankCorpFundamentals(rows);
    const recommendations = ranked.map(buildFundamentalQuantRecommendation);
    const output = {
      ok: true,
      skill: skillId,
      market: 'domestic',
      shadowOnly: true,
      liveOrderAllowed: false,
      dataHealth: rows.length ? 'shadow_ready' : 'missing_corp_fundamentals',
      recommendations,
      topBuyWatchlist: recommendations.filter((item) => item.action === 'long_watchlist').slice(0, 10),
      avoidOrReduce: recommendations.filter((item) => item.action === 'avoid_or_reduce').slice(0, 10),
      evidence: { source: rows.length ? 'investment.corp_fundamentals' : 'params.fundamental' },
    };
    return {
      status: 'completed',
      output,
      metadata: { shadowOnly: true, liveOrderAllowed: false, rows: rows.length },
    };
  };
}

export function registerFundamentalQuantTradingSkill(options = {}) {
  registerSkillHandler('fundamental-quant-trading', createFundamentalQuantTradingHandler(options));
}

export default { createFundamentalQuantTradingHandler, registerFundamentalQuantTradingSkill };
