// @ts-nocheck
/**
 * shared/agent-hint-bridge.ts
 *
 * Cross-agent bus 실사용 브릿지:
 * - publish: 힌트 비동기 전송 (실패해도 거래 흐름 차단 없음)
 * - consume: 힌트 수신 + 응답 ACK (중복 소비 방지)
 */

import {
  sendMessage,
  getPendingMessages,
  respondToMessage,
} from './agent-message-bus.ts';

export async function publishAgentHint(
  fromAgent: string,
  toAgents: string[],
  payload: Record<string, unknown>,
  opts: { incidentKey?: string; messageType?: 'query' | 'broadcast' } = {},
) {
  const delivered: Array<{ toAgent: string; messageId: number }> = [];
  const failed: string[] = [];
  for (const toAgent of (Array.isArray(toAgents) ? toAgents : []).filter(Boolean)) {
    try {
      const messageId = await sendMessage(fromAgent, toAgent, payload, {
        incidentKey: opts.incidentKey,
        messageType: opts.messageType || 'query',
      });
      if (messageId > 0) delivered.push({ toAgent, messageId });
      else failed.push(toAgent);
    } catch {
      failed.push(toAgent);
    }
  }
  return { ok: failed.length === 0, delivered, failed };
}

export async function consumeAgentHints(
  agentName: string,
  opts: { incidentKey?: string; limit?: number } = {},
) {
  try {
    const pending = await getPendingMessages(agentName, {
      incidentKey: opts.incidentKey,
      limit: opts.limit || 8,
    });
    const hints: Array<{
      id: number;
      fromAgent: string;
      incidentKey: string | null;
      payload: Record<string, unknown>;
      createdAt: string;
    }> = [];

    for (const msg of pending || []) {
      if (msg.messageType !== 'query' && msg.messageType !== 'broadcast') continue;
      hints.push({
        id: msg.id,
        fromAgent: msg.fromAgent,
        incidentKey: msg.incidentKey ?? null,
        payload: (msg.payload || {}) as Record<string, unknown>,
        createdAt: new Date(msg.createdAt || Date.now()).toISOString(),
      });
      await respondToMessage(msg.id, agentName, {
        consumed: true,
        consumed_at: new Date().toISOString(),
      }).catch(() => {});
    }

    return hints;
  } catch {
    return [];
  }
}

