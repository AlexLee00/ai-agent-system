'use strict';

const os = require('os');
const path = require('path');
const { updateCriticalIncidentCache } = require('../../../packages/core/lib/critical-incident.js');

const ALERT_DEDUPE_PATH = path.join(os.tmpdir(), 'worker-alert-dedupe.json');
const ALERT_DEDUPE_WINDOW_MS = 15 * 60 * 1000;
const CANONICAL_SOURCES = new Set([
  'worker-health-check',
  'worker-monitor',
]);
const CANONICAL_EVENT_TYPES = new Set([
  'alert',
  'system_error',
  'health_check',
]);

function classifyReason(message) {
  const compact = String(message || '').replace(/\s+/g, ' ').trim();
  if (/write EPIPE|broken pipe|stdout broken pipe|stderr broken pipe/i.test(compact)) {
    return 'broken_pipe';
  }
  if (/http 실패|응답 없음/i.test(compact)) {
    return 'http_failure';
  }
  if (/websocket 비정상/i.test(compact)) {
    return 'websocket_unready';
  }
  if (/비정상 종료/i.test(compact)) {
    return 'abnormal_exit';
  }
  if (/미로드/i.test(compact)) {
    return 'launchd_unloaded';
  }
  if (/pid 없음|다운/i.test(compact)) {
    return 'service_down';
  }
  const reasonMatch = compact.match(/(?:사유|reason):\s*(.+)$/i);
  const reason = reasonMatch ? reasonMatch[1].trim() : compact;
  return reason
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9가-힣_:-]/g, '')
    .slice(0, 80) || 'unknown';
}

function normalizeAlertSignature({ source, event_type, alert_level, message }) {
  if (!CANONICAL_SOURCES.has(source)) return null;
  if (alert_level == null || alert_level < 3) return null;
  if (!CANONICAL_EVENT_TYPES.has(event_type)) return null;
  return `worker|${source}|${event_type}|${classifyReason(message)}`;
}

function updateIncidentCache(signature, message) {
  return updateCriticalIncidentCache({
    cachePath: ALERT_DEDUPE_PATH,
    signature,
    message,
    latestReason: classifyReason(message),
    windowMs: ALERT_DEDUPE_WINDOW_MS,
    logPrefix: 'worker-alerts',
  });
}

function canonicalizeWorkerCriticalAlert({ source, event_type, alert_level, message }) {
  const signature = normalizeAlertSignature({ source, event_type, alert_level, message });
  const state = updateIncidentCache(signature, message);
  if (state.suppress) {
    console.log(`[worker-alerts] duplicate suppressed: ${signature} (#${state.incident?.count || 1})`);
  }
  return {
    signature,
    suppress: state.suppress,
    incident: state.incident,
  };
}

function appendIncidentLine(message, signature, incident) {
  if (!signature || !incident) return message;
  const incidentLine =
    `incident: canonical=1 count=${incident.count} first_seen=${incident.first_seen_at} last_seen=${incident.last_seen_at} reason=${incident.latest_reason}`;
  if (String(message || '').includes('incident: canonical=1 ')) return message;
  return `${message}\n${incidentLine}`;
}

module.exports = {
  canonicalizeWorkerCriticalAlert,
  appendIncidentLine,
};
