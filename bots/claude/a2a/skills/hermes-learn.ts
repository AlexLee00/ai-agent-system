// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';
import { buildSafety, completed, textOf, toStringArray } from './symphony-common.ts';

function signalConfidence(evidence: unknown[]): number {
  const countScore = Math.min(0.5, evidence.length * 0.08);
  const text = textOf(evidence).toLowerCase();
  const repeated = /(same|repeat|recurring|반복|재발|패턴)/.test(text) ? 0.25 : 0;
  const verified = /(verified|test pass|smoke pass|검증|통과)/.test(text) ? 0.2 : 0;
  return Math.min(0.95, 0.2 + countScore + repeated + verified);
}

export async function runHermesLearn(params: unknown): Promise<A2ATaskResult> {
  const p = params && typeof params === 'object' ? params as any : {};
  const evidence = Array.isArray(p.evidence) ? p.evidence : toStringArray(p.evidence);
  const domain = String(p.domain || p.team || 'claude');
  const confidence = signalConfidence(evidence);
  const patternKey = String(p.patternKey || `${domain}:${textOf([p.title, evidence]).toLowerCase().replace(/[^a-z0-9가-힣]+/gi, '-').slice(0, 80) || 'operational-pattern'}`);
  const promote = confidence >= Number(p.minConfidence || 0.7);

  return completed('hermes-learn', {
    mode: 'hermes_4_stage_loopback_plan',
    patternKey,
    confidence,
    stages: [
      { id: 1, name: 'observe', status: evidence.length > 0 ? 'ready' : 'blocked', evidenceCount: evidence.length },
      { id: 2, name: 'extract', status: confidence >= 0.4 ? 'ready' : 'blocked', patternKey },
      { id: 3, name: 'promote', status: promote ? 'ready' : 'blocked', targetSkill: `${domain}-learned-pattern` },
      { id: 4, name: 'verify', status: promote ? 'pending_quality_gate' : 'blocked', requiredSkill: 'quality-gate' },
    ],
    skillCandidate: promote
      ? {
          id: `${domain}-learned-pattern`,
          sourcePattern: patternKey,
          targetFilesystemSkill: domain === 'claude' ? 'learning-skill' : `${domain}-skill`,
          writesFiles: false,
        }
      : null,
    safety: buildSafety(true),
  });
}

export function registerHermesLearnSkill(): void {
  registerSkillHandler('hermes-learn', runHermesLearn);
}
