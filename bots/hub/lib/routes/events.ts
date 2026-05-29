const eventLake = require('../../../../packages/core/lib/event-lake');
const { collectHealthSnapshot } = require('./health');

const defaultRouteEventLake = {
  record: (...args: any[]) => eventLake.record(...args),
};
let routeEventLake = defaultRouteEventLake;

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
    const id = await routeEventLake.record({
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
    });
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
