// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerErrorDiagnosisSkill(): void {
  registerSkillHandler('error-diagnosis', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { error_log?: string; team?: string; since_minutes?: number };
    const team = p?.team || 'all';
    const since_minutes = p?.since_minutes || 60;

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let diagnosis: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/claude/archer/diagnose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error_log: p?.error_log, team, since_minutes }),
      });
      if (res.ok) diagnosis = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'error-diagnosis', team, diagnosis, diagnosedAt: new Date().toISOString() },
    };
  });
}
