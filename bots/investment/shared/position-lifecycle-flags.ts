// @ts-nocheck

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

function boolFromAny(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function numFromAny(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadPositionLifecycleConfig() {
  try {
    const raw = yaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8')) || {};
    return raw?.position_lifecycle || {};
  } catch {
    return {};
  }
}

function modeFromConfig(config = {}) {
  const mode = String(config?.mode || process.env.LUNA_POSITION_LIFECYCLE_MODE || 'shadow')
    .trim()
    .toLowerCase();
  if (mode === 'supervised_l4' || mode === 'autonomous_l5' || mode === 'shadow') return mode;
  if (mode === 'supervised') return 'supervised_l4';
  if (mode === 'autonomous') return 'autonomous_l5';
  return 'shadow';
}

function phaseFlag(configSection = {}, envName, fallback = false) {
  if (process.env[envName] !== undefined) return boolFromAny(process.env[envName], fallback);
  return boolFromAny(configSection?.enabled, fallback);
}

function phaseMode(configSection = {}, mode = 'shadow') {
  const raw = String(configSection?.mode || mode || 'shadow').trim().toLowerCase();
  if (raw === 'supervised_l4' || raw === 'autonomous_l5' || raw === 'shadow') return raw;
  if (raw === 'supervised') return 'supervised_l4';
  if (raw === 'autonomous') return 'autonomous_l5';
  return 'shadow';
}

export function resolvePositionLifecycleFlags() {
  const config = loadPositionLifecycleConfig();
  const mode = modeFromConfig(config);

  const adaptive = config?.adaptive_cadence || {};
  const validity = config?.strategy_validity || {};
  const mutation = config?.strategy_mutation || {};
  const signalRefresh = config?.signal_refresh || {};
  const dynamicSizing = config?.dynamic_position_sizing || {};
  const dynamicTrail = config?.dynamic_trailing || {};
  const reflexive = config?.reflexive_portfolio_monitoring || {};
  const stageStream = config?.event_stream || {};

  return {
    mode,
    shadow: mode === 'shadow',
    supervised: mode === 'supervised_l4',
    autonomous: mode === 'autonomous_l5',
    phaseA: {
      enabled: phaseFlag(adaptive, 'LUNA_POSITION_ADAPTIVE_CADENCE_ENABLED', false),
      mode: phaseMode(adaptive, mode),
      defaultCadenceMs: numFromAny(process.env.LUNA_POSITION_CADENCE_DEFAULT_MS, numFromAny(adaptive?.default_cadence_ms, 300_000)),
      eventCadenceMs: numFromAny(process.env.LUNA_POSITION_CADENCE_EVENT_MS, numFromAny(adaptive?.event_cadence_ms, 60_000)),
      burstCadenceMs: numFromAny(process.env.LUNA_POSITION_CADENCE_BURST_MS, numFromAny(adaptive?.burst_cadence_ms, 30_000)),
    },
    phaseB: {
      enabled: phaseFlag(validity, 'LUNA_STRATEGY_VALIDITY_EVALUATOR_ENABLED', false),
      mode: phaseMode(validity, mode),
      holdThreshold: numFromAny(process.env.LUNA_VALIDITY_HOLD_THRESHOLD, numFromAny(validity?.hold_threshold, 0.7)),
      cautionThreshold: numFromAny(process.env.LUNA_VALIDITY_CAUTION_THRESHOLD, numFromAny(validity?.caution_threshold, 0.5)),
      pivotThreshold: numFromAny(process.env.LUNA_VALIDITY_PIVOT_THRESHOLD, numFromAny(validity?.pivot_threshold, 0.3)),
      exitThreshold: numFromAny(process.env.LUNA_VALIDITY_EXIT_THRESHOLD, numFromAny(validity?.exit_threshold, 0.3)),
    },
    phaseC: {
      enabled: phaseFlag(mutation, 'LUNA_STRATEGY_MUTATION_ENABLED', false),
      mode: phaseMode(mutation, mode),
      predictiveThreshold: numFromAny(process.env.LUNA_STRATEGY_MUTATION_PREDICTIVE_THRESHOLD, numFromAny(mutation?.predictive_threshold, 0.55)),
      dailyLimit: Math.max(1, Math.round(numFromAny(process.env.LUNA_STRATEGY_MUTATION_DAILY_LIMIT, numFromAny(mutation?.daily_limit, 5)))),
    },
    phaseD: {
      enabled: phaseFlag(signalRefresh, 'LUNA_POSITION_SIGNAL_REFRESH_ENABLED', false),
      mode: phaseMode(signalRefresh, mode),
      refreshWindowMinutes: Math.max(5, Math.round(numFromAny(process.env.LUNA_POSITION_SIGNAL_REFRESH_WINDOW_MINUTES, numFromAny(signalRefresh?.refresh_window_minutes, 120)))),
      refreshEvidenceDays: Math.max(1, Math.round(numFromAny(process.env.LUNA_POSITION_SIGNAL_REFRESH_EVIDENCE_DAYS, numFromAny(signalRefresh?.evidence_days, 3)))),
      minEvidenceCount: Math.max(0, Math.round(numFromAny(process.env.LUNA_POSITION_SIGNAL_REFRESH_MIN_EVIDENCE, numFromAny(signalRefresh?.min_evidence_count, 2)))),
    },
    phaseE: {
      enabled: phaseFlag(dynamicSizing, 'LUNA_DYNAMIC_POSITION_SIZING_ENABLED', false),
      mode: phaseMode(dynamicSizing, mode),
      maxPyramidRatio: Math.max(0, numFromAny(process.env.LUNA_DYNAMIC_POSITION_MAX_PYRAMID_RATIO, numFromAny(dynamicSizing?.max_pyramid_ratio, 0.25))),
      maxTrimRatio: Math.max(0, numFromAny(process.env.LUNA_DYNAMIC_POSITION_MAX_TRIM_RATIO, numFromAny(dynamicSizing?.max_trim_ratio, 0.6))),
      kellyHalfCap: Math.max(0, numFromAny(process.env.LUNA_DYNAMIC_POSITION_KELLY_HALF_CAP, numFromAny(dynamicSizing?.kelly_half_cap, 0.2))),
    },
    phaseF: {
      enabled: phaseFlag(dynamicTrail, 'LUNA_DYNAMIC_TRAIL_ENGINE_ENABLED', false),
      mode: phaseMode(dynamicTrail, mode),
      atrMultiplier: Math.max(0.1, numFromAny(process.env.LUNA_DYNAMIC_TRAIL_ATR_MULTIPLIER, numFromAny(dynamicTrail?.atr_multiplier, 2.5))),
      chandelierMultiplier: Math.max(0.1, numFromAny(process.env.LUNA_DYNAMIC_TRAIL_CHANDELIER_MULTIPLIER, numFromAny(dynamicTrail?.chandelier_multiplier, 3.0))),
    },
    phaseG: {
      enabled: phaseFlag(reflexive, 'LUNA_REFLEXIVE_PORTFOLIO_MONITORING_ENABLED', false),
      mode: phaseMode(reflexive, mode),
      maxConcentrationPct: Math.max(0.1, numFromAny(process.env.LUNA_REFLEXIVE_MAX_CONCENTRATION_PCT, numFromAny(reflexive?.max_concentration_pct, 0.45))),
      maxDrawdownChainCount: Math.max(1, Math.round(numFromAny(process.env.LUNA_REFLEXIVE_MAX_DRAWDOWN_CHAIN, numFromAny(reflexive?.max_drawdown_chain_count, 3)))),
      maxCorrelation: Math.max(0.1, numFromAny(process.env.LUNA_REFLEXIVE_MAX_CORRELATION, numFromAny(reflexive?.max_correlation, 0.85))),
    },
    phaseH: {
      enabled: phaseFlag(stageStream, 'LUNA_POSITION_LIFECYCLE_EVENT_STREAM_ENABLED', false),
      mode: phaseMode(stageStream, mode),
    },
    shouldMutateLive() {
      return this.phaseC.enabled && !this.shadow;
    },
    shouldExecuteSignalRefresh() {
      return this.phaseD.enabled;
    },
    shouldApplyDynamicSizing() {
      return this.phaseE.enabled;
    },
    shouldApplyDynamicTrail() {
      return this.phaseF.enabled;
    },
    shouldApplyReflexiveMonitoring() {
      return this.phaseG.enabled;
    },
    shouldEmitStageEvents() {
      return this.phaseH.enabled || !this.shadow;
    },
  };
}

export default resolvePositionLifecycleFlags;
