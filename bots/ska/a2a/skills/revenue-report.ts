// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerRevenueReportSkill(): void {
  registerSkillHandler('revenue-report', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { period?: 'day' | 'week' | 'month' };
    const period = p?.period || 'day';

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let report: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/ska/revenue?period=${period}`);
      if (res.ok) report = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'revenue-report', period, report, reportedAt: new Date().toISOString() },
    };
  });
}
