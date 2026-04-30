// @ts-nocheck
import { spawn } from 'node:child_process';

export const GUARDRAIL_CATEGORIES = ['safety', 'runtime', 'data', 'trading'];

const DEFAULT_GUARDRAILS = [
  {
    name: 'luna_l5_readiness',
    category: 'safety',
    severity: 'critical',
    owner: 'luna',
    command: ['node', 'scripts/luna-l5-readiness-report.ts', '--json'],
  },
  {
    name: 'intelligent_discovery',
    category: 'trading',
    severity: 'high',
    owner: 'scout',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:intelligent-discovery'],
  },
  {
    name: 'posttrade_feedback',
    category: 'data',
    severity: 'high',
    owner: 'chronos',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:posttrade-feedback'],
  },
  {
    name: 'agent_memory_routing',
    category: 'runtime',
    severity: 'medium',
    owner: 'luna',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:agent-memory-routing'],
  },
  {
    name: 'omega_completion',
    category: 'runtime',
    severity: 'medium',
    owner: 'luna',
    command: ['npm', '--prefix', new URL('..', import.meta.url).pathname, 'run', '-s', 'check:luna-final-omega'],
  },
  {
    name: 'luna_full_integration_closure_gate',
    category: 'safety',
    severity: 'critical',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-full-integration-closure-gate.ts', '--json'],
  },
  {
    name: 'luna_operational_blocker_pack',
    category: 'safety',
    severity: 'critical',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-operational-blocker-pack.ts', '--json'],
  },
  {
    name: 'luna_reconcile_blockers',
    category: 'trading',
    severity: 'critical',
    owner: 'hephaestos',
    command: ['node', 'scripts/luna-reconcile-blocker-report.ts', '--json'],
  },
  {
    name: 'luna_live_fire_final_gate',
    category: 'safety',
    severity: 'critical',
    owner: 'luna',
    command: ['node', 'scripts/luna-live-fire-final-gate.ts', '--json'],
  },
  {
    name: 'agent_message_bus_hygiene',
    category: 'runtime',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/runtime-agent-message-bus-hygiene.ts', '--dry-run', '--json'],
  },
  {
    name: 'luna_curriculum_bootstrap_plan',
    category: 'runtime',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-curriculum-bootstrap.ts', '--json'],
  },
  {
    name: 'luna_launchd_cutover_preflight_pack',
    category: 'runtime',
    severity: 'high',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-launchd-cutover-preflight-pack.ts', '--json'],
  },
  {
    name: 'luna_7day_observation',
    category: 'data',
    severity: 'medium',
    owner: 'luna',
    command: ['node', 'scripts/runtime-luna-7day-report.ts', '--json', '--no-write'],
  },
];

function normalizeEntry(entry = {}) {
  if (!GUARDRAIL_CATEGORIES.includes(entry.category)) throw new Error(`invalid guardrail category: ${entry.category}`);
  if (!entry.name || !Array.isArray(entry.command) || entry.command.length === 0) throw new Error('invalid guardrail entry');
  return {
    severity: 'medium',
    owner: 'luna',
    evidence: {},
    ...entry,
  };
}

export function createGuardrailRegistry(entries = DEFAULT_GUARDRAILS) {
  const normalized = entries.map(normalizeEntry);
  return {
    entries: normalized,
    list: (category = null) => category ? normalized.filter((entry) => entry.category === category) : [...normalized],
    get: (name) => normalized.find((entry) => entry.name === name) || null,
  };
}

function runCommand(command, { cwd = new URL('..', import.meta.url).pathname, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const [bin, ...args] = command;
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, exitCode: null, stdout, stderr: `${stderr}\nTIMEOUT ${timeoutMs}ms`.trim() });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, stdout, stderr });
    });
  });
}

export async function runGuardrail(entry, opts = {}) {
  const normalized = normalizeEntry(entry);
  if (opts.dryRun !== false) {
    return {
      ok: true,
      dryRun: true,
      name: normalized.name,
      category: normalized.category,
      severity: normalized.severity,
      owner: normalized.owner,
      command: normalized.command,
      blockers: [],
      warnings: [],
      evidence: { registered: true },
    };
  }
  const result = await runCommand(normalized.command, opts);
  return {
    ok: result.ok,
    dryRun: false,
    name: normalized.name,
    category: normalized.category,
    severity: normalized.severity,
    owner: normalized.owner,
    command: normalized.command,
    blockers: result.ok ? [] : [`exit_code:${result.exitCode}`],
    warnings: result.stderr ? [result.stderr.slice(0, 500)] : [],
    evidence: { stdout: result.stdout.slice(0, 1000) },
  };
}

export async function runRegisteredGuardrails({ category = null, dryRun = true } = {}) {
  const registry = createGuardrailRegistry();
  const entries = registry.list(category);
  const results = [];
  for (const entry of entries) results.push(await runGuardrail(entry, { dryRun }));
  return {
    ok: results.every((result) => result.ok),
    total: results.length,
    passed: results.filter((result) => result.ok).length,
    results,
  };
}

export default {
  GUARDRAIL_CATEGORIES,
  createGuardrailRegistry,
  runGuardrail,
  runRegisteredGuardrails,
};
