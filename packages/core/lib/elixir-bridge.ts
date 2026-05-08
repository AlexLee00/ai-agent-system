import { z } from 'zod';
import { EventRecordSchema } from './event-lake.core.js';
import { MessageEnvelopeSchema } from './message-envelope.core.js';
import { createMessage } from './message-envelope.js';
import { MarketRegimeResultSchema } from '../../../bots/investment/shared/market-regime.core.js';

export const BridgePayloadSchema = z.object({
  envelope: MessageEnvelopeSchema.optional(),
  event: EventRecordSchema.optional(),
  regime: MarketRegimeResultSchema.optional(),
}).refine((value) => !!(value.envelope || value.event || value.regime), {
  message: 'at least one payload is required',
});

export type BridgePayload = z.infer<typeof BridgePayloadSchema>;

export function encodeBridgePayload(payload: BridgePayload): string {
  return JSON.stringify(BridgePayloadSchema.parse(payload));
}

export function decodeBridgePayload(serialized: string): BridgePayload {
  return BridgePayloadSchema.parse(JSON.parse(serialized));
}

export async function createOrchestrationBridgePayload({
  fromBot = 'luna',
  toBot = 'elixir',
  market,
  symbol = null,
  stage,
  sessionId = null,
  regime = null,
  severity = 'info',
}: {
  fromBot?: string;
  toBot?: string;
  market?: string | null;
  symbol?: string | null;
  stage?: string | null;
  sessionId?: string | null;
  regime?: unknown;
  severity?: 'debug' | 'info' | 'warn' | 'error' | 'critical';
} = {}): Promise<{ payload: BridgePayload; serialized: string }> {
  const envelope = createMessage('status_update', fromBot, toBot, {
    bridge: 'luna_orchestrate',
    market,
    symbol,
    stage,
  }, {
    run_id: sessionId,
    task_id: symbol,
    correlation_id: stage || null,
    priority: severity === 'error' || severity === 'critical' ? 'high' : 'normal',
  });

  const event = EventRecordSchema.parse({
    eventType: 'luna_orchestrate',
    team: 'luna',
    botName: fromBot,
    severity,
    traceId: sessionId || undefined,
    title: `${fromBot}:${stage || 'unknown'}`,
    message: [market || 'unknown', symbol || 'all', stage || 'unknown'].join(':'),
    tags: [
      'bridge:luna_orchestrate',
      market ? `market:${market}` : null,
      symbol ? `symbol:${symbol}` : null,
      stage ? `stage:${stage}` : null,
    ].filter(Boolean),
    metadata: {
      market,
      symbol,
      stage,
      sessionId,
    },
  });

  const payload = BridgePayloadSchema.parse(regime ? { envelope, event, regime } : { envelope, event });
  return {
    payload,
    serialized: encodeBridgePayload(payload),
  };
}
