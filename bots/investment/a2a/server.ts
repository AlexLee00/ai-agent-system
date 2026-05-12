// @ts-nocheck
/**
 * Luna A2A Server — Google A2A Protocol (JSON-RPC 2.0 + SSE)
 * Port: 8765
 *
 * 엔드포인트:
 *   GET  /.well-known/agent.json  → Agent Card
 *   POST /a2a                     → JSON-RPC 2.0 태스크
 *   POST /a2a/notify              → 수신 알림
 *   GET  /a2a/stream/:taskId      → SSE 스트리밍
 */

import { createRequire } from 'module';
import { handleTask, registerSkillHandler } from './handlers/task-handler.ts';
import { handleMessage } from './handlers/message-handler.ts';
import { handleNotification } from './handlers/notification-handler.ts';
import { registerMarketRegimeAnalysisSkill } from './skills/market-regime-analysis.ts';
import { registerEntryDecisionShadowSkill } from './skills/entry-decision-shadow.ts';
import { registerDynamicTpSlShadowSkill } from './skills/dynamic-tpsl-shadow.ts';
import { registerMetaNeuralReflexionSkill } from './skills/meta-neural-reflexion.ts';
import { registerFactorModelShadowSkill } from './skills/factor-model-shadow.ts';
import { registerStatArbShadowSkill } from './skills/stat-arb-shadow.ts';
import { registerRlPolicyShadowSkills } from './skills/rl-policy-shadow.ts';
import { registerRiskSimulationShadowSkills } from './skills/risk-simulation-shadow.ts';
import { registerCommunicationInfrastructureGateSkill } from './skills/communication-infrastructure-gate.ts';

const _require = createRequire(import.meta.url);
const express = _require('express');

const agentCard = JSON.parse(
  await import('fs').then(m => m.readFileSync(new URL('./luna-card.json', import.meta.url), 'utf-8'))
);

const PORT = parseInt(process.env.LUNA_A2A_PORT || '8765', 10);
const app = express();
app.use(express.json());

registerMarketRegimeAnalysisSkill();
registerEntryDecisionShadowSkill();
registerDynamicTpSlShadowSkill();
registerMetaNeuralReflexionSkill();
registerFactorModelShadowSkill();
registerStatArbShadowSkill();
registerRlPolicyShadowSkills();
registerRiskSimulationShadowSkills();
registerCommunicationInfrastructureGateSkill();

// ── SSE 스트림 저장소 ──────────────────────────────────────────────
const _streams: Map<string, ReturnType<typeof express.response.write>[]> = new Map();

function sseWrite(taskId: string, chunk: unknown, done = false): void {
  const listeners = _streams.get(taskId) || [];
  const data = JSON.stringify({ taskId, chunk, done });
  for (const res of listeners) {
    try { (res as any).write(`data: ${data}\n\n`); } catch (_) {}
    if (done) { try { (res as any).end(); } catch (_) {} }
  }
  if (done) _streams.delete(taskId);
}

// ── Agent Card ─────────────────────────────────────────────────────
app.get('/.well-known/agent.json', (_req, res) => {
  res.json(agentCard);
});

// ── JSON-RPC 2.0 엔드포인트 ────────────────────────────────────────
app.post('/a2a', async (req, res) => {
  const { jsonrpc, method, id, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
  }

  try {
    if (method === 'tasks/send') {
      const result = await handleTask(params);
      return res.json({ jsonrpc: '2.0', id, result });
    }

    if (method === 'messages/send') {
      const result = handleMessage(params);
      return res.json({ jsonrpc: '2.0', id, result });
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: msg } });
  }
});

// ── 알림 수신 ──────────────────────────────────────────────────────
app.post('/a2a/notify', (req, res) => {
  handleNotification(req.body);
  res.json({ ok: true });
});

// ── SSE 스트리밍 ───────────────────────────────────────────────────
app.get('/a2a/stream/:taskId', (req, res) => {
  const { taskId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const bucket = _streams.get(taskId) || [];
  bucket.push(res);
  _streams.set(taskId, bucket);

  req.on('close', () => {
    const bucket = (_streams.get(taskId) || []).filter(r => r !== res);
    if (bucket.length) _streams.set(taskId, bucket);
    else _streams.delete(taskId);
  });
});

// ── 헬스체크 ──────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, agent: agentCard.name }));

app.listen(PORT, () => {
  console.log(`[Luna][A2A] 서버 가동 :${PORT}`);
});

export { sseWrite, registerSkillHandler };
