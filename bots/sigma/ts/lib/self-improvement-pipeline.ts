import {
  planSelfImprovement,
  type SelfImprovementSignal,
  type SkillExtractionPlan,
} from './intelligent-library.js';

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
  };
  promptCandidates: PromptCandidate[];
  skillCandidates: SkillExtractionPlan[];
  fineTuneCandidate: {
    ready: boolean;
    support: number;
    reason: string;
  };
  nextActions: string[];
}

function boolEnv(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').toLowerCase());
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

  const fineTuneReady = base.fineTuneCandidate;
  return {
    ok: true,
    status: 'self_improvement_plan_ready',
    dryRun,
    activation: {
      selfImprovementEnabled: boolEnv('SIGMA_SELF_IMPROVEMENT_ENABLED'),
      voyagerSkillAutoExtractionEnabled: boolEnv('SIGMA_VOYAGER_SKILL_AUTO_EXTRACTION'),
      fineTuningNotifyEnabled: boolEnv('SIGMA_FINE_TUNING_NOTIFY_ENABLED'),
      autonomyMode: process.env.SIGMA_LIBRARY_AUTONOMY_MODE || 'shadow',
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
      boolEnv('SIGMA_VOYAGER_SKILL_AUTO_EXTRACTION')
        ? 'preview Voyager skill extraction candidates before promotion'
        : 'review skill candidates before SUCCESS/AVOID file promotion',
      'notify master only when fineTuneCandidate.ready=true',
    ],
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
