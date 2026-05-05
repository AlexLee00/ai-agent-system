import {
  planSelfImprovement,
  type SelfImprovementSignal,
  type SkillExtractionPlan,
} from './intelligent-library.js';
import { initSchema, get } from '../../../investment/shared/db.ts';
import { upsertPosttradeSkill } from '../../../investment/shared/db/posttrade.ts';

export interface PromptCandidate {
  promptName: string;
  support: number;
  status: 'shadow';
  reason: string;
}

export interface SelfImprovementPlan {
  ok: boolean;
  status: string;
  dryRun: boolean;
  activation: {
    selfImprovementEnabled: boolean;
    voyagerSkillAutoExtractionEnabled: boolean;
    fineTuningNotifyEnabled: boolean;
    autonomyMode: string;
    applyMode: SelfImprovementApplyMode;
    operatorApplyEnabled: boolean;
    voyagerApplyEnabled: boolean;
  };
  applyGate: {
    mode: SelfImprovementApplyMode;
    applyAllowed: boolean;
    applyBlocked: string | null;
  };
  promptCandidates: PromptCandidate[];
  skillCandidates: SkillExtractionPlan[];
  appliedSkills?: AppliedSkill[];
  skillCountBefore?: number | null;
  skillCountAfter?: number | null;
  fineTuneCandidate: {
    ready: boolean;
    support: number;
    reason: string;
  };
  nextActions: string[];
}

export type SelfImprovementApplyMode = 'shadow' | 'supervised' | 'autonomous';

export interface AppliedSkill {
  ok: boolean;
  kind: 'SUCCESS' | 'AVOID';
  team: string;
  agent: string;
  patternKey: string;
  support: number;
  rowId: string | number | null;
  appliedAt: string;
}

function boolEnv(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').toLowerCase());
}

function resolveApplyMode(value = process.env.SIGMA_SELF_IMPROVEMENT_APPLY_MODE): SelfImprovementApplyMode {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'supervised' || normalized === 'autonomous') return normalized;
  return 'shadow';
}

function buildApplyBlockedReason({
  dryRun,
  selfImprovementEnabled,
  voyagerSkillAutoExtractionEnabled,
  applyMode,
  skillCandidateCount,
}: {
  dryRun: boolean;
  selfImprovementEnabled: boolean;
  voyagerSkillAutoExtractionEnabled: boolean;
  applyMode: SelfImprovementApplyMode;
  skillCandidateCount: number;
}): string | null {
  if (dryRun) return 'self_improvement_dry_run';
  if (!selfImprovementEnabled) return 'self_improvement_disabled';
  if (!voyagerSkillAutoExtractionEnabled) return 'voyager_skill_auto_extraction_disabled';
  if (applyMode === 'shadow') return 'self_improvement_apply_not_enabled_in_operator';
  if (skillCandidateCount <= 0) return 'no_skill_candidates';
  return null;
}

export function buildSelfImprovementPlan(signals: SelfImprovementSignal[], opts: { dryRun?: boolean } = {}): SelfImprovementPlan {
  const dryRun = opts.dryRun !== false;
  const base = planSelfImprovement(signals);
  const supportByPrompt = new Map<string, number>();
  for (const signal of signals) {
    if (!signal.promptName || signal.outcome !== 'success') continue;
    supportByPrompt.set(signal.promptName, (supportByPrompt.get(signal.promptName) ?? 0) + 1);
  }

  const promptCandidates = base.promptCandidates.map((promptName) => ({
    promptName,
    support: supportByPrompt.get(promptName) ?? 0,
    status: 'shadow' as const,
    reason: 'success_pattern_candidate',
  }));

  const applyMode = resolveApplyMode();
  const selfImprovementEnabled = boolEnv('SIGMA_SELF_IMPROVEMENT_ENABLED');
  const voyagerSkillAutoExtractionEnabled = boolEnv('SIGMA_VOYAGER_SKILL_AUTO_EXTRACTION');
  const applyBlocked = buildApplyBlockedReason({
    dryRun,
    selfImprovementEnabled,
    voyagerSkillAutoExtractionEnabled,
    applyMode,
    skillCandidateCount: base.skillCandidates.length,
  });
  const fineTuneReady = base.fineTuneCandidate;
  return {
    ok: true,
    status: 'self_improvement_plan_ready',
    dryRun,
    activation: {
      selfImprovementEnabled,
      voyagerSkillAutoExtractionEnabled,
      fineTuningNotifyEnabled: boolEnv('SIGMA_FINE_TUNING_NOTIFY_ENABLED'),
      autonomyMode: process.env.SIGMA_LIBRARY_AUTONOMY_MODE || 'shadow',
      applyMode,
      operatorApplyEnabled: applyMode !== 'shadow',
      voyagerApplyEnabled: applyMode !== 'shadow' && voyagerSkillAutoExtractionEnabled,
    },
    applyGate: {
      mode: applyMode,
      applyAllowed: applyBlocked == null,
      applyBlocked,
    },
    promptCandidates,
    skillCandidates: base.skillCandidates,
    fineTuneCandidate: {
      ready: fineTuneReady,
      support: signals.length,
      reason: fineTuneReady ? 'dpo_or_activity_support_threshold_met' : 'insufficient_support_for_fine_tuning',
    },
    nextActions: [
      'review prompt candidates before analyst_prompts shadow insert',
      voyagerSkillAutoExtractionEnabled
        ? 'preview Voyager skill extraction candidates before promotion'
        : 'review skill candidates before SUCCESS/AVOID file promotion',
      'notify master only when fineTuneCandidate.ready=true',
    ],
  };
}

export function toPosttradeSkillPayload(candidate: SkillExtractionPlan) {
  const skillType = candidate.kind === 'SUCCESS' ? 'success' : 'avoid';
  const normalizedPattern = candidate.pattern
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'pattern';
  const patternKey = `sigma:${candidate.team}:${candidate.agent}:${skillType}:${normalizedPattern}`;
  return {
    market: 'all',
    agentName: `sigma.${candidate.agent}`,
    skillType,
    patternKey,
    title: `[Sigma ${candidate.kind}] ${candidate.pattern}`,
    summary: `Sigma self-improvement ${candidate.kind.toLowerCase()} pattern from ${candidate.support} supporting signal(s): ${candidate.pattern}`,
    invocationCount: candidate.support,
    successRate: candidate.kind === 'SUCCESS' ? 1 : 0,
    winCount: candidate.kind === 'SUCCESS' ? candidate.support : 0,
    lossCount: candidate.kind === 'AVOID' ? candidate.support : 0,
    sourceTradeIds: [],
    metadata: {
      source: 'sigma_self_improvement',
      team: candidate.team,
      agent: candidate.agent,
      kind: candidate.kind,
      fileName: candidate.fileName,
      support: candidate.support,
      applyMode: resolveApplyMode(),
    },
  };
}

async function countPosttradeSkills(): Promise<number | null> {
  const row = await get(`SELECT COUNT(*)::int AS cnt FROM investment.luna_posttrade_skills`, []).catch(() => null);
  const count = Number(row?.cnt);
  return Number.isFinite(count) ? count : null;
}

export async function runSelfImprovementPipeline(
  signals: SelfImprovementSignal[],
  opts: { dryRun?: boolean } = {},
): Promise<SelfImprovementPlan> {
  const plan = buildSelfImprovementPlan(signals, opts);
  plan.skillCountBefore = null;
  plan.skillCountAfter = null;
  plan.appliedSkills = [];

  await initSchema().catch(() => null);
  plan.skillCountBefore = await countPosttradeSkills();

  if (plan.applyGate.applyBlocked) {
    plan.skillCountAfter = plan.skillCountBefore;
    return plan;
  }

  for (const candidate of plan.skillCandidates) {
    const payload = toPosttradeSkillPayload(candidate);
    const row = await upsertPosttradeSkill(payload);
    plan.appliedSkills.push({
      ok: Boolean(row?.id),
      kind: candidate.kind,
      team: candidate.team,
      agent: candidate.agent,
      patternKey: payload.patternKey,
      support: candidate.support,
      rowId: row?.id ?? null,
      appliedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    });
  }

  plan.skillCountAfter = await countPosttradeSkills();
  return {
    ...plan,
    status: 'self_improvement_apply_complete',
  };
}

export function buildMonthlySelfImprovementFixture(): SelfImprovementSignal[] {
  return [
    ...Array.from({ length: 5 }, () => ({
      team: 'sigma',
      agent: 'librarian',
      outcome: 'success' as const,
      pattern: 'cross-team-memory-prefix',
      promptName: 'sigma_library_context_v1',
    })),
    ...Array.from({ length: 3 }, () => ({
      team: 'sigma',
      agent: 'librarian',
      outcome: 'failure' as const,
      pattern: 'dataset-export-without-lineage',
    })),
  ];
}
