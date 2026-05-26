#!/usr/bin/env tsx

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const CONFIRM = 'hub-stage-d-self-healing-canary';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PROTECTED = new Set([
  'ai.hub.resource-api',
  'ai.hub.llm-oauth-monitor',
  'ai.hub.llm-oauth4-master-review',
  'ai.hub.llm-groq-fallback-test',
  'ai.hub.llm-model-check',
  'ai.hub.llm-cache-cleanup',
  'ai.hub.incident-summary',
  'ai.hub.severity-decay',
  'ai.hub.noisy-producer-auto-learn',
  'ai.hub.roundtable-reflection',
  'ai.hub.daily-metrics-digest',
  'ai.hub.hourly-status-digest',
  'ai.hub.weekly-audit-digest',
  'ai.hub.weekly-advisory-digest',
]);
const CANARY_LABELS = ['ai.hub.llm-tier-probe'];

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name) {
  const prefix = `${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : null;
}

function buildPlan() {
  return {
    ok: true,
    stage: 'hub_stage_d',
    task: 'D3_self_healing',
    mode: 'shadow_by_default',
    phases: [
      { phase: 1, mode: 'shadow', duration: '7d', action: 'detect + alert only' },
      { phase: 2, mode: 'canary', duration: '7d', action: 'one non-protected label only' },
      { phase: 3, mode: 'gradual', duration: '7d', action: 'up to five non-protected labels' },
    ],
    canaryLabels: CANARY_LABELS,
    protectedLabels: Array.from(PROTECTED),
    prohibited: [
      'restart/kill/unload/bootout/kickstart -k on PROTECTED 14',
      'database destructive repair',
      'secret mutation',
    ],
    applyGate: `--apply --confirm=${CONFIRM} --label=${CANARY_LABELS[0]}`,
  };
}

function launchctl(args) {
  const result = spawnSync('launchctl', args, { encoding: 'utf8', timeout: 15_000 });
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

function launchctlPrint(label) {
  const uid = process.getuid ? process.getuid() : Number(spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim());
  return launchctl(['print', `gui/${uid}/${label}`]);
}

function canaryPlistPath(label) {
  return path.join(PROJECT_ROOT, 'bots', 'hub', 'launchd', `${label}.plist`);
}

async function main() {
  const apply = hasFlag('--apply');
  const confirm = argValue('--confirm');
  const label = argValue('--label') || CANARY_LABELS[0];
  const plan = buildPlan();

  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    dryRun: !apply,
    label,
    plan,
    applied: null,
  };

  if (!apply) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (confirm !== CONFIRM) {
    result.ok = false;
    result.error = 'confirm_required';
    result.requiredConfirm = CONFIRM;
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }
  if (PROTECTED.has(label)) {
    result.ok = false;
    result.error = 'protected_label_blocked';
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }
  if (!CANARY_LABELS.includes(label)) {
    result.ok = false;
    result.error = 'unsupported_canary_label';
    result.allowedLabels = CANARY_LABELS;
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }

  const loaded = launchctlPrint(label);
  if (!loaded.ok) {
    result.ok = false;
    result.error = 'canary_label_not_loaded';
    result.loaded = loaded;
    result.bootstrapCommand = `launchctl bootstrap gui/$(id -u) ${canaryPlistPath(label)}`;
    result.note = 'Bootstrap is required before canary kickstart; PROTECTED 14 labels are still excluded.';
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }

  const uid = process.getuid ? process.getuid() : Number(spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim());
  result.applied = launchctl(['kickstart', `gui/${uid}/${label}`]);
  result.ok = result.applied.ok;
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
