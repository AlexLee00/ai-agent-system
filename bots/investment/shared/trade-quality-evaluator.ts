// @ts-nocheck
/**
 * shared/trade-quality-evaluator.ts — Phase A: Trade Quality Score 4-차원 평가
 *
 * 마스터 비전 4 질문:
 *   1. market_decision_score  — 종목 매매가 적절했는지?
 *   2. pipeline_quality_score — 자료 수집→평가→매수→매도 전 단계가 적절했는지?
 *   3. monitoring_score       — 포지션 관리 모니터링/평가/피드백이 이루어졌는지?
 *   4. backtest_utilization_score — 백테스팅 결과가 잘 활용되었는지?
 */

import * as db from './db.ts';
import { callLLM } from './llm-client.ts';
import { getPosttradeFeedbackRuntimeConfig } from './runtime-config.ts';

const MARKET_ALIASES = {
  all: 'all',
  crypto: 'crypto',
  domestic: 'domestic',
  overseas: 'overseas',
};

export interface TradeQualityResult {
  trade_id: number;
  market_decision_score: number;
  pipeline_quality_score: number;
  monitoring_score: number;
  backtest_utilization_score: number;
  overall_score: number;
  category: 'preferred' | 'neutral' | 'rejected';
  rationale: string;
  sub_score_breakdown: Record<string, unknown>;
}

/**
 * 단일 trade에 대한 4-차원 품질 평가를 수행하고 DB에 저장한다.
 * Kill switch: LUNA_TRADE_QUALITY_EVALUATOR_ENABLED (config.yaml → posttrade_feedback.trade_quality.enabled)
 */
export async function evaluateTradeQuality(tradeId: number, opts: { dryRun?: boolean } = {}): Promise<TradeQualityResult | null> {
  const posttradeCfg = getPosttradeFeedbackRuntimeConfig();
  const qualityCfg = posttradeCfg?.trade_quality || {};
  const trade        = await fetchTrade(tradeId);
  if (!trade) return null;

  const rationale    = await fetchRationale(tradeId);
  const analystData  = await fetchAnalystContributions(tradeId);
  const lifecycleEvt = await fetchLifecycleEvents(trade);
  const backtestData = await fetchBacktestUtilization(tradeId, trade);
  const reviewData   = await fetchTradeReview(tradeId);

  const withinBudget = await ensureDailyEvaluationBudget({
    dryRun: opts?.dryRun === true,
    budgetUsd: Number(qualityCfg?.llm_daily_budget_usd || 5),
  });
  if (!withinBudget.ok) {
    await recordQualityEvaluationFailure(tradeId, 'llm_daily_budget_exceeded', {
      budgetUsd: qualityCfg?.llm_daily_budget_usd,
      usedEstimateUsd: withinBudget.usedEstimateUsd,
    }).catch(() => {});
    return null;
  }

  const breakdown = await llmEvaluate(trade, rationale, analystData, lifecycleEvt, backtestData, reviewData);
  if (!breakdown) {
    await recordQualityEvaluationFailure(tradeId, 'llm_evaluation_unavailable', {}).catch(() => {});
    return null;
  }

  const constitutionalCfg = posttradeCfg?.constitutional_feedback || {};
  const violationCount = extractConstitutionViolationCount(reviewData, backtestData);
  const constitutionPenalty = constitutionalCfg?.enabled && violationCount > 0
    ? Math.min(0.6, Number(constitutionalCfg?.violation_penalty || 0.20) * violationCount)
    : 0;
  const overall = computeOverall(breakdown, qualityCfg?.weights || {}) - constitutionPenalty;
  const category = classify(overall, {
    preferred: Number(qualityCfg?.preferred_threshold || 0.70),
    rejected: Number(qualityCfg?.rejected_threshold || 0.40),
  });

  const result: TradeQualityResult = {
    trade_id: tradeId,
    market_decision_score:      clamp(breakdown.market_decision_score ?? 0.5),
    pipeline_quality_score:     clamp(breakdown.pipeline_quality_score ?? 0.5),
    monitoring_score:           clamp(breakdown.monitoring_score ?? 0.5),
    backtest_utilization_score: clamp(breakdown.backtest_utilization_score ?? 0.5),
    overall_score:  clamp(overall),
    category,
    rationale: breakdown.rationale ?? '',
    sub_score_breakdown: {
      ...(breakdown || {}),
      constitution_violation_count: violationCount,
      constitution_penalty: constitutionPenalty,
    },
  };

  if (!opts.dryRun) {
    await persistResult(result);
    await db.run(
      `INSERT INTO investment.mapek_knowledge (event_type, payload)
       VALUES ('posttrade_quality_evaluated', $1)`,
      [JSON.stringify({
        trade_id: tradeId,
        category: result.category,
        overall_score: result.overall_score,
        market: trade.market || null,
        exchange: trade.exchange || null,
        evaluated_at: new Date().toISOString(),
      })],
    ).catch(() => {});
  }

  return result;
}

/**
 * 아직 평가되지 않은 최근 종료 거래 목록을 반환한다.
 */
export async function fetchPendingTradeIds(limit = 50): Promise<number[]> {
  const candidates = await fetchPendingPosttradeCandidates({ limit });
  return candidates.map((item) => Number(item.tradeId)).filter((id) => Number.isFinite(id));
}

export async function fetchPendingPosttradeCandidates({
  limit = 50,
  market = 'all',
}: {
  limit?: number;
  market?: string;
} = {}): Promise<Array<{ tradeId: number; source: 'knowledge' | 'fallback_scan'; knowledgeId?: number | null }>> {
  const safeLimit = Math.max(1, Number(limit || 50));
  const targetMarket = normalizeMarketKey(market);
  const rows = await db.query(
    `SELECT
       mk.id AS knowledge_id,
       NULLIF(mk.payload->>'trade_id', '')::BIGINT AS trade_id,
       COALESCE(th.market, CASE WHEN th.exchange = 'binance' THEN 'crypto' WHEN th.exchange = 'kis' THEN 'domestic' ELSE 'overseas' END) AS market,
       mk.created_at
     FROM investment.mapek_knowledge mk
     LEFT JOIN investment.trade_history th ON th.id = NULLIF(mk.payload->>'trade_id', '')::BIGINT
     LEFT JOIN investment.trade_quality_evaluations tqe ON tqe.trade_id = NULLIF(mk.payload->>'trade_id', '')::BIGINT
     WHERE mk.event_type = 'quality_evaluation_pending'
       AND NULLIF(mk.payload->>'trade_id', '') IS NOT NULL
       AND COALESCE(mk.payload->>'posttrade_processed', 'false') <> 'true'
       AND tqe.trade_id IS NULL
     ORDER BY mk.created_at ASC
     LIMIT $1`,
    [safeLimit * 5],
  ).catch(() => []);
  const fromKnowledge = [];
  const seen = new Set<number>();
  for (const row of rows || []) {
    const tradeId = Number(row.trade_id);
    if (!Number.isFinite(tradeId) || tradeId <= 0) continue;
    const rowMarket = normalizeMarketKey(row.market);
    if (targetMarket !== 'all' && rowMarket !== targetMarket) continue;
    if (seen.has(tradeId)) continue;
    seen.add(tradeId);
    fromKnowledge.push({ tradeId, source: 'knowledge' as const, knowledgeId: Number(row.knowledge_id) || null });
    if (fromKnowledge.length >= safeLimit) return fromKnowledge;
  }

  const fallbackRows = await db.query(
    `SELECT th.id
       FROM investment.trade_history th
       LEFT JOIN investment.trade_quality_evaluations tqe ON tqe.trade_id = th.id
      WHERE th.exit_at IS NOT NULL
        AND tqe.trade_id IS NULL
        ${targetMarket === 'all' ? '' : `AND COALESCE(th.market, CASE WHEN th.exchange = 'binance' THEN 'crypto' WHEN th.exchange = 'kis' THEN 'domestic' ELSE 'overseas' END) = $2`}
      ORDER BY th.exit_at DESC
      LIMIT $1`,
    targetMarket === 'all' ? [safeLimit * 2] : [safeLimit * 2, targetMarket],
  ).catch(() => []);
  for (const row of fallbackRows || []) {
    const tradeId = Number(row.id);
    if (!Number.isFinite(tradeId) || tradeId <= 0 || seen.has(tradeId)) continue;
    seen.add(tradeId);
    fromKnowledge.push({ tradeId, source: 'fallback_scan' as const, knowledgeId: null });
    if (fromKnowledge.length >= safeLimit) break;
  }
  return fromKnowledge;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function fetchTrade(tradeId: number) {
  return db.get(`
    SELECT id, symbol, market, direction, entry_price, exit_price, amount_krw,
           entry_at, exit_at, exit_reason, setup_type, exchange
    FROM investment.trade_history
    WHERE id = $1
  `, [tradeId]);
}

async function fetchRationale(tradeId: number): Promise<string> {
  const row = await db.get(`
    SELECT content FROM luna_rag_documents
    WHERE category = 'thesis'
      AND metadata->>'trade_id' = $1::text
    ORDER BY created_at DESC LIMIT 1
  `, [String(tradeId)]);
  return row?.content ?? 'rationale 없음';
}

async function fetchAnalystContributions(tradeId: number) {
  const row = await db.get(`
    SELECT analyst_accuracy, aria_accurate, sophia_accurate, oracle_accurate, hermes_accurate
    FROM investment.trade_review
    WHERE trade_id = $1
    LIMIT 1
  `, [tradeId]);
  return row ?? {};
}

async function fetchLifecycleEvents(trade: any) {
  const symbol = String(trade?.symbol || '');
  const tradeId = Number(trade?.id || 0);
  const entryAt = trade?.entry_at ? new Date(trade.entry_at).getTime() : 0;
  const exitAt = trade?.exit_at ? new Date(trade.exit_at).getTime() : Date.now();
  const fromTs = new Date((entryAt || Date.now()) - 2 * 60 * 60 * 1000).toISOString();
  const toTs = new Date((exitAt || Date.now()) + 2 * 60 * 60 * 1000).toISOString();
  const rows = await db.query(`
    SELECT phase, stage_id, event_type, output_snapshot, created_at
    FROM position_lifecycle_events
    WHERE symbol = $1
      AND created_at BETWEEN $2::timestamptz AND $3::timestamptz
      AND (
        (output_snapshot->>'tradeId')::BIGINT = $4
        OR (output_snapshot->>'trade_id')::BIGINT = $4
        OR (input_snapshot->>'tradeId')::BIGINT = $4
        OR (input_snapshot->>'trade_id')::BIGINT = $4
        OR $4 <= 0
      )
    ORDER BY created_at DESC
    LIMIT 20
  `, [symbol, fromTs, toTs, tradeId > 0 ? tradeId : null]);
  return rows ?? [];
}

async function fetchBacktestUtilization(tradeId: number, trade: any) {
  const symbol = String(trade?.symbol || '');
  const entryAt = trade?.entry_at ? new Date(trade.entry_at).toISOString() : null;
  // mapek_knowledge에서 trade 범위 기반 backtest 조회 여부 확인
  const row = await db.get(`
    SELECT payload
      FROM investment.mapek_knowledge
     WHERE event_type IN ('signal_outcome', 'backtest_report', 'backtest_prediction')
       AND (
         payload->>'trade_id' = $1::text
         OR payload->>'symbol' = $2
       )
       ${entryAt ? `AND created_at >= ($3::timestamptz - INTERVAL '7 days')` : ''}
     ORDER BY created_at DESC
     LIMIT 1
  `, entryAt ? [String(tradeId), symbol, entryAt] : [String(tradeId), symbol]);
  return row?.payload ?? {};
}

async function fetchTradeReview(tradeId: number) {
  return db.get(`
    SELECT reevaluation_count, setup_type, regime,
           strategy_family, family_bias
    FROM investment.trade_review
    WHERE trade_id = $1
    LIMIT 1
  `, [tradeId]);
}

async function llmEvaluate(trade: any, rationale: string, analystData: any, lifecycleEvt: any[], backtestData: any, reviewData: any): Promise<any> {
  const pnlPct = computePnlPct(trade);
  const holdHours = computeHoldHours(trade);
  const reevalCount = reviewData?.reevaluation_count ?? 0;

  const systemPrompt = `당신은 엄격한 퀀트 트레이딩 품질 심사관입니다.
거래의 4가지 측면을 각각 0.0~1.0으로 평가하고 JSON으로만 답합니다.`;

  const userPrompt = `
## 거래 정보
- 심볼: ${trade.symbol} | 시장: ${trade.market} | 방향: ${trade.direction}
- 진입가: ${trade.entry_price} | 청산가: ${trade.exit_price}
- PnL: ${pnlPct.toFixed(2)}% | 보유시간: ${holdHours.toFixed(1)}h
- 청산 이유: ${trade.exit_reason}
- 셋업 타입: ${trade.setup_type ?? '?'} | 레지임: ${reviewData?.regime ?? '?'}

## 당시 매매 근거
${rationale}

## 분석가 기여도
${JSON.stringify(analystData, null, 2)}

## 포지션 라이프사이클 이벤트 수
${lifecycleEvt.length}개 (재평가 횟수: ${reevalCount})

## 백테스팅 데이터
${JSON.stringify(backtestData, null, 2)}

---

아래 4가지를 각각 0.0~1.0으로 평가하세요:

1. **market_decision_score** — 이 매매 자체가 적절했는가? (PnL, risk-adjusted return, 보유기간)
2. **pipeline_quality_score** — 자료수집→감성분석→기술분석→진입→청산 등 전 단계의 의사결정 품질
3. **monitoring_score** — 포지션 보유 중 모니터링, 재평가, 피드백이 충실히 이루어졌는가?
4. **backtest_utilization_score** — 백테스팅 결과가 의사결정에 실질적으로 활용되었는가?

JSON 형식으로만 답하세요:
{
  "market_decision_score": 0.0~1.0,
  "pipeline_quality_score": 0.0~1.0,
  "monitoring_score": 0.0~1.0,
  "backtest_utilization_score": 0.0~1.0,
  "rationale": "종합 평가 요약 (한국어, 2~3문장)"
}`;

  try {
    const text = await callLLM('luna.posttrade_judge', systemPrompt, userPrompt, 512, {
      market: trade.market,
      symbol: trade.symbol,
    });
    return parseJson(text);
  } catch (err) {
    console.error(`[TradeQualityEvaluator] LLM 평가 실패 trade_id=${trade?.id || 'unknown'}:`, err);
    return null;
  }
}

async function persistResult(result: TradeQualityResult) {
  await db.run(`
    INSERT INTO investment.trade_quality_evaluations
      (trade_id, market_decision_score, pipeline_quality_score,
       monitoring_score, backtest_utilization_score,
       overall_score, category, rationale, sub_score_breakdown, evaluated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    ON CONFLICT (trade_id) DO UPDATE SET
      market_decision_score      = EXCLUDED.market_decision_score,
      pipeline_quality_score     = EXCLUDED.pipeline_quality_score,
      monitoring_score           = EXCLUDED.monitoring_score,
      backtest_utilization_score = EXCLUDED.backtest_utilization_score,
      overall_score              = EXCLUDED.overall_score,
      category                   = EXCLUDED.category,
      rationale                  = EXCLUDED.rationale,
      sub_score_breakdown        = EXCLUDED.sub_score_breakdown,
      evaluated_at               = NOW()
  `, [
    result.trade_id,
    result.market_decision_score,
    result.pipeline_quality_score,
    result.monitoring_score,
    result.backtest_utilization_score,
    result.overall_score,
    result.category,
    result.rationale,
    JSON.stringify(result.sub_score_breakdown),
  ]);
}

function computeOverall(b: any, weightInput: Record<string, unknown> = {}): number {
  const weight = normalizeWeights(weightInput);
  return (
    (b.market_decision_score      ?? 0.5) * weight.market_decision +
    (b.pipeline_quality_score     ?? 0.5) * weight.pipeline_quality +
    (b.monitoring_score           ?? 0.5) * weight.monitoring +
    (b.backtest_utilization_score ?? 0.5) * weight.backtest_utilization
  );
}

function classify(score: number, threshold: { preferred: number; rejected: number }): 'preferred' | 'neutral' | 'rejected' {
  if (score >= Number(threshold?.preferred || 0.70)) return 'preferred';
  if (score <= Number(threshold?.rejected || 0.40))  return 'rejected';
  return 'neutral';
}

function normalizeWeights(input: Record<string, unknown>) {
  const candidate = {
    market_decision: Number(input?.market_decision ?? 0.35),
    pipeline_quality: Number(input?.pipeline_quality ?? 0.30),
    monitoring: Number(input?.monitoring ?? 0.20),
    backtest_utilization: Number(input?.backtest_utilization ?? 0.15),
  };
  const total = Object.values(candidate).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  if (!Number.isFinite(total) || total <= 0) {
    return { market_decision: 0.35, pipeline_quality: 0.30, monitoring: 0.20, backtest_utilization: 0.15 };
  }
  return {
    market_decision: candidate.market_decision / total,
    pipeline_quality: candidate.pipeline_quality / total,
    monitoring: candidate.monitoring / total,
    backtest_utilization: candidate.backtest_utilization / total,
  };
}

function normalizeMarketKey(market: unknown) {
  const raw = String(market || 'all').trim().toLowerCase();
  if (raw === 'binance') return MARKET_ALIASES.crypto;
  if (raw === 'kis') return MARKET_ALIASES.domestic;
  if (raw === 'kis_overseas') return MARKET_ALIASES.overseas;
  if (raw === 'domestic' || raw === 'overseas' || raw === 'crypto' || raw === 'all') return raw;
  return 'all';
}

async function ensureDailyEvaluationBudget({
  dryRun = false,
  budgetUsd = 5,
}: {
  dryRun?: boolean;
  budgetUsd?: number;
} = {}) {
  if (dryRun) return { ok: true, usedEstimateUsd: 0 };
  const safeBudget = Math.max(0, Number(budgetUsd || 0));
  if (safeBudget <= 0) return { ok: true, usedEstimateUsd: 0 };
  const row = await db.get(
    `SELECT COUNT(*)::int AS cnt
       FROM investment.trade_quality_evaluations
      WHERE evaluated_at >= NOW()::date`,
    [],
  ).catch(() => ({ cnt: 0 }));
  const cnt = Number(row?.cnt || 0);
  const usedEstimateUsd = cnt * 0.03;
  return { ok: usedEstimateUsd <= safeBudget, usedEstimateUsd };
}

async function recordQualityEvaluationFailure(tradeId: number, code: string, meta: Record<string, unknown> = {}) {
  await db.run(
    `INSERT INTO investment.mapek_knowledge (event_type, payload)
     VALUES ('quality_evaluation_failed', $1)`,
    [JSON.stringify({
      trade_id: tradeId,
      code,
      meta: meta || {},
      created_at: new Date().toISOString(),
    })],
  );
}

function extractConstitutionViolationCount(reviewData: any, backtestData: any) {
  const reviewCount = Number(reviewData?.constitution_violations || 0);
  if (Number.isFinite(reviewCount) && reviewCount > 0) return Math.round(reviewCount);
  const arr = backtestData?.constitution_violations;
  if (Array.isArray(arr) && arr.length > 0) return arr.length;
  return 0;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
}

function computePnlPct(trade: any): number {
  const entry = Number(trade.entry_price) || 0;
  const exit  = Number(trade.exit_price)  || 0;
  if (entry === 0) return 0;
  const raw = (exit - entry) / entry * 100;
  return trade.direction === 'short' ? -raw : raw;
}

function computeHoldHours(trade: any): number {
  const entry = trade.entry_at ? new Date(trade.entry_at).getTime() : 0;
  const exit  = trade.exit_at  ? new Date(trade.exit_at).getTime()  : Date.now();
  return (exit - entry) / 3_600_000;
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fallthrough */ } }
  return null;
}
