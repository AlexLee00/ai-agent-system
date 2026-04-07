import { z } from 'zod';

const runtime = require('./market-regime.js') as {
  REGIMES: Record<string, string>;
  REGIME_GUIDES: Record<string, RegimeGuide>;
  getMarketRegime: (market?: string, signals?: MarketSignals) => Promise<MarketRegimeResult>;
  formatMarketRegime: (regime: MarketRegimeResult | null | undefined) => string;
};

export const RegimeTypeSchema = z.enum([
  'trending_bull',
  'trending_bear',
  'ranging',
  'volatile',
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
});

export type RegimeType = z.infer<typeof RegimeTypeSchema>;
export type RegimeGuide = z.infer<typeof RegimeGuideSchema>;
export type BenchmarkSnapshot = z.infer<typeof BenchmarkSnapshotSchema>;
export type MarketSignals = z.infer<typeof MarketSignalsSchema>;
export type MarketRegimeResult = z.infer<typeof MarketRegimeResultSchema>;

export const REGIMES = runtime.REGIMES as Record<string, RegimeType>;
export const REGIME_GUIDES = runtime.REGIME_GUIDES as Record<RegimeType, RegimeGuide>;

export async function getMarketRegime(
  market = 'binance',
  signals: MarketSignals = {},
): Promise<MarketRegimeResult> {
  return MarketRegimeResultSchema.parse(
    await runtime.getMarketRegime(market, MarketSignalsSchema.parse(signals)),
  );
}

export function formatMarketRegime(regime: MarketRegimeResult | null | undefined): string {
  return runtime.formatMarketRegime(regime);
}
