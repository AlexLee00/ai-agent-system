export type WeightMap = Record<string, number>;
export type MetricsMap = Record<string, any>;
export type NormalizeFn = (
  weights: WeightMap,
  components: string[],
  floor: number,
  ceiling: number,
  fallback: WeightMap,
) => WeightMap;
export type AdjustPolicyFn = (metrics: MetricsMap, context: {
  components: string[];
  maxDelta: number;
}) => {
  deltas?: Record<string, unknown>;
  reasons?: string[];
};

export const DEFAULT_FLOOR = 0.08;
export const DEFAULT_CEILING = 0.48;
export const DEFAULT_MAX_DELTA = 0.07;

export function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clamp(value: unknown, min = 0, max = 1, fallback = 0): number {
  return Math.max(min, Math.min(max, n(value, fallback)));
}

export function round(value: unknown, digits = 6): number {
  return Number(n(value, 0).toFixed(digits));
}

export function capDelta(delta: unknown, maxDelta: number): number {
  return clamp(delta, -Math.abs(maxDelta), Math.abs(maxDelta), 0);
}

export function applyDelta(
  baseWeights: WeightMap,
  deltas: Record<string, unknown> = {},
  components: string[],
  maxDelta = DEFAULT_MAX_DELTA,
  normalize: NormalizeFn,
  floor = DEFAULT_FLOOR,
  ceiling = DEFAULT_CEILING,
): WeightMap {
  const next: WeightMap = {};
  for (const key of components) {
    next[key] = n(baseWeights?.[key], 0) + capDelta(deltas?.[key] ?? 0, maxDelta);
  }
  return normalize(next, components, floor, ceiling, baseWeights);
}

export function hasSamples(metrics: MetricsMap = {}, sampleKeys: string[] = []): boolean {
  return sampleKeys.some((path) => {
    const value = path.split('.').reduce((current, key) => current?.[key], metrics);
    return n(value, 0) > 0;
  });
}

export function buildShadowResult(options: {
  status: string;
  source: string;
  baseWeights: WeightMap;
  weights: WeightMap;
  deltas: WeightMap;
  metrics: MetricsMap;
  reasons: string[];
  generatedAt?: string;
  mode?: string;
  maxDelta?: number;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ok: true,
    status: options.status,
    source: options.source,
    ...(options.mode != null ? { mode: options.mode } : {}),
    shadowOnly: true,
    liveMutation: false,
    generatedAt: options.generatedAt || new Date().toISOString(),
    baseWeights: options.baseWeights,
    weights: options.weights,
    deltas: options.deltas,
    ...(options.maxDelta != null ? { maxDelta: options.maxDelta } : {}),
    metrics: options.metrics,
    reasons: options.reasons,
    ...(options.extra || {}),
  };
  return result;
}

export function buildWeightFeedback(options: {
  baseWeights: WeightMap;
  components: string[];
  metrics?: MetricsMap;
  sampleKeys?: string[];
  normalize: NormalizeFn;
  adjustPolicy: AdjustPolicyFn;
  maxDelta?: number;
  floor?: number;
  ceiling?: number;
  status?: string;
  insufficientStatus?: string;
  source: string;
  mode?: string;
  generatedAt?: string;
  insufficientReasons?: string[];
  extra?: Record<string, unknown>;
  includeMaxDelta?: boolean;
  deltaDigits?: number;
}): Record<string, unknown> {
  const components = options.components;
  const metrics = options.metrics || {};
  const maxDelta = options.maxDelta ?? DEFAULT_MAX_DELTA;
  const emptyDeltas = Object.fromEntries(components.map((key) => [key, 0]));

  if (!hasSamples(metrics, options.sampleKeys || [])) {
    return buildShadowResult({
      status: options.insufficientStatus || 'insufficient_feedback_static_weights',
      source: options.source,
      mode: options.mode,
      generatedAt: options.generatedAt,
      baseWeights: options.baseWeights,
      weights: options.baseWeights,
      deltas: emptyDeltas,
      metrics,
      reasons: options.insufficientReasons || ['insufficient_feedback_samples'],
      extra: options.extra,
    });
  }

  const adjusted = options.adjustPolicy(metrics, { components, maxDelta });
  const rawDeltas = adjusted.deltas || emptyDeltas;
  const weights = applyDelta(
    options.baseWeights,
    rawDeltas,
    components,
    maxDelta,
    options.normalize,
    options.floor ?? DEFAULT_FLOOR,
    options.ceiling ?? DEFAULT_CEILING,
  );
  const appliedDeltas = Object.fromEntries(
    components.map((key) => [key, round(n(weights[key], 0) - n(options.baseWeights[key], 0), options.deltaDigits)]),
  );

  return buildShadowResult({
    status: options.status || 'shadow_weight_feedback_ready',
    source: options.source,
    mode: options.mode,
    generatedAt: options.generatedAt,
    baseWeights: options.baseWeights,
    weights,
    deltas: appliedDeltas,
    maxDelta: options.includeMaxDelta === false ? undefined : maxDelta,
    metrics,
    reasons: adjusted.reasons?.length ? adjusted.reasons : ['feedback_within_control_band'],
    extra: options.extra,
  });
}
