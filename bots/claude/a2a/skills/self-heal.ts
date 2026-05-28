import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';
import { buildSafety, completed, dryRunEnabled, hubJson, textOf } from './symphony-common.ts';

function classifyLevel(input: unknown): number {
  const explicit = Number((input as any)?.level || (input as any)?.severity || 0);
  if (explicit >= 1 && explicit <= 3) return explicit;
  const text = textOf(input).toLowerCase();
  if (/data loss|secret|security|rollback|kill|unload|시크릿|보안|롤백/.test(text)) return 3;
  if (/restart|crash|timeout|down|재시작|중단/.test(text)) return 2;
  return 1;
}

export async function runSelfHeal(params: unknown): Promise<A2ATaskResult> {
  const p = params && typeof params === 'object' ? params as any : {};
  const dryRun = dryRunEnabled(params);
  const level = classifyLevel(p);
  const blockedReason = level >= 3 && p.execute === true
    ? 'level3_self_heal_requires_separate_operator_approval_path'
    : null;
  const execute = p.execute === true && !dryRun && !blockedReason;
  const target = String(p.target || p.service || 'claude-team');
  const plan = [
    { level: 1, name: 'diagnose_only', action: 'collect health/error context', automatic: true },
    { level: 2, name: 'safe_config_or_restart_plan', action: 'prepare non-destructive fix plan', automatic: level <= 2 },
    { level: 3, name: 'patch_or_protected_action', action: 'requires explicit operator approval', automatic: false },
  ];
  const healResult = execute
    ? await hubJson('/api/claude/doctor/heal', { method: 'POST', body: { target, level } })
    : null;

  return completed('self-heal', {
    mode: execute ? 'self_heal_execute' : blockedReason ? 'self_heal_blocked' : 'self_heal_plan',
    target,
    level,
    plan,
    blockedActions: ['protected_launchd_restart', 'secret_mutation', 'rollback_without_explicit_approval'],
    blockedReason,
    healResult,
    safety: buildSafety(dryRun, { mutatesHub: execute, protectedActionBlocked: level >= 3 }),
  });
}

export function registerSelfHealSkill(): void {
  registerSkillHandler('self-heal', runSelfHeal);
}
