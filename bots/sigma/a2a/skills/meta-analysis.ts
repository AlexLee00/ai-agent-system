// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerMetaAnalysisSkill(): void {
  registerSkillHandler('meta-analysis', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { period?: string; teams?: string[] };
    const period = p?.period || '7d';
    const teams = p?.teams || ['luna', 'darwin', 'blog', 'claude', 'ska'];

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let summary: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/sigma/meta-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period, teams }),
      });
      if (res.ok) summary = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'meta-analysis', period, teams, summary, analyzedAt: new Date().toISOString() },
    };
  });
}
