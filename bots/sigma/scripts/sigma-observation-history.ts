import fs from 'node:fs';
import path from 'node:path';

export type SigmaObservationHistoryEntry = {
  date: string;
  generatedAt: string;
  status: string;
  ok: boolean;
  finalActivationActive: number;
  finalActivationTotal: number;
  dashboardStatus: string;
  protectedMissing: string[];
  blockers: string[];
  warnings: string[];
  metrics: {
    alarmRoundtables24h: number;
    hubAlarms24h: number;
    voyagerSkillCandidates: number;
    graphNodes: number;
    graphEdges: number;
    datasets: number;
    reflexion24h: number;
    agentMessages7d: number;
    sigmaCost24hUsd: number;
  };
  budget: {
    dailyCostUsd: number;
    dailyLimitUsd: number;
    utilizationPct: number;
  };
};

export type SigmaObservationHistorySummary = {
  ok: boolean;
  targetDays: number;
  observedDays: number;
  status: 'pending_observation' | 'ready' | 'blocked';
  windowStartDate: string | null;
  firstDate: string | null;
  latestDate: string | null;
  missingDates: string[];
  blockerDates: string[];
  latest: SigmaObservationHistoryEntry | null;
};

export function defaultObservationHistoryPath(repoRoot: string): string {
  return path.join(repoRoot, 'bots/sigma/output/observation/sigma-observation-history.jsonl');
}

export function readObservationHistory(filePath: string): SigmaObservationHistoryEntry[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SigmaObservationHistoryEntry)
      .filter((row) => Boolean(row.date && row.generatedAt));
  } catch {
    return [];
  }
}

export function appendObservationHistory(filePath: string, entry: SigmaObservationHistoryEntry): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function addDays(dateLabel: string, offsetDays: number): string {
  const [year, month, day] = dateLabel.split('-').map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return date.toISOString().slice(0, 10);
}

export function summarizeObservationHistory(
  rows: SigmaObservationHistoryEntry[],
  options: { targetDays?: number } = {},
): SigmaObservationHistorySummary {
  const targetDays = Math.max(1, Math.floor(options.targetDays ?? 7));
  const byDate = new Map<string, SigmaObservationHistoryEntry>();
  for (const row of rows) {
    const previous = byDate.get(row.date);
    if (!previous || row.generatedAt > previous.generatedAt) {
      byDate.set(row.date, row);
    }
  }

  const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const latestDate = sorted.at(-1)?.date ?? null;
  const expectedDates = latestDate
    ? Array.from({ length: targetDays }, (_, index) => addDays(latestDate, index - targetDays + 1))
    : [];
  const recent = expectedDates
    .map((date) => byDate.get(date))
    .filter((row): row is SigmaObservationHistoryEntry => Boolean(row));
  const missingDates = expectedDates.filter((date) => !byDate.has(date));
  const blockerDates = recent
    .filter((row) => !row.ok || row.blockers.length > 0)
    .map((row) => row.date);
  const observedDays = recent.length;
  const status = blockerDates.length > 0
    ? 'blocked'
    : observedDays >= targetDays && missingDates.length === 0
      ? 'ready'
      : 'pending_observation';

  return {
    ok: status === 'ready',
    targetDays,
    observedDays,
    status,
    windowStartDate: expectedDates[0] ?? null,
    firstDate: recent[0]?.date ?? null,
    latestDate,
    missingDates,
    blockerDates,
    latest: recent.at(-1) ?? null,
  };
}
