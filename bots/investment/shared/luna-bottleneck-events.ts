// @ts-nocheck

import { pgPool } from './db/core.ts';

const EVENT_TYPE = 'luna_bottleneck_autonomy';

function text(value, fallback = '') {
  const normalized = String(value == null ? fallback : value).trim();
  return normalized || fallback;
}

function severity(value) {
  const normalized = text(value, 'info').toLowerCase();
  return ['debug', 'info', 'warn', 'error', 'critical'].includes(normalized) ? normalized : 'info';
}

function redact(value, depth = 0) {
  if (depth > 8) return '[redacted:depth]';
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/token|secret|password|authorization|api[_-]?key|refresh/i.test(key)) return [key, '[redacted]'];
    return [key, redact(item, depth + 1)];
  }));
}

export function buildLunaBottleneckEventPayload(report = {}) {
  const hardBlockers = Array.isArray(report.hardBlockers) ? report.hardBlockers : [];
  const bottlenecks = Array.isArray(report.bottlenecks) ? report.bottlenecks : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const eventSeverity = hardBlockers.length > 0
    ? 'error'
    : bottlenecks.length > 0 || warnings.length > 0
      ? 'warn'
      : 'info';
  return {
    eventType: EVENT_TYPE,
    team: 'investment',
    botName: 'luna',
    severity: eventSeverity,
    title: `Luna bottleneck autonomy ${report.status || 'report'}`,
    message: [
      `status=${report.status || 'unknown'}`,
      `hard=${hardBlockers.length}`,
      `bottlenecks=${bottlenecks.length}`,
      `safeFixes=${Array.isArray(report.safeFixCandidates) ? report.safeFixCandidates.length : 0}`,
    ].join(' '),
    tags: ['luna', 'bottleneck', 'autonomy', 'codex'],
    metadata: redact({
      status: report.status || null,
      ok: report.ok === true,
      hardBlockers,
      bottlenecks: bottlenecks.slice(0, 50),
      warnings: warnings.slice(0, 50),
      safeFixCandidates: (report.safeFixCandidates || []).slice(0, 25),
      nextActions: (report.nextActions || []).slice(0, 25),
      evidenceSummary: report.evidenceSummary || {},
      generatedAt: report.generatedAt || null,
    }),
  };
}

export async function publishLunaBottleneckEvent(report = {}) {
  const payload = buildLunaBottleneckEventPayload(report);
  try {
    await pgPool.run('agent', 'CREATE SCHEMA IF NOT EXISTS agent', []);
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS agent.event_lake (
        id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        team TEXT NOT NULL DEFAULT 'general',
        bot_name TEXT NOT NULL DEFAULT 'unknown',
        severity TEXT NOT NULL DEFAULT 'info',
        trace_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        feedback_score NUMERIC,
        feedback TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `, []);
    const rows = await pgPool.query('agent', `
      INSERT INTO agent.event_lake (
        event_type, team, bot_name, severity, title, message, tags, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::TEXT[], $8::JSONB)
      RETURNING id
    `, [
      payload.eventType,
      text(payload.team, 'investment'),
      text(payload.botName, 'luna'),
      severity(payload.severity),
      text(payload.title),
      text(payload.message),
      payload.tags || [],
      JSON.stringify(payload.metadata || {}),
    ]);
    return { ok: true, eventType: EVENT_TYPE, id: rows?.[0]?.id || null };
  } catch (error) {
    return { ok: false, eventType: EVENT_TYPE, error: error?.message || String(error) };
  }
}

export default {
  buildLunaBottleneckEventPayload,
  publishLunaBottleneckEvent,
};
