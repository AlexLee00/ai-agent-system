const crypto = require('crypto');

const PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);

function normalizeString(value, maxLength = 120) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function resolveTraceId(req) {
  const raw = normalizeString(req.headers?.['x-trace-id'], 128);
  if (raw) return raw;
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolvePriority(req) {
  const fromHeader = normalizeString(req.headers?.['x-priority'], 16);
  const fromBody = normalizeString(req.body?.priority, 16);
  const candidate = String(fromBody || fromHeader || 'normal').toLowerCase();
  if (PRIORITIES.has(candidate)) {
    return candidate;
  }
  return 'normal';
}

function resolveCallerTeam(req) {
  return normalizeString(req.body?.callerTeam, 120) || normalizeString(req.headers?.['x-caller-team'], 120);
}

function resolveAgent(req) {
  return normalizeString(req.body?.agent, 120) || normalizeString(req.headers?.['x-agent'], 120);
}

function hubRequestContextMiddleware(req, res, next) {
  const context = {
    traceId: resolveTraceId(req),
    callerTeam: resolveCallerTeam(req),
    agent: resolveAgent(req),
    priority: resolvePriority(req),
    receivedAt: new Date().toISOString(),
  };

  req.hubRequestContext = context;
  res.locals = res.locals || {};
  res.locals.hubRequestContext = context;
  res.set('X-Hub-Trace-Id', context.traceId);
  return next();
}

module.exports = {
  hubRequestContextMiddleware,
};
