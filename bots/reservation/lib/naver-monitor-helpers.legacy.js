'use strict';

const fs = require('fs');
const path = require('path');

function deriveDevtoolsHttpUrl(wsEndpoint) {
  if (!wsEndpoint || typeof wsEndpoint !== 'string') return null;
  const match = wsEndpoint.match(/^ws:\/\/([^/]+)\/devtools\/browser\//);
  if (!match) return null;
  return `http://${match[1]}/json/version`;
}

async function waitForDevtoolsEndpoint(wsEndpoint, wait, timeoutMs = 10000) {
  const httpUrl = deriveDevtoolsHttpUrl(wsEndpoint);
  if (!httpUrl) return false;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(httpUrl, { method: 'GET' });
      if (res.ok) return true;
    } catch (_) {}
    await wait(250);
  }
  return false;
}

function readWsEndpointFromActivePort(userDataDir) {
  try {
    const activePortPath = path.join(userDataDir, 'DevToolsActivePort');
    const raw = fs.readFileSync(activePortPath, 'utf8').trim();
    const [port, browserPath] = raw.split(/\r?\n/);
    if (!port || !browserPath) return null;
    return `ws://127.0.0.1:${port}${browserPath}`;
  } catch (_) {
    return null;
  }
}

async function waitForWsEndpointFromActivePort(userDataDir, wait, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const wsEndpoint = readWsEndpointFromActivePort(userDataDir);
    if (wsEndpoint) {
      const ready = await waitForDevtoolsEndpoint(wsEndpoint, wait, 1000);
      if (ready) return wsEndpoint;
    }
    await wait(250);
  }
  return null;
}

function parseTimeText(timeText) {
  if (!timeText) return null;
  const match = String(timeText).match(/(오전|오후)\s+(\d{1,2}):(\d{2})~(오전|오후)?\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;

  const period1 = match[1];
  const hour1 = parseInt(match[2], 10);
  const minute1 = parseInt(match[3], 10);
  const period2 = match[4] || period1;
  const hour2 = parseInt(match[5], 10);
  const minute2 = parseInt(match[6], 10);

  const convertTo24 = (hour, period) => {
    if (period.includes('오전')) return hour === 12 ? 0 : hour;
    return hour === 12 ? 12 : hour + 12;
  };

  const start24 = convertTo24(hour1, period1);
  const end24 = convertTo24(hour2, period2);

  return {
    start: `${String(start24).padStart(2, '0')}:${String(minute1).padStart(2, '0')}`,
    end: `${String(end24).padStart(2, '0')}:${String(minute2).padStart(2, '0')}`,
  };
}

function chooseCanonicalReservationIdForSlot(slotRows, fallbackId = null) {
  const rows = Array.isArray(slotRows) ? slotRows : [];
  if (rows.length === 0) return fallbackId ? String(fallbackId) : null;

  const scoreRow = (row) => {
    let score = 0;
    if (/^\d+$/.test(String(row.id || ''))) score += 100;
    if (row.status === 'completed') score += 20;
    if (['paid', 'manual', 'manual_retry', 'verified'].includes(row.pickkoStatus)) score += 10;
    if (row.markedSeen) score += 2;
    if (!row.seenOnly) score += 1;
    return score;
  };

  return rows
    .slice()
    .sort((a, b) => scoreRow(b) - scoreRow(a) || String(b.id).localeCompare(String(a.id)))[0]?.id
    || (fallbackId ? String(fallbackId) : null);
}

module.exports = {
  deriveDevtoolsHttpUrl,
  waitForDevtoolsEndpoint,
  readWsEndpointFromActivePort,
  waitForWsEndpointFromActivePort,
  parseTimeText,
  chooseCanonicalReservationIdForSlot,
};
