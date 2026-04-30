#!/usr/bin/env node
// @ts-nocheck
/**
 * runtime-first-cycle-posttrade-verify.ts — Phase Z5: Posttrade 처리 검증 ⭐
 *
 * close 이벤트 → posttrade 처리 완료 추적:
 *   Phase A: trade_quality_score 계산 검증
 *   Phase B: stage_attribution 분석 검증
 *   Phase D: skill_extraction 시도 검증
 *
 * 사용법:
 *   tsx bots/investment/scripts/runtime-first-cycle-posttrade-verify.ts
 *   tsx bots/investment/scripts/runtime-first-cycle-posttrade-verify.ts --json
 *   tsx bots/investment/scripts/runtime-first-cycle-posttrade-verify.ts --symbol=BTC/USDT
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const POSTTRADE_HEARTBEAT = path.join(INVESTMENT_DIR, 'output', 'ops', 'posttrade-feedback-worker-heartbeat.json');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    exchange: argv.find((a) => a.startsWith('--exchange='))?.split('=')[1] || 'binance',
    symbol: argv.find((a) => a.startsWith('--symbol='))?.split('=')[1] || null,
    hours: Number(argv.find((a) => a.startsWith('--hours='))?.split('=')[1] || 168),
    tradeId: argv.find((a) => a.startsWith('--trade-id='))
      ? Number(argv.find((a) => a.startsWith('--trade-id='))!.split('=')[1])
      : null,
  };
}

function readJson(file: string) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function heartbeatAgeMinutes(hb: any) {
  const ts = hb?.completedAt || hb?.startedAt;
  if (!ts) return null;
  return Math.round((Date.now() - new Date(ts).getTime()) / 60000);
}

async function getPosttradeEvaluations(symbol: string | null, tradeId: number | null, hours: number) {
  try {
    const cond = tradeId
      ? `AND payload->>'trade_id' = '${tradeId}'`
      : symbol
        ? `AND (payload->>'symbol' = '${symbol}' OR payload::text ILIKE '%${symbol}%')`
        : '';
    const rows = await db.query(
      `SELECT id, event_type, payload, created_at, processed_at
         FROM investment.mapek_knowledge
        WHERE event_type IN (
          'quality_evaluation_result', 'quality_evaluation_pending',
          'quality_evaluation_failed', 'trade_quality_evaluated'
        )
          AND created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
          ${cond}
        ORDER BY created_at DESC
        LIMIT 20`,
      [],
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getTradeQualityEvaluations(symbol: string | null, tradeId: number | null, hours: number) {
  try {
    let whereClause = `WHERE evaluated_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'`;
    const params: any[] = [];
    if (tradeId) {
      params.push(tradeId);
      whereClause += ` AND trade_id = $${params.length}`;
    } else if (symbol) {
      params.push(symbol);
      whereClause += ` AND symbol = $${params.length}`;
    }
    const rows = await db.query(
      `SELECT id, trade_id, symbol, market_decision_score, pipeline_quality_score,
              monitoring_score, backtest_utilization_score, overall_score,
              category, rationale, evaluated_at
         FROM investment.trade_quality_evaluations
         ${whereClause}
        ORDER BY evaluated_at DESC
        LIMIT 10`,
      params,
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getStageAttributions(symbol: string | null, tradeId: number | null, hours: number) {
  try {
    const cond = tradeId
      ? `AND payload->>'trade_id' = '${tradeId}'`
      : symbol
        ? `AND (payload->>'symbol' = '${symbol}' OR payload::text ILIKE '%${symbol}%')`
        : '';
    const rows = await db.query(
      `SELECT id, event_type, payload, created_at
         FROM investment.mapek_knowledge
        WHERE event_type IN (
          'stage_attribution', 'stage_attribution_result',
          'posttrade_stage_attribution', 'attribution_analysis'
        )
          AND created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
          ${cond}
        ORDER BY created_at DESC
        LIMIT 10`,
      [],
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getSkillExtractionAttempts(hours: number) {
  try {
    const rows = await db.query(
      `SELECT id, event_type, payload, created_at
         FROM investment.mapek_knowledge
        WHERE event_type IN (
          'skill_extraction_attempt', 'skill_extracted',
          'skill_extraction_skipped', 'posttrade_skill_extraction'
        )
          AND created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
        ORDER BY created_at DESC
        LIMIT 10`,
      [],
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getPosttradeSkills(hours: number) {
  try {
    const rows = await db.query(
      `SELECT id, agent_name, skill_type, pattern_key, title,
              invocation_count, success_rate, created_at, updated_at
         FROM investment.posttrade_skills
        WHERE updated_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
        ORDER BY updated_at DESC
        LIMIT 10`,
      [],
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getFeedbackToActionMap(hours: number) {
  try {
    const rows = await db.query(
      `SELECT id, parameter_name, old_value, new_value, reason, created_at
         FROM investment.feedback_to_action_map
        WHERE created_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
        ORDER BY created_at DESC
        LIMIT 10`,
      [],
    );
    return rows || [];
  } catch {
    return [];
  }
}

function checkDof(
  posttradeEvals: any[],
  tradeQualityEvals: any[],
  stageAttributions: any[],
  skillAttempts: any[],
  hb: any,
) {
  const processed = Number(hb?.result?.processed ?? 0);
  const dof: string[] = [];

  dof.push(processed >= 1
    ? `✅ posttrade-feedback-worker processed=${processed}`
    : posttradeEvals.some((e) => e.event_type === 'quality_evaluation_pending')
      ? `⚠️  posttrade worker 대기 중 (pending 이벤트 있음, processed=${processed})`
      : `❌ posttrade worker processed=0 (close 이벤트 미도달 가능)`,
  );

  const hasResult = tradeQualityEvals.length > 0 ||
    posttradeEvals.some((e) => e.event_type === 'quality_evaluation_result');
  dof.push(hasResult
    ? `✅ trade_quality_score 계산 완료 (${tradeQualityEvals.length > 0 ? `overall=${tradeQualityEvals[0]?.overall_score}` : 'mapek_knowledge 기록'})`
    : `⚠️  trade_quality_score 미계산 (Phase A 미동작)`,
  );

  const hasAttr = stageAttributions.length > 0;
  dof.push(hasAttr
    ? `✅ stage_attribution 분석 완료 (${stageAttributions.length}건)`
    : `⚠️  stage_attribution 없음 (Phase B 미동작 또는 1건 부족)`,
  );

  dof.push(skillAttempts.length > 0
    ? `✅ Phase D skill_extraction 시도 기록 (${skillAttempts.length}건)`
    : `⚠️  Phase D skill_extraction 없음 (단일 거래 정상 — ≥3건 필요)`,
  );

  return dof;
}

export async function runFirstCyclePosttradeVerify({
  exchange = 'binance',
  symbol = null,
  tradeId = null,
  hours = 168,
}: { exchange?: string; symbol?: string | null; tradeId?: number | null; hours?: number } = {}) {
  await db.initSchema();

  const hb = readJson(POSTTRADE_HEARTBEAT);
  const hbAge = heartbeatAgeMinutes(hb);

  const [
    posttradeEvals,
    tradeQualityEvals,
    stageAttributions,
    skillAttempts,
    posttradeSkills,
    feedbackActions,
  ] = await Promise.allSettled([
    getPosttradeEvaluations(symbol, tradeId, hours),
    getTradeQualityEvaluations(symbol, tradeId, hours),
    getStageAttributions(symbol, tradeId, hours),
    getSkillExtractionAttempts(hours),
    getPosttradeSkills(hours),
    getFeedbackToActionMap(hours),
  ]).then((results) => results.map((r) => (r.status === 'fulfilled' ? r.value : [])));

  const latestQuality = (tradeQualityEvals || [])[0] || null;
  const latestMapekEval = (posttradeEvals || []).find((e) => e.event_type === 'quality_evaluation_result');

  const dof = checkDof(
    posttradeEvals || [],
    tradeQualityEvals || [],
    stageAttributions || [],
    skillAttempts || [],
    hb,
  );

  return {
    ok: (tradeQualityEvals || []).length > 0 || Number(hb?.result?.processed || 0) >= 1,
    checkedAt: new Date().toISOString(),
    exchange,
    symbol,
    tradeId,
    dof,
    posttradeWorker: {
      ageMinutes: hbAge,
      ok: hb?.ok === true,
      processed: Number(hb?.result?.processed ?? 0),
      mode: hb?.mode ?? null,
      market: hb?.market ?? null,
      learning: hb?.learning ? {
        skillExtraction: hb.learning.skillExtraction,
        dashboard: hb.learning.dashboard,
      } : null,
    },
    phaseA: {
      label: 'Phase A: Trade Quality Score',
      mapekEventCount: (posttradeEvals || []).length,
      evaluationTableCount: (tradeQualityEvals || []).length,
      latestEvaluation: latestQuality ? {
        tradeId: latestQuality.trade_id,
        symbol: latestQuality.symbol,
        marketDecisionScore: latestQuality.market_decision_score,
        pipelineQualityScore: latestQuality.pipeline_quality_score,
        monitoringScore: latestQuality.monitoring_score,
        backtestUtilizationScore: latestQuality.backtest_utilization_score,
        overallScore: latestQuality.overall_score,
        category: latestQuality.category,
        evaluatedAt: latestQuality.evaluated_at,
      } : latestMapekEval ? {
        payload: latestMapekEval.payload,
        at: latestMapekEval.created_at,
      } : null,
      mapekTypes: [...new Set((posttradeEvals || []).map((e) => e.event_type))],
    },
    phaseB: {
      label: 'Phase B: Stage Attribution',
      eventCount: (stageAttributions || []).length,
      recent: (stageAttributions || []).slice(0, 3).map((e) => ({
        eventType: e.event_type,
        at: e.created_at,
        summary: Object.keys(e.payload || {}).slice(0, 5),
      })),
    },
    phaseD: {
      label: 'Phase D: Skill Extraction',
      attemptCount: (skillAttempts || []).length,
      skillCount: (posttradeSkills || []).length,
      skills: (posttradeSkills || []).slice(0, 5).map((s) => ({
        agentName: s.agent_name,
        skillType: s.skill_type,
        patternKey: s.pattern_key,
        invocationCount: s.invocation_count,
        successRate: s.success_rate,
      })),
    },
    feedbackActions: {
      count: (feedbackActions || []).length,
      recent: (feedbackActions || []).slice(0, 3).map((f) => ({
        parameter: f.parameter_name,
        old: f.old_value,
        new: f.new_value,
        reason: f.reason,
        at: f.created_at,
      })),
    },
  };
}

async function main() {
  const args = parseArgs();
  const result = await runFirstCyclePosttradeVerify({
    exchange: args.exchange,
    symbol: args.symbol,
    tradeId: args.tradeId,
    hours: args.hours,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log('🤖 Phase Z5: Posttrade Feedback 검증 ⭐');
  console.log('='.repeat(50));
  console.log(`checkedAt: ${result.checkedAt} / exchange: ${result.exchange}`);
  if (result.symbol) console.log(`symbol: ${result.symbol}`);
  console.log('');

  const pw = result.posttradeWorker;
  console.log('📡 Posttrade Worker');
  console.log(`  ok: ${pw.ok ? '✅' : '❌'} / age=${pw.ageMinutes}m`);
  console.log(`  processed: ${pw.processed} / mode: ${pw.mode} / market: ${pw.market}`);
  if (pw.learning?.dashboard) {
    const dash = pw.learning.dashboard;
    console.log(`  dashboard: total=${dash.total || 0} / by_category=${JSON.stringify(dash.by_category || {})}`);
  }
  console.log('');

  const pA = result.phaseA;
  console.log(`📊 ${pA.label}`);
  console.log(`  mapek 이벤트: ${pA.mapekEventCount}건 / evaluation 테이블: ${pA.evaluationTableCount}건`);
  console.log(`  event types: ${pA.mapekTypes.join(', ') || '없음'}`);
  if (pA.latestEvaluation && 'overallScore' in pA.latestEvaluation) {
    const e = pA.latestEvaluation;
    console.log(`  최신 평가:`);
    console.log(`    trade_id=${e.tradeId} / symbol=${e.symbol}`);
    console.log(`    market_decision=${e.marketDecisionScore?.toFixed(2)} / pipeline=${e.pipelineQualityScore?.toFixed(2)}`);
    console.log(`    monitoring=${e.monitoringScore?.toFixed(2)} / backtest=${e.backtestUtilizationScore?.toFixed(2)}`);
    console.log(`    overall=${e.overallScore?.toFixed(2)} / category=${e.category}`);
  } else if (pA.latestEvaluation) {
    console.log(`  mapek payload keys: ${JSON.stringify(Object.keys(pA.latestEvaluation.payload || {}))}`);
  } else {
    console.log(`  평가 없음 (Phase A 미완료)`);
  }
  console.log('');

  const pB = result.phaseB;
  console.log(`📈 ${pB.label}`);
  console.log(`  이벤트: ${pB.eventCount}건`);
  for (const e of pB.recent) {
    console.log(`  [${e.eventType}] @ ${e.at} / keys=${e.summary.join(',')}`);
  }
  if (pB.eventCount === 0) console.log(`  없음 (단일 거래 시 정상 — 누적 후 활성)`);
  console.log('');

  const pD = result.phaseD;
  console.log(`🧠 ${pD.label}`);
  console.log(`  시도: ${pD.attemptCount}건 / 누적 스킬: ${pD.skillCount}건`);
  if (pD.skillCount === 0) console.log(`  없음 (≥3건 필요 — 단일 거래 시 정상)`);
  for (const s of pD.skills) {
    console.log(`  [${s.agentName}] ${s.skillType}: ${s.patternKey} (invoked=${s.invocationCount}, success=${s.successRate})`);
  }
  console.log('');

  if (result.feedbackActions.count > 0) {
    console.log('⚙️  Feedback to Action');
    for (const f of result.feedbackActions.recent) {
      console.log(`  ${f.parameter}: ${f.old} → ${f.new} (${f.reason})`);
    }
    console.log('');
  }

  console.log('✅ Definition of Done');
  for (const line of result.dof) {
    console.log(`  ${line}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-first-cycle-posttrade-verify 실패:',
  });
}
