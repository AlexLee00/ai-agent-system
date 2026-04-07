import { z } from 'zod';

export const HiringModeSchema = z.enum(['balanced', 'greedy', 'explore']);

export const RegimeGuideSchema = z.object({
  agentWeights: z.record(z.string(), z.number()).optional(),
}).strict();

export const HiringRequirementsSchema = z.object({
  limit: z.number().int().positive().optional(),
  mode: HiringModeSchema.optional(),
  taskHint: z.string().optional(),
  excludeNames: z.array(z.string()).optional(),
  regimeGuide: RegimeGuideSchema.optional(),
  quality_min: z.number().optional(),
  deadline_ms: z.number().int().positive().optional(),
});

export const HiringResultSchema = z.object({
  quality: z.number().optional(),
  duration_ms: z.number().optional(),
  hallucination: z.boolean().optional(),
});

export const ContractTaskDataSchema = z.object({
  team: z.string().optional(),
  employer_team: z.string().optional(),
  employerTeam: z.string().optional(),
  description: z.string().optional(),
  task: z.string().optional(),
  requirements: HiringRequirementsSchema.optional(),
  reward: z.record(z.string(), z.unknown()).optional(),
  penalty: z.record(z.string(), z.unknown()).optional(),
});

export type HiringMode = z.infer<typeof HiringModeSchema>;
export type RegimeGuide = z.infer<typeof RegimeGuideSchema>;
export type HiringRequirements = z.infer<typeof HiringRequirementsSchema>;
export type HiringResult = z.infer<typeof HiringResultSchema>;
export type ContractTaskData = z.infer<typeof ContractTaskDataSchema>;
