import { z } from 'zod';

export const EventSeveritySchema = z.enum(['debug', 'info', 'warn', 'error', 'critical']);

export const EventRecordSchema = z.object({
  eventType: z.string().min(1),
  team: z.string().optional(),
  botName: z.string().optional(),
  severity: EventSeveritySchema.optional(),
  traceId: z.string().optional(),
  title: z.string().optional(),
  message: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const EventLakeSearchSchema = z.object({
  q: z.string().optional(),
  eventType: z.string().optional(),
  team: z.string().optional(),
  severity: EventSeveritySchema.optional(),
  botName: z.string().optional(),
  minutes: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

export const EventLakeFeedbackSchema = z.object({
  score: z.number().nullable().optional(),
  feedback: z.string().optional(),
});

export const EventLakeRowSchema = z.object({
  id: z.number().int(),
  event_type: z.string(),
  team: z.string(),
  bot_name: z.string(),
  severity: EventSeveritySchema,
  trace_id: z.string().nullable().optional(),
  title: z.string(),
  message: z.string(),
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()).or(z.array(z.unknown())).or(z.unknown()),
  feedback_score: z.number().nullable().optional(),
  feedback: z.string().nullable().optional(),
  created_at: z.union([z.string(), z.date()]),
  updated_at: z.union([z.string(), z.date()]),
});

export const EventLakeStatsSchema = z.object({
  window_minutes: z.number().int(),
  total: z.number().int(),
  errors: z.number().int(),
  warnings: z.number().int(),
  teams: z.number().int(),
  bots: z.number().int(),
  services: z.array(z.record(z.string(), z.unknown())),
});

export type EventSeverity = z.infer<typeof EventSeveritySchema>;
export type EventRecordInput = z.infer<typeof EventRecordSchema>;
export type EventLakeSearchInput = z.infer<typeof EventLakeSearchSchema>;
export type EventLakeFeedbackInput = z.infer<typeof EventLakeFeedbackSchema>;
export type EventLakeRow = z.infer<typeof EventLakeRowSchema>;
export type EventLakeStats = z.infer<typeof EventLakeStatsSchema>;
