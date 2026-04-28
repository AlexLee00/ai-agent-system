#!/usr/bin/env node
// @ts-nocheck

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  LUNA_L5_PHASE_CONFIG_KEYS,
  LUNA_L5_PHASE_SEQUENCE,
} from '../shared/luna-l5-operational-gate.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.yaml');

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  return yaml.load(readFileSync(CONFIG_PATH, 'utf8')) || {};
}

function sectionEnabled(config = {}, phase) {
  const key = LUNA_L5_PHASE_CONFIG_KEYS[phase];
  return config?.position_lifecycle?.[key]?.enabled === true;
}

function choosePhases(config = {}, requested = 'next') {
  if (requested === 'all') return LUNA_L5_PHASE_SEQUENCE.map((item) => item.phase);
  if (requested && requested !== 'next') {
    const requestedPhases = String(requested).split(',').map((item) => item.trim()).filter(Boolean);
    return requestedPhases.filter((phase) => LUNA_L5_PHASE_CONFIG_KEYS[phase]);
  }
  const next = LUNA_L5_PHASE_SEQUENCE.find((item) => !sectionEnabled(config, item.phase));
  return next ? [next.phase] : [];
}

export function buildLunaL5PhaseActivationPlan({
  config = loadConfig(),
  requestedPhase = 'next',
} = {}) {
  const phases = choosePhases(config, requestedPhase);
  const steps = LUNA_L5_PHASE_SEQUENCE
    .filter((item) => phases.includes(item.phase))
    .map((item) => ({
      ...item,
      currentlyEnabled: sectionEnabled(config, item.phase),
      action: sectionEnabled(config, item.phase) ? 'already_enabled' : 'enable',
    }));
  const blockers = [];
  if (!config?.position_lifecycle) blockers.push('position_lifecycle_config_missing');
  if (phases.length === 0) blockers.push('no_phase_to_enable');
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'luna_l5_phase_activation_plan_ready' : 'luna_l5_phase_activation_plan_blocked',
    configPath: CONFIG_PATH,
    requestedPhase,
    steps,
    blockers,
    nextSmokeCommands: steps.map((step) => step.smokeCommand),
  };
}

export function patchLifecyclePhases(config = {}, phases = []) {
  const next = { ...(config || {}) };
  next.position_lifecycle = { ...(next.position_lifecycle || {}) };
  for (const phase of phases) {
    const key = LUNA_L5_PHASE_CONFIG_KEYS[phase];
    if (!key) continue;
    next.position_lifecycle[key] = {
      ...(next.position_lifecycle[key] || {}),
      enabled: true,
    };
  }
  return next;
}

function parseArgs(argv = []) {
  const args = { json: false, apply: false, confirm: null, phase: 'next' };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--apply') args.apply = true;
    else if (raw.startsWith('--confirm=')) args.confirm = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--phase=')) args.phase = raw.split('=').slice(1).join('=') || 'next';
  }
  return args;
}

export async function runLunaL5PhaseActivationOperator(args = {}) {
  const config = loadConfig();
  const plan = buildLunaL5PhaseActivationPlan({ config, requestedPhase: args.phase || 'next' });
  if (!args.apply) {
    return {
      ok: plan.ok,
      status: plan.ok ? 'luna_l5_phase_activation_preview_ready' : 'luna_l5_phase_activation_preview_blocked',
      applied: false,
      plan,
      nextCommand: plan.ok
        ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-l5-phase-activate -- --phase=${args.phase || 'next'} --apply --confirm=luna-l5-phase-activate --json`
        : null,
    };
  }
  if (args.confirm !== 'luna-l5-phase-activate') {
    return {
      ok: false,
      status: 'luna_l5_phase_activation_confirmation_required',
      applied: false,
      plan,
      reason: 'use --confirm=luna-l5-phase-activate',
    };
  }
  if (plan.ok !== true) {
    return {
      ok: false,
      status: 'luna_l5_phase_activation_blocked',
      applied: false,
      plan,
      reason: plan.blockers.join(', ') || 'phase activation blocked',
    };
  }
  const patched = patchLifecyclePhases(config, plan.steps.map((step) => step.phase));
  writeFileSync(CONFIG_PATH, yaml.dump(patched, { lineWidth: 120, noRefs: true }), 'utf8');
  return {
    ok: true,
    status: 'luna_l5_phase_activation_applied',
    applied: true,
    configPath: CONFIG_PATH,
    enabledPhases: plan.steps.map((step) => step.phase),
    plan,
  };
}

function renderText(result = {}) {
  return [
    '🧩 Luna L5 phase activation operator',
    `status: ${result.status || 'unknown'}`,
    `applied: ${result.applied === true}`,
    `phases: ${(result.plan?.steps || []).map((step) => step.phase).join(',') || 'none'}`,
    `blockers: ${(result.plan?.blockers || []).join(' / ') || 'none'}`,
    result.nextCommand ? `next: ${result.nextCommand}` : null,
  ].filter(Boolean).join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runLunaL5PhaseActivationOperator(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-l5-phase-activation-operator 실패:',
  });
}
