export type LLMProvider = 'claude-code-oauth' | 'groq' | 'failed';

export type AbstractModel = 'anthropic_haiku' | 'anthropic_sonnet' | 'anthropic_opus';

export interface LLMCallRequest {
  prompt: string;
  abstractModel: AbstractModel;
  systemPrompt?: string;
  jsonSchema?: Record<string, unknown>;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  agent?: string;
  callerTeam?: 'sigma' | 'darwin';
  urgency?: 'low' | 'medium' | 'high';
  taskType?: string;
}

export interface LLMCallResponse {
  ok: boolean;
  provider: LLMProvider;
  result?: string;
  structuredOutput?: unknown;
  durationMs: number;
  apiDurationMs?: number;
  totalCostUsd?: number;
  modelUsage?: Record<string, unknown>;
  sessionId?: string;
  primaryError?: string;
  fallbackCount?: number;
  error?: string;
}
