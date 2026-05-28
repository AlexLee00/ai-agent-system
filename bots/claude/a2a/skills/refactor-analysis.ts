// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';
import { completed } from './symphony-common.ts';

const REFACTOR_MCP_BASE = process.env.REFACTOR_MCP_URL || 'http://localhost:8774';

async function callRefactorMcp(tool: string, params: unknown): Promise<unknown> {
  try {
    const res = await fetch(`${REFACTOR_MCP_BASE}/tools/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function runRefactorAnalysis(params: unknown): Promise<A2ATaskResult> {
  const p = params && typeof params === 'object' ? (params as any) : {};
  const targetPath = p.path || p.target || 'bots';
  const mode = p.mode || 'analyze';

  let result: unknown;

  if (mode === 'analyze') {
    result = await callRefactorMcp('analyze_tech_debt', { path: targetPath });
  } else if (mode === 'suggest') {
    result = await callRefactorMcp('suggest_refactoring', { file: targetPath });
  } else if (mode === 'verify') {
    result = await callRefactorMcp('verify_refactoring', { after: targetPath, before: p.before });
  } else {
    result = { ok: false, error: `unknown mode: ${mode}` };
  }

  return completed('refactor-analysis', {
    mode,
    target: targetPath,
    result,
  });
}

export function registerRefactorAnalysisSkill(): void {
  registerSkillHandler('refactor-analysis', runRefactorAnalysis);
}
