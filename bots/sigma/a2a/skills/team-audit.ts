// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerTeamAuditSkill(): void {
  registerSkillHandler('team-audit', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { team?: string; dimensions?: string[] };
    const team = p?.team || 'all';
    const dimensions = p?.dimensions || ['autonomy', 'cost', 'reliability', 'a2a'];

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let auditResult: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/sigma/team-audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team, dimensions }),
      });
      if (res.ok) auditResult = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'team-audit', team, dimensions, auditResult, auditedAt: new Date().toISOString() },
    };
  });
}
