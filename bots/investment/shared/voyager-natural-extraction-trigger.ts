// @ts-nocheck
/**
 * Voyager natural skill extraction trigger.
 *
 * Default contract:
 * - enabled for observation, but dry-run by default.
 * - production skill writes require dryRun=false and explicit env
 *   LUNA_VOYAGER_NATURAL_EXTRACTION_APPLY=true.
 */

import { extractPosttradeSkills } from './posttrade-skill-extractor.ts';

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(raw);
}

export function isVoyagerNaturalExtractionEnabled() {
  return boolEnv('LUNA_VOYAGER_NATURAL_EXTRACTION_ENABLED', true);
}

export function isVoyagerNaturalExtractionApplyAllowed() {
  return boolEnv('LUNA_VOYAGER_NATURAL_EXTRACTION_APPLY', false);
}

export function getVoyagerNaturalMinTradeCount() {
  return Math.max(1, Number(process.env.LUNA_VOYAGER_MIN_TRADE_COUNT || 3) || 3);
}

export function buildVoyagerNaturalExtractionPlan({
  closedTradeCount = 0,
  minTradeCount = getVoyagerNaturalMinTradeCount(),
  market = 'all',
  dryRun = true,
} = {}) {
  const ready = Number(closedTradeCount || 0) >= Number(minTradeCount || 0);
  return {
    ok: true,
    enabled: isVoyagerNaturalExtractionEnabled(),
    dryRun,
    status: ready ? 'ready_for_natural_extraction' : 'pending_closed_trade_accumulation',
    market,
    closedTradeCount: Number(closedTradeCount || 0),
    minTradeCount,
    ready,
    productionSkillPromoted: false,
    reason: ready
      ? 'closed trade count satisfies natural extraction threshold'
      : `closed trade count ${closedTradeCount}/${minTradeCount}`,
  };
}

export async function onTradeClosedForVoyager(trade = {}, opts = {}) {
  const closedTradeCount = Number(opts.closedTradeCount ?? trade.closedTradeCount ?? 1);
  const dryRun = opts.dryRun !== false;
  const plan = buildVoyagerNaturalExtractionPlan({
    closedTradeCount,
    minTradeCount: opts.minTradeCount ?? getVoyagerNaturalMinTradeCount(),
    market: opts.market || trade.market || trade.exchange || 'all',
    dryRun,
  });
  if (!plan.enabled) return { ...plan, status: 'disabled', extraction: null };
  if (!plan.ready) return { ...plan, extraction: null };
  if (!dryRun && !isVoyagerNaturalExtractionApplyAllowed() && opts.forceApply !== true) {
    return {
      ...plan,
      status: 'apply_blocked',
      extraction: null,
      blockers: ['LUNA_VOYAGER_NATURAL_EXTRACTION_APPLY is not true'],
    };
  }
  const extractFn = opts.extractFn || extractPosttradeSkills;
  const extraction = await extractFn({
    days: opts.days || 90,
    market: plan.market,
    dryRun,
  });
  return {
    ...plan,
    status: dryRun ? 'dry_run_extraction_ready' : 'extraction_applied',
    extraction,
    productionSkillPromoted: dryRun ? false : Number(extraction?.extracted || 0) > 0,
  };
}

export default {
  isVoyagerNaturalExtractionEnabled,
  isVoyagerNaturalExtractionApplyAllowed,
  getVoyagerNaturalMinTradeCount,
  buildVoyagerNaturalExtractionPlan,
  onTradeClosedForVoyager,
};
