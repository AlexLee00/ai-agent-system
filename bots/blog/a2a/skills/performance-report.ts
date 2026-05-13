// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerPerformanceReportSkill(): void {
  registerSkillHandler('performance-report', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { days?: number; top_n?: number };
    const days = p?.days || 7;
    const top_n = p?.top_n || 5;

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let report: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/blog/performance?days=${days}&top_n=${top_n}`);
      if (res.ok) report = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'performance-report', days, top_n, report, reportedAt: new Date().toISOString() },
    };
  });
}
