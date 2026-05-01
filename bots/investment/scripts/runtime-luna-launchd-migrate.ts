#!/usr/bin/env node
// @ts-nocheck
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  inspectLaunchdList,
  launchdDomain,
  parseLaunchctlListLine,
  runLaunchctl,
} from '../shared/launchd-service.ts';

const INVESTMENT_ROOT = resolve(new URL('..', import.meta.url).pathname);
const LAUNCHD_ROOT = resolve(INVESTMENT_ROOT, 'launchd');
const REQUIRED_CONFIRM = 'luna-launchd-graceful-migration';

const TARGET_LABELS = [
  'ai.luna.marketdata-mcp',
  'ai.luna.tradingview-ws',
  'ai.investment.commander',
  'ai.elixir.supervisor',
  'ai.investment.runtime-autopilot',
  'ai.investment.market-regime-capture',
  'ai.luna.daily-backtest',
  'ai.luna.guardrails-hourly',
  'ai.luna.7day-natural-checkpoint',
  'ai.luna.trade-journal-dashboard',
  'ai.luna.voyager-skill-acceleration',
];

const PROTECTED_LABELS = new Set([
  'ai.luna.marketdata-mcp',
  'ai.luna.tradingview-ws',
  'ai.investment.commander',
  'ai.elixir.supervisor',
]);

const RETIRE_GROUPS = [
  {
    group: 'marketdata_ws_to_mcp',
    labels: ['ai.luna.binance-ws', 'ai.luna.kis-ws-domestic', 'ai.luna.kis-ws-overseas'],
    replacementLabels: ['ai.luna.marketdata-mcp'],
    replacementChecks: ['marketdata_mcp_health'],
  },
  {
    group: 'maintenance_to_sweeper',
    labels: ['ai.investment.maintenance-collect', 'ai.investment.position-watch', 'ai.investment.unrealized-pnl'],
    replacementLabels: ['ai.elixir.supervisor'],
  },
  {
    group: 'reports_to_skills',
    labels: ['ai.luna.daily-report', 'ai.luna.weekly-review', 'ai.luna.shadow-auto-promote'],
    replacementLabels: ['ai.investment.reporter'],
  },
  {
    group: 'cycle_workers_to_luna_skills',
    labels: ['ai.investment.luna-entry-trigger-worker', 'ai.investment.posttrade-feedback-worker'],
    replacementLabels: ['ai.elixir.supervisor'],
  },
  {
    group: 'market_alerts_to_reporter',
    labels: [
      'ai.investment.market-alert-crypto-daily',
      'ai.investment.market-alert-domestic-open',
      'ai.investment.market-alert-domestic-close',
      'ai.investment.market-alert-overseas-open',
      'ai.investment.market-alert-overseas-close',
    ],
    replacementLabels: ['ai.investment.reporter'],
  },
  {
    group: 'prescreen_to_argos',
    labels: ['ai.investment.prescreen-domestic', 'ai.investment.prescreen-overseas'],
    replacementLabels: ['ai.investment.argos'],
  },
  // Section 2-7: 추가 retire 검토 (Phase Ψ5 최종 8 달성)
  {
    group: 'crypto_to_mcp',
    labels: ['ai.investment.crypto', 'ai.investment.crypto.validation'],
    replacementLabels: ['ai.luna.marketdata-mcp'],
    replacementChecks: ['marketdata_mcp_health'],
  },
  {
    group: 'markets_to_stockflow',
    labels: [
      'ai.investment.domestic',
      'ai.investment.domestic.validation',
      'ai.investment.overseas',
      'ai.investment.overseas.validation',
    ],
    replacementLabels: ['ai.elixir.supervisor'],
  },
  {
    group: 'argos_to_elixir',
    labels: ['ai.investment.argos'],
    replacementLabels: ['ai.elixir.supervisor'],
  },
  {
    group: 'daily_feedback_to_skill',
    labels: ['ai.investment.daily-feedback'],
    replacementLabels: ['ai.elixir.supervisor'],
  },
  {
    group: 'reporter_to_telegram',
    labels: ['ai.investment.reporter'],
    replacementLabels: ['ai.elixir.supervisor'],
  },
];

function parseArgs(argv = process.argv.slice(2)) {
  const getValue = (name, fallback = null) => {
    const prefix = `${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
    return fallback;
  };
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
    confirm: getValue('--confirm'),
    group: getValue('--group'),
    maxGroups: Number(getValue('--max-groups', '0')) || 0,
    validationWaitMs: Number(getValue('--validation-wait-ms', process.env.LUNA_LAUNCHD_MIGRATION_WAIT_MS || '300000')),
    skipValidationWait: argv.includes('--skip-validation-wait'),
  };
}

function listLaunchdRows() {
  const result = runLaunchctl(['list']);
  if (!result.ok) {
    return {
      ok: false,
      rows: [],
      error: result.error || result.stderr || 'launchctl_list_failed',
      command: result.command,
    };
  }
  const rows = String(result.stdout || '')
    .split(/\r?\n/)
    .map(parseLaunchctlListLine)
    .filter(Boolean);
  return { ok: true, rows, command: result.command };
}

function getVisibleLabels({ visibleLabels = null } = {}) {
  if (Array.isArray(visibleLabels)) return new Set(visibleLabels);
  const listed = listLaunchdRows();
  if (!listed.ok) return new Set();
  return new Set(listed.rows.map((row) => row.label));
}

function plistPathForLabel(label) {
  return resolve(LAUNCHD_ROOT, `${label}.plist`);
}

function buildBootoutCommand(label) {
  return {
    label,
    args: ['bootout', `${launchdDomain()}/${label}`],
    command: `launchctl bootout ${launchdDomain()}/${label}`,
  };
}

function buildBootstrapCommand(label) {
  const plistPath = plistPathForLabel(label);
  return {
    label,
    plistPath,
    exists: existsSync(plistPath),
    args: ['bootstrap', launchdDomain(), plistPath],
    command: `launchctl bootstrap ${launchdDomain()} ${plistPath}`,
  };
}

function buildReplacementStatus(group, { visibleLabels = null } = {}) {
  const simulatedVisible = Array.isArray(visibleLabels) ? new Set(visibleLabels) : null;
  return (group.replacementLabels || []).map((label) => {
    if (simulatedVisible) {
      return {
        label,
        loaded: simulatedVisible.has(label),
        pid: simulatedVisible.has(label) ? 1 : null,
        lastExitStatus: null,
        ok: simulatedVisible.has(label),
        simulated: true,
      };
    }
    const state = inspectLaunchdList(label);
    return {
      label,
      loaded: Boolean(state.loaded),
      pid: state.pid ?? null,
      lastExitStatus: state.lastExitStatus ?? null,
      ok: Boolean(state.ok && state.loaded),
    };
  });
}

async function checkMarketdataMcpHealth({ timeoutMs = 3_000 } = {}) {
  const port = process.env.LUNA_MARKETDATA_MCP_PORT || '4088';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok && body?.ok !== false,
      status: response.status,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyGroupHealth(group, { visibleLabels = null } = {}) {
  const replacements = buildReplacementStatus(group, { visibleLabels });
  const missingReplacements = replacements.filter((item) => !item.ok).map((item) => item.label);
  const checks = [];
  if ((group.replacementChecks || []).includes('marketdata_mcp_health')) {
    if (Array.isArray(visibleLabels)) checks.push({ name: 'marketdata_mcp_health', ok: true, simulated: true });
    else checks.push({ name: 'marketdata_mcp_health', ...(await checkMarketdataMcpHealth()) });
  }
  const failedChecks = checks.filter((item) => !item.ok).map((item) => item.name);
  return {
    ok: missingReplacements.length === 0 && failedChecks.length === 0,
    replacements,
    checks,
    missingReplacements,
    failedChecks,
  };
}

export function buildLaunchdMigrationPlan({ visibleLabels = null } = {}) {
  const visible = getVisibleLabels({ visibleLabels });
  const retire = RETIRE_GROUPS.flatMap((group) => group.labels.map((label) => {
    const bootout = buildBootoutCommand(label);
    const rollback = buildBootstrapCommand(label);
    return {
      group: group.group,
      label,
      visible: visible.has(label),
      protected: PROTECTED_LABELS.has(label),
      action: PROTECTED_LABELS.has(label) ? 'keep_protected' : 'retire_candidate',
      bootoutCommand: bootout.command,
      rollbackCommand: rollback.command,
      rollbackPlistExists: rollback.exists,
    };
  }));
  const protectedViolations = retire.filter((item) => item.protected);
  return {
    ok: protectedViolations.length === 0,
    dryRun: true,
    requiredConfirm: REQUIRED_CONFIRM,
    targetLabels: TARGET_LABELS,
    protectedLabels: Array.from(PROTECTED_LABELS),
    retireCandidates: retire.filter((item) => item.action === 'retire_candidate'),
    visibleRetireCandidates: retire.filter((item) => item.action === 'retire_candidate' && item.visible),
    protectedViolations,
    steps: RETIRE_GROUPS.map((group) => ({
      group: group.group,
      labels: group.labels,
      visibleLabels: group.labels.filter((label) => visible.has(label)),
      replacementLabels: group.replacementLabels || [],
      action: 'dry_run_or_apply_with_confirm',
      validation: 'wait_then_verify_replacement_health_before_next_group',
    })),
    note: 'Apply requires --apply --confirm=luna-launchd-graceful-migration. Protected labels are never booted out.',
  };
}

async function rollbackBootedOutLabels(labels) {
  const results = [];
  for (const label of [...labels].reverse()) {
    const rollback = buildBootstrapCommand(label);
    if (!rollback.exists) {
      results.push({ label, ok: false, skipped: true, error: 'rollback_plist_missing', ...rollback });
      continue;
    }
    const result = runLaunchctl(rollback.args, { timeout: 10_000 });
    results.push({ label, ok: result.ok, ...rollback, result });
  }
  return results;
}

export async function executeLaunchdMigration({
  apply = false,
  confirm = null,
  group = null,
  maxGroups = 0,
  validationWaitMs = 300_000,
  skipValidationWait = false,
  visibleLabels = null,
} = {}) {
  const plan = buildLaunchdMigrationPlan({ visibleLabels });
  if (!plan.ok) {
    return {
      ok: false,
      dryRun: !apply,
      applied: false,
      code: 'protected_label_in_retire_plan',
      plan,
    };
  }
  if (apply && confirm !== REQUIRED_CONFIRM) {
    return {
      ok: false,
      dryRun: false,
      applied: false,
      code: 'confirmation_required',
      requiredConfirm: REQUIRED_CONFIRM,
      plan,
    };
  }

  const selectedGroups = RETIRE_GROUPS
    .filter((item) => !group || item.group === group)
    .slice(0, maxGroups > 0 ? maxGroups : undefined);
  const visible = getVisibleLabels({ visibleLabels });
  const steps = [];
  const bootedOut = [];

  for (const step of selectedGroups) {
    const visibleLabelsForStep = step.labels.filter((label) => visible.has(label));
    const stepResult = {
      group: step.group,
      labels: step.labels,
      visibleLabels: visibleLabelsForStep,
      replacementLabels: step.replacementLabels || [],
      dryRun: !apply,
      bootout: [],
      rollback: [],
      validation: null,
      skipped: visibleLabelsForStep.length === 0,
    };
    if (stepResult.skipped) {
      stepResult.validation = await verifyGroupHealth(step, { visibleLabels });
      steps.push(stepResult);
      continue;
    }

    if (!apply) {
      stepResult.bootout = visibleLabelsForStep.map((label) => ({ ...buildBootoutCommand(label), ok: true, planned: true }));
      stepResult.rollback = visibleLabelsForStep.map((label) => ({ ...buildBootstrapCommand(label), planned: true }));
      stepResult.validation = await verifyGroupHealth(step, { visibleLabels });
      steps.push(stepResult);
      continue;
    }

    for (const label of visibleLabelsForStep) {
      if (PROTECTED_LABELS.has(label)) {
        stepResult.bootout.push({ label, ok: false, error: 'protected_label_refused' });
        stepResult.rollback = await rollbackBootedOutLabels(bootedOut);
        return {
          ok: false,
          dryRun: false,
          applied: true,
          code: 'protected_label_refused',
          failedGroup: step.group,
          steps: [...steps, stepResult],
        };
      }
      const command = buildBootoutCommand(label);
      const result = runLaunchctl(command.args, { timeout: 10_000 });
      stepResult.bootout.push({ label, ok: result.ok, ...command, result });
      if (result.ok) bootedOut.push(label);
    }
    const bootoutFailures = stepResult.bootout.filter((item) => item.ok !== true);
    if (bootoutFailures.length > 0) {
      stepResult.rollback = await rollbackBootedOutLabels(bootedOut);
      steps.push(stepResult);
      return {
        ok: false,
        dryRun: false,
        applied: true,
        code: 'bootout_failed_rolled_back',
        failedGroup: step.group,
        bootoutFailures,
        bootedOut,
        steps,
      };
    }

    if (!skipValidationWait && validationWaitMs > 0) {
      await sleep(validationWaitMs);
    }
    stepResult.validation = await verifyGroupHealth(step, { visibleLabels });
    if (!stepResult.validation.ok) {
      stepResult.rollback = await rollbackBootedOutLabels(bootedOut);
      steps.push(stepResult);
      return {
        ok: false,
        dryRun: false,
        applied: true,
        code: 'validation_failed_rolled_back',
        failedGroup: step.group,
        bootedOut,
        steps,
      };
    }
    steps.push(stepResult);
  }

  return {
    ok: true,
    dryRun: !apply,
    applied: apply,
    selectedGroups: selectedGroups.map((item) => item.group),
    validationWaitMs,
    skippedValidationWait: skipValidationWait,
    bootedOut,
    beforePlan: plan,
    steps,
  };
}

async function main() {
  const args = parseArgs();
  const result = await executeLaunchdMigration(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) {
    console.log(`runtime-luna-launchd-migrate ${result.dryRun ? 'dry-run' : 'applied'} groups=${result.selectedGroups.length} bootedOut=${result.bootedOut.length}`);
  } else {
    console.log(`runtime-luna-launchd-migrate blocked code=${result.code || 'unknown'}`);
    process.exitCode = 1;
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-launchd-migrate 실패:' });
}
