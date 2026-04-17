const eventLake = require('../../../../packages/core/lib/event-lake');

function toInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
    return res.json({ ok: true, ...result });
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
