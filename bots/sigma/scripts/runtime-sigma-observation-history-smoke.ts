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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-observation-history-'));
const historyPath = path.join(tmpDir, 'history.jsonl');

function row(date: string, ok = true, suffix = '00'): SigmaObservationHistoryEntry {
  return {
    date,
    generatedAt: `${date}T00:00:${suffix}.000Z`,
    status: ok ? 'sigma_observation_review_ready' : 'sigma_observation_review_blocked',
    ok,
    finalActivationActive: 19,
    finalActivationTotal: 19,
    dashboardStatus: 'sigma_library_contract_ready',
    protectedMissing: [],
    blockers: ok ? [] : ['fixture_blocker'],
    warnings: [],
    metrics: {
      alarmRoundtables24h: 1,
      hubAlarms24h: 2,
      voyagerSkillCandidates: 3,
      graphNodes: 35,
      graphEdges: 33,
      datasets: 18,
      reflexion24h: 1,
      agentMessages7d: 10,
      sigmaCost24hUsd: 0,
    },
    budget: {
      dailyCostUsd: 0,
      dailyLimitUsd: 10,
      utilizationPct: 0,
    },
  };
}

for (let day = 1; day <= 6; day += 1) {
  appendObservationHistory(historyPath, row(`2026-05-0${day}`));
}

let summary = summarizeObservationHistory(readObservationHistory(historyPath));
assert.equal(summary.status, 'pending_observation');
assert.equal(summary.observedDays, 6);

appendObservationHistory(historyPath, row('2026-05-07'));
summary = summarizeObservationHistory(readObservationHistory(historyPath));
assert.equal(summary.status, 'ready');
assert.equal(summary.observedDays, 7);
assert.equal(summary.ok, true);

appendObservationHistory(historyPath, row('2026-05-07', false, '01'));
summary = summarizeObservationHistory(readObservationHistory(historyPath));
assert.equal(summary.status, 'blocked');
assert.deepEqual(summary.blockerDates, ['2026-05-07']);

const gapHistoryPath = path.join(tmpDir, 'gap-history.jsonl');
for (const date of ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-08']) {
  appendObservationHistory(gapHistoryPath, row(date));
}
summary = summarizeObservationHistory(readObservationHistory(gapHistoryPath));
assert.equal(summary.status, 'pending_observation');
assert.deepEqual(summary.missingDates, ['2026-05-07']);

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_observation_history_smoke_passed',
  observedDays: summary.observedDays,
  blockerDates: summary.blockerDates,
}, null, 2));
