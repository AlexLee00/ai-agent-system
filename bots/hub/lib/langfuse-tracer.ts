'use strict';

// Langfuse 자동 trace 헬퍼
// 비동기 fire-and-forget — Hub uptime에 영향 없음
// LANGFUSE_ENABLED=true + LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY 필요

import path from 'node:path';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

let _client: import('langfuse').Langfuse | null = null;
let _initAttempted = false;

function _getClient(): import('langfuse').Langfuse | null {
  if (_initAttempted) return _client;
  _initAttempted = true;

  const enabled = (process.env.LANGFUSE_ENABLED || '').toLowerCase();
  if (!['true', '1', 'yes'].includes(enabled)) return null;

  const host = process.env.LANGFUSE_HOST || 'http://localhost:3000';
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY || '';
  const secretKey = process.env.LANGFUSE_SECRET_KEY || '';

  if (!publicKey || !secretKey) {
    console.warn('[langfuse-tracer] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 미설정 — trace 비활성화');
    return null;
  }

  try {
    const { Langfuse } = require('langfuse');
    _client = new Langfuse({ publicKey, secretKey, baseUrl: host, flushAt: 20, flushInterval: 5000 });
    console.log(`[langfuse-tracer] 초기화 완료 (${host})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[langfuse-tracer] 초기화 실패 (무시):', msg);
  }
  return _client;
}

export interface LangfuseLLMCallMeta {
  agent?: string;
  callerTeam?: string;
  taskType?: string;
  selectorKey?: string;
  abstractModel?: string;
  autoRouted?: boolean;
  predictedModel?: string;
  budgetGuardStatus?: string;
  promptChars?: number;
  systemPromptChars?: number;
}

export function traceLLMCall(
  req: { prompt?: string; systemPrompt?: string },
  result: {
    ok: boolean;
    provider?: string;
    selected_route?: string;
    durationMs?: number;
    totalCostUsd?: number;
    error?: string;
    cacheHit?: boolean;
  },
  meta: LangfuseLLMCallMeta = {},
): void {
  const client = _getClient();
  if (!client) return;

  setImmediate(() => {
    try {
      const trace = client.trace({
        name: 'llm_call',
        userId: meta.agent || meta.callerTeam || 'hub',
        tags: [
          meta.callerTeam || 'hub',
          meta.taskType || 'unknown',
          result.ok ? 'success' : 'failure',
          result.cacheHit ? 'cache_hit' : 'live',
        ].filter(Boolean),
        metadata: {
          agent: meta.agent,
          callerTeam: meta.callerTeam,
          taskType: meta.taskType,
          selectorKey: meta.selectorKey,
          abstractModel: meta.abstractModel,
          autoRouted: meta.autoRouted,
          predictedModel: meta.predictedModel,
          budgetGuardStatus: meta.budgetGuardStatus,
          provider: result.provider,
          selectedRoute: result.selected_route,
          durationMs: result.durationMs,
          costUsd: result.totalCostUsd,
          ok: result.ok,
          error: result.error,
          cacheHit: result.cacheHit,
          promptChars: meta.promptChars ?? (req.prompt?.length || 0),
          systemPromptChars: meta.systemPromptChars ?? (req.systemPrompt?.length || 0),
        },
      });

      trace.generation({
        name: 'llm_generation',
        model: result.selected_route || meta.abstractModel || 'unknown',
        modelParameters: { provider: result.provider },
        input: req.prompt ? req.prompt.slice(0, 500) : '',
        startTime: new Date(Date.now() - (result.durationMs || 0)),
        endTime: new Date(),
        usage: result.totalCostUsd ? { totalCost: result.totalCostUsd } : undefined,
        level: result.ok ? 'DEFAULT' : 'ERROR',
        statusMessage: result.error,
      });
    } catch (e: unknown) {
      // silent — Hub uptime 보호
    }
  });
}

export function traceAgentRun(
  agent: string,
  input: string,
  output: string,
  meta: { team?: string; durationMs?: number; ok?: boolean } = {},
): void {
  const client = _getClient();
  if (!client) return;

  setImmediate(() => {
    try {
      client.trace({
        name: 'agent_run',
        userId: agent,
        input: input.slice(0, 500),
        output: output.slice(0, 500),
        tags: [agent, meta.team || 'hub', meta.ok !== false ? 'success' : 'failure'].filter(Boolean),
        metadata: { agent, team: meta.team, durationMs: meta.durationMs, ok: meta.ok },
      });
    } catch {
      // silent
    }
  });
}

export async function flushLangfuse(): Promise<void> {
  const client = _getClient();
  if (!client) return;
  try {
    await client.flushAsync();
  } catch {
    // silent
  }
}
