// @ts-nocheck
import { createRequire } from 'module';
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

const require = createRequire(import.meta.url);

async function callSigmaLibraryMcp(method: string, params: Record<string, unknown> = {}) {
  const url = process.env.SIGMA_LIBRARY_MCP_URL || 'http://127.0.0.1:4097/rpc';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `blog-${Date.now()}`, method, params }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) {
      return { ok: false, skipped: true, reason: body?.error?.message || `http_${res.status}` };
    }
    return { ok: true, result: body.result };
  } catch (error) {
    return { ok: false, skipped: true, reason: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export function registerBlogRemodelOpsSkills(): void {
  registerSkillHandler('great-library-w-axis', async (): Promise<A2ATaskResult> => ({
    id: '',
    status: 'completed',
    output: {
      ok: true,
      skill: 'great-library-w-axis',
      mode: 'metadata_only',
      summary: 'Blog vault feed contributes W-axis unverified findings through Sigma; writes remain outside A2A.',
    },
  }));

  registerSkillHandler('sigma-success-pattern', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { query?: string; limit?: number };
    const list = await callSigmaLibraryMcp('tools/list');
    if (!list.ok) {
      return { id: '', status: 'completed', output: { ok: true, skipped: true, reason: list.reason } };
    }
    const search = await callSigmaLibraryMcp('tools/call', {
      name: 'library-search',
      arguments: {
        query: p?.query || 'blog success_pattern writing crank validated',
        limit: Math.max(1, Math.min(10, Number(p?.limit || 5))),
        layerSearchEnabled: true,
        intent: '전략반영',
      },
    });
    return {
      id: '',
      status: 'completed',
      output: {
        ok: true,
        skill: 'sigma-success-pattern',
        mode: 'read_only',
        sigma: search,
      },
    };
  });

  registerSkillHandler('comment-evolution-proposal', async (): Promise<A2ATaskResult> => {
    const { runCommentStrategyEvolver } = require('../../lib/comment-strategy-evolver.ts');
    const report = await runCommentStrategyEvolver({ days: 7, write: false });
    return {
      id: '',
      status: 'completed',
      output: { ok: true, skill: 'comment-evolution-proposal', shadowOnly: true, report },
    };
  });
}
