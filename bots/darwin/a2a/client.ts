/**
 * udarwin A2A Client — 외부 에이전트 호출
 * Google A2A Protocol (JSON-RPC 2.0 + SSE)
 */

import type { A2ATask, A2ATaskResult, A2ANotification } from './types.ts';

interface AgentEndpoint {
  name: string;
  url: string;
}

const KNOWN_AGENTS: Record<string, AgentEndpoint> = {
  luna:       { name: 'Luna Trading Agent',  url: process.env.LUNA_A2A_URL    || 'http://localhost:8765' },
  darwin:     { name: 'Darwin R&D Agent',    url: process.env.DARWIN_A2A_URL  || 'http://localhost:8766' },
  sigma:      { name: 'Sigma Meta Agent',    url: process.env.SIGMA_A2A_URL   || 'http://localhost:8767' },
  justin:     { name: 'Justin Legal Agent',  url: process.env.JUSTIN_A2A_URL  || 'http://localhost:8768' },
  blog:       { name: 'Blog Content Agent',  url: process.env.BLOG_A2A_URL    || 'http://localhost:8770' },
  claude_bot: { name: 'Claude Ops Agent',    url: process.env.CLAUDE_A2A_URL  || 'http://localhost:8771' },
  ska:        { name: 'Ska Revenue Agent',   url: process.env.SKA_A2A_URL     || 'http://localhost:8772' },
};

let _fetchFn: typeof fetch = globalThis.fetch;

export function setFetch(f: typeof fetch): void {
  _fetchFn = f;
}

export async function getAgentCard(agentId: string): Promise<unknown> {
  const ep = KNOWN_AGENTS[agentId];
  if (!ep) throw new Error(`알 수 없는 에이전트: ${agentId}`);
  const res = await _fetchFn(`${ep.url}/.well-known/agent.json`, { method: 'GET' });
  if (!res.ok) throw new Error(`Agent Card 조회 실패: ${res.status}`);
  return res.json();
}

export async function sendTask(agentId: string, task: Omit<A2ATask, 'id'>): Promise<A2ATaskResult> {
  const ep = KNOWN_AGENTS[agentId];
  if (!ep) throw new Error(`알 수 없는 에이전트: ${agentId}`);

  const payload = {
    jsonrpc: '2.0',
    method: 'tasks/send',
    id: `darwin-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    params: { ...task, id: `task-${Date.now()}` },
  };

  const res = await _fetchFn(`${ep.url}/a2a`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`[A2A] ${agentId} 태스크 전송 실패: ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`[A2A] ${agentId} 오류: ${body.error.message}`);
  return body.result as A2ATaskResult;
}

export async function broadcast(
  notification: Omit<A2ANotification, 'timestamp'>,
  targets: string[] = Object.keys(KNOWN_AGENTS)
): Promise<void> {
  const notif: A2ANotification = { ...notification, timestamp: new Date().toISOString(), source: 'darwin' };
  await Promise.allSettled(
    targets.map(async (agentId) => {
      const ep = KNOWN_AGENTS[agentId];
      if (!ep) return;
      try {
        await _fetchFn(`${ep.url}/a2a/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(notif),
        });
      } catch (err) {
        console.log(`[udarwin][A2A] broadcast to ${agentId} 실패: ${err}`);
      }
    })
  );
}

export { KNOWN_AGENTS };
