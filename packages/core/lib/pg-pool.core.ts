import { z } from 'zod';

export const PgSchemaNameSchema = z.enum([
  'claude',
  'reservation',
  'investment',
  'ska',
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

export const PoolHealthIssueSchema = z.object({
  schema: z.string(),
  status: z.string(),
  detail: z.string(),
});

export const PoolHealthSchema = z.object({
  stats: z.array(PoolStatsSchema),
  issues: z.array(PoolHealthIssueSchema),
});

export type PgSchemaName = z.infer<typeof PgSchemaNameSchema>;
export type PoolStats = z.infer<typeof PoolStatsSchema>;
export type PoolHealthIssue = z.infer<typeof PoolHealthIssueSchema>;
export type PoolHealth = z.infer<typeof PoolHealthSchema>;
