'use strict';

const fs = require('fs');

function updateCriticalIncidentCache({
  cachePath,
  signature,
  message,
  latestReason,
  windowMs = 15 * 60 * 1000,
  logPrefix = 'critical-incident',
}) {
  if (!signature) {
    return { suppress: false, incident: null };
  }

  try {
    fs.mkdirSync(require('path').dirname(cachePath), { recursive: true });
    let cache = {};

    if (fs.existsSync(cachePath)) {
      cache = JSON.parse(fs.readFileSync(cachePath, 'utf8') || '{}');
    }

    const now = Date.now();
    const recent = cache[signature];
    cache = Object.fromEntries(
      Object.entries(cache).filter(([, incident]) => now - Number(incident?.last_seen_at || 0) < windowMs)
    );

    if (recent && now - Number(recent.last_seen_at || 0) < windowMs) {
      cache[signature] = {
        ...recent,
        count: Number(recent.count || 0) + 1,
        last_seen_at: now,
        latest_message: message,
        latest_reason: latestReason,
      };
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
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
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.warn(`[${logPrefix}] dedupe cache 실패: ${String(error?.message || error)}`);
  }

  return {
    suppress: false,
    incident: {
      count: 1,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      latest_reason: latestReason,
    },
  };
}

module.exports = {
  updateCriticalIncidentCache,
};
