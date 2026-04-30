// @ts-nocheck
/**
 * shared/agent-cross-bus.ts — Phase Ω4: Cross-Agent Bus 명시 모듈
 *
 * agent-message-bus.ts 기반 상위 API.
 * AutoGen / CrewAI 패턴 — 에이전트 간 직접 메시지 교환.
 *
 * 인터페이스:
 *   publishToBus(fromAgent, toAgent, message, meta)  — 메시지 발행
 *   subscribeBus(agentName, handler, opts)           — 폴링 기반 구독
 *   getMessageHistory(agent, limit)                  — 수신 메시지 이력
 *   clearMessages(agent, beforeAt)                   — 오래된 메시지 정리
 *
 * Kill Switch:
 *   LUNA_CROSS_AGENT_BUS_ENABLED=false → 전체 비활성 (default false)
 */

import {
  sendMessage,
  broadcastMessage,
  getPendingMessages,
  getMessagesByIncident,
  respondToMessage,
  type AgentMessage,
  type MessageType,
} from './agent-message-bus.ts';
import * as db from './db.ts';

export type { AgentMessage, MessageType };

const ENABLED = () => {
  const raw = String(process.env.LUNA_CROSS_AGENT_BUS_ENABLED ?? 'false').toLowerCase();
  return raw === 'true' || raw === '1';
};

async function withUnderlyingBusEnabled<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.LUNA_AGENT_CROSS_BUS_ENABLED;
  if (ENABLED() && !previous) {
    process.env.LUNA_AGENT_CROSS_BUS_ENABLED = 'true';
  }
  try {
    return await work();
  } finally {
    if (previous === undefined) {
      delete process.env.LUNA_AGENT_CROSS_BUS_ENABLED;
    } else {
      process.env.LUNA_AGENT_CROSS_BUS_ENABLED = previous;
    }
  }
}

export interface BusPublishOpts {
  incidentKey?: string;
  messageType?: MessageType;
}

export interface BusSubscribeOpts {
  pollIntervalMs?: number;
  maxIterations?: number;
  incidentKey?: string;
}

export interface BusHistoryOpts {
  incidentKey?: string;
  limit?: number;
  includeResponded?: boolean;
}

export type BusMessageHandler = (message: AgentMessage) => Promise<void>;

/**
 * 에이전트 간 메시지 발행.
 * @returns 생성된 message ID (-1 = 비활성 또는 오류)
 */
export async function publishToBus(
  fromAgent: string,
  toAgent: string,
  message: Record<string, unknown>,
  meta: BusPublishOpts = {},
): Promise<number> {
  if (!ENABLED()) return -1;
  return withUnderlyingBusEnabled(() => sendMessage(fromAgent, toAgent, message, {
    incidentKey: meta.incidentKey,
    messageType: meta.messageType ?? 'query',
  }));
}

/**
 * 브로드캐스트 — 모든 에이전트 대상 메시지 발행.
 */
export async function publishBroadcast(
  fromAgent: string,
  message: Record<string, unknown>,
  meta: { incidentKey?: string } = {},
): Promise<number> {
  if (!ENABLED()) return -1;
  return withUnderlyingBusEnabled(() => broadcastMessage(fromAgent, message, meta));
}

/**
 * 폴링 기반 구독.
 * handler가 각 메시지에 대해 비동기 처리.
 * maxIterations를 통해 무한루프 방지.
 */
export async function subscribeBus(
  agentName: string,
  handler: BusMessageHandler,
  opts: BusSubscribeOpts = {},
): Promise<{ processed: number; iterations: number }> {
  if (!ENABLED()) return { processed: 0, iterations: 0 };

  const pollMs = Math.max(500, opts.pollIntervalMs ?? 2000);
  const maxIter = Math.max(1, opts.maxIterations ?? 10);
  let processed = 0;
  let iterations = 0;

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  while (iterations < maxIter) {
    iterations++;
    const messages = await withUnderlyingBusEnabled(() => getPendingMessages(agentName, {
      incidentKey: opts.incidentKey,
      limit: 20,
    }));

    for (const msg of messages) {
      try {
        await handler(msg);
        processed++;
      } catch (err) {
        console.warn(`[cross-bus] ${agentName} handler error for msg#${msg.id}:`, err);
      }
    }

    if (messages.length === 0 || iterations >= maxIter) break;
    await sleep(pollMs);
  }

  return { processed, iterations };
}

/**
 * 에이전트의 메시지 이력 조회.
 * incidentKey 지정 시 해당 incident 내 모든 메시지 반환.
 * 미지정 시 to_agent 기준 최근 메시지 반환.
 */
export async function getMessageHistory(
  agent: string,
  opts: BusHistoryOpts = {},
): Promise<AgentMessage[]> {
  if (!ENABLED()) return [];

  if (opts.incidentKey) {
    return withUnderlyingBusEnabled(() => getMessagesByIncident(opts.incidentKey, { limit: opts.limit ?? 50 }));
  }

  const limit = opts.limit ?? 50;
  const respondedClause = opts.includeResponded
    ? ''
    : 'AND responded_at IS NULL';

  const rows = await db.query(
    `SELECT id, incident_key, from_agent, to_agent, message_type, payload, responded_at, created_at
     FROM investment.agent_messages
     WHERE (to_agent = $1 OR from_agent = $1)
       ${respondedClause}
     ORDER BY created_at DESC
     LIMIT $2`,
    [agent, limit],
  ).catch(() => []);

  return (rows || []).map((row: any) => ({
    id: row.id,
    incidentKey: row.incident_key ?? null,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    messageType: row.message_type as MessageType,
    payload: typeof row.payload === 'object' ? row.payload : JSON.parse(row.payload || '{}'),
    respondedAt: row.responded_at ? new Date(row.responded_at) : null,
    createdAt: new Date(row.created_at),
  }));
}

/**
 * 오래된 메시지 정리 (responded 또는 만료 기준).
 */
export async function clearMessages(
  agent: string,
  beforeAt: Date,
): Promise<{ deleted: number }> {
  if (!ENABLED()) return { deleted: 0 };

  const result = await db.run(
    `DELETE FROM investment.agent_messages
     WHERE (to_agent = $1 OR from_agent = $1)
       AND created_at < $2
       AND responded_at IS NOT NULL`,
    [agent, beforeAt.toISOString()],
  ).catch(() => null);

  return { deleted: Number(result?.rowCount || 0) };
}

/**
 * 메시지에 응답 발송.
 * agent-message-bus의 respondToMessage를 감싸는 편의 함수.
 */
export async function replyToBus(
  messageId: number,
  fromAgent: string,
  responsePayload: Record<string, unknown>,
): Promise<number> {
  if (!ENABLED()) return -1;
  return withUnderlyingBusEnabled(() => respondToMessage(messageId, fromAgent, responsePayload));
}

/**
 * 12 에이전트의 미처리 메시지 수 요약.
 * Dashboard에서 활성도 확인용.
 */
export async function getAgentBusSummary(): Promise<{
  enabled: boolean;
  totalPending: number;
  agentSummary: Array<{ agent: string; pending: number; lastActivity: string | null }>;
}> {
  if (!ENABLED()) {
    return { enabled: false, totalPending: 0, agentSummary: [] };
  }

  const rows = await db.query(
    `SELECT
       to_agent AS agent,
       COUNT(*)::int AS pending,
       MAX(created_at)::text AS last_activity
     FROM investment.agent_messages
     WHERE responded_at IS NULL
     GROUP BY to_agent
     ORDER BY pending DESC
     LIMIT 20`,
    [],
  ).catch(() => []);

  const agentSummary = (rows || []).map((row: any) => ({
    agent: row.agent,
    pending: Number(row.pending),
    lastActivity: row.last_activity ?? null,
  }));

  const totalPending = agentSummary.reduce((sum, a) => sum + a.pending, 0);

  return { enabled: true, totalPending, agentSummary };
}
