#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  investmentOpsLegacyFile,
  investmentOpsRuntimeFile,
} from '../shared/runtime-ops-path.ts';
import { runPositionRuntimeTuning } from './runtime-position-runtime-tuning.ts';

export const POSITION_RUNTIME_OVERRIDE_FILENAME = 'position-runtime-overrides.json';
export const LEGACY_POSITION_RUNTIME_OVERRIDE_FILE = investmentOpsLegacyFile(POSITION_RUNTIME_OVERRIDE_FILENAME);
export const OVERRIDE_FILE = investmentOpsRuntimeFile(POSITION_RUNTIME_OVERRIDE_FILENAME);

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    apply: false,
    confirm: null,
    json: false,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--apply') args.apply = true;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--confirm=')) args.confirm = raw.split('=').slice(1).join('=') || null;
  }
  return args;
}

function loadOverrides() {
  try {
    const readFile = !fs.existsSync(OVERRIDE_FILE) && fs.existsSync(LEGACY_POSITION_RUNTIME_OVERRIDE_FILE)
      ? LEGACY_POSITION_RUNTIME_OVERRIDE_FILE
      : OVERRIDE_FILE;
    if (!fs.existsSync(readFile)) return {};
    return JSON.parse(fs.readFileSync(readFile, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function overrideKeyForExchange(exchange) {
  if (exchange === 'binance') return 'position_watch_crypto_realtime_ms';
  if (exchange === 'kis') return 'position_watch_domestic_realtime_ms';
  if (exchange === 'kis_overseas') return 'position_watch_overseas_realtime_ms';
  return null;
}

export function buildUpdates(suggestions = []) {
  const updates = {};
  const appliedSuggestionsByKey = {};
  for (const suggestion of suggestions) {
    if (!suggestion?.exchange) continue;
    const key = overrideKeyForExchange(suggestion.exchange);
    if (!key || !Number.isFinite(Number(suggestion.recommendedCadenceMs))) continue;
    const cadence = Number(suggestion.recommendedCadenceMs);
    const existing = appliedSuggestionsByKey[key];
    if (!existing) {
      updates[key] = cadence;
      appliedSuggestionsByKey[key] = {
        exchange: suggestion.exchange,
        exchanges: [suggestion.exchange],
        key,
        status: suggestion.status,
        recommendedCadenceMs: cadence,
        currentAverageCadenceMs: suggestion.currentAverageCadenceMs ?? null,
        reason: suggestion.reason || null,
      };
      continue;
    }
    updates[key] = Math.min(Number(existing.recommendedCadenceMs || cadence), cadence);
    existing.recommendedCadenceMs = updates[key];
    existing.status = existing.status === 'tighten_runtime_watch' || suggestion.status === 'tighten_runtime_watch'
      ? 'tighten_runtime_watch'
      : existing.status;
    existing.exchanges = Array.from(new Set([...(existing.exchanges || []), suggestion.exchange]));
    existing.exchange = existing.exchanges.join(',');
    existing.reason = [existing.reason, suggestion.reason].filter(Boolean).join(' | ');
  }
  return { updates, appliedSuggestions: Object.values(appliedSuggestionsByKey) };
}

function persistOverrides(updates = {}) {
  const previous = loadOverrides();
  const next = { ...previous, ...updates, updatedAt: new Date().toISOString() };
  const dir = path.dirname(OVERRIDE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(next, null, 2));
  return { previous, next };
}

function renderText(result = {}) {
  const lines = [
    '🛠️ Position Runtime Autotune',
    `status: ${result.status || 'unknown'}`,
    `override file: ${result.overrideFile || OVERRIDE_FILE}`,
  ];
  for (const item of result.appliedSuggestions || []) {
    lines.push(`- ${item.exchange} | ${item.key} ${item.currentAverageCadenceMs || 'n/a'} -> ${item.recommendedCadenceMs} | ${item.reason || 'n/a'}`);
  }
  return lines.join('\n');
}

export async function runPositionRuntimeAutotune(args = {}) {
  const tuning = await runPositionRuntimeTuning({
    exchange: args.exchange || null,
    json: true,
  });
  const { updates, appliedSuggestions } = buildUpdates(tuning.suggestions || []);

  if (!args.apply) {
    return {
      ok: true,
      status: Object.keys(updates).length > 0 ? 'position_runtime_autotune_ready' : 'position_runtime_autotune_idle',
      tuning,
      overrideFile: OVERRIDE_FILE,
      updates,
      appliedSuggestions,
    };
  }

  if (args.confirm !== 'runtime-autotune') {
    return {
      ok: false,
      status: 'position_runtime_autotune_confirmation_required',
      overrideFile: OVERRIDE_FILE,
      updates,
      appliedSuggestions,
      reason: 'use --confirm=runtime-autotune',
    };
  }

  const persisted = persistOverrides(updates);
  return {
    ok: true,
    status: 'position_runtime_autotune_applied',
    tuning,
    overrideFile: OVERRIDE_FILE,
    updates,
    appliedSuggestions,
    persisted,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionRuntimeAutotune(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-position-runtime-autotune 오류:',
  });
}
