// @ts-nocheck

import { query as defaultQuery } from '../../shared/db.ts';
import { buildEarningsSurpriseRecommendation } from '../../lib/korea-data/corp-fundamental.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

async function loadLatestTwoFundamentals(queryFn, params = {}) {
  if (params.current && params.previous) return [params.current, params.previous];
  const symbol = params.symbol || params.stockCode;
  const limit = Math.max(1, Math.min(200, Number(params.limit || 50)));
  const rows = symbol
    ? await Promise.resolve(queryFn(
      `WITH account_rows AS (
         SELECT stock_code,
                company_name,
                bsns_year,
                reprt_code,
                LOWER(COALESCE(account_id, '') || ' ' || COALESCE(account_nm, '')) AS account_text,
                thstrm_amount
           FROM investment.corp_financial_reports
          WHERE stock_code = $1
       ),
       periods AS (
         SELECT stock_code AS "stockCode",
                MAX(company_name) AS "companyName",
                bsns_year AS "bsnsYear",
                reprt_code AS "reprtCode",
                MAX(CASE WHEN account_text ~ 'ifrs-full_revenue|매출액|수익\\(매출액\\)|영업수익'
                         THEN thstrm_amount END) AS "revenue",
                MAX(CASE WHEN account_text ~ 'operatingincome|영업이익'
                         THEN thstrm_amount END) AS "operatingIncome"
           FROM account_rows
          GROUP BY stock_code, bsns_year, reprt_code
       )
       SELECT *
         FROM periods
        WHERE "revenue" IS NOT NULL OR "operatingIncome" IS NOT NULL
        ORDER BY "bsnsYear" DESC NULLS LAST,
                 CASE "reprtCode"
                   WHEN '11011' THEN 4
                   WHEN '11014' THEN 3
                   WHEN '11012' THEN 2
                   WHEN '11013' THEN 1
                   ELSE 0
                 END DESC
        LIMIT 2`,
      [symbol],
    )).catch(() => [])
    : await Promise.resolve(queryFn(
      `WITH account_rows AS (
         SELECT stock_code,
                company_name,
                bsns_year,
                reprt_code,
                LOWER(COALESCE(account_id, '') || ' ' || COALESCE(account_nm, '')) AS account_text,
                thstrm_amount
           FROM investment.corp_financial_reports
          WHERE stock_code IS NOT NULL
       ),
       periods AS (
         SELECT stock_code AS "stockCode",
                MAX(company_name) AS "companyName",
                bsns_year AS "bsnsYear",
                reprt_code AS "reprtCode",
                MAX(CASE WHEN account_text ~ 'ifrs-full_revenue|매출액|수익\\(매출액\\)|영업수익'
                         THEN thstrm_amount END) AS "revenue",
                MAX(CASE WHEN account_text ~ 'operatingincome|영업이익'
                         THEN thstrm_amount END) AS "operatingIncome"
           FROM account_rows
          GROUP BY stock_code, bsns_year, reprt_code
       ),
       ranked AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY "stockCode"
                  ORDER BY "bsnsYear" DESC NULLS LAST,
                           CASE "reprtCode"
                             WHEN '11011' THEN 4
                             WHEN '11014' THEN 3
                             WHEN '11012' THEN 2
                             WHEN '11013' THEN 1
                             ELSE 0
                           END DESC
                ) AS rn
           FROM periods
          WHERE "revenue" IS NOT NULL OR "operatingIncome" IS NOT NULL
       )
       SELECT *
         FROM ranked
        WHERE rn <= 2
        ORDER BY "stockCode", rn
        LIMIT $1`,
      [limit * 2],
    )).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

export function createEarningsSurpriseTradingHandler({ queryFn = defaultQuery, skillId = 'earnings-surprise-trading' } = {}) {
  return async function earningsSurpriseTrading(params = {}) {
    const usingParamEvidence = Boolean(params.current && params.previous);
    const rows = await loadLatestTwoFundamentals(queryFn, params);
    const symbol = params.symbol || params.stockCode;
    if (!symbol && !usingParamEvidence) {
      const grouped = new Map();
      for (const row of rows) {
        const key = row.stockCode || row.stock_code;
        if (!key) continue;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
      }
      const recommendations = Array.from(grouped.values())
        .filter((items) => items.length >= 2)
        .map((items) => buildEarningsSurpriseRecommendation(items[0], items[1]))
        .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
      return {
        status: 'completed',
        output: {
          ok: true,
          skill: skillId,
          market: 'domestic',
          shadowOnly: true,
          liveOrderAllowed: false,
          dataHealth: recommendations.length ? 'shadow_ready' : 'insufficient_periods',
          recommendation: recommendations[0] || buildEarningsSurpriseRecommendation({}, {}),
          recommendations,
          evidence: { source: 'investment.corp_financial_reports', mode: 'all_symbols' },
        },
        metadata: { shadowOnly: true, liveOrderAllowed: false, rows: rows.length, symbols: grouped.size },
      };
    }
    const current = rows[0] || params.current || {};
    const previous = rows[1] || params.previous || {};
    const recommendation = buildEarningsSurpriseRecommendation(current, previous);
    return {
      status: 'completed',
      output: {
        ok: true,
        skill: skillId,
        market: 'domestic',
        shadowOnly: true,
        liveOrderAllowed: false,
        dataHealth: rows.length >= 2 || (params.current && params.previous) ? 'shadow_ready' : 'insufficient_periods',
        recommendation,
        evidence: { source: usingParamEvidence ? 'params.current_previous' : 'investment.corp_financial_reports' },
      },
      metadata: { shadowOnly: true, liveOrderAllowed: false },
    };
  };
}

export function registerEarningsSurpriseTradingSkill(options = {}) {
  registerSkillHandler('earnings-surprise-trading', createEarningsSurpriseTradingHandler(options));
}

export default { createEarningsSurpriseTradingHandler, registerEarningsSurpriseTradingSkill };
