#!/usr/bin/env tsx

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateKisMarketHours } from '../shared/kis-market-hours-guard.ts';
import { getLunaParams } from '../shared/time-mode.ts';
import { getOpsSchedulerJobs } from './runtime-luna-ops-scheduler.ts';

type MarketName = 'crypto' | 'domestic' | 'overseas';

type LaunchdServiceEvidence = {
  loaded?: boolean;
  state?: string | null;
  runs?: number | null;
  lastExitCode?: number | null;
  runIntervalSeconds?: number | null;
  error?: string | null;
};

type SchedulerJobState = {
  lastRunAt?: string | null;
  lastOpenRunAt?: string | null;
  lastStatus?: string | null;
  lastOutcome?: string | null;
  lastSummary?: string | null;
  lastError?: string | null;
  consecutiveFailures?: number | string | null;
  totalRuns?: number | string | null;
};

type SchedulerState = {
  updatedAt?: string | null;
  jobs?: Record<string, SchedulerJobState>;
};

type MarketSession = {
  isOpen?: boolean;
  state?: string | null;
  reasonCode?: string | null;
};

type CycleDefinition = {
  name: string;
  market: string;
  cadenceSeconds: number;
};

type CycleCadenceJob = {
  name?: string;
  cadence?: { seconds?: number | string | null } | null;
};

type LunaCycleParams = {
  cycleSec?: number | string | null;
};

type TradeObservationRow = {
  market?: string;
  recent_events?: number | string | null;
  open_positions?: number | string | null;
  last_event_ms?: number | string | null;
};

type BuildOptions = {
  generatedAt?: string;
  windowHours?: number;
  service?: LaunchdServiceEvidence;
  schedulerState?: SchedulerState | null;
  schedulerStateError?: string | null;
  marketSessions?: Partial<Record<MarketName, MarketSession>>;
  cycleDefinitions?: CycleDefinition[];
  tradeRows?: TradeObservationRow[];
  tradeQueryError?: string | null;
  statePath?: string;
};

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_STATE_PATH = path.join(INVESTMENT_ROOT, 'output', 'ops', 'luna-ops-scheduler-state.json');
const SERVICE_LABEL = 'ai.luna.ops-scheduler';
const MARKET_NAMES: MarketName[] = ['crypto', 'domestic', 'overseas'];
const SCHEDULER_STATE_STALE_MS = 30 * 60 * 1000;
const MIN_CYCLE_FRESHNESS_MS = 15 * 60 * 1000;
const CLOSED_MARKET_CYCLE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function numeric(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function latestJobEntry(entries: Array<{ name: string; state: SchedulerJobState }>) {
  return entries.reduce<{ name: string; state: SchedulerJobState; at: number } | null>((latest, entry) => {
    const at = new Date(String(entry.state.lastRunAt || '')).getTime();
    if (!Number.isFinite(at)) return latest;
    if (!latest || at > latest.at) return { ...entry, at };
    return latest;
  }, null);
}

function isNonOpenMarketCycleOutcome(value: unknown): boolean {
  const outcome = String(value || '').trim();
  return outcome === 'cadence_wait'
    || outcome === 'kill_switch_off'
    || outcome.startsWith('market_closed_');
}

function latestOpenJobEntry(entries: Array<{ name: string; state: SchedulerJobState }>) {
  return entries.reduce<{ name: string; state: SchedulerJobState; at: number } | null>((latest, entry) => {
    const explicit = new Date(String(entry.state.lastOpenRunAt || '')).getTime();
    const fallback = isNonOpenMarketCycleOutcome(entry.state.lastOutcome)
      ? Number.NaN
      : new Date(String(entry.state.lastRunAt || '')).getTime();
    const at = Number.isFinite(explicit) ? explicit : fallback;
    if (!Number.isFinite(at)) return latest;
    if (!latest || at > latest.at) return { ...entry, at };
    return latest;
  }, null);
}

function summarizeService(service: LaunchdServiceEvidence = {}) {
  const reasons: string[] = [];
  if (service.loaded !== true) reasons.push('service_not_loaded');
  if (service.error) reasons.push('service_inspection_error');
  if (service.lastExitCode !== null
    && service.lastExitCode !== undefined
    && numeric(service.lastExitCode, -1) !== 0) reasons.push('last_exit_nonzero');
  const hasRunEvidence = numeric(service.runs) > 0 || service.state === 'running';
  const status = reasons.length > 0 ? 'degraded' : (hasRunEvidence ? 'healthy' : 'no_sample');
  return {
    status,
    reasons: reasons.length > 0 ? reasons : [status === 'healthy' ? 'launchd_healthy' : 'no_run_evidence'],
    loaded: service.loaded === true,
    state: service.state || null,
    runs: numeric(service.runs),
    lastExitCode: service.lastExitCode === null || service.lastExitCode === undefined
      ? null
      : numeric(service.lastExitCode),
    runIntervalSeconds: service.runIntervalSeconds === null || service.runIntervalSeconds === undefined
      ? null
      : numeric(service.runIntervalSeconds),
    error: service.error || null,
  };
}

function summarizeSchedulerState(
  schedulerState: SchedulerState | null | undefined,
  schedulerStateError: string | null | undefined,
  generatedAtMs: number,
) {
  if (schedulerStateError) {
    return {
      status: 'degraded',
      reasons: ['state_read_error'],
      updatedAt: null,
      ageMs: null,
      error: schedulerStateError,
    };
  }
  const updatedAt = isoOrNull(schedulerState?.updatedAt);
  if (!updatedAt) {
    return {
      status: 'no_sample',
      reasons: ['state_missing'],
      updatedAt: null,
      ageMs: null,
      error: null,
    };
  }
  const ageMs = Math.max(0, generatedAtMs - new Date(updatedAt).getTime());
  const stale = ageMs > SCHEDULER_STATE_STALE_MS;
  return {
    status: stale ? 'degraded' : 'healthy',
    reasons: [stale ? 'state_stale' : 'state_recent'],
    updatedAt,
    ageMs,
    error: null,
  };
}

function summarizeMarket({
  market,
  generatedAtMs,
  schedulerState,
  marketSession,
  definitions,
  tradeRow,
}: {
  market: MarketName;
  generatedAtMs: number;
  schedulerState: SchedulerState | null | undefined;
  marketSession: MarketSession;
  definitions: CycleDefinition[];
  tradeRow?: TradeObservationRow;
}) {
  const jobEntries = definitions.map((definition) => ({
    name: definition.name,
    state: schedulerState?.jobs?.[definition.name] || {},
  }));
  const latest = latestJobEntry(jobEntries);
  const latestOpen = latestOpenJobEntry(jobEntries);
  const failedJobs = jobEntries
    .filter((entry) => entry.state.lastStatus === 'failed' || numeric(entry.state.consecutiveFailures) > 0)
    .map((entry) => entry.name);
  const cadenceSeconds = definitions.reduce((minimum, definition) => {
    const current = positiveInteger(definition.cadenceSeconds, 1800, 1, 86400);
    return minimum === null ? current : Math.min(minimum, current);
  }, null as number | null);
  const freshnessMs = Math.max(MIN_CYCLE_FRESHNESS_MS, numeric(cadenceSeconds, 1800) * 3 * 1000);
  const lastRunAt = latest ? new Date(latest.at).toISOString() : null;
  const lastRunAgeMs = latest ? Math.max(0, generatedAtMs - latest.at) : null;
  const lastOpenRunAt = latestOpen ? new Date(latestOpen.at).toISOString() : null;
  const ageMs = latestOpen ? Math.max(0, generatedAtMs - latestOpen.at) : null;
  const isOpen = market === 'crypto' ? true : marketSession.isOpen === true;
  const reasons: string[] = [];
  let status = 'healthy';

  if (definitions.length === 0 || !latest) {
    status = 'no_sample';
    reasons.push(definitions.length === 0 ? 'cycle_not_registered' : 'cycle_never_run');
  } else if (failedJobs.length > 0) {
    status = 'degraded';
    reasons.push('cycle_failure');
  } else if (!latestOpen) {
    status = 'no_sample';
    reasons.push('open_cycle_never_observed');
  } else if (!isOpen && ageMs !== null && ageMs > CLOSED_MARKET_CYCLE_MAX_AGE_MS) {
    status = 'degraded';
    reasons.push('last_open_cycle_stale');
  } else if (!isOpen) {
    reasons.push('market_closed');
  } else if (ageMs === null || ageMs > freshnessMs) {
    status = 'degraded';
    reasons.push('cycle_stale');
  } else {
    reasons.push('cycle_recent');
  }

  return {
    market,
    status,
    reasons,
    session: {
      isOpen,
      state: market === 'crypto' ? 'open' : marketSession.state || (isOpen ? 'open' : 'closed'),
      reasonCode: market === 'crypto' ? 'always_open' : marketSession.reasonCode || null,
    },
    jobs: definitions.map((definition) => definition.name),
    failedJobs,
    cadenceSeconds,
    freshnessMs,
    closedMarketMaxAgeMs: CLOSED_MARKET_CYCLE_MAX_AGE_MS,
    lastRunAt,
    lastRunAgeMs,
    lastOpenRunAt,
    ageMs,
    lastStatus: latest?.state.lastStatus || null,
    lastOutcome: latest?.state.lastOutcome || null,
    lastSummary: latest?.state.lastSummary || null,
    recentTradeEvents: numeric(tradeRow?.recent_events),
    openPositions: numeric(tradeRow?.open_positions),
    lastTradeEventAt: numeric(tradeRow?.last_event_ms) > 0
      ? new Date(numeric(tradeRow?.last_event_ms)).toISOString()
      : null,
  };
}

export function buildMarketCycleObservationReport(options: BuildOptions = {}) {
  const generatedAt = isoOrNull(options.generatedAt) || new Date().toISOString();
  const generatedAtMs = new Date(generatedAt).getTime();
  const service = summarizeService(options.service);
  const schedulerState = summarizeSchedulerState(
    options.schedulerState,
    options.schedulerStateError,
    generatedAtMs,
  );
  const definitions = options.cycleDefinitions || [];
  const rowsByMarket = new Map((options.tradeRows || []).map((row) => [String(row.market || ''), row]));
  const marketSummaries = Object.fromEntries(MARKET_NAMES.map((market) => [market, summarizeMarket({
    market,
    generatedAtMs,
    schedulerState: options.schedulerState,
    marketSession: options.marketSessions?.[market] || {},
    definitions: definitions.filter((definition) => definition.market === market),
    tradeRow: rowsByMarket.get(market),
  })])) as Record<MarketName, ReturnType<typeof summarizeMarket>>;
  const tradeEvents = MARKET_NAMES.reduce((sum, market) => sum + marketSummaries[market].recentTradeEvents, 0);
  const tradeJournal = options.tradeQueryError
    ? { status: 'query_error', error: options.tradeQueryError, recentEvents: null }
    : { status: tradeEvents > 0 ? 'healthy' : 'no_sample', error: null, recentEvents: tradeEvents };
  const degraded = service.status === 'degraded'
    || schedulerState.status === 'degraded'
    || tradeJournal.status === 'query_error'
    || MARKET_NAMES.some((market) => marketSummaries[market].status === 'degraded');
  const sampledMarkets = MARKET_NAMES.filter((market) => marketSummaries[market].status !== 'no_sample');
  const missingMarkets = MARKET_NAMES.filter((market) => marketSummaries[market].status === 'no_sample');
  const hasEvidence = service.status === 'healthy'
    || schedulerState.status === 'healthy'
    || MARKET_NAMES.some((market) => marketSummaries[market].status === 'healthy');
  const status = degraded ? 'degraded' : (hasEvidence ? 'healthy' : 'no_sample');
  const coverageAwareStatus = status === 'healthy' && missingMarkets.length > 0
    ? 'incomplete'
    : status;

  return {
    ok: coverageAwareStatus === 'healthy',
    status: coverageAwareStatus,
    generatedAt,
    windowHours: positiveInteger(options.windowHours, 24, 1, 168),
    sources: {
      service: `launchctl:${SERVICE_LABEL}`,
      schedulerState: options.statePath || DEFAULT_STATE_PATH,
      tradeJournal: 'investment.trade_journal',
    },
    service,
    schedulerState,
    markets: marketSummaries,
    marketCoverage: {
      required: MARKET_NAMES.length,
      sampled: sampledMarkets.length,
      missingMarkets,
    },
    tradeJournal,
    liveMutation: false,
    dbWrite: false,
    schedulerKick: false,
    externalCall: false,
  };
}

export function inspectOpsSchedulerService(): LaunchdServiceEvidence {
  const domain = `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`;
  const result = spawnSync('/bin/launchctl', ['print', domain], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status !== 0) {
    return {
      loaded: false,
      state: null,
      runs: 0,
      lastExitCode: null,
      runIntervalSeconds: null,
      error: String(result.stderr || result.error?.message || 'launchctl_print_failed').trim(),
    };
  }
  const output = String(result.stdout || '');
  const state = output.match(/^\s*state = (.+)$/m)?.[1]?.trim() || null;
  const runs = output.match(/^\s*runs = (\d+)$/m)?.[1];
  const lastExitCode = output.match(/^\s*last exit code = (-?\d+)$/m)?.[1];
  const interval = output.match(/^\s*run interval = (\d+) seconds$/m)?.[1];
  return {
    loaded: true,
    state,
    runs: runs === undefined ? null : Number(runs),
    lastExitCode: lastExitCode === undefined ? null : Number(lastExitCode),
    runIntervalSeconds: interval === undefined ? null : Number(interval),
    error: null,
  };
}

export function readSchedulerState(statePath = DEFAULT_STATE_PATH) {
  try {
    return { state: JSON.parse(fs.readFileSync(statePath, 'utf8')) as SchedulerState, error: null };
  } catch (error: any) {
    return { state: null, error: String(error?.message || error) };
  }
}

export async function fetchTradeJournalObservationRows(hours = 24): Promise<TradeObservationRow[]> {
  const pgPool = require('../../../packages/core/lib/pg-pool.ts');
  const sinceMs = Date.now() - positiveInteger(hours, 24, 1, 168) * 60 * 60 * 1000;
  return pgPool.queryReadonly('investment', `
    SELECT CASE
             WHEN COALESCE(market, '') = 'crypto' OR exchange = 'binance' THEN 'crypto'
             WHEN COALESCE(market, '') = 'domestic' OR exchange IN ('kis', 'krx') THEN 'domestic'
             WHEN COALESCE(market, '') = 'overseas' OR exchange = 'kis_overseas' THEN 'overseas'
             ELSE COALESCE(NULLIF(market, ''), 'all')
           END AS market,
           COUNT(*) FILTER (
             WHERE COALESCE(exit_time, entry_time, created_at) >= $1
           )::int AS recent_events,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) = 'open')::int AS open_positions,
           MAX(COALESCE(exit_time, entry_time, created_at)) AS last_event_ms
      FROM investment.trade_journal
     GROUP BY 1
     ORDER BY 1
  `, [sinceMs]);
}

function resolveCycleCadenceSeconds(job: CycleCadenceJob, lunaParams: LunaCycleParams = {}): number {
  const schedulerCadence = positiveInteger(job?.cadence?.seconds, 1800, 1, 86400);
  if (job?.name !== 'market_cycle_crypto') return schedulerCadence;
  const runtimeCadence = positiveInteger(lunaParams?.cycleSec, schedulerCadence, 1, 86400);
  return Math.max(schedulerCadence, runtimeCadence);
}

function getCycleDefinitions(lunaParams: LunaCycleParams = getLunaParams()): CycleDefinition[] {
  return getOpsSchedulerJobs()
    .filter((job) => job.category === 'market_cycle' && MARKET_NAMES.includes(job.market as MarketName))
    .map((job) => ({
      name: job.name,
      market: job.market,
      cadenceSeconds: resolveCycleCadenceSeconds(job, lunaParams),
    }));
}

function parseArgs(argv = process.argv.slice(2)) {
  let hours = 24;
  let statePath = DEFAULT_STATE_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--hours') hours = positiveInteger(argv[++index], 24, 1, 168);
    else if (arg.startsWith('--hours=')) hours = positiveInteger(arg.slice('--hours='.length), 24, 1, 168);
    else if (arg === '--state-path') statePath = path.resolve(String(argv[++index] || ''));
    else if (arg.startsWith('--state-path=')) statePath = path.resolve(arg.slice('--state-path='.length));
    else if (arg !== '--json') throw new Error(`unknown argument: ${arg}`);
  }
  return { hours, statePath };
}

async function main() {
  const { hours, statePath } = parseArgs();
  const pgPool = require('../../../packages/core/lib/pg-pool.ts');
  const generatedAt = new Date().toISOString();
  const stateResult = readSchedulerState(statePath);
  let tradeRows: TradeObservationRow[] = [];
  let tradeQueryError: string | null = null;
  try {
    tradeRows = await fetchTradeJournalObservationRows(hours);
  } catch (error: any) {
    tradeQueryError = String(error?.message || error);
  }
  const report = buildMarketCycleObservationReport({
    generatedAt,
    windowHours: hours,
    service: inspectOpsSchedulerService(),
    schedulerState: stateResult.state,
    schedulerStateError: stateResult.error,
    marketSessions: {
      crypto: { isOpen: true, state: 'open', reasonCode: 'always_open' },
      domestic: evaluateKisMarketHours({ market: 'domestic', now: new Date(generatedAt) }),
      overseas: evaluateKisMarketHours({ market: 'overseas', now: new Date(generatedAt) }),
    },
    cycleDefinitions: getCycleDefinitions(),
    tradeRows,
    tradeQueryError,
    statePath,
  });
  console.log(JSON.stringify(report, null, 2));
  await pgPool.closeAll();
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`runtime-luna-market-cycle-observation failed: ${error?.message || error}`);
    process.exit(1);
  });
}

export const _testOnly = {
  parseArgs,
  summarizeService,
  summarizeSchedulerState,
  summarizeMarket,
  resolveCycleCadenceSeconds,
  getCycleDefinitions,
};
