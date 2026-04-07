import { z } from 'zod';

const runtime = require('./pg-pool.js') as {
  getPool: (schema: string) => unknown;
  parameterize: (sql: string) => string;
  query: <T = Record<string, unknown>>(schema: string, sql: string, params?: unknown[]) => Promise<T[]>;
  run: <T = Record<string, unknown>>(schema: string, sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: T[] }>;
  get: <T = Record<string, unknown>>(schema: string, sql: string, params?: unknown[]) => Promise<T | null>;
  prepare: (schema: string, sql: string) => {
    get: <T = Record<string, unknown>>(...args: unknown[]) => Promise<T | null>;
    all: <T = Record<string, unknown>>(...args: unknown[]) => Promise<T[]>;
    run: <T = Record<string, unknown>>(...args: unknown[]) => Promise<{ rowCount: number; rows: T[] }>;
  };
  transaction: <T>(schema: string, fn: (client: unknown) => Promise<T>) => Promise<T>;
  ping: (schema?: string) => Promise<boolean>;
  closeAll: () => Promise<void>;
  getPoolStats: (schema?: string) => unknown;
  getAllPoolStats: () => unknown[];
  checkPoolHealth: (threshold?: number) => unknown;
  getClient: (schema: string) => Promise<unknown>;
};

export const PgSchemaNameSchema = z.enum([
  'claude',
  'reservation',
  'investment',
  'ska',
  'worker',
  'blog',
  'agent',
  'sigma',
  'public',
]);

export const PoolStatsSchema = z.object({
  schema: z.string(),
  total: z.number().int(),
  idle: z.number().int(),
  waiting: z.number().int(),
  active: z.number().int(),
  utilization: z.string(),
});

export type PgSchemaName = z.infer<typeof PgSchemaNameSchema>;
export type PoolStats = z.infer<typeof PoolStatsSchema>;

export function getPool(schema: PgSchemaName): unknown {
  return runtime.getPool(PgSchemaNameSchema.parse(schema));
}

export function parameterize(sql: string): string {
  return runtime.parameterize(sql);
}

export async function query<T = Record<string, unknown>>(schema: PgSchemaName, sql: string, params: unknown[] = []): Promise<T[]> {
  return runtime.query<T>(PgSchemaNameSchema.parse(schema), sql, params);
}

export async function run<T = Record<string, unknown>>(schema: PgSchemaName, sql: string, params: unknown[] = []): Promise<{ rowCount: number; rows: T[] }> {
  return runtime.run<T>(PgSchemaNameSchema.parse(schema), sql, params);
}

export async function get<T = Record<string, unknown>>(schema: PgSchemaName, sql: string, params: unknown[] = []): Promise<T | null> {
  return runtime.get<T>(PgSchemaNameSchema.parse(schema), sql, params);
}

export function prepare(schema: PgSchemaName, sql: string) {
  return runtime.prepare(PgSchemaNameSchema.parse(schema), sql);
}

export async function transaction<T>(schema: PgSchemaName, fn: (client: unknown) => Promise<T>): Promise<T> {
  return runtime.transaction<T>(PgSchemaNameSchema.parse(schema), fn);
}

export async function ping(schema: PgSchemaName = 'public'): Promise<boolean> {
  return runtime.ping(PgSchemaNameSchema.parse(schema));
}

export async function closeAll(): Promise<void> {
  return runtime.closeAll();
}

export function getPoolStats(schema?: PgSchemaName): PoolStats | Record<string, PoolStats> | null {
  const value = schema ? runtime.getPoolStats(PgSchemaNameSchema.parse(schema)) : runtime.getPoolStats();
  if (!value) return null;
  if (schema) return PoolStatsSchema.parse(value);
  return z.record(z.string(), PoolStatsSchema).parse(value);
}

export function getAllPoolStats(): PoolStats[] {
  return z.array(PoolStatsSchema).parse(runtime.getAllPoolStats());
}

export function checkPoolHealth(threshold = 0.8): unknown {
  return runtime.checkPoolHealth(threshold);
}

export async function getClient(schema: PgSchemaName): Promise<unknown> {
  return runtime.getClient(PgSchemaNameSchema.parse(schema));
}
