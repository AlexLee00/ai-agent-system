import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  appendObservationHistory,
  readObservationHistory,
  summarizeObservationHistory,
  type SigmaObservationHistoryEntry,
} from './sigma-observation-history.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-7day-completion-'));
const historyPath = path.join(tmpDir, 'history.jsonl');

function row(date: string): SigmaObservationHistoryEntry {
  return {
    date,
    generatedAt: `${date}T00:00:00.000Z`,
    status: 'sigma_observation_review_ready',
    ok: true,
    finalActivationActive: 19,
    finalActivationTotal: 19,
    dashboardStatus: 'sigma_library_contract_ready',
    protectedMissing: [],
    blockers: [],
    warnings: [],
    metrics: {
      alarmRoundtables24h: 10,
      hubAlarms24h: 100,
      voyagerSkillCandidates: 2,
      graphNodes: 35,
      graphEdges: 33,
      datasets: 18,
      reflexion24h: 1,
      agentMessages7d: 700,
      sigmaCost24hUsd: 0,
    },
    budget: {
      dailyCostUsd: 0,
      dailyLimitUsd: 10,
      utilizationPct: 0,
    },
  };
}

for (const date of ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06']) {
  appendObservationHistory(historyPath, row(date));
}
let summary = summarizeObservationHistory(readObservationHistory(historyPath));
assert.equal(summary.status, 'pending_observation');
assert.equal(summary.observedDays, 6);

appendObservationHistory(historyPath, row('2026-05-07'));
summary = summarizeObservationHistory(readObservationHistory(historyPath));
assert.equal(summary.status, 'ready');
assert.equal(summary.ok, true);

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_7day_completion_smoke_passed',
  observedDays: summary.observedDays,
  firstDate: summary.firstDate,
  latestDate: summary.latestDate,
}, null, 2));
