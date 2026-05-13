// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerOptimizationProposalSkill(): void {
  registerSkillHandler('optimization-proposal', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { focus?: 'cost' | 'performance' | 'reliability' | 'all' };
    const focus = p?.focus || 'all';

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let proposals: unknown[] = [];
    try {
      const res = await fetch(`${HUB_URL}/api/sigma/optimization-proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focus }),
      });
      if (res.ok) proposals = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'optimization-proposal', focus, proposals, proposedAt: new Date().toISOString() },
    };
  });
}
