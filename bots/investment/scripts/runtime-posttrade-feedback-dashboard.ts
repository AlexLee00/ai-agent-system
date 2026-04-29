#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { getPosttradeFeedbackRuntimeConfig } from '../shared/runtime-config.ts';
import { getRecentPosttradeSkills, getRecentFeedbackToActionMap } from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysRaw = argv.find((arg) => arg.startsWith('--days='))?.split('=')[1];
  const market = argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all';
  return {
    days: Math.max(1, Number(daysRaw || 14) || 14),
    market: String(market).trim().toLowerCase() || 'all',
    json: argv.includes('--json'),
  };
}

function normalizeMarket(market: unknown) {
  const raw = String(market || 'all').trim().toLowerCase();
  if (raw === 'binance') return 'crypto';
  if (raw === 'kis') return 'domestic';
  if (raw === 'kis_overseas') return 'overseas';
  if (raw === 'crypto' || raw === 'domestic' || raw === 'overseas' || raw === 'all') return raw;
  return 'all';
}

async function countRows(sql: string, params: unknown[] = []) {
  const row = await db.get(sql, params).catch(() => null);
  return Number(row?.cnt || 0);
}

async function buildQualitySummary(days = 14, market = 'all') {
  const normalized = normalizeMarket(market);
  const params: unknown[] = [Math.max(1, Number(days || 14))];
  let marketClause = '';
  if (normalized !== 'all') {
    params.push(normalized);
    marketClause = `
      AND COALESCE(th.market, CASE WHEN th.exchange = 'binance' THEN 'crypto' WHEN th.exchange = 'kis' THEN 'domestic' ELSE 'overseas' END) = $2
    `;
  }
  return db.query(
    `SELECT
       COALESCE(tqe.category, 'unknown') AS category,
       COUNT(*)::int AS cnt
     FROM investment.trade_quality_evaluations tqe
     JOIN investment.trade_history th ON th.id = tqe.trade_id
     WHERE tqe.evaluated_at >= NOW() - ($1::int * INTERVAL '1 day')
       ${marketClause}
     GROUP BY 1
     ORDER BY cnt DESC`,
    params,
  ).catch(() => []);
}

export async function buildPosttradeFeedbackDashboard({ days = 14, market = 'all' } = {}) {
  await db.initSchema();
  const normalizedMarket = normalizeMarket(market);
  const qualitySummary = await buildQualitySummary(days, normalizedMarket);
  const dpoCount = await countRows(
    `SELECT COUNT(*)::int AS cnt
       FROM luna_dpo_preference_pairs
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
    [Math.max(1, Number(days || 14))],
  );
  const ragCount = await countRows(
    `SELECT COUNT(*)::int AS cnt
       FROM luna_rag_documents
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND category IN ('trade_review', 'thesis')`,
    [Math.max(1, Number(days || 14))],
  );
  const reflexionCount = await countRows(
    `SELECT COUNT(*)::int AS cnt
       FROM investment.luna_failure_reflexions
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
    [Math.max(1, Number(days || 14))],
  );
  const skills = await getRecentPosttradeSkills({ market: normalizedMarket === 'all' ? null : normalizedMarket, limit: 100 });
  const feedbackMapRows = await getRecentFeedbackToActionMap({ days, market: normalizedMarket === 'all' ? null : normalizedMarket, limit: 200 });
  const cfg = getPosttradeFeedbackRuntimeConfig();

  const byCategory = Object.fromEntries((qualitySummary || []).map((row) => [String(row.category), Number(row.cnt || 0)]));
  const totalQuality = Object.values(byCategory).reduce((sum, value) => sum + Number(value || 0), 0);

  return {
    ok: true,
    event_type: 'posttrade_dashboard_report',
    generated_at: new Date().toISOString(),
    market: normalizedMarket,
    days: Number(days || 14),
    mode: cfg?.mode || 'shadow',
    quality: {
      total: totalQuality,
      by_category: byCategory,
    },
    learning_channels: {
      dpo_pairs: dpoCount,
      rag_documents: ragCount,
      failure_reflexions: reflexionCount,
      extracted_skills: skills.length,
      feedback_to_action_rows: feedbackMapRows.length,
    },
    top_skills: (skills || []).slice(0, 10).map((row) => ({
      market: row.market,
      skill_type: row.skill_type,
      pattern_key: row.pattern_key,
      success_rate: Number(row.success_rate || 0),
      invocation_count: Number(row.invocation_count || 0),
    })),
  };
}

async function main() {
  const args = parseArgs();
  const result = await buildPosttradeFeedbackDashboard({
    days: args.days,
    market: args.market,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[posttrade-dashboard] market=${result.market} quality=${result.quality.total} skills=${result.learning_channels.extracted_skills} map=${result.learning_channels.feedback_to_action_rows}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-dashboard 실패:',
  });
}

