import { randomBytes } from 'node:crypto';
import { getTraceContext, traceStore } from './trace';

export type CycleTraceContext = {
  trace_id: string;
  traceId: string;
  cycle_id: string;
  cycleId: string;
  kind: string;
  started_at: number;
  startedAt: number;
  [key: string]: any;
};

function cleanKind(kind: string): string {
  return String(kind || 'cycle')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'cycle';
}

function makeTraceId(): string {
  return randomBytes(16).toString('hex');
}

function makeCycleId(kind: string, traceId: string): string {
  return `${cleanKind(kind)}:${Date.now().toString(36)}:${traceId.slice(0, 12)}`;
}

function normalizeCycleTrace(input: Record<string, any> = {}): CycleTraceContext {
  const kind = cleanKind(input.kind || 'cycle');
  const traceId = String(input.traceId || input.trace_id || '').trim() || makeTraceId();
  const cycleId = String(input.cycleId || input.cycle_id || '').trim() || makeCycleId(kind, traceId);
  const startedAt = Number(input.startedAt || input.started_at || Date.now()) || Date.now();
  return {
    ...input,
    trace_id: traceId,
    traceId,
    cycle_id: cycleId,
    cycleId,
    kind,
    started_at: startedAt,
    startedAt,
  };
}

export function createCycleTrace(kind = 'cycle', extra: Record<string, any> = {}): CycleTraceContext {
  return normalizeCycleTrace({ ...extra, kind });
}

export function getCurrentCycleTrace(): CycleTraceContext | null {
  const current = getTraceContext();
  if (!current) return null;
  const traceId = String(current.traceId || current.trace_id || '').trim();
  const cycleId = String(current.cycleId || current.cycle_id || current.metadata?.cycleId || current.metadata?.cycle_id || '').trim();
  if (!traceId && !cycleId) return null;
  return normalizeCycleTrace({
    ...current,
    traceId,
    cycleId: cycleId || `cycle:${traceId || makeTraceId()}`,
    kind: current.kind || current.cycleKind || current.metadata?.kind || 'cycle',
  });
}

export function getCurrentTracePropagation(): Record<string, string> {
  const current = getCurrentCycleTrace();
  if (!current) return {};
  return {
    traceId: current.traceId,
    trace_id: current.traceId,
    cycleId: current.cycleId,
    cycle_id: current.cycleId,
  };
}

export function withTrace<T>(ctx: Record<string, any>, fn: () => T): T {
  return traceStore.run(normalizeCycleTrace(ctx), fn);
}

