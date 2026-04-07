'use strict';

const eventLake = require('../../../../packages/core/lib/event-lake');

function _toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function eventsSearchRoute(req, res) {
  try {
    const rows = await eventLake.search({
      q: req.query.q || '',
      eventType: req.query.event_type || '',
      team: req.query.team || '',
      severity: req.query.severity || '',
      botName: req.query.bot || '',
      minutes: _toInt(req.query.minutes, 24 * 60),
      limit: _toInt(req.query.limit, 50),
    });
    return res.json({ ok: true, total: rows.length, results: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function eventsStatsRoute(req, res) {
  try {
    const result = await eventLake.stats({
      minutes: _toInt(req.query.minutes, 24 * 60),
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function eventsFeedbackRoute(req, res) {
  try {
    const id = Number.parseInt(req.body?.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: 'valid id required' });
    }
    const row = await eventLake.addFeedback(id, {
      score: req.body?.score,
      feedback: req.body?.feedback || '',
    });
    if (!row) return res.status(404).json({ ok: false, error: 'event not found' });
    return res.json({ ok: true, event: row });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  eventsSearchRoute,
  eventsStatsRoute,
  eventsFeedbackRoute,
};
