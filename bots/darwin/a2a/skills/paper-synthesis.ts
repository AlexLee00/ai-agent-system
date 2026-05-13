// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerPaperSynthesisSkill(): void {
  registerSkillHandler('paper-synthesis', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { keywords?: string[]; limit?: number };
    const keywords = p?.keywords || ['LLM', 'agent', 'finance'];
    const limit = p?.limit || 5;

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let papers: unknown[] = [];
    try {
      const res = await fetch(`${HUB_URL}/api/darwin/papers/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords, limit }),
      });
      if (res.ok) papers = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'paper-synthesis', keywords, papers, synthesizedAt: new Date().toISOString() },
    };
  });
}
