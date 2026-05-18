#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { get, query, run } from '../shared/db/core.ts';
import { insertEntryTrigger } from '../shared/luna-discovery-entry-store.ts';
import { ensureLunaPromotionEntryTriggerBridgeSchema } from '../shared/luna-promotion-entry-trigger-bridge.ts';
import {
  BINANCE_TOP_VOLUME_BLOCK_REASON,
  buildFixtureBinanceTopVolumeUniverse,
  evaluateBinanceTopVolumeUniverseGate,
  fetchBinanceTopVolumeUniverse,
  normalizeBinanceUsdtSymbol,
} from '../shared/binance-top-volume-universe.ts';

export const LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_CONFIRM = 'luna-promotion-entry-trigger-materialize-active';
export const LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_PHASE = 'luna_promotion_entry_trigger_materialize';

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const apply = hasFlag('apply', argv);
  return {
    json: hasFlag('json', argv),
    strict: hasFlag('strict', argv),
    apply,
    dryRun: hasFlag('dry-run', argv) || !apply,
    fixture: hasFlag('fixture', argv),
    confirm: String(argValue('confirm', '', argv) || ''),
    market: String(argValue('market', 'crypto', argv) || 'crypto').trim().toLowerCase(),
    exchange: String(argValue('exchange', 'binance', argv) || 'binance').trim().toLowerCase(),
    symbols: String(argValue('symbols', '', argv) || ''),
    hours: Math.max(1, Number(argValue('hours', 168, argv)) || 168),
    limit: Math.max(1, Number(argValue('limit', 100, argv)) || 100),
    ttlMinutes: Math.max(30, Number(argValue('ttl-minutes', process.env.LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_TTL_MINUTES || 180)) || 180),
  };
}

function normalizeSymbol(value = '') {
  const canonical = normalizeBinanceUsdtSymbol(value);
  return canonical || String(value || '').trim().toUpperCase();
}

function top30GateForBridgeRow(row = {}, universe = {}) {
  const market = String(row.market || 'crypto').trim().toLowerCase();
  const exchange = String(row.exchange || 'binance').trim().toLowerCase();
  const symbol = normalizeSymbol(row.symbol);
  if (market !== 'crypto' || exchange !== 'binance') {
    return {
      ok: true,
      blocked: false,
      applies: false,
      reason: 'non_crypto_binance_top30_not_applicable',
      code: 'non_crypto_binance_top30_not_applicable',
      symbol,
      canonicalSymbol: symbol,
      rank: null,
      limit: universe?.limit || 30,
      source: universe?.source || 'binance_top30_not_applicable',
      fetchedAt: universe?.fetchedAt || null,
    };
  }
  return {
    ...evaluateBinanceTopVolumeUniverseGate(symbol, universe),
    applies: true,
  };
}

function splitSymbols(value = '') {
  return [...new Set(String(value || '')
    .split(',')
    .map((item) => normalizeSymbol(item))
    .filter(Boolean))];
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function clamp01(value, fallback = 0.5) {
  const parsed = num(value, fallback);
  return Math.max(0, Math.min(1, parsed));
}

function isoPlusMinutes(now, minutes) {
  const base = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const safeBase = Number.isFinite(base) ? base : Date.now();
  return new Date(safeBase + Math.max(30, Number(minutes || 180)) * 60_000).toISOString();
}

function fixtureBridgeRows(now = new Date()) {
  return [
    {
      id: 'promotion-entry-trigger-bridge:crypto:binance:BTC_USDT',
      symbol: 'BTC/USDT',
      market: 'crypto',
      exchange: 'binance',
      bridge_status: 'shadow_bridge_pending_approval',
      gap_reason: 'promotion_ready_active_entry_trigger_missing',
      promotion_observed_at: now.toISOString(),
      promotion_confidence: 0.78,
      cycle_count: 8,
      pass_count: 7,
      consecutive_passes: 5,
      trigger_type: 'mtf_alignment',
      proposed_trigger_state: 'armed',
      ttl_minutes: 180,
      trigger_payload: {
        setupType: 'promotion_ready_shadow',
        triggerType: 'mtf_alignment',
        confidence: 0.78,
        predictiveScore: 0.74,
        triggerContext: { source: 'fixture_promotion_gate' },
        triggerMeta: { source: 'fixture_bridge_shadow' },
      },
      coverage_snapshot: { activeTriggerCount: 0 },
      approval_required: 'explicit_master_live_promotion_approval',
    },
  ];
}

async function loadPendingBridgeRows(options = {}) {
  if (options.fixture) return fixtureBridgeRows(options.now || new Date());
  await ensureLunaPromotionEntryTriggerBridgeSchema();
  const symbols = splitSymbols(options.symbols);
  const conditions = [
    `bridge_status = 'shadow_bridge_pending_approval'`,
    `COALESCE(shadow_only, true) IS TRUE`,
    `COALESCE(live_mutation, false) IS FALSE`,
    `COALESCE(entry_trigger_db_mutation, false) IS FALSE`,
    `updated_at >= now() - ($1::int * interval '1 hour')`,
  ];
  const params = [Math.max(1, Number(options.hours || 168))];
  if (options.market && options.market !== 'all') {
    params.push(String(options.market).toLowerCase());
    conditions.push(`market = $${params.length}`);
  }
  if (options.exchange && options.exchange !== 'all') {
    params.push(String(options.exchange).toLowerCase());
    conditions.push(`exchange = $${params.length}`);
  }
  if (symbols.length > 0) {
    params.push(symbols);
    conditions.push(`symbol = ANY($${params.length})`);
  }
  params.push(Math.max(1, Number(options.limit || 100)));
  return query(`
    SELECT *
      FROM luna_promotion_entry_trigger_bridge_shadow
     WHERE ${conditions.join(' AND ')}
     ORDER BY promotion_confidence DESC NULLS LAST, updated_at DESC
     LIMIT $${params.length}
  `, params).catch(() => []);
}

async function loadActiveEntryTrigger({ symbol, exchange, triggerType } = {}) {
  if (!symbol || !exchange || !triggerType) return null;
  return get(`
    SELECT *
      FROM entry_triggers
     WHERE symbol = $1
       AND exchange = $2
       AND trigger_type = $3
       AND trigger_state IN ('armed', 'waiting')
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1
  `, [symbol, exchange, triggerType]).catch(() => null);
}

async function markBridgeMaterialized({ bridgeId, entryTriggerId, materializedAt, materializedPayload } = {}) {
  if (!bridgeId || !entryTriggerId) return null;
  return run(`
    UPDATE luna_promotion_entry_trigger_bridge_shadow
       SET bridge_status = 'active_entry_trigger_materialized',
           entry_trigger_db_mutation = true,
           live_mutation = false,
           shadow_only = true,
           trigger_payload = COALESCE(trigger_payload, '{}'::jsonb) || $2::jsonb,
           coverage_snapshot = COALESCE(coverage_snapshot, '{}'::jsonb) || $3::jsonb,
           updated_at = now()
     WHERE id = $1
  `, [
    bridgeId,
    JSON.stringify({
      materializedEntryTriggerId: entryTriggerId,
      materializedAt,
      materializedBy: LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_PHASE,
    }),
    JSON.stringify({
      activeEntryTriggerMaterialized: true,
      materializedPayload,
    }),
  ]);
}

function buildEntryTrigger(row = {}, gate = {}, options = {}) {
  const payload = parseJson(row.trigger_payload, {});
  const context = parseJson(payload.triggerContext, payload.triggerContext || {});
  const meta = parseJson(payload.triggerMeta, payload.triggerMeta || {});
  const coverage = parseJson(row.coverage_snapshot, {});
  const triggerType = row.trigger_type || payload.triggerType || 'mtf_alignment';
  const triggerState = row.proposed_trigger_state || payload.proposedTriggerState || 'armed';
  const ttlMinutes = Math.max(30, num(row.ttl_minutes, options.ttlMinutes || 180));
  const materializedAt = (options.now || new Date()).toISOString();
  const predictiveScore = payload.predictiveScore ?? meta.latestTrigger?.predictiveScore ?? coverage.latestTrigger?.predictiveScore ?? null;
  return {
    symbol: normalizeSymbol(row.symbol),
    exchange: String(row.exchange || options.exchange || 'binance').trim().toLowerCase(),
    setupType: payload.setupType || 'promotion_ready_shadow',
    triggerType,
    triggerState,
    confidence: clamp01(row.promotion_confidence ?? payload.confidence, 0.5),
    targetPrice: payload.targetPrice ?? null,
    stopLoss: payload.stopLoss ?? null,
    takeProfit: payload.takeProfit ?? null,
    waitingFor: payload.waitingFor === 'explicit_master_live_promotion_approval'
      ? 'luna_entry_trigger_fire_conditions'
      : (payload.waitingFor || 'luna_entry_trigger_fire_conditions'),
    predictiveScore: predictiveScore == null ? null : num(predictiveScore, null),
    expiresAt: isoPlusMinutes(options.now || new Date(), ttlMinutes),
    triggerContext: {
      ...context,
      phase: LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_PHASE,
      source: 'promotion_entry_trigger_materialize',
      materializedFromBridgeId: row.id || null,
      promotionObservedAt: row.promotion_observed_at || null,
      promotionCycleCount: num(row.cycle_count, 0),
      promotionPassCount: num(row.pass_count, 0),
      promotionConsecutivePasses: num(row.consecutive_passes, 0),
      bridgeGapReason: row.gap_reason || null,
    },
    triggerMeta: {
      ...meta,
      phase: LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_PHASE,
      source: 'promotion_entry_trigger_materialize',
      requiredApproval: 'explicit_master_live_promotion_approval_for_active_entry_trigger_materialization',
      approvalConfirmToken: LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_CONFIRM,
      liveMutation: false,
      entryTriggerDbMutation: true,
      protectedPidMutation: false,
      binanceTop30Gate: gate,
      materializedAt,
    },
  };
}

function summarizeItems(items = []) {
  return items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
}

export async function runLunaPromotionEntryTriggerMaterialize(options = parseArgs(), deps = {}) {
  if (options.apply && options.dryRun) {
    return {
      ok: false,
      status: 'luna_promotion_entry_trigger_materialize_apply_conflict',
      phase: LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_PHASE,
      dryRun: true,
      apply: true,
      liveMutation: false,
      entryTriggerDbMutation: false,
      blockers: [{ type: 'safety', name: 'apply_dry_run_conflict', detail: 'Do not combine --apply and --dry-run.' }],
    };
  }
  if (options.apply && options.confirm !== LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_CONFIRM) {
    return {
      ok: false,
      status: 'luna_promotion_entry_trigger_materialize_apply_blocked',
      phase: LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_PHASE,
      dryRun: false,
      apply: true,
      liveMutation: false,
      entryTriggerDbMutation: false,
      requiredConfirm: LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_CONFIRM,
      blockers: [{
        type: 'safety',
        name: 'confirm_required',
        detail: `Active entry-trigger materialization requires --confirm=${LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_CONFIRM}.`,
      }],
    };
  }

  const now = deps.now || new Date();
  const universe = deps.universe
    || (deps.fetchUniverse
      ? await deps.fetchUniverse(options)
      : options.fixture
        ? buildFixtureBinanceTopVolumeUniverse({ limit: 30 })
        : await fetchBinanceTopVolumeUniverse({ limit: 30, quote: 'USDT' }));
  const bridgeRows = deps.bridgeRows
    || (deps.loadPendingBridgeRows
      ? await deps.loadPendingBridgeRows(options)
      : await loadPendingBridgeRows({ ...options, now }));

  const items = [];
  let materialized = 0;
  let alreadyActive = 0;
  let blocked = 0;

  for (const row of bridgeRows || []) {
    const symbol = normalizeSymbol(row.symbol);
    const exchange = String(row.exchange || options.exchange || 'binance').trim().toLowerCase();
    const gate = top30GateForBridgeRow({ ...row, symbol, exchange }, universe);
    const trigger = buildEntryTrigger({ ...row, symbol, exchange }, gate, { ...options, now });
    const item = {
      bridgeId: row.id || null,
      symbol,
      market: String(row.market || options.market || 'crypto').trim().toLowerCase(),
      exchange,
      triggerType: trigger.triggerType,
      proposedTriggerState: trigger.triggerState,
      confidence: trigger.confidence,
      predictiveScore: trigger.predictiveScore,
      expiresAt: trigger.expiresAt,
      binanceTop30Rank: gate.rank,
      binanceTop30Applicable: gate.applies === true,
      inBinanceTop30Universe: gate.ok,
      top30Blocker: gate.blocked ? BINANCE_TOP_VOLUME_BLOCK_REASON : null,
      liveMutation: false,
      entryTriggerDbMutation: false,
      protectedPidMutation: false,
      status: 'eligible_dry_run',
      entryTriggerId: null,
      blockers: [],
      triggerPreview: trigger,
    };

    if (!gate.ok) {
      blocked += 1;
      item.status = 'blocked_outside_binance_top30_volume_universe';
      item.blockers.push({ name: BINANCE_TOP_VOLUME_BLOCK_REASON, detail: `${symbol} is outside Binance Spot USDT Top30 universe.` });
      items.push(item);
      continue;
    }

    const active = deps.loadActiveEntryTrigger
      ? await deps.loadActiveEntryTrigger({ symbol, exchange, triggerType: trigger.triggerType })
      : await loadActiveEntryTrigger({ symbol, exchange, triggerType: trigger.triggerType });
    if (active?.id) {
      alreadyActive += 1;
      item.status = 'already_active_entry_trigger';
      item.entryTriggerId = active.id;
      item.entryTriggerDbMutation = false;
      items.push(item);
      continue;
    }

    if (options.apply) {
      const inserted = deps.insertEntryTrigger
        ? await deps.insertEntryTrigger(trigger)
        : await insertEntryTrigger(trigger);
      if (inserted?.id) {
        materialized += 1;
        item.status = 'active_entry_trigger_materialized';
        item.entryTriggerId = inserted.id;
        item.entryTriggerDbMutation = true;
        const materializedAt = now.toISOString();
        if (deps.markBridgeMaterialized) {
          await deps.markBridgeMaterialized({ bridgeId: item.bridgeId, entryTriggerId: inserted.id, materializedAt, materializedPayload: trigger });
        } else {
          await markBridgeMaterialized({ bridgeId: item.bridgeId, entryTriggerId: inserted.id, materializedAt, materializedPayload: trigger });
        }
      } else {
        blocked += 1;
        item.status = 'entry_trigger_insert_failed';
        item.blockers.push({ name: 'entry_trigger_insert_failed', detail: `${symbol} active entry trigger insert returned no row.` });
      }
    }

    items.push(item);
  }

  const eligible = items.filter((item) => item.status === 'eligible_dry_run').length;
  const blockers = items.flatMap((item) => item.blockers.map((blocker) => ({
    type: 'promotion_entry_trigger_materialize',
    symbol: item.symbol,
    ...blocker,
  })));
  const status = bridgeRows.length === 0
    ? 'luna_promotion_entry_trigger_materialize_no_targets'
    : options.apply
      ? materialized > 0 && blocked > 0
        ? 'luna_promotion_entry_trigger_materialize_partial'
        : materialized > 0
        ? 'luna_promotion_entry_trigger_materialize_written'
        : blocked > 0
          ? 'luna_promotion_entry_trigger_materialize_blocked'
          : 'luna_promotion_entry_trigger_materialize_noop'
      : blocked > 0
        ? 'luna_promotion_entry_trigger_materialize_plan_attention'
        : 'luna_promotion_entry_trigger_materialize_planned';

  return {
    ok: options.apply ? blockers.length === 0 : true,
    status,
    phase: LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_PHASE,
    checkedAt: now.toISOString(),
    dryRun: options.dryRun,
    apply: options.apply,
    fixture: options.fixture === true,
    confirmToken: LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_CONFIRM,
    requiredApproval: 'explicit_master_live_promotion_approval_for_active_entry_trigger_materialization',
    liveMutation: false,
    entryTriggerDbMutation: options.apply && materialized > 0,
    protectedPidMutation: false,
    summary: {
      pendingBridgeRows: bridgeRows.length,
      eligibleDryRun: eligible,
      materialized,
      alreadyActive,
      blocked,
      byStatus: summarizeItems(items),
      liveMutation: false,
      entryTriggerDbMutation: options.apply && materialized > 0,
    },
    universe: {
      source: universe.source,
      fetchedAt: universe.fetchedAt,
      limit: universe.limit,
      quote: universe.quote,
    },
    items,
    blockers,
    safety: {
      liveOrderExecuted: false,
      liveMutation: false,
      protectedProcessTouched: false,
      secretMutation: false,
    },
    nextAction: options.apply
      ? 'monitor_materialized_entry_trigger_fire_conditions'
      : `If approved, rerun with --apply --confirm=${LUNA_PROMOTION_ENTRY_TRIGGER_MATERIALIZE_CONFIRM}.`,
  };
}

async function main() {
  const options = parseArgs();
  const report = await runLunaPromotionEntryTriggerMaterialize(options);
  if (options.strict && !report.ok) process.exitCode = 1;
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.status} pending=${report.summary.pendingBridgeRows} materialized=${report.summary.materialized} blocked=${report.summary.blocked}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'runtime-luna-promotion-entry-trigger-materialize error:',
  });
}

export default { runLunaPromotionEntryTriggerMaterialize };
