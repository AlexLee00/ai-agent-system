import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerBillingCheckSkill(): void {
  registerSkillHandler('billing-check', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { period?: string };
    const period = p?.period || 'today';

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let billing: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/claude/billing?period=${period}`);
      if (res.ok) billing = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'billing-check', period, billing, checkedAt: new Date().toISOString() },
    };
  });
}
