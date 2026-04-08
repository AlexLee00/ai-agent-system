import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

type TraceContext = {
  trace_id: string;
  started_at: number;
  [key: string]: any;
};

export const traceStore = new AsyncLocalStorage<TraceContext>();

export function startTrace(metadata: Record<string, any> = {}): TraceContext {
  return {
    trace_id: randomUUID(),
    started_at: Date.now(),
    ...metadata,
  };
}

export function getTraceId(): string | null {
  const store = traceStore.getStore();
  return store?.trace_id || null;
}

export function getTraceContext(): TraceContext | null {
  return traceStore.getStore() || null;
}

export function withTrace<T>(traceContext: TraceContext, fn: () => T): T {
  return traceStore.run(traceContext, fn);
}

export function continueTrace<T>(traceId: string, fn: () => T, extra: Record<string, any> = {}): T {
  const ctx: TraceContext = {
    trace_id: traceId,
    continued: true,
    started_at: Date.now(),
    ...extra,
  };
  return traceStore.run(ctx, fn);
}

export function traceLog(level: string, message: string, data: Record<string, any> = {}) {
  const traceId = getTraceId();
  const enriched = traceId ? { trace_id: traceId, ...data } : data;
  const prefix = traceId ? `[${traceId.slice(0, 8)}]` : '';
  const consoleMap = console as unknown as Record<string, (...args: any[]) => void>;
  const fn = consoleMap[level] || console.log;
  fn(`${prefix} ${message}`, Object.keys(enriched).length > 0 ? enriched : '');
}
