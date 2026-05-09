import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  SIGMA_TEAMS,
  evaluateConstitution,
  type SelfImprovementSignal,
  type SigmaTeam,
} from './intelligent-library.js';

const require = createRequire(import.meta.url);

const pgPool = require('../../../../packages/core/lib/pg-pool.js') as {
  query: <T = unknown>(schema: string, sql: string, params?: unknown[]) => Promise<T[]>;
};

export type LibrarySourceKind =
  | 'hub_alarm'
  | 'agent_message'
  | 'luna_reflexion'
  | 'sigma_directive'
  | 'dpo_preference'
  | 'mcp_usage';

export interface LibraryRecord {
  team: SigmaTeam;
  agent: string;
  sourceKind: LibrarySourceKind;
  sourceId: string;
  createdAt: string;
  text: string;
  piiRedactedText: string;
  redactions: string[];
  contentHash: string;
  payload: Record<string, unknown>;
  constitutionAllowed: boolean;
  constitutionCritiques: string[];
}

export interface LibraryDataSourceReport {
  ok: boolean;
  records: LibraryRecord[];
  warnings: string[];
  stats: {
    total: number;
    bySource: Record<string, number>;
    byTeam: Record<string, number>;
    redacted: number;
    constitutionBlocked: number;
  };
}

export interface LibraryPersistenceMetrics {
  entityRelationships: number;
  dataLineage: number;
  datasetSnapshots: number;
  warnings: string[];
}

export interface CollectLibraryRecordsOptions {
  sinceHours?: number;
  limitPerSource?: number;
  teams?: readonly SigmaTeam[];
}

function stableJson(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

function hashRecord(input: {
  team: string;
  agent: string;
  sourceKind: string;
  sourceId: string;
  createdAt: string;
  text: string;
  payload: unknown;
}): string {
  return crypto.createHash('sha256').update(stableJson(input)).digest('hex');
}

function normalizeTeam(value: unknown): SigmaTeam {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'investment') return 'luna';
  if (raw === 'reservation' || raw === 'eve') return 'ska';
  return (SIGMA_TEAMS as readonly string[]).includes(raw) ? raw as SigmaTeam : 'sigma';
}

function compactText(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (part == null) return '';
      if (typeof part === 'string') return part;
      return stableJson(part);
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8_000);
}

function buildRecord(input: {
  team: unknown;
  agent: unknown;
  sourceKind: LibrarySourceKind;
  sourceId: unknown;
  createdAt: unknown;
  text: string;
  payload: Record<string, unknown>;
}): LibraryRecord | null {
  const team = normalizeTeam(input.team);
  const agent = String(input.agent ?? 'unknown').trim() || 'unknown';
  const sourceId = `${input.sourceKind}:${String(input.sourceId ?? crypto.randomUUID())}`;
  const createdAt = input.createdAt ? new Date(String(input.createdAt)).toISOString() : new Date(0).toISOString();
  const text = input.text.trim();
  if (!text) return null;

  const constitution = evaluateConstitution({
    collection: team === 'justin' ? 'rag_legal' : `rag_${team}`,
    text,
    externalExport: false,
    masterApproved: false,
  });
  const redactions = constitution.critiques
    .filter((critique) => critique.startsWith('pii_redacted:'))
    .map((critique) => critique.slice('pii_redacted:'.length));
  const contentHash = hashRecord({
    team,
    agent,
    sourceKind: input.sourceKind,
    sourceId,
    createdAt,
    text: constitution.redactedText,
    payload: input.payload,
  });

  return {
    team,
    agent,
    sourceKind: input.sourceKind,
    sourceId,
    createdAt,
    text,
    piiRedactedText: constitution.redactedText,
    redactions,
    contentHash,
    payload: input.payload,
    constitutionAllowed: constitution.allowed,
    constitutionCritiques: constitution.critiques,
  };
}

async function safeQuery<T>(
  schema: string,
  label: string,
  sql: string,
  params: unknown[],
  warnings: string[],
): Promise<T[]> {
  try {
    return await pgPool.query<T>(schema, sql, params);
  } catch (error) {
    warnings.push(`${label}:${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function summarize(records: LibraryRecord[], warnings: string[]): LibraryDataSourceReport {
  const bySource: Record<string, number> = {};
  const byTeam: Record<string, number> = {};
  for (const record of records) {
    bySource[record.sourceKind] = (bySource[record.sourceKind] ?? 0) + 1;
    byTeam[record.team] = (byTeam[record.team] ?? 0) + 1;
  }
  return {
    ok: warnings.length === 0 || records.length > 0,
    records,
    warnings,
    stats: {
      total: records.length,
      bySource,
      byTeam,
      redacted: records.filter((record) => record.redactions.length > 0).length,
      constitutionBlocked: records.filter((record) => !record.constitutionAllowed).length,
    },
  };
}

export async function collectLibraryRecords(options: CollectLibraryRecordsOptions = {}): Promise<LibraryDataSourceReport> {
  const sinceHours = Math.max(1, Math.min(24 * 30, options.sinceHours ?? 24 * 7));
  const limit = Math.max(1, Math.min(500, options.limitPerSource ?? 80));
  const allowedTeams = new Set((options.teams ?? SIGMA_TEAMS).map((team) => normalizeTeam(team)));
  const warnings: string[] = [];
  const records: LibraryRecord[] = [];

  const hubAlarms = await safeQuery<any>('agent', 'agent.hub_alarms', `
    SELECT id, team, bot_name, severity, alarm_type, title, message, status, metadata, received_at
      FROM agent.hub_alarms
     WHERE received_at >= NOW() - ($1 || ' hours')::INTERVAL
     ORDER BY received_at DESC
     LIMIT $2
  `, [String(sinceHours), limit], warnings);
  for (const row of hubAlarms) {
    const record = buildRecord({
      team: row.team,
      agent: row.bot_name,
      sourceKind: 'hub_alarm',
      sourceId: row.id,
      createdAt: row.received_at,
      text: compactText([row.title, row.message, row.severity, row.alarm_type, row.status]),
      payload: {
        severity: row.severity,
        alarmType: row.alarm_type,
        status: row.status,
        metadata: row.metadata ?? {},
      },
    });
    if (record && allowedTeams.has(record.team)) records.push(record);
  }

  const agentMessages = await safeQuery<any>('investment', 'investment.agent_messages', `
    SELECT id, incident_key, from_agent, to_agent, message_type, payload, responded_at, created_at
      FROM investment.agent_messages
     WHERE created_at >= NOW() - ($1 || ' hours')::INTERVAL
     ORDER BY created_at DESC
     LIMIT $2
  `, [String(sinceHours), limit], warnings);
  for (const row of agentMessages) {
    const record = buildRecord({
      team: row.to_agent,
      agent: row.from_agent,
      sourceKind: 'agent_message',
      sourceId: row.id,
      createdAt: row.created_at,
      text: compactText([row.incident_key, row.message_type, row.payload]),
      payload: {
        incidentKey: row.incident_key,
        toAgent: row.to_agent,
        messageType: row.message_type,
        responded: Boolean(row.responded_at),
        payload: row.payload ?? {},
      },
    });
    if (record && allowedTeams.has(record.team)) records.push(record);
  }

  const reflexions = await safeQuery<any>('investment', 'investment.luna_failure_reflexions', `
    SELECT id, trade_id, hindsight, avoid_pattern, stage_attribution, created_at
      FROM investment.luna_failure_reflexions
     WHERE created_at >= NOW() - ($1 || ' hours')::INTERVAL
     ORDER BY created_at DESC
     LIMIT $2
  `, [String(sinceHours), limit], warnings);
  for (const row of reflexions) {
    const record = buildRecord({
      team: 'luna',
      agent: 'luna',
      sourceKind: 'luna_reflexion',
      sourceId: row.id,
      createdAt: row.created_at,
      text: compactText([row.hindsight, row.avoid_pattern, row.stage_attribution]),
      payload: {
        tradeId: row.trade_id,
        avoidPattern: row.avoid_pattern ?? {},
        stageAttribution: row.stage_attribution ?? {},
      },
    });
    if (record && allowedTeams.has(record.team)) records.push(record);
  }

  const directives = await safeQuery<any>('public', 'public.sigma_v2_directive_audit', `
    SELECT id, directive_id, tier, team, action, principle_check_result, outcome, rollback_spec, executed_at
      FROM public.sigma_v2_directive_audit
     WHERE executed_at >= NOW() - ($1 || ' hours')::INTERVAL
     ORDER BY executed_at DESC
     LIMIT $2
  `, [String(sinceHours), limit], warnings);
  for (const row of directives) {
    const record = buildRecord({
      team: row.team,
      agent: 'sigma',
      sourceKind: 'sigma_directive',
      sourceId: row.id ?? row.directive_id,
      createdAt: row.executed_at,
      text: compactText([row.outcome, row.action, row.principle_check_result, row.rollback_spec]),
      payload: {
        directiveId: row.directive_id,
        tier: row.tier,
        outcome: row.outcome,
        action: row.action ?? {},
        principleCheckResult: row.principle_check_result ?? {},
      },
    });
    if (record && allowedTeams.has(record.team)) records.push(record);
  }

  const dpoPairs = await safeQuery<any>('public', 'public.sigma_dpo_preference_pairs', `
    SELECT id, cycle_id, analyst, team, metrics, score, critique, improvements, category, inserted_at
      FROM public.sigma_dpo_preference_pairs
     WHERE inserted_at >= NOW() - ($1 || ' hours')::INTERVAL
     ORDER BY inserted_at DESC
     LIMIT $2
  `, [String(sinceHours), limit], warnings);
  for (const row of dpoPairs) {
    const record = buildRecord({
      team: row.team,
      agent: row.analyst,
      sourceKind: 'dpo_preference',
      sourceId: row.id ?? row.cycle_id,
      createdAt: row.inserted_at,
      text: compactText([row.category, row.score, row.critique, row.improvements, row.metrics]),
      payload: {
        cycleId: row.cycle_id,
        score: row.score,
        category: row.category,
        metrics: row.metrics ?? {},
        improvements: row.improvements ?? {},
      },
    });
    if (record && allowedTeams.has(record.team)) records.push(record);
  }

  const mcpUsage = await safeQuery<any>('public', 'public.sigma_mcp_usage_audit', `
    SELECT id, endpoint, tool_name, status, success, metadata, request_at
      FROM public.sigma_mcp_usage_audit
     WHERE request_at >= NOW() - ($1 || ' hours')::INTERVAL
     ORDER BY request_at DESC
     LIMIT $2
  `, [String(sinceHours), limit], warnings);
  for (const row of mcpUsage) {
    const record = buildRecord({
      team: 'sigma',
      agent: row.tool_name ?? 'mcp',
      sourceKind: 'mcp_usage',
      sourceId: row.id,
      createdAt: row.request_at,
      text: compactText([row.endpoint, row.tool_name, row.status, row.success, row.metadata]),
      payload: {
        endpoint: row.endpoint,
        toolName: row.tool_name,
        status: row.status,
        success: row.success,
        metadata: row.metadata ?? {},
      },
    });
    if (record && allowedTeams.has(record.team)) records.push(record);
  }

  const unique = new Map<string, LibraryRecord>();
  for (const record of records) {
    if (!unique.has(record.contentHash)) unique.set(record.contentHash, record);
  }
  return summarize([...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), warnings);
}

export function buildSelfImprovementSignalsFromRecords(records: readonly LibraryRecord[]): SelfImprovementSignal[] {
  return records.flatMap((record) => {
    const payload = record.payload ?? {};
    const text = record.piiRedactedText.toLowerCase();
    const payloadText = stableJson(payload).toLowerCase();
    const evidence = `${text} ${payloadText}`;
    let outcome: SelfImprovementSignal['outcome'] = 'neutral';
    const routineEvent = /signal_sent|observed|general_review|reflection_unavailable|watchlist|heartbeat|report_only/.test(evidence);
    const explicitFailure = /error|critical|fail(?:ed|ure)?|오류|긴급|unresolved|needs_human|repair_failed|exception|rollback|blocked|timeout|denied|실패|장애/.test(evidence);
    const explicitSuccess = /applied|success|complete|completed|ok|succeeded|resolved|tier2_applied|성공|완료|해소/.test(evidence);

    if (record.sourceKind === 'luna_reflexion' && !routineEvent) outcome = 'failure';
    if (record.sourceKind === 'hub_alarm') {
      const severity = String(payload.severity ?? '').toLowerCase();
      const alarmType = String(payload.alarmType ?? '').toLowerCase();
      const status = String(payload.status ?? '').toLowerCase();
      if (/error|critical|fatal/.test(`${severity} ${alarmType} ${status}`) || (explicitFailure && !routineEvent)) {
        outcome = 'failure';
      } else if (explicitSuccess) {
        outcome = 'success';
      }
    }
    if (record.sourceKind === 'sigma_directive') {
      const rawOutcome = String(payload.outcome ?? '').toLowerCase();
      if (explicitSuccess || /applied|success|complete|ok|tier2_applied/.test(rawOutcome)) {
        outcome = 'success';
      } else if (!routineEvent && /failed|failure|error|rollback|blocked|denied/.test(rawOutcome)) {
        outcome = 'failure';
      }
    }
    if (record.sourceKind === 'dpo_preference') {
      const score = Number(payload.score);
      outcome = Number.isFinite(score) && score >= 0.7 ? 'success' : Number.isFinite(score) && score <= 0.4 ? 'failure' : 'neutral';
    }
    if (record.sourceKind === 'mcp_usage') {
      const status = Number(payload.status);
      if (payload.success === true) outcome = 'success';
      else if (Number.isFinite(status) && status >= 500) outcome = 'failure';
    }
    if (record.sourceKind === 'agent_message' && payload.responded === true) outcome = 'success';

    if (outcome === 'neutral') return [];
    const pattern = record.piiRedactedText
      .replace(/\s+/g, ' ')
      .slice(0, 120)
      .trim() || `${record.sourceKind}:${outcome}`;
    return [{
      team: record.team,
      agent: record.agent,
      outcome,
      pattern,
      promptName: outcome === 'success' && record.sourceKind === 'sigma_directive' ? 'sigma_library_context_v1' : undefined,
    }];
  });
}

export async function collectSelfImprovementSignals(options: CollectLibraryRecordsOptions = {}): Promise<{
  signals: SelfImprovementSignal[];
  report: LibraryDataSourceReport;
}> {
  const report = await collectLibraryRecords(options);
  return {
    report,
    signals: buildSelfImprovementSignalsFromRecords(report.records),
  };
}

async function countRows(schema: string, table: string, warnings: string[]): Promise<number> {
  try {
    const rows = await pgPool.query<{ cnt: number | string }>(
      schema,
      `SELECT COUNT(*)::int AS cnt FROM ${schema}.${table}`,
    );
    return Number(rows[0]?.cnt ?? 0);
  } catch (error) {
    warnings.push(`${schema}.${table}:${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

export async function collectLibraryPersistenceMetrics(): Promise<LibraryPersistenceMetrics> {
  const warnings: string[] = [];
  const [entityRelationships, dataLineage, datasetSnapshots] = await Promise.all([
    countRows('sigma', 'entity_relationships', warnings),
    countRows('sigma', 'data_lineage', warnings),
    countRows('sigma', 'dataset_snapshots', warnings),
  ]);
  return {
    entityRelationships,
    dataLineage,
    datasetSnapshots,
    warnings,
  };
}

export function buildFixtureLibraryRecords(): LibraryRecord[] {
  const now = new Date('2026-05-09T00:00:00.000Z').toISOString();
  return [
    buildRecord({
      team: 'luna',
      agent: 'luna',
      sourceKind: 'luna_reflexion',
      sourceId: 'fixture-luna-1',
      createdAt: now,
      text: 'Luna BTC/USDT failed entry generated reflexion and risk guard improvement',
      payload: { symbol: 'BTC/USDT', outcome: 'failure' },
    }),
    buildRecord({
      team: 'blog',
      agent: 'blo',
      sourceKind: 'hub_alarm',
      sourceId: 'fixture-blog-1',
      createdAt: now,
      text: 'Blog queue claim repair succeeded after duplicate publish alarm',
      payload: { severity: 'info', outcome: 'success' },
    }),
    buildRecord({
      team: 'sigma',
      agent: 'librarian',
      sourceKind: 'sigma_directive',
      sourceId: 'fixture-sigma-1',
      createdAt: now,
      text: 'Sigma library graph persisted lineage without external export token sk-test_1234567890abcdef',
      payload: { outcome: 'tier2_applied' },
    }),
  ].filter(Boolean) as LibraryRecord[];
}
