const { z } = require('zod');
const { getPlaybookPhases } = require('./playbook');

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const STEP_SIDE_EFFECTS = ['none', 'read_only', 'write', 'external_mutation', 'money_movement'];
const PLAYBOOK_PHASES = getPlaybookPhases();

const ControlStepSchema = z.object({
  id: z.string().trim().min(1).max(120),
  tool: z.string().trim().min(1).max(200),
  args: z.record(z.any()).default({}),
  sideEffect: z.enum(STEP_SIDE_EFFECTS).default('read_only'),
  notes: z.string().trim().max(400).optional(),
});

const ControlVerifySchema = z.object({
  tool: z.string().trim().min(1).max(200),
  args: z.record(z.any()).default({}),
});

const PlaybookPhaseSchema = z.object({
  phase: z.enum(PLAYBOOK_PHASES),
  objective: z.string().trim().min(1).max(200),
  checks: z.array(z.string().trim().min(1).max(200)).min(1),
});

const ControlPlanSchema = z.object({
  goal: z.string().trim().min(1).max(400),
  team: z.string().trim().min(1).max(120).default('general'),
  risk: z.enum(RISK_LEVELS).default('low'),
  requiresApproval: z.boolean().default(false),
  dryRun: z.boolean().default(true),
  steps: z.array(ControlStepSchema).min(1),
  verify: z.array(ControlVerifySchema).default([]),
  playbook: z.object({
    phases: z.array(PlaybookPhaseSchema).min(6),
  }),
  metadata: z.record(z.any()).default({}),
});

const ControlPlanRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000).optional(),
  goal: z.string().trim().min(1).max(400).optional(),
  team: z.string().trim().min(1).max(120).optional(),
  dryRun: z.boolean().optional(),
  context: z.record(z.any()).optional(),
}).refine((value) => Boolean(value.message || value.goal), {
  message: 'message or goal is required',
});

function parseControlPlan(input) {
  const parsed = ControlPlanSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  return {
    ok: false,
    error: {
      code: 'invalid_control_plan',
      message: 'invalid control plan',
      details: parsed.error.flatten(),
    },
  };
}

function parseControlPlanRequest(input) {
  const parsed = ControlPlanRequestSchema.safeParse(input ?? {});
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  return {
    ok: false,
    error: {
      code: 'invalid_control_plan_request',
      message: 'invalid control plan request',
      details: parsed.error.flatten(),
    },
  };
}

function validateMutatingPlanPlaybook(plan) {
  const hasMutatingStep = Array.isArray(plan?.steps)
    && plan.steps.some((step) => !['none', 'read_only'].includes(String(step?.sideEffect || '')));
  if (!hasMutatingStep) return { ok: true };

  const phaseSet = new Set(
    (plan?.playbook?.phases || []).map((phase) => String(phase?.phase || '').trim()),
  );
  const required = ['frame', 'plan', 'review', 'test'];
  const missing = required.filter((phase) => !phaseSet.has(phase));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `mutating_plan_missing_playbook_phases:${missing.join(',')}`,
    };
  }
  return { ok: true };
}

module.exports = {
  RISK_LEVELS,
  STEP_SIDE_EFFECTS,
  ControlPlanSchema,
  ControlPlanRequestSchema,
  parseControlPlan,
  parseControlPlanRequest,
  validateMutatingPlanPlaybook,
};
