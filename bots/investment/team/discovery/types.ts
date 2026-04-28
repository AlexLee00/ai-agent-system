// @ts-nocheck
// Discovery Layer 공용 타입 정의

export type DiscoveryMarket = 'domestic' | 'overseas' | 'crypto';
export type DiscoveryTier = 1 | 2;
export type DiscoveryQualityStatus = 'ready' | 'degraded' | 'insufficient';

export interface DiscoverySignal {
  symbol: string;
  score: number;      // 0~1
  reason: string;
  confidence?: number; // 0~1
  reasonCode?: string | null;
  evidenceRef?: Record<string, unknown> | null;
  qualityFlags?: string[];
  ttlHours?: number;
  raw?: Record<string, unknown>;
}

export interface DiscoveryQuality {
  status: DiscoveryQualityStatus;
  sourceTier: DiscoveryTier;
  signalCount: number;
}

export interface DiscoveryResult {
  source: string;
  market: DiscoveryMarket;
  fetchedAt: string;
  signals: DiscoverySignal[];
  quality: DiscoveryQuality;
}

export interface DiscoveryCollectOptions {
  limit?: number;
  timeoutMs?: number;
  dryRun?: boolean;
}

export interface DiscoveryAdapter {
  source: string;
  market: DiscoveryMarket;
  tier: DiscoveryTier;
  reliability: number;    // 0~1
  collect(options?: DiscoveryCollectOptions): Promise<DiscoveryResult>;
}

// Orchestrator 결과 — 모든 어댑터 병렬 수집 후 통합
export interface DiscoveryOrchestratorResult {
  orchestratedAt: string;
  markets: {
    domestic: DiscoveryResult[];
    overseas: DiscoveryResult[];
    crypto: DiscoveryResult[];
  };
  merged: {
    domestic: DiscoverySignal[];
    overseas: DiscoverySignal[];
    crypto: DiscoverySignal[];
  };
  errors: Array<{ adapter: string; error: string }>;
  stats: {
    totalAdapters: number;
    successCount: number;
    errorCount: number;
    totalSignals: number;
  };
}
