// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerTodayAuditSkill(): void {
  registerSkillHandler('today-audit', async (_params: unknown): Promise<A2ATaskResult> => {
    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let auditResult: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/ska/today-audit`);
      if (res.ok) auditResult = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'today-audit', auditResult, auditedAt: new Date().toISOString() },
    };
  });
}
