#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { getPosttradeFeedbackRuntimeConfig } from '../shared/runtime-config.ts';
import { getRecentPosttradeSkills, getRecentFeedbackToActionMap } from '../shared/db.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
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

async function buildConstitutionSummary(days = 14, market = 'all') {
  const normalized = normalizeMarket(market);
  const params: unknown[] = [Math.max(1, Number(days || 14))];
  let marketClause = '';
  if (normalized !== 'all') {
    params.push(normalized);
    marketClause = `
      AND COALESCE(th.market, CASE WHEN th.exchange = 'binance' THEN 'crypto' WHEN th.exchange = 'kis' THEN 'domestic' ELSE 'overseas' END) = $2
    `;
  }
  const rows = await db.query(
    `SELECT
       violation.value::text AS violation,
       COUNT(*)::int AS cnt
     FROM investment.trade_quality_evaluations tqe
     JOIN investment.trade_history th ON th.id = tqe.trade_id
     CROSS JOIN LATERAL jsonb_array_elements_text(
       CASE
         WHEN jsonb_typeof(tqe.sub_score_breakdown->'constitution_violations') = 'array'
         THEN tqe.sub_score_breakdown->'constitution_violations'
         ELSE '[]'::jsonb
       END
     ) AS violation(value)
     WHERE tqe.evaluated_at >= NOW() - ($1::int * INTERVAL '1 day')
       ${marketClause}
     GROUP BY 1
     ORDER BY cnt DESC, violation ASC
     LIMIT 10`,
    params,
  ).catch(async (error) => {
    const message = String(error?.message || error || '');
    if (!message.includes('trade_history') && !message.includes('does not exist')) return [];
    return db.query(
      `SELECT
         violation.value::text AS violation,
         COUNT(*)::int AS cnt
       FROM investment.trade_quality_evaluations tqe
       CROSS JOIN LATERAL jsonb_array_elements_text(
         CASE
           WHEN jsonb_typeof(tqe.sub_score_breakdown->'constitution_violations') = 'array'
           THEN tqe.sub_score_breakdown->'constitution_violations'
           ELSE '[]'::jsonb
         END
       ) AS violation(value)
       WHERE tqe.evaluated_at >= NOW() - ($1::int * INTERVAL '1 day')
       GROUP BY 1
       ORDER BY cnt DESC, violation ASC
       LIMIT 10`,
      [Math.max(1, Number(days || 14))],
    ).catch(() => []);
  });
  const topViolations = (rows || []).map((row) => ({
    code: String(row.violation || '').replace(/^"|"$/g, ''),
    count: Number(row.cnt || 0),
  })).filter((item) => item.code);
  return {
    violationCount: topViolations.reduce((sum, item) => sum + Number(item.count || 0), 0),
    topViolations,
  };
}

export async function buildPosttradeFeedbackDashboard({ days = 14, market = 'all' } = {}) {
  await db.initSchema();
  const normalizedMarket = normalizeMarket(market);
  const qualitySummary = await buildQualitySummary(days, normalizedMarket);
  const constitutionSummary = await buildConstitutionSummary(days, normalizedMarket);
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
    constitution: constitutionSummary,
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

export async function recordPosttradeFeedbackDashboard(report, { dryRun = false } = {}) {
  if (!report || report.ok !== true) {
    return { ok: false, code: 'invalid_posttrade_dashboard_report' };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, recorded: false };
  }
  const row = await db.get(
    `INSERT INTO investment.mapek_knowledge (event_type, payload)
     VALUES ('posttrade_dashboard_report', $1)
     RETURNING id`,
    [JSON.stringify(report)],
  ).catch((error) => ({
    error: String(error?.message || error || 'unknown'),
  }));
  if (row?.error) return { ok: false, code: 'posttrade_dashboard_record_failed', error: row.error };
  return { ok: true, recorded: true, knowledgeId: row?.id || null };
}

export function buildPosttradeDashboardTelegramMessage(report) {
  const quality = report?.quality || {};
  const channels = report?.learning_channels || {};
  const topSkills = Array.isArray(report?.top_skills) ? report.top_skills : [];
  return [
    '📊 [Luna] Posttrade 학습 리포트',
    `기간: 최근 ${report?.days || 0}일 / 시장: ${report?.market || 'all'} / mode: ${report?.mode || 'shadow'}`,
    `품질 평가: total=${quality.total || 0} preferred=${quality.by_category?.preferred || 0} neutral=${quality.by_category?.neutral || 0} rejected=${quality.by_category?.rejected || 0}`,
    `헌법 위반: total=${report?.constitution?.violationCount || 0}${report?.constitution?.topViolations?.length ? ` / top=${report.constitution.topViolations.slice(0, 3).map((item) => `${item.code}:${item.count}`).join(', ')}` : ''}`,
    `학습 채널: DPO=${channels.dpo_pairs || 0} RAG=${channels.rag_documents || 0} Reflexion=${channels.failure_reflexions || 0} Skills=${channels.extracted_skills || 0} FeedbackMap=${channels.feedback_to_action_rows || 0}`,
    topSkills.length > 0
      ? `대표 skill: ${topSkills.slice(0, 3).map((item) => `${item.skill_type}:${item.pattern_key}`).join(', ')}`
      : '대표 skill: 없음',
  ].join('\n');
}

export async function publishPosttradeDashboardReport(report, {
  dryRun = false,
  includeEmpty = false,
} = {}) {
  if (!report || report.ok !== true) return { ok: false, code: 'invalid_posttrade_dashboard_report' };
  const qualityTotal = Number(report?.quality?.total || 0);
  const channels = report?.learning_channels || {};
  const learningTotal = Number(channels.dpo_pairs || 0)
    + Number(channels.rag_documents || 0)
    + Number(channels.failure_reflexions || 0)
    + Number(channels.extracted_skills || 0)
    + Number(channels.feedback_to_action_rows || 0);
  if (!includeEmpty && qualityTotal === 0 && learningTotal === 0) {
    return { ok: true, skipped: true, reason: 'empty_posttrade_dashboard' };
  }
  const message = buildPosttradeDashboardTelegramMessage(report);
  if (dryRun) return { ok: true, dryRun: true, skipped: false, message };
  const delivered = await publishAlert({
    from_bot: 'luna',
    team: 'investment',
    event_type: 'report',
    alert_level: 1,
    message,
    payload: {
      event_type: report.event_type,
      market: report.market,
      days: report.days,
      quality: report.quality,
      constitution: report.constitution,
      learning_channels: report.learning_channels,
    },
  });
  return { ok: delivered === true, delivered: delivered === true };
}

async function main() {
  const args = parseArgs();
  const result = await buildPosttradeFeedbackDashboard({
    days: args.days,
    market: args.market,
  });
  if (process.argv.includes('--write')) {
    result.record = await recordPosttradeFeedbackDashboard(result, {
      dryRun: process.argv.includes('--dry-run'),
    });
  }
  if (process.argv.includes('--telegram')) {
    result.telegram = await publishPosttradeDashboardReport(result, {
      dryRun: process.argv.includes('--dry-run'),
      includeEmpty: process.argv.includes('--include-empty'),
    });
  }
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
