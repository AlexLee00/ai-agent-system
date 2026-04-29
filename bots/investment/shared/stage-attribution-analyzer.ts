// @ts-nocheck
/**
 * shared/stage-attribution-analyzer.ts — Phase B: Stage Attribution Tracker
 *
 * 각 의사결정 단계(Discovery → Sentiment → Technical → Setup → Entry →
 * Lifecycle Stage 1~8 → Exit)가 trade outcome에 얼마나 기여했는지 추적.
 */

import * as db from './db.ts';

export interface StageAttribution {
  trade_id: number;
  stage_id: string;
  decision_type: string;
  decision_score: number;
  contribution_to_outcome: number; // -1 ~ +1
  evidence: Record<string, unknown>;
}

const STAGE_IDS = [
  'discovery', 'sentiment', 'technical', 'setup',
  'entry', 'stage_1', 'stage_2', 'stage_3', 'stage_4',
  'stage_5', 'stage_6', 'stage_7', 'stage_8', 'exit',
];

/**
 * trade_id에 대한 단계별 기여도를 분석하고 DB에 저장한다.
 */
export async function analyzeStageAttribution(
  tradeId: number,
  overallPnlPct: number,
  opts: { dryRun?: boolean } = {}
): Promise<StageAttribution[]> {
  const trade      = await fetchTradeBasic(tradeId);
  const reviewData = await fetchReviewData(tradeId);
  const lifecycle  = await fetchLifecycleData(trade);
  const ragDocs    = await fetchRagDocs(tradeId);

  const attributions = buildAttributions(tradeId, trade, overallPnlPct, reviewData, lifecycle, ragDocs);

  if (!opts.dryRun && attributions.length > 0) {
    await persistAttributions(attributions);
  }

  return attributions;
}

/**
 * 특정 trade의 stage attribution을 조회한다.
 */
export async function getStageAttributions(tradeId: number): Promise<StageAttribution[]> {
  const rows = await db.query(`
    SELECT trade_id, stage_id, decision_type, decision_score,
           contribution_to_outcome, evidence
    FROM investment.trade_decision_attribution
    WHERE trade_id = $1
    ORDER BY contribution_to_outcome DESC
  `, [tradeId]);
  return rows as StageAttribution[];
}

// ─── Private ─────────────────────────────────────────────────────────────────

async function fetchTradeBasic(tradeId: number) {
  return db.get(`
    SELECT id, symbol, market, exchange, direction,
           entry_price, exit_price, entry_at, exit_at,
           exit_reason, setup_type
    FROM investment.trade_history
    WHERE id = $1
  `, [tradeId]);
}

async function fetchReviewData(tradeId: number) {
  return db.get(`
    SELECT analyst_accuracy, reevaluation_count, regime,
           strategy_family, family_bias,
           aria_accurate, sophia_accurate, oracle_accurate, hermes_accurate
    FROM investment.trade_review
    WHERE trade_id = $1
    LIMIT 1
  `, [tradeId]);
}

async function fetchLifecycleData(trade: any) {
  const symbol = String(trade?.symbol || '');
  if (!symbol) return [];
  const tradeId = Number(trade?.id || 0);
  const entryAt = trade?.entry_at ? new Date(trade.entry_at).getTime() : 0;
  const exitAt = trade?.exit_at ? new Date(trade.exit_at).getTime() : Date.now();
  const fromTs = new Date((entryAt || Date.now()) - 2 * 60 * 60 * 1000).toISOString();
  const toTs = new Date((exitAt || Date.now()) + 2 * 60 * 60 * 1000).toISOString();
  return db.query(`
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
    ORDER BY created_at ASC
    LIMIT 30
  `, [symbol, fromTs, toTs, tradeId > 0 ? tradeId : null]);
}

async function fetchRagDocs(tradeId: number) {
  return db.query(`
    SELECT category, content, metadata
    FROM luna_rag_documents
    WHERE metadata->>'trade_id' = $1::text
    ORDER BY created_at DESC
    LIMIT 10
  `, [String(tradeId)]);
}

function buildAttributions(
  tradeId: number,
  trade: any,
  pnlPct: number,
  review: any,
  lifecycle: any[],
  ragDocs: any[]
): StageAttribution[] {
  const attrs: StageAttribution[] = [];
  const sign = pnlPct >= 0 ? 1 : -1;

  // Discovery — RAG thesis 문서 존재 여부
  const hasThesis = ragDocs.some((d: any) => d.category === 'thesis');
  attrs.push({
    trade_id: tradeId,
    stage_id: 'discovery',
    decision_type: 'candidate_selection',
    decision_score: hasThesis ? 0.8 : 0.3,
    contribution_to_outcome: hasThesis ? sign * 0.10 : sign * -0.05,
    evidence: { has_thesis: hasThesis, rag_doc_count: ragDocs.length },
  });

  // Sentiment — sophia_accurate
  const sophiaOk = review?.sophia_accurate ?? null;
  attrs.push({
    trade_id: tradeId,
    stage_id: 'sentiment',
    decision_type: 'sentiment_analysis',
    decision_score: sophiaOk === true ? 0.8 : sophiaOk === false ? 0.2 : 0.5,
    contribution_to_outcome: sophiaOk === true ? sign * 0.08 : sophiaOk === false ? sign * -0.08 : 0,
    evidence: { sophia_accurate: sophiaOk },
  });

  // Technical — aria_accurate
  const ariaOk = review?.aria_accurate ?? null;
  attrs.push({
    trade_id: tradeId,
    stage_id: 'technical',
    decision_type: 'technical_analysis',
    decision_score: ariaOk === true ? 0.8 : ariaOk === false ? 0.2 : 0.5,
    contribution_to_outcome: ariaOk === true ? sign * 0.12 : ariaOk === false ? sign * -0.12 : 0,
    evidence: { aria_accurate: ariaOk, oracle_accurate: review?.oracle_accurate },
  });

  // Setup — setup_type 존재 여부
  const hasSetup = Boolean(trade?.setup_type);
  attrs.push({
    trade_id: tradeId,
    stage_id: 'setup',
    decision_type: 'setup_classification',
    decision_score: hasSetup ? 0.75 : 0.4,
    contribution_to_outcome: hasSetup ? sign * 0.08 : sign * -0.04,
    evidence: { setup_type: trade?.setup_type, regime: review?.regime },
  });

  // Entry — lifecycle 첫 이벤트 체크
  const hasEntryEvent = lifecycle.some((e: any) => e.phase === 'entry' || e.event_type?.includes('entry'));
  attrs.push({
    trade_id: tradeId,
    stage_id: 'entry',
    decision_type: 'entry_timing',
    decision_score: hasEntryEvent ? 0.7 : 0.5,
    contribution_to_outcome: sign * (Math.abs(pnlPct) > 2 ? 0.15 : 0.05),
    evidence: { has_entry_event: hasEntryEvent, pnl_pct: pnlPct },
  });

  // Lifecycle stages 1~8 (reevaluation 밀도)
  const reevalCount = Number(review?.reevaluation_count ?? 0);
  const monitoringScore = Math.min(1.0, reevalCount / 5); // 5회 재평가 = 만점
  for (let i = 1; i <= 8; i++) {
    const stageEvents = lifecycle.filter((e: any) =>
      String(e.stage_id || '').toLowerCase() === `stage_${i}`
      || String(e.phase || '').toLowerCase().includes(`stage_${i}`)
      || String(e.event_type || '').toLowerCase().includes(`stage_${i}`)
    );
    attrs.push({
      trade_id: tradeId,
      stage_id: `stage_${i}`,
      decision_type: 'position_monitoring',
      decision_score: stageEvents.length > 0 ? 0.7 : monitoringScore * 0.5,
      contribution_to_outcome: stageEvents.length > 0 ? sign * 0.02 : 0,
      evidence: { event_count: stageEvents.length, reeval_count: reevalCount },
    });
  }

  // Exit — exit_reason 분석
  const exitReason = trade?.exit_reason ?? '';
  const goodExit = ['tp_hit', 'trailing_stop', 'strategy_exit'].some(r => exitReason.includes(r));
  const forcedExit = ['sl_hit', 'forced', 'liquidation'].some(r => exitReason.includes(r));
  attrs.push({
    trade_id: tradeId,
    stage_id: 'exit',
    decision_type: 'exit_timing',
    decision_score: goodExit ? 0.85 : forcedExit ? 0.25 : 0.5,
    contribution_to_outcome: goodExit ? sign * 0.15 : forcedExit ? sign * -0.15 : sign * 0.05,
    evidence: { exit_reason: exitReason, good_exit: goodExit, forced_exit: forcedExit },
  });

  return attrs;
}

async function persistAttributions(attrs: StageAttribution[]) {
  for (const a of attrs) {
    await db.run(`
      INSERT INTO investment.trade_decision_attribution
        (trade_id, stage_id, decision_type, decision_score, contribution_to_outcome, evidence)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (trade_id, stage_id) DO UPDATE SET
        decision_type           = EXCLUDED.decision_type,
        decision_score          = EXCLUDED.decision_score,
        contribution_to_outcome = EXCLUDED.contribution_to_outcome,
        evidence                = EXCLUDED.evidence,
        created_at              = NOW()
    `, [
      a.trade_id, a.stage_id, a.decision_type,
      a.decision_score, a.contribution_to_outcome,
      JSON.stringify(a.evidence),
    ]);
  }
}
