'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

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
  if (!signature) return { suppress: false, incident: null };

  try {
    fs.mkdirSync(path.dirname(ALERT_DEDUPE_PATH), { recursive: true });
    let cache = {};

    if (fs.existsSync(ALERT_DEDUPE_PATH)) {
      cache = JSON.parse(fs.readFileSync(ALERT_DEDUPE_PATH, 'utf8') || '{}');
    }

    const now = Date.now();
    const latestReason = classifyReason(message);
    const recent = cache[signature];
    cache = Object.fromEntries(
      Object.entries(cache).filter(([, incident]) => now - Number(incident?.last_seen_at || 0) < ALERT_DEDUPE_WINDOW_MS)
    );

    if (recent && now - Number(recent.last_seen_at || 0) < ALERT_DEDUPE_WINDOW_MS) {
      cache[signature] = {
        ...recent,
        count: Number(recent.count || 0) + 1,
        last_seen_at: now,
        latest_message: message,
        latest_reason: latestReason,
      };
      fs.writeFileSync(ALERT_DEDUPE_PATH, JSON.stringify(cache, null, 2));
      return {
        suppress: true,
        incident: {
          count: cache[signature].count,
          first_seen_at: new Date(cache[signature].first_seen_at).toISOString(),
          last_seen_at: new Date(cache[signature].last_seen_at).toISOString(),
          latest_reason: cache[signature].latest_reason,
        },
      };
    }

    cache[signature] = {
      count: 1,
      first_seen_at: now,
      last_seen_at: now,
      latest_message: message,
      latest_reason: latestReason,
    };
    fs.writeFileSync(ALERT_DEDUPE_PATH, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.warn(`[worker-alerts] dedupe cache 실패: ${String(error?.message || error)}`);
  }

  return {
    suppress: false,
    incident: {
      count: 1,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      latest_reason: classifyReason(message),
    },
  };
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
