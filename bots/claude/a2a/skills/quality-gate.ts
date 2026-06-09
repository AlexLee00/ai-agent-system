import { createRequire } from 'module';
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';
import { buildSafety, completed } from './symphony-common.ts';

const require = createRequire(__filename);
const { buildSymphonyValidationPlan } = require('../../lib/symphony/validation-adapter.ts');

function passValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object') {
    if ((value as any).pass !== undefined) return Boolean((value as any).pass);
    if ((value as any).ok !== undefined) return Boolean((value as any).ok);
    if ((value as any).status !== undefined) return ['pass', 'passed', 'ok', 'success'].includes(String((value as any).status).toLowerCase());
  }
  return false;
}

export async function runQualityGate(params: unknown): Promise<A2ATaskResult> {
  const p = params && typeof params === 'object' ? params as any : {};
  const task = p.task || { id: p.taskId || 'unpersisted-task' };
  const validationPlan = buildSymphonyValidationPlan(task);
  const checks = {
    reviewer: passValue(p.reviewer || p.review),
    guardian: passValue(p.guardian || p.security),
    builder: passValue(p.builder || p.build),
    test_runner: passValue(p.test_runner || p.tests || p.test),
  };
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  const status = failed.length === 0 ? 'promotion_ready' : 'promotion_blocked';

  return completed('quality-gate', {
    mode: 'promotion_gate',
    status,
    pass: failed.length === 0,
    failed,
    checks,
    validationPlan,
    safety: buildSafety(true),
  });
}

export function registerQualityGateSkill(): void {
  registerSkillHandler('quality-gate', runQualityGate);
}
