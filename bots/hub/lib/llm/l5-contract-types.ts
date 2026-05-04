export type HubLlmJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export type HubLlmBackpressureKind =
  | 'admission_queue_full'
  | 'admission_queue_timeout'
  | 'provider_rate_limit'
  | 'provider_cooldown'
  | 'provider_circuit_open'
  | 'shared_limiter_full';

export interface HubLlmBackpressure {
  kind: HubLlmBackpressureKind;
  retryAfterMs: number;
  httpStatus: 429 | 503;
  provider?: string;
  scope?: string;
}

export interface HubLlmJobSummary {
  id: string;
  status: HubLlmJobStatus;
  createdAt: string;
  updatedAt: string;
  traceId: string | null;
  payloadSummary: {
    callerTeam: string | null;
    agent: string | null;
    selectorKey: string | null;
    abstractModel: string | null;
    promptBytes: number;
  };
}
