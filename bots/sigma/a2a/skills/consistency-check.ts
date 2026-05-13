// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerConsistencyCheckSkill(): void {
  registerSkillHandler('consistency-check', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { scope?: 'config' | 'schema' | 'llm' | 'all' };
    const scope = p?.scope || 'all';

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let issues: unknown[] = [];
    try {
      const res = await fetch(`${HUB_URL}/api/sigma/consistency-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      if (res.ok) issues = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'consistency-check', scope, issues, checkedAt: new Date().toISOString() },
    };
  });
}
