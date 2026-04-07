import { z } from 'zod';

const runtime = require('./hiring-contract.js') as {
  selectBestAgent: (role: string, team?: string | null, requirements?: HiringRequirements) => Promise<Record<string, unknown> | null>;
  createContractTask: (employerId: number | string, task: ContractTaskData) => Promise<Record<string, unknown>>;
  completeContractTask: (contractId: number | string, result?: HiringResult) => Promise<Record<string, unknown>>;
  listActiveContracts: (team?: string) => Promise<Record<string, unknown>[]>;
  getActiveContracts: (team?: string) => Promise<Record<string, unknown>[]>;
};

export const HiringModeSchema = z.enum(['balanced', 'greedy', 'explore']);
export const RegimeGuideSchema = z.object({
  agentWeights: z.record(z.string(), z.number()).optional(),
}).strict().optional();

export const HiringRequirementsSchema = z.object({
  limit: z.number().int().positive().optional(),
  mode: HiringModeSchema.optional(),
  taskHint: z.string().optional(),
  excludeNames: z.array(z.string()).optional(),
  regimeGuide: RegimeGuideSchema,
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

export type HiringRequirements = z.infer<typeof HiringRequirementsSchema>;
export type HiringResult = z.infer<typeof HiringResultSchema>;
export type ContractTaskData = z.infer<typeof ContractTaskDataSchema>;
export type RegimeGuide = NonNullable<z.infer<typeof RegimeGuideSchema>>;

export async function selectBestAgent(
  role: string,
  team: string | null = null,
  requirements: HiringRequirements = {},
): Promise<Record<string, unknown> | null> {
  return runtime.selectBestAgent(role, team, HiringRequirementsSchema.parse(requirements));
}

export async function createContractTask(
  employerId: number | string,
  task: ContractTaskData,
): Promise<Record<string, unknown>> {
  return runtime.createContractTask(employerId, ContractTaskDataSchema.parse(task));
}

export async function completeContractTask(
  contractId: number | string,
  result: HiringResult = {},
): Promise<Record<string, unknown>> {
  return runtime.completeContractTask(contractId, HiringResultSchema.parse(result));
}

export async function listActiveContracts(team?: string): Promise<Record<string, unknown>[]> {
  return runtime.listActiveContracts(team);
}

export async function getActiveContracts(team?: string): Promise<Record<string, unknown>[]> {
  return runtime.getActiveContracts(team);
}
