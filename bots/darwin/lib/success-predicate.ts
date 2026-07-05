'use strict';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { execFileSync }: typeof import('child_process') = require('child_process');
const env: { PROJECT_ROOT: string } = require('../../../packages/core/lib/env');

interface PredicateExpect {
  exitCode?: number;
  stdoutIncludes?: string;
}

interface PredicateAssertion {
  name: string;
  command: string;
  expect: PredicateExpect;
}

interface SuccessPredicate {
  assertions: PredicateAssertion[];
  targetMetric: {
    description: string;
    source: string;
  };
  budget: {
    maxWallMs: number;
    maxLlmCalls: number;
  };
}

interface PredicateValidationResult {
  ok: boolean;
  predicate: SuccessPredicate | null;
  errors: string[];
}

interface AssertionResult {
  name: string;
  command: string;
  ok: boolean;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  expect: PredicateExpect;
}

const DEFAULT_MAX_WALL_MS = 300_000;
const DEFAULT_MAX_LLM_CALLS = 20;
const MIN_ASSERTIONS = 3;
const MAX_ASSERTIONS = 6;
const MAX_OUTPUT_CHARS = 4000;
const LEARNINGS_PATH = path.join(env.PROJECT_ROOT, 'bots/darwin/docs/learnings.md');

const UNSAFE_COMMAND_PATTERNS = [
  /\blaunchctl\b/i,
  /\bgit\s+push\b/i,
  /\bgh\s+pr\b/i,
  /\bpsql\b/i,
  /\bsudo\b/i,
  /\brm\s+-rf\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
];

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeExpect(raw: unknown): PredicateExpect {
  const obj = toObject(raw);
  const expect: PredicateExpect = {};
  if (obj.exitCode !== undefined) {
    const exitCode = Number(obj.exitCode);
    if (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) expect.exitCode = exitCode;
  }
  if (obj.stdoutIncludes !== undefined) {
    const text = String(obj.stdoutIncludes || '');
    if (text) expect.stdoutIncludes = text;
  }
  return expect;
}

function normalizeSuccessPredicate(raw: unknown): SuccessPredicate | null {
  const obj = toObject(raw);
  const assertionsRaw = Array.isArray(obj.assertions) ? obj.assertions : [];
  const assertions = assertionsRaw.map((item) => {
    const assertion = toObject(item);
    return {
      name: String(assertion.name || '').trim(),
      command: String(assertion.command || '').trim(),
      expect: normalizeExpect(assertion.expect),
    };
  });
  const targetMetric = toObject(obj.targetMetric);
  const budget = toObject(obj.budget);
  return {
    assertions,
    targetMetric: {
      description: String(targetMetric.description || '').trim(),
      source: String(targetMetric.source || '').trim(),
    },
    budget: {
      maxWallMs: readPositiveInt(budget.maxWallMs, DEFAULT_MAX_WALL_MS),
      maxLlmCalls: readPositiveInt(budget.maxLlmCalls, DEFAULT_MAX_LLM_CALLS),
    },
  };
}

function validateCommandSafety(command: string): string | null {
  if (!command) return 'command_missing';
  if (command.length > 500) return 'command_too_long';
  if (UNSAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) return 'unsafe_command';
  return null;
}

function validateSuccessPredicate(raw: unknown): PredicateValidationResult {
  const predicate = normalizeSuccessPredicate(raw);
  const errors: string[] = [];
  if (!predicate) return { ok: false, predicate: null, errors: ['predicate_missing'] };

  if (predicate.assertions.length < MIN_ASSERTIONS) errors.push(`assertions_too_few:${predicate.assertions.length}`);
  if (predicate.assertions.length > MAX_ASSERTIONS) errors.push(`assertions_too_many:${predicate.assertions.length}`);
  if (!predicate.targetMetric.description) errors.push('target_metric_description_missing');
  if (!predicate.targetMetric.source) errors.push('target_metric_source_missing');
  if (predicate.budget.maxWallMs <= 0) errors.push('budget_max_wall_ms_invalid');
  if (predicate.budget.maxLlmCalls <= 0) errors.push('budget_max_llm_calls_invalid');

  predicate.assertions.forEach((assertion, index) => {
    if (!assertion.name) errors.push(`assertion_${index}_name_missing`);
    const safetyError = validateCommandSafety(assertion.command);
    if (safetyError) errors.push(`assertion_${index}_${safetyError}`);
    if (assertion.expect.exitCode === undefined && assertion.expect.stdoutIncludes === undefined) {
      errors.push(`assertion_${index}_expect_missing`);
    }
  });

  return { ok: errors.length === 0, predicate, errors };
}

function parseJsonObjectFromText(text: unknown): Record<string, unknown> | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return toObject(parsed);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1]);
      return toObject(parsed);
    } catch {}
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      return toObject(parsed);
    } catch {}
  }
  return null;
}

function truncate(value: unknown): string {
  return String(value || '').slice(0, MAX_OUTPUT_CHARS);
}

function runOneAssertion(assertion: PredicateAssertion, cwd: string, timeoutMs: number): AssertionResult {
  const started = Date.now();
  const safetyError = validateCommandSafety(assertion.command);
  if (safetyError) {
    return {
      name: assertion.name,
      command: assertion.command,
      ok: false,
      durationMs: 0,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: safetyError,
      expect: assertion.expect,
    };
  }

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = String(execFileSync(assertion.command, {
      cwd,
      shell: '/bin/bash',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    }) || '');
  } catch (error) {
    const err = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; signal?: string; message?: string };
    exitCode = Number.isInteger(err.status) ? Number(err.status) : err.signal === 'SIGTERM' ? 124 : 1;
    stdout = String(err.stdout || '');
    stderr = String(err.stderr || err.message || '');
  }

  const expectedExitCode = assertion.expect.exitCode ?? 0;
  const exitOk = exitCode === expectedExitCode;
  const stdoutOk = assertion.expect.stdoutIncludes === undefined || stdout.includes(assertion.expect.stdoutIncludes);
  return {
    name: assertion.name,
    command: assertion.command,
    ok: exitOk && stdoutOk,
    durationMs: Date.now() - started,
    exitCode,
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    error: exitOk ? stdoutOk ? null : 'stdout_mismatch' : 'exit_code_mismatch',
    expect: assertion.expect,
  };
}

function runSuccessPredicate(
  rawPredicate: unknown,
  options: { cwd: string; now?: () => number } = { cwd: env.PROJECT_ROOT }
) {
  const validation = validateSuccessPredicate(rawPredicate);
  if (!validation.ok || !validation.predicate) {
    return {
      ok: false,
      validation,
      predicate: validation.predicate,
      assertionResults: [],
      budget: null,
      failureReason: 'predicate_invalid',
    };
  }

  const predicate = validation.predicate;
  const now = options.now || Date.now;
  const started = now();
  const assertionResults: AssertionResult[] = [];
  for (const assertion of predicate.assertions) {
    const elapsed = now() - started;
    const remaining = predicate.budget.maxWallMs - elapsed;
    if (remaining <= 0) {
      assertionResults.push({
        name: assertion.name,
        command: assertion.command,
        ok: false,
        durationMs: 0,
        exitCode: null,
        stdout: '',
        stderr: '',
        error: 'budget_exceeded',
        expect: assertion.expect,
      });
      break;
    }
    const result = runOneAssertion(assertion, options.cwd, Math.max(1, remaining));
    assertionResults.push(result);
    if (!result.ok) break;
  }

  const durationMs = now() - started;
  const ok = assertionResults.length === predicate.assertions.length && assertionResults.every((item) => item.ok);
  return {
    ok,
    validation,
    predicate,
    assertionResults,
    predicate_results: assertionResults,
    budget: {
      maxWallMs: predicate.budget.maxWallMs,
      maxLlmCalls: predicate.budget.maxLlmCalls,
      durationMs,
      llmCalls: 0,
      withinWallBudget: durationMs <= predicate.budget.maxWallMs,
      withinLlmBudget: true,
    },
    failureReason: ok ? null : assertionResults.find((item) => !item.ok)?.error || 'assertion_failed',
  };
}

function appendLearningLine(
  proposalId: string,
  reason: string,
  details: Record<string, unknown> = {},
  options: { learningsPath?: string } = {}
): string {
  const learningsPath = options.learningsPath || LEARNINGS_PATH;
  fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
  const line = [
    new Date().toISOString(),
    `proposal=${proposalId}`,
    `reason=${reason}`,
    `details=${JSON.stringify(details).slice(0, 600)}`,
  ].join(' | ');
  fs.appendFileSync(learningsPath, `${line}\n`, 'utf8');
  return line;
}

function buildPredicateGenerationPrompt(paper: Record<string, unknown>, proposal: string): string {
  return [
    'Return JSON only. No markdown.',
    'Schema: {"assertions":[{"name":"...","command":"...","expect":{"exitCode":0}}],"targetMetric":{"description":"...","source":"..."},"budget":{"maxWallMs":300000,"maxLlmCalls":20}}',
    'Create 3 to 6 binary assertions that reuse existing repo checks/smokes where possible.',
    'Commands must run from the repository root or Darwin lab cwd and must not mutate DB, launchd, git remote, or secrets.',
    `Paper title: ${String(paper.title || '')}`,
    `Paper summary: ${String(paper.korean_summary || paper.summary || '').slice(0, 1200)}`,
    `Proposal: ${String(proposal || '').slice(0, 2000)}`,
  ].join('\n');
}

module.exports = {
  DEFAULT_MAX_WALL_MS,
  DEFAULT_MAX_LLM_CALLS,
  MIN_ASSERTIONS,
  MAX_ASSERTIONS,
  LEARNINGS_PATH,
  normalizeSuccessPredicate,
  validateSuccessPredicate,
  validateCommandSafety,
  parseJsonObjectFromText,
  runSuccessPredicate,
  appendLearningLine,
  buildPredicateGenerationPrompt,
};
