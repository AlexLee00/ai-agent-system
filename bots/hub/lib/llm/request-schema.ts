const { z } = require('zod');

const VALID_ABSTRACT_MODELS = ['anthropic_haiku', 'anthropic_sonnet', 'anthropic_opus'];
const VALID_PRIORITY = ['low', 'normal', 'high', 'critical'];
const DEFAULT_MAX_TIMEOUT_MS = 180_000;
const BLOG_WRITER_MAX_TIMEOUT_MS = 600_000;

const LlmCallBodySchema = z.object({
  prompt: z.string().min(1),
  abstractModel: z.enum(VALID_ABSTRACT_MODELS),
  systemPrompt: z.string().optional(),
  jsonSchema: z.any().optional(),
  timeoutMs: z.number().int().positive().max(BLOG_WRITER_MAX_TIMEOUT_MS).optional(),
  maxBudgetUsd: z.number().positive().optional(),
  agent: z.string().trim().min(1).max(120).optional(),
  selectorKey: z.string().trim().min(1).max(160).optional(),
  callerTeam: z.string().trim().min(1).max(120).optional(),
  urgency: z.enum(VALID_PRIORITY).optional(),
  taskType: z.string().trim().min(1).max(120).optional(),
  priority: z.enum(VALID_PRIORITY).optional(),
  cacheEnabled: z.boolean().optional(),
  cacheType: z.string().trim().min(1).max(64).optional(),
}).passthrough();

type LlmCallParseResult = {
  ok: true;
  data: Record<string, any>;
} | {
  ok: false;
  error: {
    code: string;
    message: string;
    details: unknown;
  };
};

function parseLlmCallPayload(body: unknown): LlmCallParseResult {
  const parsed = LlmCallBodySchema.safeParse(body ?? {});
  if (parsed.success) {
    const maxTimeoutMs = resolveMaxTimeoutMs(parsed.data);
    if (Number(parsed.data.timeoutMs || 0) > maxTimeoutMs) {
      return {
        ok: false,
        error: {
          code: 'invalid_llm_call_payload',
          message: 'invalid llm call payload',
          details: {
            fieldErrors: {
              timeoutMs: [`Number must be less than or equal to ${maxTimeoutMs}`],
            },
            formErrors: [],
          },
        },
      };
    }
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

function resolveMaxTimeoutMs(data: Record<string, any>): number {
  return isLongRunningBlogWriterRequest(data) ? BLOG_WRITER_MAX_TIMEOUT_MS : DEFAULT_MAX_TIMEOUT_MS;
}

function isLongRunningBlogWriterRequest(data: Record<string, any>): boolean {
  const callerTeam = String(data?.callerTeam || '').trim().toLowerCase();
  const selectorKey = String(data?.selectorKey || '').trim().toLowerCase();
  const agent = String(data?.agent || '').trim().toLowerCase();
  if (callerTeam !== 'blog') return false;
  return selectorKey === 'blog.pos.writer'
    || selectorKey === 'blog.gems.writer'
    || agent === 'pos'
    || agent === 'gems';
}

module.exports = {
  VALID_ABSTRACT_MODELS,
  VALID_PRIORITY,
  BLOG_WRITER_MAX_TIMEOUT_MS,
  DEFAULT_MAX_TIMEOUT_MS,
  isLongRunningBlogWriterRequest,
  parseLlmCallPayload,
};
