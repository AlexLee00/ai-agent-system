// @ts-nocheck

import { run } from './db/core.ts';

export const LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_CONFIRM = 'luna-promotion-entry-trigger-bridge-shadow';
export const LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_PHASE = 'luna_promotion_entry_trigger_shadow_bridge';

function normalizeSymbol(value = '') {
  return String(value || '').trim().toUpperCase();
}

function normalizeMarket(value = 'crypto') {
  return String(value || 'crypto').trim().toLowerCase();
}

function normalizeExchange(value = 'binance') {
  return String(value || 'binance').trim().toLowerCase();
}

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function iso(value = null) {
  const parsed = value ? Date.parse(String(value)) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function json(value, fallback = {}) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function bridgeIdFor(row = {}) {
  const symbol = normalizeSymbol(row.symbol).replace(/[^A-Z0-9]/g, '_');
  const market = normalizeMarket(row.market).replace(/[^a-z0-9]/g, '_');
  const exchange = normalizeExchange(row.exchange).replace(/[^a-z0-9]/g, '_');
  return `promotion-entry-trigger-bridge:${market}:${exchange}:${symbol}`;
}

export async function ensureLunaPromotionEntryTriggerBridgeSchema() {
  await run(`
    CREATE TABLE IF NOT EXISTS luna_promotion_entry_trigger_bridge_shadow (
      id                         TEXT PRIMARY KEY,
      symbol                     TEXT NOT NULL,
      market                     TEXT NOT NULL,
      exchange                   TEXT NOT NULL,
      bridge_status              TEXT NOT NULL,
      gap_reason                 TEXT,
      promotion_observed_at      TIMESTAMPTZ,
      promotion_confidence       DOUBLE PRECISION DEFAULT 0,
      cycle_count                INTEGER DEFAULT 0,
      pass_count                 INTEGER DEFAULT 0,
      consecutive_passes         INTEGER DEFAULT 0,
      trigger_type               TEXT NOT NULL,
      proposed_trigger_state     TEXT NOT NULL,
      ttl_minutes                INTEGER DEFAULT 180,
      trigger_payload            JSONB DEFAULT '{}'::jsonb,
      coverage_snapshot          JSONB DEFAULT '{}'::jsonb,
      approval_required          TEXT NOT NULL,
      shadow_only                BOOLEAN DEFAULT true,
      live_mutation              BOOLEAN DEFAULT false,
      entry_trigger_db_mutation  BOOLEAN DEFAULT false,
      created_at                 TIMESTAMPTZ DEFAULT now(),
      updated_at                 TIMESTAMPTZ DEFAULT now()
    )
  `);
  await run(`
    CREATE INDEX IF NOT EXISTS idx_luna_promotion_entry_trigger_bridge_scope
      ON luna_promotion_entry_trigger_bridge_shadow(symbol, market, exchange, updated_at DESC)
  `).catch(() => {});
  await run(`
    CREATE INDEX IF NOT EXISTS idx_luna_promotion_entry_trigger_bridge_status
      ON luna_promotion_entry_trigger_bridge_shadow(bridge_status, updated_at DESC)
  `).catch(() => {});
}

function triggerPayloadFor(row = {}, options = {}) {
  const ttlMinutes = Math.max(30, n(options.ttlMinutes ?? process.env.LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_TTL_MINUTES, 180));
  const latestTrigger = row.latestTrigger || {};
  const confidence = n(row.avgConfidence ?? row.avg_confidence, 0);
  const cycleCount = n(row.cycleCount ?? row.cycle_count, 0);
  const passCount = n(row.passCount ?? row.pass_count, 0);
  const consecutivePasses = n(row.consecutivePasses ?? row.consecutive_passes, 0);
  return {
    symbol: normalizeSymbol(row.symbol),
    market: normalizeMarket(row.market),
    exchange: normalizeExchange(row.exchange),
    setupType: 'promotion_ready_shadow',
    triggerType: 'mtf_alignment',
    proposedTriggerState: 'armed',
    waitingFor: 'luna_entry_trigger_fire_conditions',
    confidence,
    predictiveScore: latestTrigger.predictiveScore == null ? null : n(latestTrigger.predictiveScore, null),
    expiresInMinutes: ttlMinutes,
    triggerContext: {
      phase: LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_PHASE,
      source: 'paper_promotion_gate_shadow',
      bridgeShadowOnly: true,
      hints: {
        promotionReady: true,
        promotionConfidence: confidence,
        promotionCycleCount: cycleCount,
        promotionPassCount: passCount,
        promotionConsecutivePasses: consecutivePasses,
        promotionObservedAt: row.observedAt || row.observed_at || null,
        discoveryScore: Math.max(confidence, n(latestTrigger.discoveryScore, 0)),
      },
      promotion: {
        decision: row.promotionDecision || row.decision || null,
        observedAt: row.observedAt || row.observed_at || null,
        cycleCount,
        passCount,
        consecutivePasses,
        avgConfidence: confidence,
      },
    },
    triggerMeta: {
      phase: LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_PHASE,
      source: 'promotion_entry_trigger_bridge_shadow',
      liveMutationAllowed: false,
      entryTriggerDbMutationAllowed: true,
      requiredApproval: 'autonomous_shadow_entry_trigger_materialization_confirm_token',
      latestTrigger,
    },
  };
}

export function buildPromotionEntryTriggerBridgePlan(coverageReport = {}, options = {}) {
  const rows = Array.isArray(coverageReport.rows) ? coverageReport.rows : [];
  const missing = rows.filter((row) => row.promotionCandidate === true && Number(row.activeTriggerCount || 0) === 0);
  const ttlMinutes = Math.max(30, n(options.ttlMinutes ?? process.env.LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_TTL_MINUTES, 180));
  const items = missing.map((row) => {
    const payload = triggerPayloadFor(row, { ttlMinutes });
    return {
      id: bridgeIdFor(row),
      symbol: normalizeSymbol(row.symbol),
      market: normalizeMarket(row.market),
      exchange: normalizeExchange(row.exchange),
      bridgeStatus: 'shadow_bridge_pending_approval',
      gapReason: row.gapReason || 'promotion_ready_active_entry_trigger_missing',
      promotionObservedAt: iso(row.observedAt || row.observed_at),
      promotionConfidence: n(row.avgConfidence ?? row.avg_confidence, 0),
      cycleCount: n(row.cycleCount ?? row.cycle_count, 0),
      passCount: n(row.passCount ?? row.pass_count, 0),
      consecutivePasses: n(row.consecutivePasses ?? row.consecutive_passes, 0),
      triggerType: payload.triggerType,
      proposedTriggerState: payload.proposedTriggerState,
      ttlMinutes,
      triggerPayload: payload,
      coverageSnapshot: row,
      approvalRequired: 'autonomous_shadow_entry_trigger_materialization_confirm_token',
      shadowOnly: true,
      liveMutation: false,
      entryTriggerDbMutation: false,
      recommendedCommands: [
        `npm --prefix bots/investment run -s runtime:luna-promotion-entry-trigger-coverage -- --json --dry-run --market=${normalizeMarket(row.market)} --exchange=${normalizeExchange(row.exchange)} --hours=${coverageReport.hours || 168}`,
        `npm --prefix bots/investment run -s runtime:luna-entry-trigger-diagnose -- --json --symbols=${normalizeSymbol(row.symbol)}`,
        `npm --prefix bots/investment run -s runtime:luna-promotion-entry-trigger-materialize -- --json --dry-run --market=${normalizeMarket(row.market)} --exchange=${normalizeExchange(row.exchange)} --hours=${coverageReport.hours || 168} --symbols=${normalizeSymbol(row.symbol)}`,
        'Shadow-only active entry_triggers may be materialized with the materialize confirm token; live order paths remain separately gated.',
      ],
    };
  });

  return {
    ok: items.length === 0,
    status: items.length === 0
      ? 'luna_promotion_entry_trigger_bridge_clear'
      : 'luna_promotion_entry_trigger_bridge_pending_approval',
    phase: LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_PHASE,
    shadowMode: true,
    liveMutation: false,
    entryTriggerDbMutation: false,
    protectedPidMutation: false,
    requiredApproval: 'autonomous_shadow_entry_trigger_materialization_confirm_token',
    checkedAt: coverageReport.checkedAt || new Date().toISOString(),
    coverageStatus: coverageReport.status || null,
    coverageSummary: coverageReport.summary || null,
    summary: {
      promotionCandidates: n(coverageReport.summary?.promotionCandidates, rows.length),
      missingActiveTrigger: items.length,
      bridgePlanItems: items.length,
      shadowDbMutationOnly: true,
      liveMutation: false,
      entryTriggerDbMutation: false,
    },
    items,
    blockers: items.map((item) => ({
      type: 'entry_trigger_bridge',
      symbol: item.symbol,
      name: item.gapReason,
      detail: `${item.symbol} is staged for master-approved entry-trigger materialization; no active entry trigger was inserted.`,
    })),
    nextAction: items.length > 0
      ? 'autonomous_shadow_entry_trigger_materialization_pending'
      : 'continue_entry_trigger_fire_readiness_monitoring',
  };
}

export async function upsertPromotionEntryTriggerBridgeShadowItem(item = {}) {
  await ensureLunaPromotionEntryTriggerBridgeSchema();
  return run(`
    INSERT INTO luna_promotion_entry_trigger_bridge_shadow
      (id, symbol, market, exchange, bridge_status, gap_reason, promotion_observed_at,
       promotion_confidence, cycle_count, pass_count, consecutive_passes,
       trigger_type, proposed_trigger_state, ttl_minutes, trigger_payload,
       coverage_snapshot, approval_required, shadow_only, live_mutation,
       entry_trigger_db_mutation, updated_at)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,true,false,false,now())
    ON CONFLICT (id) DO UPDATE SET
      bridge_status = EXCLUDED.bridge_status,
      gap_reason = EXCLUDED.gap_reason,
      promotion_observed_at = EXCLUDED.promotion_observed_at,
      promotion_confidence = EXCLUDED.promotion_confidence,
      cycle_count = EXCLUDED.cycle_count,
      pass_count = EXCLUDED.pass_count,
      consecutive_passes = EXCLUDED.consecutive_passes,
      trigger_type = EXCLUDED.trigger_type,
      proposed_trigger_state = EXCLUDED.proposed_trigger_state,
      ttl_minutes = EXCLUDED.ttl_minutes,
      trigger_payload = EXCLUDED.trigger_payload,
      coverage_snapshot = EXCLUDED.coverage_snapshot,
      approval_required = EXCLUDED.approval_required,
      shadow_only = true,
      live_mutation = false,
      entry_trigger_db_mutation = false,
      updated_at = now()
  `, [
    item.id,
    item.symbol,
    item.market,
    item.exchange,
    item.bridgeStatus,
    item.gapReason,
    item.promotionObservedAt,
    item.promotionConfidence,
    item.cycleCount,
    item.passCount,
    item.consecutivePasses,
    item.triggerType,
    item.proposedTriggerState,
    item.ttlMinutes,
    json(item.triggerPayload, {}),
    json(item.coverageSnapshot, {}),
    item.approvalRequired,
  ]);
}

export async function writePromotionEntryTriggerBridgeShadow(plan = {}) {
  await ensureLunaPromotionEntryTriggerBridgeSchema();
  let written = 0;
  for (const item of plan.items || []) {
    await upsertPromotionEntryTriggerBridgeShadowItem(item);
    written += 1;
  }
  return {
    ok: true,
    written,
    shadowDbMutation: written > 0,
    liveMutation: false,
    entryTriggerDbMutation: false,
  };
}

export default {
  LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_CONFIRM,
  LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_PHASE,
  buildPromotionEntryTriggerBridgePlan,
  ensureLunaPromotionEntryTriggerBridgeSchema,
  upsertPromotionEntryTriggerBridgeShadowItem,
  writePromotionEntryTriggerBridgeShadow,
};
