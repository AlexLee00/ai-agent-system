import type { Request, Response } from 'express';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT_ROOT = process.env.PROJECT_ROOT
  || path.resolve(typeof __dirname === 'string' ? __dirname : path.join(process.cwd(), 'bots/hub/lib/routes'), '../../../..');

type JaenongBackend = {
  operations: { handleJaenongCommand: (command: string, deps: Record<string, unknown>) => Promise<any> };
  db: { query: (...args: any[]) => Promise<any>; run: (...args: any[]) => Promise<any> };
};

let backendPromise: Promise<JaenongBackend> | null = null;

function loadBackend() {
  if (!backendPromise) {
    const operationsUrl = pathToFileURL(path.join(
      PROJECT_ROOT,
      'bots/investment/shared/jaenong-operations.ts',
    )).href;
    const dbUrl = pathToFileURL(path.join(PROJECT_ROOT, 'bots/investment/shared/db.ts')).href;
    backendPromise = Promise.all([import(operationsUrl), import(dbUrl)])
      .then(([operations, db]) => ({ operations, db }));
  }
  return backendPromise;
}

function responseText(result: any): string {
  if (result.action === 'status') {
    const state = result.state?.status || 'unknown';
    const ref = result.brief?.briefRef || 'none';
    const ack = result.ack?.acknowledgedAt ? 'acknowledged' : 'not-acked';
    return `JAENONG status=${state} brief=${ref} ack=${ack} shadow-only`;
  }
  return `JAENONG ${result.action} ok brief=${result.briefRef || 'none'} state=${result.state || 'shadow'} shadow-only`;
}

function isMasterChat(chatId: string): boolean {
  const allowed = new Set(String(process.env.MASTER_TELEGRAM_CHAT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
  return allowed.size > 0 && allowed.has(chatId);
}

export async function jaenongCommandRoute(req: Request, res: Response) {
  try {
    const command = String(req.body?.text || '').trim();
    if (!/^\/jaenong(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(command)) {
      return res.status(400).json({ ok: false, error: 'jaenong_command_invalid' });
    }
    const chatId = String(req.body?.chat_id || '').trim();
    if (!chatId || !isMasterChat(chatId)) {
      return res.status(403).json({ ok: false, error: 'jaenong_master_chat_required' });
    }
    const { operations, db } = await loadBackend();
    const result = await operations.handleJaenongCommand(command, {
      actor: `telegram-master:${chatId}`,
      queryFn: db.query,
      runFn: db.run,
    });
    return res.json({ ...result, message: responseText(result), executionConnected: false });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not_found/.test(message) ? 404 : 400;
    return res.status(status).json({ ok: false, error: message, executionConnected: false });
  }
}

export default { jaenongCommandRoute };
