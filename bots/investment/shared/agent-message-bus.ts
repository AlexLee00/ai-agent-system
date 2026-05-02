// @ts-nocheck
/**
 * shared/agent-message-bus.ts — Phase E: Cross-Agent Message Bus
 *
 * AutoGen / CrewAI 패턴 기반 에이전트 간 직접 메시지 교환.
 * agent_messages 테이블 활용 (20260428_agent_memory_system.sql).
 *
 * 흐름 예시:
 *   argos: "이 종목 sentiment 어때?" → sophia
 *   sophia: 자기 RAG로 retrieval → "긍정 0.65, 24h delta +0.12" → argos 응답
 *   결과가 incident_key 기반으로 누적
 *
 * Kill Switch:
 *   LUNA_AGENT_CROSS_BUS_ENABLED=false → 전체 비활성 (메시지 전송/조회 모두 no-op)
 */

import { isAgentMemoryFeatureEnabled } from './agent-memory-runtime.ts';
import * as db from './db.ts';

const BUS_ENABLED = () => isAgentMemoryFeatureEnabled('crossBusEnabled');

export type MessageType = 'query' | 'response' | 'broadcast';

export interface AgentMessage {
  id: number;
  incidentKey: string | null;
  fromAgent: string;
  toAgent: string;
  messageType: MessageType;
  payload: Record<string, unknown>;
  respondedAt: Date | null;
  createdAt: Date;
}

export interface SendMessageOpts {
  incidentKey?: string;
  messageType?: MessageType;
}

/**
 * 에이전트 → 에이전트 메시지 전송.
 * @returns 생성된 message ID
 */
export async function sendMessage(
  fromAgent: string,
  toAgent: string,
  payload: Record<string, unknown>,
  opts: SendMessageOpts = {},
): Promise<number> {
  if (!BUS_ENABLED()) return -1;

  try {
    const result = await db.run(
      `INSERT INTO investment.agent_messages
         (from_agent, to_agent, incident_key, message_type, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        fromAgent,
        toAgent,
        opts.incidentKey ?? null,
        opts.messageType ?? 'query',
        JSON.stringify(payload),
      ],
    );
    const messageId = result.rows?.[0]?.id ?? -1;
    if (messageId > 0) {
      recordHintEvent('cross_agent_hint_published', {
        messageId,
        incidentKey: opts.incidentKey ?? null,
        fromAgent,
        toAgent,
        messageType: opts.messageType ?? 'query',
      }).catch(() => {});
    }
    return messageId;
  } catch {
    return -1;
  }
}

/**
 * 브로드캐스트: 모든 에이전트에게 메시지 전송 (to_agent = 'all').
 * @returns 생성된 message ID
 */
export async function broadcastMessage(
  fromAgent: string,
  payload: Record<string, unknown>,
  opts: { incidentKey?: string } = {},
): Promise<number> {
  return sendMessage(fromAgent, 'all', payload, {
    incidentKey: opts.incidentKey,
    messageType: 'broadcast',
  });
}

/**
 * 특정 에이전트의 미응답 쿼리 수신.
 */
export async function getPendingMessages(
  agentName: string,
  opts: { incidentKey?: string; limit?: number } = {},
): Promise<AgentMessage[]> {
  if (!BUS_ENABLED()) return [];

  try {
    const whereParts = ['(to_agent = $1 OR to_agent = \'all\')', 'responded_at IS NULL'];
    const params: unknown[] = [agentName];

    if (opts.incidentKey) {
      params.push(opts.incidentKey);
      whereParts.push(`incident_key = $${params.length}`);
    }

    const limit = opts.limit ?? 20;
    params.push(limit);

    const rows = await db.query(
      `SELECT id, incident_key, from_agent, to_agent, message_type, payload, responded_at, created_at
         FROM investment.agent_messages
        WHERE ${whereParts.join(' AND ')}
        ORDER BY created_at ASC
        LIMIT $${params.length}`,
      params,
    );

    return rows.map(rowToMessage);
  } catch {
    return [];
  }
}

/**
 * incident_key 내 모든 메시지 조회 (대화 흐름 확인용).
 */
export async function getMessagesByIncident(
  incidentKey: string,
  opts: { limit?: number } = {},
): Promise<AgentMessage[]> {
  if (!BUS_ENABLED()) return [];

  try {
    const rows = await db.query(
      `SELECT id, incident_key, from_agent, to_agent, message_type, payload, responded_at, created_at
         FROM investment.agent_messages
        WHERE incident_key = $1
        ORDER BY created_at ASC
        LIMIT $2`,
      [incidentKey, opts.limit ?? 100],
    );

    return rows.map(rowToMessage);
  } catch {
    return [];
  }
}

/**
 * 메시지에 응답 (responded_at 기록 + response 메시지 생성).
 * @returns 응답 message ID
 */
export async function respondToMessage(
  messageId: number,
  fromAgent: string,
  responsePayload: Record<string, unknown>,
): Promise<number> {
  if (!BUS_ENABLED()) return -1;

  try {
    // 원본 메시지 조회
    const orig = await db.query(
      `SELECT from_agent, to_agent, incident_key FROM investment.agent_messages WHERE id = $1`,
      [messageId],
    );

    if (!orig.length) return -1;

    const { from_agent: originalSender, incident_key: incidentKey } = orig[0];

    // 원본 메시지에 responded_at 기록
    await db.run(
      `UPDATE investment.agent_messages SET responded_at = NOW() WHERE id = $1`,
      [messageId],
    );

    // 응답 메시지 삽입 (원래 발신자에게 전송)
    const responseId = await sendMessage(fromAgent, originalSender, responsePayload, {
      incidentKey: incidentKey ?? undefined,
      messageType: 'response',
    });
    if (responseId > 0) {
      recordHintEvent('cross_agent_hint_consumed', {
        messageId,
        responseId,
        incidentKey: incidentKey ?? null,
        fromAgent,
        toAgent: originalSender,
      }).catch(() => {});
    }
    return responseId;
  } catch {
    return -1;
  }
}

/**
 * 에이전트가 다른 에이전트에게 동기식 질의 (전송 → 폴링 → 응답 반환).
 * 타임아웃 내 응답 없으면 null 반환.
 *
 * 운영 시 비동기 패턴 권장. 이 함수는 테스트/단순 흐름용.
 */
export async function queryAgent(
  fromAgent: string,
  toAgent: string,
  queryPayload: Record<string, unknown>,
  opts: {
    incidentKey?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<AgentMessage | null> {
  if (!BUS_ENABLED()) return null;

  const msgId = await sendMessage(fromAgent, toAgent, queryPayload, {
    incidentKey: opts.incidentKey,
    messageType: 'query',
  });

  if (msgId < 0) return null;

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollIntervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));

    try {
      const rows = await db.query(
        `SELECT id, incident_key, from_agent, to_agent, message_type, payload, responded_at, created_at
           FROM investment.agent_messages
          WHERE message_type = 'response'
            AND to_agent = $1
            AND from_agent = $2
            AND created_at > NOW() - INTERVAL '5 minutes'
          ORDER BY created_at DESC
          LIMIT 1`,
        [fromAgent, toAgent],
      );

      if (rows.length) {
        return rowToMessage(rows[0]);
      }
    } catch {
      break;
    }
  }

  return null;
}

export async function getMessageBusHygiene(opts: { staleHours?: number; limit?: number } = {}) {
  const staleHours = Math.max(1, Number(opts.staleHours || 6) || 6);
  const limit = Math.max(1, Math.min(200, Number(opts.limit || 50) || 50));
  try {
    const rows = await db.query(
      `SELECT
         to_agent,
         message_type,
         COUNT(*) AS stale_count,
         MIN(created_at) AS oldest_created_at
       FROM investment.agent_messages
       WHERE responded_at IS NULL
         AND message_type IN ('query', 'broadcast')
         AND created_at < NOW() - ($1::int * INTERVAL '1 hour')
       GROUP BY to_agent, message_type
       ORDER BY stale_count DESC, oldest_created_at ASC
       LIMIT $2`,
      [staleHours, limit],
    );
    return {
      ok: true,
      staleHours,
      staleCount: rows.reduce((sum, row) => sum + Number(row.stale_count || 0), 0),
      rows,
    };
  } catch (error) {
    return {
      ok: false,
      staleHours,
      staleCount: 0,
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function expireStaleAgentMessages(opts: {
  staleHours?: number;
  limit?: number;
  incidentKeyPrefix?: string;
  dryRun?: boolean;
  safeOnly?: boolean;
} = {}) {
  const staleHours = Math.max(1, Number(opts.staleHours || 24) || 24);
  const limit = Math.max(1, Math.min(500, Number(opts.limit || 100) || 100));
  const incidentPrefix = String(opts.incidentKeyPrefix || '').trim();
  const dryRun = opts.dryRun === true;
  try {
    const params: unknown[] = [staleHours, limit];
    let incidentFilter = '';
    if (incidentPrefix) {
      params.push(`${incidentPrefix}%`);
      incidentFilter = `AND incident_key LIKE $${params.length}`;
    }
    const safeOnlyFilter = opts.safeOnly === true
      ? "AND LOWER(to_agent) NOT IN ('all', 'hermes')"
      : '';
    const candidates = await db.query(
      `SELECT id, incident_key, from_agent, to_agent, message_type, payload, responded_at, created_at
       FROM investment.agent_messages
       WHERE responded_at IS NULL
         AND message_type IN ('query', 'broadcast')
         AND created_at < NOW() - ($1::int * INTERVAL '1 hour')
         ${incidentFilter}
         ${safeOnlyFilter}
       ORDER BY created_at ASC
       LIMIT $2`,
      params,
    );
    if (dryRun || candidates.length === 0) {
      return { ok: true, dryRun, staleHours, candidates: candidates.length, expired: 0, safeOnly: opts.safeOnly === true };
    }
    const ids = candidates.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
    if (ids.length === 0) return { ok: true, dryRun, staleHours, candidates: candidates.length, expired: 0, safeOnly: opts.safeOnly === true };
    const result = await db.run(
      `UPDATE investment.agent_messages
       SET responded_at = NOW(),
           payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
       WHERE id = ANY($1::bigint[])
         AND responded_at IS NULL`,
      [
        ids,
        JSON.stringify({
          staleExpired: true,
          expiredAt: new Date().toISOString(),
          staleHours,
        }),
      ],
    );
    return {
      ok: true,
      dryRun,
      staleHours,
      candidates: candidates.length,
      expired: Number(result.rowCount || 0),
      safeOnly: opts.safeOnly === true,
    };
  } catch (error) {
    return {
      ok: false,
      dryRun,
      staleHours,
      candidates: 0,
      expired: 0,
      safeOnly: opts.safeOnly === true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

function rowToMessage(row: Record<string, unknown>): AgentMessage {
  return {
    id: row.id as number,
    incidentKey: (row.incident_key as string | null) ?? null,
    fromAgent: row.from_agent as string,
    toAgent: row.to_agent as string,
    messageType: row.message_type as MessageType,
    payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>,
    respondedAt: row.responded_at ? new Date(row.responded_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

async function recordHintEvent(eventType: string, payload: Record<string, unknown>) {
  try {
    await db.run(
      `INSERT INTO investment.mapek_knowledge (event_type, payload)
       VALUES ($1, $2::jsonb)`,
      [eventType, JSON.stringify(payload || {})],
    );
  } catch {
    // event 기록 실패는 버스 동작을 중단시키지 않는다.
  }
}
