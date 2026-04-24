#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE = '/Users/alexlee/projects/ai-agent-system/bots/investment/output/ops/position-runtime-autopilot-history.jsonl';

export function readPositionRuntimeAutopilotHistoryLines(
  file = DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function appendPositionRuntimeAutopilotHistory(
  snapshot,
  file = DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

export function readPositionRuntimeAutopilotHistorySummary(
  file = DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
) {
  const history = readPositionRuntimeAutopilotHistoryLines(file);
  const current = history[history.length - 1] || null;
  const previous = history[history.length - 2] || null;
  return {
    file,
    historyCount: history.length,
    current,
    previous,
  };
}
