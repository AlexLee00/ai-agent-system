#!/usr/bin/env node
// @ts-nocheck

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { normalizeLifecycleMode } from '../shared/luna-l5-operational-gate.ts';
import { appendLunaL5TransitionHistory } from '../shared/luna-l5-transition-history.ts';
import { buildLunaL5FinalGateReport } from './luna-l5-final-gate.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.yaml');

function parseArgs(argv = []) {
  const args = {
    json: false,
    apply: false,
    confirm: null,
    targetMode: 'supervised_l4',
    sync: false,
    requirePositionSync: false,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--apply') args.apply = true;
    else if (raw === '--sync') args.sync = true;
    else if (raw === '--require-position-sync') args.requirePositionSync = true;
    else if (raw.startsWith('--confirm=')) args.confirm = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--target=')) args.targetMode = raw.split('=').slice(1).join('=') || 'supervised_l4';
  }
  return args;
}

function loadConfigForPatch() {
  if (!existsSync(CONFIG_PATH)) return {};
  return yaml.load(readFileSync(CONFIG_PATH, 'utf8')) || {};
}

function patchPositionLifecycleMode(config = {}, targetMode = 'supervised_l4') {
  const next = { ...(config || {}) };
  next.position_lifecycle = {
    ...(next.position_lifecycle || {}),
    mode: normalizeLifecycleMode(targetMode),
  };
  return next;
}

export async function runLunaL5CutoverOperator(args = {}) {
  const targetMode = normalizeLifecycleMode(args.targetMode || 'supervised_l4');
  const finalGate = await buildLunaL5FinalGateReport({
    targetMode,
    sync: args.sync === true,
    requirePositionSync: args.requirePositionSync === true,
  });

  if (!args.apply) {
    const result = {
      ok: finalGate.ok,
      status: finalGate.ok ? 'luna_l5_cutover_preview_clear' : 'luna_l5_cutover_preview_blocked',
      applied: false,
      targetMode,
      finalGate,
      nextCommand: finalGate.ok
        ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-l5-cutover -- --target=${targetMode} --apply --confirm=luna-l5-cutover --json`
        : null,
    };
    appendLunaL5TransitionHistory({
      eventType: 'luna_l5_cutover_preview',
      status: result.status,
      ok: result.ok,
      targetMode,
      blockers: finalGate.blockers || [],
      warnings: finalGate.warnings || [],
    });
    return result;
  }

  if (args.confirm !== 'luna-l5-cutover') {
    const result = {
      ok: false,
      status: 'luna_l5_cutover_confirmation_required',
      applied: false,
      targetMode,
      finalGate,
      reason: 'use --confirm=luna-l5-cutover',
    };
    appendLunaL5TransitionHistory({
      eventType: 'luna_l5_cutover_apply',
      status: result.status,
      ok: false,
      targetMode,
      reason: result.reason,
    });
    return result;
  }
  if (finalGate.ok !== true) {
    const result = {
      ok: false,
      status: 'luna_l5_cutover_blocked',
      applied: false,
      targetMode,
      finalGate,
      reason: finalGate.blockers.join(', ') || 'final gate blocked',
    };
    appendLunaL5TransitionHistory({
      eventType: 'luna_l5_cutover_apply',
      status: result.status,
      ok: false,
      targetMode,
      blockers: finalGate.blockers || [],
      warnings: finalGate.warnings || [],
      reason: result.reason,
    });
    return result;
  }

  const current = loadConfigForPatch();
  const patched = patchPositionLifecycleMode(current, targetMode);
  writeFileSync(CONFIG_PATH, yaml.dump(patched, { lineWidth: 120, noRefs: true }), 'utf8');
  const result = {
    ok: true,
    status: 'luna_l5_cutover_applied',
    applied: true,
    targetMode,
    configPath: CONFIG_PATH,
    finalGate,
  };
  appendLunaL5TransitionHistory({
    eventType: 'luna_l5_cutover_apply',
    status: result.status,
    ok: true,
    targetMode,
    blockers: [],
    warnings: finalGate.warnings || [],
  });
  return result;
}

function renderText(result = {}) {
  return [
    '🚀 Luna L5 cutover operator',
    `status: ${result.status || 'unknown'}`,
    `target: ${result.targetMode || 'unknown'}`,
    `applied: ${result.applied === true}`,
    `blockers: ${(result.finalGate?.blockers || []).join(' / ') || 'none'}`,
    result.nextCommand ? `next: ${result.nextCommand}` : null,
  ].filter(Boolean).join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runLunaL5CutoverOperator(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ luna-l5-cutover-operator 실패:',
  });
}
