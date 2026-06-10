const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eventLake = require('../../../../packages/core/lib/event-lake');
const { collectHealthSnapshot } = require('./health');

const defaultRouteEventLake = {
  record: (...args: any[]) => eventLake.record(...args),
};
let routeEventLake = defaultRouteEventLake;
let spoolDrainInFlight = false;

export function _testOnly_setEventsRouteEventLakeMocks(overrides: Partial<typeof defaultRouteEventLake> = {}) {
  routeEventLake = { ...defaultRouteEventLake, ...overrides };
}

export function _testOnly_resetEventsRouteEventLakeMocks() {
  routeEventLake = defaultRouteEventLake;
}

function text(value: unknown, fallback = '') {
  const normalized = String(value == null ? fallback : value).trim();
  return normalized || fallback;
}

function toInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveIntEnv(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number.parseInt(String(process.env[name] || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function runtimeDir(): string {
  const configured = String(process.env.HUB_RUNTIME_DIR || '').trim();
  return configured.replace(/^~(?=$|\/)/, os.homedir()) || path.join(os.homedir(), '.ai-agent-system', 'hub');
}

export function eventsPublishSpoolFile(): string {
  const configured = String(process.env.HUB_EVENTS_PUBLISH_SPOOL_FILE || '').trim();
  return configured.replace(/^~(?=$|\/)/, os.homedir()) || path.join(runtimeDir(), 'events-publish-spool.jsonl');
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message || error || 'unknown_error').slice(0, 500);
}

async function appendSpooledEvent(recordPayload: Record<string, unknown>, error: unknown, spoolFile = eventsPublishSpoolFile()): Promise<void> {
  const payload = {
    queuedAt: new Date().toISOString(),
    reason: errorMessage(error),
    record: recordPayload,
  };
  await fs.promises.mkdir(path.dirname(spoolFile), { recursive: true, mode: 0o700 });
  await fs.promises.appendFile(spoolFile, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { await fs.promises.chmod(spoolFile, 0o600); } catch {}
}

function parseSpooledLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (!parsed?.record || typeof parsed.record !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function appendRemainingSpooledEvents(spoolFile: string, entries: Array<Record<string, unknown>>): Promise<void> {
  if (!entries.length) return;
  await fs.promises.mkdir(path.dirname(spoolFile), { recursive: true, mode: 0o700 });
  const body = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
  await fs.promises.appendFile(spoolFile, body, { encoding: 'utf8', mode: 0o600 });
  try { await fs.promises.chmod(spoolFile, 0o600); } catch {}
}

export async function drainEventsPublishSpool(options: { spoolFile?: string; limit?: number } = {}) {
  if (spoolDrainInFlight) return { ok: true, skipped: true, reason: 'drain_in_flight', drained: 0, remaining: 0 };
  spoolDrainInFlight = true;

  const spoolFile = options.spoolFile || eventsPublishSpoolFile();
  const limit = Math.min(
    Math.max(1, Number(options.limit || 0) || positiveIntEnv('HUB_EVENTS_PUBLISH_SPOOL_DRAIN_LIMIT', 50, 1, 1000)),
    1000,
  );
  const processingFile = `${spoolFile}.${process.pid}.${Date.now()}.processing`;

  try {
    await fs.promises.rename(spoolFile, processingFile).catch((error: any) => {
      if (error?.code === 'ENOENT') return;
      throw error;
    });
    if (!fs.existsSync(processingFile)) return { ok: true, drained: 0, remaining: 0 };

    const raw = await fs.promises.readFile(processingFile, 'utf8');
    const entries = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(parseSpooledLine).filter(Boolean) as Array<Record<string, unknown>>;
    let drained = 0;
    const remaining: Array<Record<string, unknown>> = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (drained >= limit) {
        remaining.push(entry, ...entries.slice(index + 1));
        break;
      }
      try {
        await routeEventLake.record(entry.record);
        drained += 1;
      } catch (error) {
        remaining.push({ ...entry, lastDrainError: errorMessage(error), lastDrainAt: new Date().toISOString() }, ...entries.slice(index + 1));
        break;
      }
    }

    await appendRemainingSpooledEvents(spoolFile, remaining);
    await fs.promises.unlink(processingFile).catch(() => null);
    return { ok: true, drained, remaining: remaining.length };
  } finally {
    spoolDrainInFlight = false;
  }
}

function deriveTeam(source: string, topic: string) {
  const candidate = text(source || topic).split(/[.:/-]/)[0]?.toLowerCase() || '';
  if (candidate === 'luna' || candidate === 'investment') return 'investment';
  if (candidate === 'ska' || candidate === 'reservation') return 'reservation';
  if (candidate === 'hub') return 'hub';
  if (candidate === 'blog') return 'blog';
  if (candidate === 'claude') return 'claude';
  if (candidate === 'darwin') return 'darwin';
  if (candidate === 'sigma') return 'sigma';
  return candidate || 'general';
}

function objectValue(input: unknown, key: string): unknown {
  if (!input || typeof input !== 'object') return null;
  return (input as Record<string, unknown>)[key];
}

function explicitHeader(req: any, name: string): string {
  const value = req?.headers?.[name] || req?.headers?.[name.toLowerCase()];
  return text(Array.isArray(value) ? value[0] : value, '');
}

export function resolvePublishedEventTraceId(body: any = {}, req: any = {}): string {
  return text(
    body.traceId
      || body.trace_id
      || objectValue(body.payload, 'traceId')
      || objectValue(body.payload, 'trace_id')
      || body.incidentKey
      || body.incident_key
      || explicitHeader(req, 'x-trace-id')
      || explicitHeader(req, 'x-hub-trace-id'),
    '',
  );
}

export async function eventsPublishRoute(req: any, res: any) {
  try {
    const body = req.body || {};
    const source = text(body.source || body.botName || body.bot_name, 'unknown');
    const topic = text(body.topic || body.eventType || body.event_type, 'general_event');
    const severity = text(body.severity, 'info').toLowerCase();
    const traceId = resolvePublishedEventTraceId(body, req);
    const recordPayload = {
      eventType: topic,
      team: text(body.team, deriveTeam(source, topic)),
      botName: source,
      severity: ['debug', 'info', 'warn', 'error', 'critical'].includes(severity) ? severity : 'info',
      traceId,
      title: text(body.title, topic),
      message: text(body.message, ''),
      tags: ['hub-events-publish', source].filter(Boolean),
      metadata: {
        source,
        topic,
        payload: body.payload ?? null,
        timestamp: body.timestamp ?? Date.now(),
      },
    };
    let id: string | number | null = null;
    try {
      id = await routeEventLake.record(recordPayload);
      drainEventsPublishSpool().catch((error) => {
        console.warn(`[hub/events] publish spool drain failed: ${errorMessage(error)}`);
      });
    } catch (error) {
      try {
        await appendSpooledEvent(recordPayload, error);
        console.warn(`[hub/events] event_lake unavailable; publish spooled: ${errorMessage(error)}`);
        return res.status(202).json({ ok: true, queued: true, id: null, warning: 'event_lake_spooled' });
      } catch (spoolError) {
        return res.status(503).json({ ok: false, error: 'event_lake_unavailable', detail: errorMessage(spoolError) });
      }
    }
    return res.json({ ok: true, id });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

export async function eventsSearchRoute(req: any, res: any) {
  try {
    const rows = await eventLake.search({
      q: req.query.q || '',
      eventType: req.query.event_type || '',
      team: req.query.team || '',
      severity: req.query.severity || '',
      botName: req.query.bot || '',
      minutes: toInt(req.query.minutes, 24 * 60),
      limit: toInt(req.query.limit, 50),
    });
    return res.json({ ok: true, total: rows.length, results: rows });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

export async function eventsStatsRoute(req: any, res: any) {
  try {
    const result = await eventLake.stats({
      minutes: toInt(req.query.minutes, 24 * 60),
    });
    return res.json({ ok: true, ...result });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

export async function eventsFeedbackRoute(req: any, res: any) {
  try {
    const id = Number.parseInt(req.body?.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'valid id required' });
    }
    const row = await eventLake.addFeedback(id, {
      score: req.body?.score,
      feedback: req.body?.feedback || '',
    });
    if (!row) {
      return res.status(404).json({ ok: false, error: 'event not found' });
    }
    return res.json({ ok: true, event: row });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

export async function commandEventsRecentRoute(req: any, res: any) {
  try {
    const result = await eventLake.recentCommands({
      minutes: toInt(req.query.minutes, 24 * 60),
      limit: toInt(req.query.limit, 50),
      targetTeam: req.query.target_team || '',
      pipeline: req.query.pipeline || '',
      commandId: req.query.command_id || '',
    });
    return res.json({ ok: true, ...result });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

export async function commandEventsSummaryRoute(req: any, res: any) {
  try {
    const result = await eventLake.commandSummary({
      minutes: toInt(req.query.minutes, 24 * 60),
      limit: toInt(req.query.limit, 20),
      targetTeam: req.query.target_team || '',
      pipeline: req.query.pipeline || '',
    });
    const health = await collectHealthSnapshot().catch(() => null);
    const runtimeAlignment = health?.resources
      ? {
          ownership_alignment: health.resources.ownership_alignment || null,
          daemon_cutover: health.resources.daemon_cutover || null,
        }
      : null;

    return res.json({ ok: true, ...result, runtime_alignment: runtimeAlignment });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

export async function commandEventsStuckRoute(req: any, res: any) {
  try {
    const result = await eventLake.stuckCommands({
      minutes: toInt(req.query.minutes, 24 * 60),
      thresholdMinutes: toInt(req.query.threshold_minutes, 15),
      limit: toInt(req.query.limit, 20),
      targetTeam: req.query.target_team || '',
      pipeline: req.query.pipeline || '',
    });
    const health = await collectHealthSnapshot().catch(() => null);
    const runtimeAlignment = health?.resources
      ? {
          ownership_alignment: health.resources.ownership_alignment || null,
          daemon_cutover: health.resources.daemon_cutover || null,
        }
      : null;

    return res.json({ ok: true, ...result, runtime_alignment: runtimeAlignment });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

export async function commandEventsFailedRoute(req: any, res: any) {
  try {
    const result = await eventLake.failedCommands({
      minutes: toInt(req.query.minutes, 24 * 60),
      limit: toInt(req.query.limit, 20),
      targetTeam: req.query.target_team || '',
      pipeline: req.query.pipeline || '',
    });
    const health = await collectHealthSnapshot().catch(() => null);
    const runtimeAlignment = health?.resources
      ? {
          ownership_alignment: health.resources.ownership_alignment || null,
          daemon_cutover: health.resources.daemon_cutover || null,
        }
      : null;

    return res.json({ ok: true, ...result, runtime_alignment: runtimeAlignment });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

export async function commandEventsInboxRoute(req: any, res: any) {
  try {
    const targetTeam = String(req.query.target_team || '').trim();
    if (!targetTeam) {
      return res.status(400).json({ ok: false, error: 'target_team required' });
    }

    const result = await eventLake.commandInbox({
      targetTeam,
      minutes: toInt(req.query.minutes, 24 * 60),
      limit: toInt(req.query.limit, 50),
    });
    return res.json({ ok: true, ...result });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

export async function commandEventsLifecycleRoute(req: any, res: any) {
  try {
    const commandId = String(req.body?.command_id || '').trim();
    const status = String(req.body?.status || '').trim();

    if (!commandId) {
      return res.status(400).json({ ok: false, error: 'command_id required' });
    }

    if (!status) {
      return res.status(400).json({ ok: false, error: 'status required' });
    }

    const result = await eventLake.appendCommandLifecycle({
      commandId,
      status,
      pipeline: req.body?.pipeline || '',
      targetTeam: req.body?.target_team || '',
      botName: req.body?.bot_name || req.body?.botName || 'unknown',
      source: req.body?.source || 'hub.command_lifecycle',
      message: req.body?.message || '',
      detail: req.body?.detail,
    });

    if (!result) {
      return res.status(404).json({ ok: false, error: 'issued command not found' });
    }

    return res.json({ ok: true, ...result });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
