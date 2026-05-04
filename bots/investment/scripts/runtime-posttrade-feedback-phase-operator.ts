#!/usr/bin/env node
// @ts-nocheck

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { buildPosttradeFeedbackL5Gate } from './runtime-posttrade-feedback-l5-gate.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaDelegatedAuthorityDecision } from '../shared/luna-delegated-authority.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = join(__dirname, '..');
const CONFIG_PATH = join(INVESTMENT_DIR, 'config.yaml');
const CONFIRM = 'luna-posttrade-feedback-operate';

const POSTTRADE_PHASES = [
  {
    phase: 'phaseA',
    key: 'trade_quality',
    label: 'Trade Quality Evaluator',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:trade-quality-evaluator-smoke',
  },
  {
    phase: 'phaseB',
    key: 'stage_attribution',
    label: 'Stage Attribution',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:stage-attribution-smoke',
  },
  {
    phase: 'phaseC',
    key: 'reflexion',
    label: 'Reflexion Engine',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:reflexion-engine-smoke',
  },
  {
    phase: 'phaseD',
    key: 'skill_extraction',
    label: 'Skill Extraction',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:posttrade-skill-extraction -- --force --dry-run --json',
  },
  {
    phase: 'phaseE',
    key: 'parameter_feedback_map',
    label: 'Feedback to Action Map',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:feedback-to-action-map-smoke',
  },
  {
    phase: 'phaseF',
    key: 'constitutional_feedback',
    label: 'Constitutional Feedback',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:posttrade-constitution-smoke',
  },
  {
    phase: 'phaseG',
    key: 'market_differentiated',
    label: 'Market Differentiated Learning',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:posttrade-market-differentiated-smoke',
  },
  {
    phase: 'phaseH',
    key: 'dashboard',
    label: 'Posttrade Dashboard',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:posttrade-dashboard-smoke',
  },
  {
    phase: 'worker',
    key: 'worker',
    label: 'Posttrade Worker',
    smokeCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:posttrade-feedback-heartbeat-bootstrap -- --json',
  },
];

function parseArgs(argv = process.argv.slice(2)) {
  const phaseRaw = argv.find((arg) => arg.startsWith('--phase='))?.split('=').slice(1).join('=') || 'all';
  const modeRaw = argv.find((arg) => arg.startsWith('--mode='))?.split('=').slice(1).join('=') || 'shadow';
  const confirm = argv.find((arg) => arg.startsWith('--confirm='))?.split('=').slice(1).join('=') || '';
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
    autoApply: argv.includes('--auto-apply'),
    runSmoke: argv.includes('--run-smoke'),
    rollbackOnFail: argv.includes('--rollback-on-fail'),
    phase: phaseRaw,
    mode: normalizeMode(modeRaw),
    confirm,
  };
}

function normalizeMode(value = 'shadow') {
  const mode = String(value || 'shadow').trim().toLowerCase();
  if (mode === 'shadow' || mode === 'supervised_l4' || mode === 'autonomous_l5') return mode;
  if (mode === 'supervised') return 'supervised_l4';
  if (mode === 'autonomous') return 'autonomous_l5';
  return 'shadow';
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  return yaml.load(readFileSync(CONFIG_PATH, 'utf8')) || {};
}

function pickPhases(config = {}, requested = 'all') {
  const all = POSTTRADE_PHASES.map((item) => item.phase);
  if (requested === 'all') return all;
  if (requested === 'next') {
    const cfg = config?.posttrade_feedback || {};
    const next = POSTTRADE_PHASES.find((item) => cfg?.[item.key]?.enabled !== true);
    return next ? [next.phase] : [];
  }
  return String(requested || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => all.includes(item));
}

function currentSection(config = {}, key = '') {
  return config?.posttrade_feedback?.[key] || {};
}

function buildPhasePatch(section = {}, mode = 'shadow', key = '', { autoApply = false } = {}) {
  const patch = {
    ...(section || {}),
    enabled: true,
    shadow: mode === 'shadow',
    hard_gate: false,
  };
  if (key === 'parameter_feedback_map') patch.auto_apply = mode !== 'shadow' && autoApply === true;
  if (key === 'worker') {
    patch.interval_sec = Math.max(300, Number(section?.interval_sec || 300) || 300);
    patch.loop_limit = Math.max(1, Number(section?.loop_limit || 20) || 20);
  }
  return patch;
}

export function patchPosttradeFeedbackConfig(config = {}, phases = [], mode = 'shadow', { autoApply = false } = {}) {
  const next = { ...(config || {}) };
  next.posttrade_feedback = { ...(next.posttrade_feedback || {}) };
  next.posttrade_feedback.mode = normalizeMode(mode);
  for (const phase of phases) {
    const meta = POSTTRADE_PHASES.find((item) => item.phase === phase);
    if (!meta) continue;
    next.posttrade_feedback[meta.key] = buildPhasePatch(currentSection(next, meta.key), next.posttrade_feedback.mode, meta.key, { autoApply });
  }
  return next;
}

export function buildPosttradeFeedbackPhasePlan({
  config = loadConfig(),
  requestedPhase = 'all',
  mode = 'shadow',
  autoApply = false,
} = {}) {
  const targetMode = normalizeMode(mode);
  const phases = pickPhases(config, requestedPhase);
  const steps = POSTTRADE_PHASES
    .filter((item) => phases.includes(item.phase))
    .map((item) => ({
      ...item,
      currentlyEnabled: currentSection(config, item.key)?.enabled === true,
      currentShadow: currentSection(config, item.key)?.shadow !== false,
      action: currentSection(config, item.key)?.enabled === true ? 'verify' : 'enable',
    }));
  const blockers = [];
  if (!existsSync(CONFIG_PATH)) blockers.push('config_yaml_missing');
  if (steps.length === 0) blockers.push('no_posttrade_phase_selected');
  if (targetMode === 'autonomous_l5') blockers.push('autonomous_l5_requires_separate_human_cutover');
  if (targetMode === 'shadow' && autoApply === true) blockers.push('auto_apply_requires_supervised_or_higher');
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'posttrade_phase_plan_ready' : 'posttrade_phase_plan_blocked',
    configPath: CONFIG_PATH,
    requestedPhase,
    mode: targetMode,
    autoApply: autoApply === true,
    confirmRequired: CONFIRM,
    steps,
    blockers,
    smokeCommands: steps.map((step) => step.smokeCommand),
  };
}

function withDelegatedPosttradeAuthority(plan = {}) {
  const autonomousBlocker = 'autonomous_l5_requires_separate_human_cutover';
  const blockers = Array.isArray(plan.blockers) ? [...plan.blockers] : [];
  const delegatedGateBlockers = blockers.filter((item) => item !== autonomousBlocker);
  const delegatedAuthority = buildLunaDelegatedAuthorityDecision({
    action: 'runtime_config_apply',
    finalGate: {
      ok: delegatedGateBlockers.length === 0,
      blockers: delegatedGateBlockers,
    },
  });

  if (blockers.includes(autonomousBlocker) && delegatedAuthority.canSelfApprove) {
    return {
      ...plan,
      ok: delegatedGateBlockers.length === 0,
      status: delegatedGateBlockers.length === 0 ? 'posttrade_phase_plan_ready' : 'posttrade_phase_plan_blocked',
      blockers: delegatedGateBlockers,
      delegatedAuthority,
    };
  }

  return {
    ...plan,
    delegatedAuthority,
  };
}

export function runSmokeCommands(commands = []) {
  return commands.map((command) => {
    const startedAt = new Date().toISOString();
    const proc = spawnSync(command, {
      shell: true,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env },
      cwd: INVESTMENT_DIR,
    });
    return {
      command,
      startedAt,
      ok: proc.status === 0,
      status: proc.status,
      signal: proc.signal || null,
      stdoutTail: String(proc.stdout || '').slice(-1200),
      stderrTail: String(proc.stderr || '').slice(-1200),
      error: proc.error?.message || null,
    };
  });
}

export async function runPosttradeFeedbackPhaseOperator(input = {}) {
  const args = { ...parseArgs([]), ...(input || {}) };
  const config = loadConfig();
  const plan = withDelegatedPosttradeAuthority(buildPosttradeFeedbackPhasePlan({
    config,
    requestedPhase: args.phase || 'all',
    mode: args.mode || 'shadow',
    autoApply: args.autoApply === true,
  }));

  if (!args.apply) {
    return {
      ok: plan.ok,
      status: plan.ok ? 'posttrade_phase_activation_preview_ready' : 'posttrade_phase_activation_preview_blocked',
      applied: false,
      plan,
      nextCommand: plan.ok
        ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:posttrade-feedback-phase-operate -- --phase=${args.phase || 'all'} --mode=${plan.mode}${args.autoApply === true ? ' --auto-apply' : ''} --apply${plan.delegatedAuthority?.canSelfApprove ? '' : ` --confirm=${CONFIRM}`} --run-smoke --rollback-on-fail --json`
        : null,
    };
  }

  if (args.confirm !== CONFIRM && plan.delegatedAuthority?.canSelfApprove !== true) {
    return {
      ok: false,
      status: 'posttrade_phase_activation_confirmation_required',
      applied: false,
      reason: `use --confirm=${CONFIRM}`,
      plan,
    };
  }
  if (plan.ok !== true) {
    return {
      ok: false,
      status: 'posttrade_phase_activation_blocked',
      applied: false,
      reason: plan.blockers.join(', ') || 'phase activation blocked',
      plan,
    };
  }

  const finalPatched = patchPosttradeFeedbackConfig(config, plan.steps.map((step) => step.phase), plan.mode, {
    autoApply: args.autoApply === true,
  });
  writeFileSync(CONFIG_PATH, yaml.dump(finalPatched, { lineWidth: 120, noRefs: true }), 'utf8');

  const smokeResults = args.runSmoke ? runSmokeCommands(plan.smokeCommands || []) : [];
  const smokeOk = smokeResults.every((item) => item.ok === true);
  let rollbackApplied = false;
  if (args.runSmoke && smokeOk !== true && args.rollbackOnFail === true) {
    writeFileSync(CONFIG_PATH, yaml.dump(config, { lineWidth: 120, noRefs: true }), 'utf8');
    rollbackApplied = true;
  }

  const l5Gate = await buildPosttradeFeedbackL5Gate({ strict: false }).catch((error) => ({
    ok: false,
    status: 'posttrade_l5_gate_failed',
    blockers: [`l5_gate_failed:${error?.message || String(error)}`],
  }));

  return {
    ok: (args.runSmoke ? smokeOk : true) && l5Gate?.ok === true,
    status: args.runSmoke && smokeOk !== true
      ? 'posttrade_phase_activation_applied_smoke_failed'
      : l5Gate?.ok === true
        ? 'posttrade_phase_activation_applied'
        : 'posttrade_phase_activation_applied_gate_attention',
    applied: true,
    mode: plan.mode,
    approvalSource: args.confirm === CONFIRM ? 'operator_confirm' : plan.delegatedAuthority?.approvalSource || null,
    enabledPhases: plan.steps.map((step) => step.phase),
    smokeOk: args.runSmoke ? smokeOk : null,
    rollbackApplied,
    plan,
    smokeResults,
    l5Gate,
  };
}

function renderText(result = {}) {
  return [
    '🌙 Luna posttrade feedback phase operator',
    `status: ${result.status || 'unknown'}`,
    `applied: ${result.applied === true}`,
    `mode: ${result.mode || result.plan?.mode || 'unknown'}`,
    `phases: ${(result.plan?.steps || []).map((step) => step.phase).join(',') || 'none'}`,
    `blockers: ${(result.plan?.blockers || []).join(' / ') || 'none'}`,
    `smoke: ${result.smokeOk == null ? 'not-run' : result.smokeOk}`,
    `rollback: ${result.rollbackApplied === true ? 'applied' : 'not-applied'}`,
    result.nextCommand ? `next: ${result.nextCommand}` : null,
  ].filter(Boolean).join('\n');
}

async function main() {
  const args = parseArgs();
  const result = await runPosttradeFeedbackPhaseOperator(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
  if (args.apply && result.ok !== true) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-phase-operator 실패:',
  });
}
