#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';

export const DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE = '/tmp/investment-runtime-position-strategy-remediation-history.jsonl';

export function readPositionStrategyRemediationHistoryLines(file = DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function appendPositionStrategyRemediationHistory(file, snapshot) {
  fs.appendFileSync(file, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

export function readPositionStrategyRemediationHistory(file = DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE) {
  const history = readPositionStrategyRemediationHistoryLines(file);
  const current = history[history.length - 1] || null;
  const previous = history[history.length - 2] || null;
  const recordedAt = current?.recordedAt ? new Date(current.recordedAt) : null;
  const ageMs = recordedAt && !Number.isNaN(recordedAt.getTime())
    ? Math.max(0, Date.now() - recordedAt.getTime())
    : null;
  const ageMinutes = ageMs === null ? null : Math.floor(ageMs / (1000 * 60));
  return {
    ok: true,
    file,
    historyCount: history.length,
    current,
    previous,
    lastRecordedAt: current?.recordedAt || null,
    ageMinutes,
    stale: ageMinutes === null ? true : ageMinutes >= 60,
    statusChanged: previous && current ? previous.status !== current.status : false,
    nextCommandChanged: previous && current ? String(previous.nextCommand || '') !== String(current.nextCommand || '') : false,
    delta: {
      duplicateManaged: previous && current ? Number(current.duplicateManaged || 0) - Number(previous.duplicateManaged || 0) : 0,
      orphanProfiles: previous && current ? Number(current.orphanProfiles || 0) - Number(previous.orphanProfiles || 0) : 0,
      unmatchedManaged: previous && current ? Number(current.unmatchedManaged || 0) - Number(previous.unmatchedManaged || 0) : 0,
    },
  };
}
