import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerHypothesisGenerationSkill(): void {
  registerSkillHandler('hypothesis-generation', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { context?: string; team?: string };
    const context = p?.context || '';
    const team = p?.team || 'all';

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let hypotheses: unknown[] = [];
    try {
      const res = await fetch(`${HUB_URL}/api/darwin/hypothesis/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, team }),
      });
      if (res.ok) hypotheses = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'hypothesis-generation', team, hypotheses, generatedAt: new Date().toISOString() },
    };
  });
}
