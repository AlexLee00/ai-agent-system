// @ts-nocheck
import { query, run, get } from './core.ts';
import { resolveLunaAutonomyPhase } from '../autonomy-phase.ts';

export async function insertLifecycleEvent({
  positionScopeKey,
  exchange,
  symbol,
  tradeMode = 'normal',
  phase,
  stageId = null,
  ownerAgent = null,
  eventType,
  inputSnapshot = {},
  outputSnapshot = {},
  policySnapshot = {},
  evidenceSnapshot = {},
  idempotencyKey = null,
}) {
  if (!positionScopeKey || !exchange || !symbol || !phase || !eventType) return null;
  if (idempotencyKey) {
    const existing = await get(
      `SELECT id FROM position_lifecycle_events WHERE idempotency_key = $1`,
      [idempotencyKey],
    ).catch(() => null);
    if (existing) return existing.id;
  }
  const row = await get(
    `INSERT INTO position_lifecycle_events
       (position_scope_key, exchange, symbol, trade_mode, phase, stage_id, owner_agent, event_type,
        input_snapshot, output_snapshot, policy_snapshot, evidence_snapshot, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      positionScopeKey, exchange, symbol, tradeMode || 'normal',
      phase, stageId || null, ownerAgent || null, eventType,
      JSON.stringify(inputSnapshot ?? {}),
      JSON.stringify(outputSnapshot ?? {}),
      JSON.stringify(policySnapshot ?? {}),
      JSON.stringify(evidenceSnapshot ?? {}),
      idempotencyKey || null,
    ],
  ).catch(() => null);
  return row?.id || null;
}

export async function getLifecycleEventsForScope(positionScopeKey, { limit = 50 } = {}) {
  return query(
    `SELECT * FROM position_lifecycle_events
     WHERE position_scope_key = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [positionScopeKey, limit],
  ).catch(() => []);
}

export async function getLifecyclePhaseCoverage({ days = 7 } = {}) {
  return query(
    `SELECT symbol, exchange, trade_mode,
            array_agg(DISTINCT phase ORDER BY phase) AS covered_phases,
            COUNT(*) AS event_count,
            MAX(created_at) AS last_event_at
     FROM position_lifecycle_events
     WHERE created_at >= now() - ($1::int * INTERVAL '1 day')
     GROUP BY symbol, exchange, trade_mode
     ORDER BY last_event_at DESC`,
    [days],
  ).catch(() => []);
}

export async function insertCloseoutReview({
  signalId = null,
  tradeId = null,
  journalId = null,
  exchange,
  symbol,
  tradeMode = 'normal',
  closeoutType,
  closeoutReason = null,
  plannedRatio = null,
  executedRatio = null,
  plannedNotional = null,
  executedNotional = null,
  slippagePct = null,
  feeTotal = null,
  pnlRealized = null,
  pnlRemainingUnrealized = null,
  regime = null,
  setupType = null,
  strategyFamily = null,
  familyBias = null,
  autonomyPhase = null,
  reviewStatus = 'pending',
  reviewResult = {},
  policySuggestions = [],
  idempotencyKey = null,
}) {
  if (!exchange || !symbol || !closeoutType) return null;
  if (idempotencyKey) {
    const existing = await get(
      `SELECT id FROM position_closeout_reviews WHERE idempotency_key = $1`,
      [idempotencyKey],
    ).catch(() => null);
    if (existing) return existing.id;
  }
  const row = await get(
    `INSERT INTO position_closeout_reviews
       (signal_id, trade_id, journal_id, exchange, symbol, trade_mode,
        closeout_type, closeout_reason, planned_ratio, executed_ratio,
        planned_notional, executed_notional, slippage_pct, fee_total,
        pnl_realized, pnl_remaining_unrealized, regime, setup_type,
        strategy_family, family_bias, autonomy_phase, review_status, review_result,
        policy_suggestions, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     RETURNING id`,
    [
      signalId || null, tradeId || null, journalId || null,
      exchange, symbol, tradeMode || 'normal',
      closeoutType, closeoutReason || null,
      plannedRatio != null ? Number(plannedRatio) : null,
      executedRatio != null ? Number(executedRatio) : null,
      plannedNotional != null ? Number(plannedNotional) : null,
      executedNotional != null ? Number(executedNotional) : null,
      slippagePct != null ? Number(slippagePct) : null,
      feeTotal != null ? Number(feeTotal) : null,
      pnlRealized != null ? Number(pnlRealized) : null,
      pnlRemainingUnrealized != null ? Number(pnlRemainingUnrealized) : null,
      regime || null, setupType || null,
      strategyFamily || null, familyBias || null,
      autonomyPhase || resolveLunaAutonomyPhase(Date.now()),
      reviewStatus || 'pending',
      JSON.stringify(reviewResult ?? {}),
      JSON.stringify(policySuggestions ?? []),
      idempotencyKey || null,
    ],
  ).catch(() => null);
  return row?.id || null;
}

export async function updateCloseoutReview(id, {
  reviewStatus,
  reviewResult = null,
  policySuggestions = null,
  executedRatio = null,
  executedNotional = null,
  slippagePct = null,
  pnlRealized = null,
  journalId = null,
  tradeId = null,
} = {}) {
  if (!id) return null;
  const sets = ['reviewed_at = now()'];
  const params = [];
  let idx = 1;
  if (reviewStatus != null) { sets.push(`review_status = $${idx++}`); params.push(reviewStatus); }
  if (reviewResult != null) { sets.push(`review_result = $${idx++}`); params.push(JSON.stringify(reviewResult)); }
  if (policySuggestions != null) { sets.push(`policy_suggestions = $${idx++}`); params.push(JSON.stringify(policySuggestions)); }
  if (executedRatio != null) { sets.push(`executed_ratio = $${idx++}`); params.push(Number(executedRatio)); }
  if (executedNotional != null) { sets.push(`executed_notional = $${idx++}`); params.push(Number(executedNotional)); }
  if (slippagePct != null) { sets.push(`slippage_pct = $${idx++}`); params.push(Number(slippagePct)); }
  if (pnlRealized != null) { sets.push(`pnl_realized = $${idx++}`); params.push(Number(pnlRealized)); }
  if (journalId != null) { sets.push(`journal_id = $${idx++}`); params.push(String(journalId)); }
  if (tradeId != null) { sets.push(`trade_id = $${idx++}`); params.push(String(tradeId)); }
  params.push(id);
  return get(
    `UPDATE position_closeout_reviews SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, review_status`,
    params,
  ).catch(() => null);
}

export async function getRecentCloseoutReviews({ days = 30, symbol = null, exchange = null, limit = 100 } = {}) {
  const conds = [`created_at >= now() - ($1::int * INTERVAL '1 day')`];
  const params = [days];
  if (symbol) { conds.push(`symbol = $${params.length + 1}`); params.push(symbol); }
  if (exchange) { conds.push(`exchange = $${params.length + 1}`); params.push(exchange); }
  params.push(limit);
  return query(
    `SELECT * FROM position_closeout_reviews WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  ).catch(() => []);
}

export async function insertExternalEvidence({
  sourceType,
  sourceName = null,
  sourceUrl = null,
  symbol = null,
  market = null,
  strategyFamily = null,
  signalDirection = null,
  score = 0,
  sourceQuality = 0.5,
  freshnessScore = 1.0,
  evidenceSummary = null,
  rawRef = {},
}) {
  if (!sourceType) return null;
  const row = await get(
    `INSERT INTO external_evidence_events
       (source_type, source_name, source_url, symbol, market, strategy_family,
        signal_direction, score, source_quality, freshness_score, evidence_summary, raw_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      sourceType, sourceName || null, sourceUrl || null,
      symbol || null, market || null, strategyFamily || null,
      signalDirection || null,
      Number(score || 0), Number(sourceQuality || 0.5), Number(freshnessScore || 1.0),
      evidenceSummary || null, JSON.stringify(rawRef ?? {}),
    ],
  ).catch(() => null);
  return row?.id || null;
}

export async function getRecentExternalEvidence({ days = 7, symbol = null, sourceType = null, limit = 50 } = {}) {
  const conds = [`created_at >= now() - ($1::int * INTERVAL '1 day')`];
  const params = [days];
  if (symbol) { conds.push(`symbol = $${params.length + 1}`); params.push(symbol); }
  if (sourceType) { conds.push(`source_type = $${params.length + 1}`); params.push(sourceType); }
  params.push(limit);
  return query(
    `SELECT * FROM external_evidence_events WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  ).catch(() => []);
}

export async function insertPositionSignalHistory({
  positionScopeKey,
  exchange,
  symbol,
  tradeMode = 'normal',
  source = 'signal_refresh',
  eventType = 'signal_refresh',
  confidence = 0,
  sentimentScore = 0,
  evidenceSnapshot = {},
  qualityFlags = [],
} = {}) {
  if (!positionScopeKey || !exchange || !symbol) return null;
  const row = await get(
    `INSERT INTO position_signal_history
       (position_scope_key, exchange, symbol, trade_mode, source, event_type,
        confidence, sentiment_score, evidence_snapshot, quality_flags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, created_at`,
    [
      positionScopeKey,
      exchange,
      symbol,
      tradeMode || 'normal',
      source || 'signal_refresh',
      eventType || 'signal_refresh',
      Number(confidence || 0),
      Number(sentimentScore || 0),
      JSON.stringify(evidenceSnapshot || {}),
      JSON.stringify(Array.isArray(qualityFlags) ? qualityFlags : []),
    ],
  ).catch(() => null);
  return row || null;
}

export async function getRecentPositionSignalHistory({
  symbol = null,
  exchange = null,
  positionScopeKey = null,
  source = null,
  limit = 50,
} = {}) {
  const conditions = ['1=1'];
  const params = [];
  if (symbol) {
    params.push(symbol);
    conditions.push(`symbol = $${params.length}`);
  }
  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (positionScopeKey) {
    params.push(positionScopeKey);
    conditions.push(`position_scope_key = $${params.length}`);
  }
  if (source) {
    params.push(source);
    conditions.push(`source = $${params.length}`);
  }
  params.push(Math.max(1, Number(limit || 50)));
  return query(
    `SELECT *
     FROM position_signal_history
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  ).catch(() => []);
}
