// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerSeoAnalysisSkill(): void {
  registerSkillHandler('seo-analysis', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { keyword?: string };
    const keyword = p?.keyword || '';

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let analysis: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/blog/seo-analysis?keyword=${encodeURIComponent(keyword)}`);
      if (res.ok) analysis = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'seo-analysis', keyword, analysis, analyzedAt: new Date().toISOString() },
    };
  });
}
