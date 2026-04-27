#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaL5ReadinessReport } from './luna-l5-readiness-report.ts';

const PHASES = [
  {
    phase: 1,
    key: 'LUNA_V2_ENABLED',
    target: 'true',
    purpose: 'V2 supervisor baseline',
    prerequisites: [],
  },
  {
    phase: 2,
    key: 'LUNA_MAPEK_ENABLED',
    target: 'true',
    purpose: 'MAPE-K autonomous loop canary',
    prerequisites: ['LUNA_V2_ENABLED'],
  },
  {
    phase: 3,
    key: 'LUNA_VALIDATION_ENABLED',
    target: 'true',
    purpose: 'validation engine canary',
    prerequisites: ['LUNA_V2_ENABLED', 'LUNA_MAPEK_ENABLED'],
  },
  {
    phase: 4,
    key: 'LUNA_PREDICTION_ENABLED',
    target: 'true',
    purpose: 'prediction engine canary',
    prerequisites: ['LUNA_V2_ENABLED', 'LUNA_MAPEK_ENABLED', 'LUNA_VALIDATION_ENABLED'],
  },
];

function isEnabled(switches, key) {
  return String(switches?.[key]?.effectiveHint || '').trim().toLowerCase() === 'true';
}

function buildPhaseStatus(report) {
  const switches = report.G1_killSwitches || {};
  return PHASES.map((phase) => {
    const enabled = isEnabled(switches, phase.key);
    const missingPrerequisites = phase.prerequisites.filter((key) => !isEnabled(switches, key));
    const canEnable = !enabled && missingPrerequisites.length === 0;
    return {
      ...phase,
      enabled,
      canEnable,
      status: enabled ? 'enabled' : (canEnable ? 'next_canary_candidate' : 'blocked_by_prerequisite'),
      missingPrerequisites,
      current: switches?.[phase.key]?.effectiveHint ?? null,
    };
  });
}

function buildCanaryCommands(nextPhase = null) {
  if (!nextPhase) return [];
  return [
    `launchctl setenv ${nextPhase.key} ${nextPhase.target}`,
    `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s check:luna-l5`,
    `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-l5-readiness -- --telegram`,
  ];
}

export async function buildLunaKillSwitchCanaryPlan() {
  const readiness = await buildLunaL5ReadinessReport();
  const phases = buildPhaseStatus(readiness);
  const nextPhase = phases.find((phase) => phase.status === 'next_canary_candidate') || null;
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    mode: 'read_only_plan',
    nextPhase,
    commands: buildCanaryCommands(nextPhase),
    phases,
    readinessWarnings: readiness.warnings || [],
  };
}

export async function runLunaKillSwitchCanarySmoke() {
  const plan = await buildLunaKillSwitchCanaryPlan();
  assert.equal(plan.mode, 'read_only_plan');
  assert.equal(plan.phases.length, 4);
  const phaseKeys = plan.phases.map((phase) => phase.key);
  assert.deepEqual(phaseKeys, [
    'LUNA_V2_ENABLED',
    'LUNA_MAPEK_ENABLED',
    'LUNA_VALIDATION_ENABLED',
    'LUNA_PREDICTION_ENABLED',
  ]);
  if (plan.nextPhase) {
    assert.ok(plan.commands.some((command) => command.includes(plan.nextPhase.key)));
  }
  return plan;
}

async function main() {
  const result = await runLunaKillSwitchCanarySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`luna kill-switch canary plan ok — next=${result.nextPhase?.key || 'none'}`);
    for (const command of result.commands) console.log(`- ${command}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna kill-switch canary 실패:',
  });
}
