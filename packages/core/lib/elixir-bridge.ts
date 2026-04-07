import { z } from 'zod';
import { EventRecordSchema } from './event-lake.core.js';
import { MessageEnvelopeSchema } from './message-envelope.core.js';
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
