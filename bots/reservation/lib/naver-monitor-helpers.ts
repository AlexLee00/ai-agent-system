import fs from 'fs';
import path from 'path';

export function deriveDevtoolsHttpUrl(wsEndpoint: unknown): string | null {
  if (!wsEndpoint || typeof wsEndpoint !== 'string') return null;
  const match = wsEndpoint.match(/^ws:\/\/([^/]+)\/devtools\/browser\//);
  if (!match) return null;
  return `http://${match[1]}/json/version`;
}

export async function waitForDevtoolsEndpoint(
  wsEndpoint: unknown,
  wait: (ms: number) => Promise<void>,
  timeoutMs = 10000,
): Promise<boolean> {
  const httpUrl = deriveDevtoolsHttpUrl(wsEndpoint);
  if (!httpUrl) return false;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(httpUrl, { method: 'GET' });
      if (response.ok) return true;
    } catch {
      // DevTools port may not be ready yet.
    }
    await wait(250);
  }
  return false;
}

export function readWsEndpointFromActivePort(userDataDir: string): string | null {
  try {
    const activePortPath = path.join(userDataDir, 'DevToolsActivePort');
    const raw = fs.readFileSync(activePortPath, 'utf8').trim();
    const [port, browserPath] = raw.split(/\r?\n/);
    if (!port || !browserPath) return null;
    return `ws://127.0.0.1:${port}${browserPath}`;
  } catch {
    return null;
  }
}

export async function waitForWsEndpointFromActivePort(
  userDataDir: string,
  wait: (ms: number) => Promise<void>,
  timeoutMs = 10000,
): Promise<string | null> {
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

export function parseTimeText(timeText: unknown): { start: string; end: string } | null {
  if (!timeText) return null;
  const match = String(timeText).match(/(오전|오후)\s+(\d{1,2}):(\d{2})~(오전|오후)?\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;

  const period1 = match[1];
  const hour1 = parseInt(match[2], 10);
  const minute1 = parseInt(match[3], 10);
  const period2 = match[4] || period1;
  const hour2 = parseInt(match[5], 10);
  const minute2 = parseInt(match[6], 10);

  const convertTo24 = (hour: number, period: string): number => {
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

export function chooseCanonicalReservationIdForSlot(
  slotRows: Array<Record<string, any>> | null | undefined,
  fallbackId: string | number | null = null,
): string | null {
  const rows = Array.isArray(slotRows) ? slotRows : [];
  if (rows.length === 0) return fallbackId ? String(fallbackId) : null;

  const scoreRow = (row: Record<string, any>): number => {
    let score = 0;
    if (/^\d+$/.test(String(row.id || ''))) score += 100;
    if (row.status === 'completed') score += 20;
    if (['paid', 'manual', 'manual_retry', 'verified'].includes(row.pickkoStatus)) score += 10;
    if (row.markedSeen) score += 2;
    if (!row.seenOnly) score += 1;
    return score;
  };

  return (
    rows
      .slice()
      .sort((a, b) => scoreRow(b) - scoreRow(a) || String(b.id).localeCompare(String(a.id)))[0]?.id
      || (fallbackId ? String(fallbackId) : null)
  );
}
