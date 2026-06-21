import { spawnSync } from 'node:child_process';

// Regime multiplier defaults. Configurable via LUNA_REGIME_LIMIT_MULT_<REGIME_UPPER>.
// Unknown/missing regime -> REGIME_MULT_FALLBACK (ranging-equivalent, conservative).
export const REGIME_MULT_DEFAULTS = {
  low_volatility_bull: 1.3,
  high_volatility_bull: 1.0,
  ranging: 0.8,
  trending_bull: 1.0,
  trending_bear: 0.5,
  low_volatility_bear: 0.6,
  high_volatility_bear: 0.4,
};

export const REGIME_MULT_FALLBACK = 0.8; // ranging equiv - safe default for unknown regime

function launchctlGetenv(key) {
  const proc = spawnSync('launchctl', ['getenv', key], { encoding: 'utf8' });
  if (proc.status !== 0) return undefined;
  return String(proc.stdout || '').trim() || undefined;
}

export function getRegimeMultiplier(regime, effectiveEnv = process.env) {
  const normalized = String(regime || '').trim().toLowerCase();
  if (normalized) {
    const envKey = `LUNA_REGIME_LIMIT_MULT_${normalized.toUpperCase().replace(/-/g, '_')}`;
    const envValue = effectiveEnv[envKey] ?? launchctlGetenv(envKey) ?? '';
    if (envValue !== '') {
      const n = Number(envValue);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (REGIME_MULT_DEFAULTS[normalized] != null) return REGIME_MULT_DEFAULTS[normalized];
  }
  return REGIME_MULT_FALLBACK;
}

