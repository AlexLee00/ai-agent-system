#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE = '/Users/alexlee/projects/ai-agent-system/bots/investment/output/ops/position-runtime-autopilot-history.jsonl';
export const DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_MAX_LINES = 3000;
export const DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_COMPACT_OVERFLOW_LINES = 250;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function nonNegativeInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

export function getPositionRuntimeAutopilotHistoryMaxLines(env = process.env) {
  return positiveInt(
    env.LUNA_POSITION_RUNTIME_AUTOPILOT_HISTORY_MAX_LINES,
    DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_MAX_LINES,
  );
}

function getPositionRuntimeAutopilotHistoryCompactOverflowLines(env = process.env) {
  return nonNegativeInt(
    env.LUNA_POSITION_RUNTIME_AUTOPILOT_HISTORY_COMPACT_OVERFLOW_LINES,
    DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_COMPACT_OVERFLOW_LINES,
  );
}

function readJsonlLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function compactPositionRuntimeAutopilotHistory(
  file = DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
  { maxLines = getPositionRuntimeAutopilotHistoryMaxLines() } = {},
) {
  const keepLines = positiveInt(maxLines, DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_MAX_LINES);
  if (!fs.existsSync(file)) return { compacted: false, before: 0, after: 0, maxLines: keepLines };
  const lines = readJsonlLines(file);
  if (lines.length <= keepLines) return { compacted: false, before: lines.length, after: lines.length, maxLines: keepLines };
  const nextLines = lines.slice(-keepLines);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${nextLines.join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { compacted: true, before: lines.length, after: nextLines.length, maxLines: keepLines };
}

export function readPositionRuntimeAutopilotHistoryLines(
  file = DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
) {
  return readJsonlLines(file)
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
  {
    maxLines = getPositionRuntimeAutopilotHistoryMaxLines(),
    compactOverflowLines = getPositionRuntimeAutopilotHistoryCompactOverflowLines(),
  } = {},
) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(snapshot)}\n`, 'utf8');
  const keepLines = positiveInt(maxLines, DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_MAX_LINES);
  const overflowLines = nonNegativeInt(compactOverflowLines, DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_COMPACT_OVERFLOW_LINES);
  const lineCount = readJsonlLines(file).length;
  if (lineCount > keepLines + overflowLines) {
    return compactPositionRuntimeAutopilotHistory(file, { maxLines: keepLines });
  }
  return { compacted: false, before: lineCount, after: lineCount, maxLines: keepLines };
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
