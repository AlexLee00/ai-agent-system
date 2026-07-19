import { z } from 'zod';

export const RegimeTypeSchema = z.enum([
  'trending_bull',
  'trending_bear',
  'ranging',
  'volatile',
  'unknown',
]);

export const RegimeGuideSchema = z.object({
  description: z.string(),
  agentWeights: z.record(z.string(), z.number()),
  tradingStyle: z.string(),
  tpMultiplier: z.number(),
  slMultiplier: z.number(),
  positionSizeMultiplier: z.number(),
  timeframe: z.string(),
});

export const BenchmarkSnapshotSchema = z.object({
  symbol: z.string(),
  label: z.string(),
  source: z.string(),
  error: z.string().optional(),
  last: z.number().nullable(),
  dayChangePct: z.number(),
  trendPct: z.number(),
});

export const ScoutSignalSchema = z.object({
  aiSignal: z.string().optional(),
  label: z.string().optional(),
  evidence: z.string().optional(),
  reasoning: z.string().optional(),
  source: z.string().optional(),
  screenerTrend: z.string().optional(),
  score: z.number().optional(),
}).passthrough();

export const MarketSignalsSchema = z.object({
  scout: ScoutSignalSchema.optional(),
}).passthrough();

export const MarketRegimeResultSchema = z.object({
  market: z.string(),
  bias: z.string(),
  summary: z.string(),
  snapshots: z.array(BenchmarkSnapshotSchema),
  regime: RegimeTypeSchema,
  confidence: z.number(),
  guide: RegimeGuideSchema,
  reason: z.string(),
  dataAvailable: z.boolean().optional(),
  degraded: z.boolean().optional(),
  dataQuality: z.object({
    dataAvailable: z.boolean(),
    degraded: z.boolean(),
    expectedCount: z.number(),
    usableCount: z.number(),
    failedCount: z.number(),
  }).optional(),
});

export type RegimeType = z.infer<typeof RegimeTypeSchema>;
export type RegimeGuide = z.infer<typeof RegimeGuideSchema>;
export type BenchmarkSnapshot = z.infer<typeof BenchmarkSnapshotSchema>;
export type MarketSignals = z.infer<typeof MarketSignalsSchema>;
export type MarketRegimeResult = z.infer<typeof MarketRegimeResultSchema>;

export const REGIMES = {
  TRENDING_BULL: 'trending_bull',
  TRENDING_BEAR: 'trending_bear',
  RANGING: 'ranging',
  VOLATILE: 'volatile',
  UNKNOWN: 'unknown',
} as const satisfies Record<string, RegimeType>;

export const REGIME_GUIDES: Record<RegimeType, RegimeGuide> = {
  [REGIMES.TRENDING_BULL]: {
    description: '강한 상승 추세',
    agentWeights: { aria: 1.25, oracle: 1.2, hound: 1.15, hera: 1.1, macro: 0.9, vibe: 0.95 },
    tradingStyle: 'aggressive',
    tpMultiplier: 1.3,
    slMultiplier: 1.0,
    positionSizeMultiplier: 1.2,
    timeframe: 'swing',
  },
  [REGIMES.TRENDING_BEAR]: {
    description: '강한 하락 추세',
    agentWeights: { macro: 1.3, vibe: 1.2, hound: 1.15, hera: 1.05, aria: 0.9, oracle: 0.9 },
    tradingStyle: 'defensive',
    tpMultiplier: 0.8,
    slMultiplier: 0.7,
    positionSizeMultiplier: 0.5,
    timeframe: 'short',
  },
  [REGIMES.RANGING]: {
    description: '횡보장',
    agentWeights: { echo: 1.2, chronos: 1.15, macro: 1.05, aria: 1.0, oracle: 1.0 },
    tradingStyle: 'neutral',
    tpMultiplier: 0.7,
    slMultiplier: 0.7,
    positionSizeMultiplier: 0.8,
    timeframe: 'short',
  },
  [REGIMES.VOLATILE]: {
    description: '급변동장',
    agentWeights: { macro: 1.35, vibe: 1.25, hound: 1.2, echo: 1.05, aria: 0.8, oracle: 0.8 },
    tradingStyle: 'defensive',
    tpMultiplier: 1.5,
    slMultiplier: 0.5,
    positionSizeMultiplier: 0.3,
    timeframe: 'scalp',
  },
  [REGIMES.UNKNOWN]: {
    description: '시장 데이터 확인 불가',
    agentWeights: {},
    tradingStyle: 'blocked',
    tpMultiplier: 1,
    slMultiplier: 1,
    positionSizeMultiplier: 0,
    timeframe: 'none',
  },
};
