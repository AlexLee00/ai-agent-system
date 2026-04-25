const { z } = require('zod');

const VALID_ABSTRACT_MODELS = ['anthropic_haiku', 'anthropic_sonnet', 'anthropic_opus'];
const VALID_PRIORITY = ['low', 'normal', 'high', 'critical'];

const LlmCallBodySchema = z.object({
  prompt: z.string().min(1),
  abstractModel: z.enum(VALID_ABSTRACT_MODELS),
  systemPrompt: z.string().optional(),
  jsonSchema: z.any().optional(),
  timeoutMs: z.number().int().positive().max(180_000).optional(),
  maxBudgetUsd: z.number().positive().optional(),
  agent: z.string().trim().min(1).max(120).optional(),
  callerTeam: z.string().trim().min(1).max(120).optional(),
  urgency: z.enum(VALID_PRIORITY).optional(),
  taskType: z.string().trim().min(1).max(120).optional(),
  priority: z.enum(VALID_PRIORITY).optional(),
  cacheEnabled: z.boolean().optional(),
  cacheType: z.string().trim().min(1).max(64).optional(),
}).passthrough();

function parseLlmCallPayload(body) {
  const parsed = LlmCallBodySchema.safeParse(body ?? {});
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  return {
    ok: false,
    error: {
      code: 'invalid_llm_call_payload',
      message: 'invalid llm call payload',
      details: parsed.error.flatten(),
    },
  };
}

module.exports = {
  VALID_ABSTRACT_MODELS,
  VALID_PRIORITY,
  parseLlmCallPayload,
};
