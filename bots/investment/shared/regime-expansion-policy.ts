// @ts-nocheck

const EIGHT_WAY_ALIASES = {
  low_volatility_bull: { baseRegime: 'trending_bull', volatility: 'low', direction: 'bull' },
  low_volatility_bear: { baseRegime: 'trending_bear', volatility: 'low', direction: 'bear' },
  high_volatility_bull: { baseRegime: 'trending_bull', volatility: 'high', direction: 'bull' },
  high_volatility_bear: { baseRegime: 'trending_bear', volatility: 'high', direction: 'bear' },
};

function isEightWayEnabled(options = {}) {
  if (typeof options.enabled === 'boolean') return options.enabled;
  return String(process.env.LUNA_REGIME_8WAY_ENABLED || '').trim().toLowerCase() === 'true';
}

export function resolveRegimeExpansionPolicy(regime = 'ranging', options = {}) {
  const normalizedRegime = String(regime || 'ranging').trim().toLowerCase() || 'ranging';
  const alias = EIGHT_WAY_ALIASES[normalizedRegime] || null;
  const enabled = isEightWayEnabled(options);
  if (!alias) {
    return {
      enabled,
      inputRegime: normalizedRegime,
      baseRegime: normalizedRegime,
      extension: null,
    };
  }
  return {
    enabled,
    inputRegime: normalizedRegime,
    baseRegime: alias.baseRegime,
    extension: enabled ? {
      volatility: alias.volatility,
      direction: alias.direction,
    } : null,
  };
}

export function applyRegimeExpansionAdjustment(policy = {}, expansion = null, market = 'crypto') {
  if (!expansion?.enabled || !expansion.extension) return policy;
  const next = { ...policy };
  const volatility = expansion.extension.volatility;
  if (volatility === 'high') {
    next.stopLossPct *= 0.9;
    next.partialExitRatioBias += 0.08;
    next.positionSizeMultiplier *= 0.85;
    next.cadenceMs = Math.min(Number(next.cadenceMs || 15_000), market === 'crypto' ? 10_000 : 12_000);
    next.monitorProfile = `${next.monitorProfile || 'monitor'}_high_vol`;
  } else if (volatility === 'low') {
    next.profitLockPct *= 1.05;
    next.partialExitRatioBias = Math.max(0.5, Number(next.partialExitRatioBias || 1) - 0.03);
    next.positionSizeMultiplier = Math.min(1.2, Number(next.positionSizeMultiplier || 1) * 1.05);
    next.monitorProfile = `${next.monitorProfile || 'monitor'}_low_vol`;
  }
  next.regimeExpansion = {
    inputRegime: expansion.inputRegime,
    baseRegime: expansion.baseRegime,
    ...expansion.extension,
  };
  return next;
}

export function getRegimeExpansionCatalog() {
  return {
    enabled: isEightWayEnabled(),
    aliases: { ...EIGHT_WAY_ALIASES },
  };
}
