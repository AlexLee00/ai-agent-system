#!/usr/bin/env node
// @ts-nocheck

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { appendLunaL5TransitionHistory } from '../shared/luna-l5-transition-history.ts';
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

export function runPhaseSmokeCommands(commands = []) {
  return commands.map((command) => {
    const startedAt = new Date().toISOString();
    const result = spawnSync(command, {
      shell: true,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env },
    });
    return {
      command,
      startedAt,
      ok: result.status === 0,
      status: result.status,
      signal: result.signal || null,
      stdoutTail: String(result.stdout || '').slice(-1200),
      stderrTail: String(result.stderr || '').slice(-1200),
      error: result.error?.message || null,
    };
  });
}

function parseArgs(argv = []) {
  const args = { json: false, apply: false, confirm: null, phase: 'next', runSmoke: false, rollbackOnFail: false };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--apply') args.apply = true;
    else if (raw === '--run-smoke') args.runSmoke = true;
    else if (raw === '--rollback-on-fail') args.rollbackOnFail = true;
    else if (raw.startsWith('--confirm=')) args.confirm = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--phase=')) args.phase = raw.split('=').slice(1).join('=') || 'next';
  }
  return args;
}

export async function runLunaL5PhaseActivationOperator(args = {}) {
  const config = loadConfig();
  const plan = buildLunaL5PhaseActivationPlan({ config, requestedPhase: args.phase || 'next' });
  if (!args.apply) {
    const result = {
      ok: plan.ok,
      status: plan.ok ? 'luna_l5_phase_activation_preview_ready' : 'luna_l5_phase_activation_preview_blocked',
      applied: false,
      plan,
      nextCommand: plan.ok
        ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-l5-phase-activate -- --phase=${args.phase || 'next'} --apply --confirm=luna-l5-phase-activate --run-smoke --json`
        : null,
    };
    appendLunaL5TransitionHistory({
      eventType: 'luna_l5_phase_activation_preview',
      status: result.status,
      ok: result.ok,
      requestedPhase: args.phase || 'next',
      blockers: plan.blockers || [],
      phases: (plan.steps || []).map((step) => step.phase),
    });
    return result;
  }
  if (args.confirm !== 'luna-l5-phase-activate') {
    const result = {
      ok: false,
      status: 'luna_l5_phase_activation_confirmation_required',
      applied: false,
      plan,
      reason: 'use --confirm=luna-l5-phase-activate',
    };
    appendLunaL5TransitionHistory({
      eventType: 'luna_l5_phase_activation_apply',
      status: result.status,
      ok: false,
      requestedPhase: args.phase || 'next',
      reason: result.reason,
    });
    return result;
  }
  if (plan.ok !== true) {
    const result = {
      ok: false,
      status: 'luna_l5_phase_activation_blocked',
      applied: false,
      plan,
      reason: plan.blockers.join(', ') || 'phase activation blocked',
    };
    appendLunaL5TransitionHistory({
      eventType: 'luna_l5_phase_activation_apply',
      status: result.status,
      ok: false,
      requestedPhase: args.phase || 'next',
      blockers: plan.blockers || [],
      reason: result.reason,
    });
    return result;
  }
  const patched = patchLifecyclePhases(config, plan.steps.map((step) => step.phase));
  writeFileSync(CONFIG_PATH, yaml.dump(patched, { lineWidth: 120, noRefs: true }), 'utf8');
  const smokeResults = args.runSmoke ? runPhaseSmokeCommands(plan.nextSmokeCommands || []) : [];
  const smokeOk = smokeResults.every((item) => item.ok === true);
  let rollbackApplied = false;
  if (args.runSmoke && smokeOk !== true && args.rollbackOnFail === true) {
    writeFileSync(CONFIG_PATH, yaml.dump(config, { lineWidth: 120, noRefs: true }), 'utf8');
    rollbackApplied = true;
  }
  const result = {
    ok: args.runSmoke ? smokeOk : true,
    status: args.runSmoke && smokeOk !== true
      ? 'luna_l5_phase_activation_applied_smoke_failed'
      : 'luna_l5_phase_activation_applied',
    applied: true,
    smokeOk: args.runSmoke ? smokeOk : null,
    rollbackApplied,
    configPath: CONFIG_PATH,
    enabledPhases: plan.steps.map((step) => step.phase),
    plan,
    smokeResults,
    rollbackCandidate: args.runSmoke && smokeOk !== true && rollbackApplied !== true
      ? {
        configPath: CONFIG_PATH,
        reason: 'phase smoke failed after config patch; either restore the previous config.yaml from git/local backup or rerun future applies with --rollback-on-fail',
      }
      : null,
  };
  appendLunaL5TransitionHistory({
    eventType: 'luna_l5_phase_activation_apply',
    status: result.status,
    ok: smokeOk !== false,
    requestedPhase: args.phase || 'next',
    phases: result.enabledPhases,
    smokeOk: result.smokeOk,
    rollbackApplied,
    smokeResults: smokeResults.map((item) => ({ command: item.command, ok: item.ok, status: item.status, signal: item.signal, error: item.error })),
  });
  return result;
}

function renderText(result = {}) {
  return [
    '🧩 Luna L5 phase activation operator',
    `status: ${result.status || 'unknown'}`,
    `applied: ${result.applied === true}`,
    `smoke: ${result.smokeOk == null ? 'not-run' : result.smokeOk}`,
    `rollback: ${result.rollbackApplied === true ? 'applied' : 'not-applied'}`,
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
