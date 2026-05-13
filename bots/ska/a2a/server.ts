// @ts-nocheck
/**
 * Ska A2A Server — Google A2A Protocol (JSON-RPC 2.0 + SSE)
 * Port: 8772
 */

import { createRequire } from 'module';
import { handleTask, registerSkillHandler } from './handlers/task-handler.ts';
import { handleMessage } from './handlers/message-handler.ts';
import { handleNotification } from './handlers/notification-handler.ts';
import { registerReservationStatusSkill } from './skills/reservation-status.ts';
import { registerRevenueReportSkill } from './skills/revenue-report.ts';
import { registerPromotionGateSkill } from './skills/promotion-gate.ts';
import { registerKioskHealthSkill } from './skills/kiosk-health.ts';
import { registerTodayAuditSkill } from './skills/today-audit.ts';

const _require = createRequire(import.meta.url);
const express = _require('express');

const agentCard = JSON.parse(
  await import('fs').then(m => m.readFileSync(new URL('./ska-card.json', import.meta.url), 'utf-8'))
);

const PORT = parseInt(process.env.SKA_A2A_PORT || '8772', 10);
const app = express();
app.use(express.json());

registerReservationStatusSkill();
registerRevenueReportSkill();
registerPromotionGateSkill();
registerKioskHealthSkill();
registerTodayAuditSkill();

const _streams: Map<string, any[]> = new Map();

function sseWrite(taskId: string, chunk: unknown, done = false): void {
  const listeners = _streams.get(taskId) || [];
  const data = JSON.stringify({ taskId, chunk, done });
  for (const res of listeners) {
    try { (res as any).write(`data: ${data}\n\n`); } catch (_) {}
    if (done) { try { (res as any).end(); } catch (_) {} }
  }
  if (done) _streams.delete(taskId);
}

app.get('/.well-known/agent.json', (_req, res) => { res.json(agentCard); });

app.post('/a2a', async (req, res) => {
  const { jsonrpc, method, id, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
  }
  try {
    if (method === 'tasks/send') return res.json({ jsonrpc: '2.0', id, result: await handleTask(params) });
    if (method === 'messages/send') return res.json({ jsonrpc: '2.0', id, result: handleMessage(params) });
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
  }
});

app.post('/a2a/notify', (req, res) => { handleNotification(req.body); res.json({ ok: true }); });

app.get('/a2a/stream/:taskId', (req, res) => {
  const { taskId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const bucket = _streams.get(taskId) || [];
  bucket.push(res);
  _streams.set(taskId, bucket);
  req.on('close', () => {
    const b = (_streams.get(taskId) || []).filter(r => r !== res);
    if (b.length) _streams.set(taskId, b); else _streams.delete(taskId);
  });
});

app.get('/health', (_req, res) => res.json({ ok: true, agent: agentCard.name }));

app.listen(PORT, () => { console.log(`[Ska][A2A] 서버 가동 :${PORT}`); });

export { sseWrite, registerSkillHandler };
