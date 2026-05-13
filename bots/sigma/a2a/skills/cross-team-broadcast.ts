// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import { broadcast } from '../client.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerCrossTeamBroadcastSkill(): void {
  registerSkillHandler('cross-team-broadcast', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { type?: string; payload?: unknown; targets?: string[] };
    const type = p?.type || 'sigma-insight';
    const payload = p?.payload || {};
    const targets = p?.targets;

    await broadcast({ type, payload }, targets);

    return {
      id: '',
      status: 'completed',
      output: { skill: 'cross-team-broadcast', type, broadcastAt: new Date().toISOString() },
    };
  });
}
