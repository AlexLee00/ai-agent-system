import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const MESSAGE_TYPES = [
  'task_request',
  'task_result',
  'task_failed',
  'handoff_request',
  'handoff_complete',
  'approval_required',
  'approval_granted',
  'approval_denied',
  'alert',
  'status_update',
  'heartbeat',
] as const;

export const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;

export const MessageTypeSchema = z.enum(MESSAGE_TYPES);
export const PrioritySchema = z.enum(PRIORITIES);

export const MessageEnvelopeSchema = z.object({
  message_id: z.string().min(1),
  trace_id: z.string().min(1),
  run_id: z.string().nullable(),
  task_id: z.string().nullable(),
  from_bot: z.string().min(1),
  to_bot: z.string().min(1),
  message_type: MessageTypeSchema,
  timestamp: z.string().min(1),
  state_version: z.number().int().nonnegative(),
  correlation_id: z.string().nullable(),
  priority: PrioritySchema,
  requires_ack: z.boolean(),
  payload: z.record(z.string(), z.unknown()),
});

export const ApprovalRequestPayloadSchema = z.object({
  action_name: z.string().min(1),
  target_resource: z.string().default(''),
  reason: z.string().default(''),
  impact_summary: z.string().default(''),
  reversible: z.boolean().default(true),
  proposed_args: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export type MessageType = z.infer<typeof MessageTypeSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;
export type ApprovalRequestPayload = z.infer<typeof ApprovalRequestPayloadSchema>;

export interface CreateMessageOptions {
  trace_id?: string;
  run_id?: string | null;
  task_id?: string | null;
  state_version?: number;
  correlation_id?: string | null;
  priority?: Priority;
  requires_ack?: boolean;
}

export function createMessage(
  type: MessageType,
  from: string,
  to: string,
  payload: Record<string, unknown>,
  options: CreateMessageOptions = {},
): MessageEnvelope {
  const envelope: MessageEnvelope = {
    message_id: randomUUID(),
    trace_id: options.trace_id || randomUUID(),
    run_id: options.run_id ?? null,
    task_id: options.task_id ?? null,
    from_bot: from,
    to_bot: to,
    message_type: type,
    timestamp: new Date().toISOString(),
    state_version: options.state_version ?? 1,
    correlation_id: options.correlation_id ?? null,
    priority: options.priority ?? 'normal',
    requires_ack: options.requires_ack ?? false,
    payload,
  };
  return MessageEnvelopeSchema.parse(envelope);
}

export function createReply(
  originalMessage: MessageEnvelope,
  type: MessageType,
  from: string,
  payload: Record<string, unknown>,
  options: CreateMessageOptions = {},
): MessageEnvelope {
  return createMessage(type, from, originalMessage.from_bot, payload, {
    trace_id: originalMessage.trace_id,
    run_id: originalMessage.run_id,
    task_id: originalMessage.task_id,
    correlation_id: originalMessage.message_id,
    state_version: (originalMessage.state_version || 0) + 1,
    ...options,
  });
}

export function createApprovalRequest(from: string, payload: ApprovalRequestPayload): MessageEnvelope {
  const normalized = ApprovalRequestPayloadSchema.parse(payload);
  return createMessage('approval_required', from, 'master', normalized, {
    priority: 'high',
    requires_ack: true,
    trace_id: normalized.trace_id as string | undefined,
  });
}

export function priorityToAlertLevel(priority: Priority): number {
  const map: Record<Priority, number> = {
    low: 1,
    normal: 1,
    high: 2,
    critical: 3,
  };
  return map[priority] || 1;
}
