// @ts-nocheck

const ENABLED_VALUES = new Set(['1', 'true', 'on', 'enabled']);

export function isGuardSizingAuthorityEnabled(env = process.env) {
  return ENABLED_VALUES.has(String(env?.LUNA_GUARD_SIZING_AUTHORITY || '').trim().toLowerCase());
}

function normalizeGuardCap(cap, index) {
  const source = String(cap?.source || `guard_${index + 1}`).trim() || `guard_${index + 1}`;
  const referenceAmountUsdt = Number(cap?.referenceAmountUsdt);
  const multiplier = Number(cap?.multiplier);
  const capAmountUsdt = Number(cap?.capAmountUsdt);
  const valid = Number.isFinite(referenceAmountUsdt)
    && referenceAmountUsdt >= 0
    && Number.isFinite(multiplier)
    && multiplier >= 0
    && multiplier <= 1
    && Number.isFinite(capAmountUsdt)
    && capAmountUsdt >= 0
    && capAmountUsdt <= referenceAmountUsdt;
  return {
    source,
    referenceAmountUsdt,
    multiplier,
    capAmountUsdt,
    blockers: Array.isArray(cap?.blockers) ? cap.blockers : [],
    valid,
  };
}

export function resolveGuardSizingAuthority(input = {}, env = process.env) {
  const enabled = isGuardSizingAuthorityEnabled(env);
  const downstreamAmountUsdt = Number(input.downstreamAmountUsdt);
  const minOrderUsdt = Number(input.minOrderUsdt || 0);
  const normalizedCaps = (Array.isArray(input.guardCaps) ? input.guardCaps : [])
    .map(normalizeGuardCap);
  const invalidCaps = normalizedCaps.filter((cap) => !cap.valid);
  const activeCaps = normalizedCaps.filter((cap) => cap.valid && cap.multiplier < 1);
  const winningCap = activeCaps.reduce((winner, cap) => (
    !winner || cap.capAmountUsdt < winner.capAmountUsdt ? cap : winner
  ), null);
  const authoritativeCapUsdt = invalidCaps.length > 0
    ? 0
    : winningCap?.capAmountUsdt ?? null;
  const counterfactualAmountUsdt = authoritativeCapUsdt == null
    ? downstreamAmountUsdt
    : Math.min(downstreamAmountUsdt, authoritativeCapUsdt);
  const appliedAmountUsdt = enabled ? counterfactualAmountUsdt : downstreamAmountUsdt;

  return {
    enabled,
    combineRule: 'minimum_absolute_cap',
    downstreamAmountUsdt,
    minOrderUsdt,
    guardCaps: normalizedCaps,
    invalidCaps,
    winningCap,
    authoritativeCapUsdt,
    counterfactualAmountUsdt,
    appliedAmountUsdt,
    wouldReduce: counterfactualAmountUsdt < downstreamAmountUsdt,
    applied: enabled && counterfactualAmountUsdt < downstreamAmountUsdt,
    wouldRejectBelowMinimum: counterfactualAmountUsdt < minOrderUsdt,
  };
}
