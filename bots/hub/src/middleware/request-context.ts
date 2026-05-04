import type { NextFunction, Request, Response } from 'express';

const crypto = require('crypto');

const PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);

type HubRequestContext = {
  traceId: string;
  callerTeam: string | null;
  agent: string | null;
  priority: string;
  receivedAt: string;
};

type HubRequest = Request & {
  hubRequestContext?: HubRequestContext;
  body?: Record<string, unknown>;
};

function normalizeString(value: unknown, maxLength = 120): string | null {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function getHeader(req: Request, name: string): unknown {
  return req.headers?.[name.toLowerCase()];
}

function resolveTraceId(req: HubRequest): string {
  const raw = normalizeString(getHeader(req, 'x-trace-id'), 128);
  if (raw) return raw;
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolvePriority(req: HubRequest): string {
  const fromHeader = normalizeString(getHeader(req, 'x-priority'), 16);
  const fromBody = normalizeString(req.body?.priority, 16);
  const candidate = String(fromBody || fromHeader || 'normal').toLowerCase();
  if (PRIORITIES.has(candidate)) {
    return candidate;
  }
  return 'normal';
}

function resolveCallerTeam(req: HubRequest): string | null {
  return normalizeString(req.body?.callerTeam, 120) || normalizeString(getHeader(req, 'x-caller-team'), 120);
}

function resolveAgent(req: HubRequest): string | null {
  return normalizeString(req.body?.agent, 120) || normalizeString(getHeader(req, 'x-agent'), 120);
}

function hubRequestContextMiddleware(req: HubRequest, res: Response, next: NextFunction) {
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
