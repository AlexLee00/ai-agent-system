'use strict';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { execFileSync }: typeof import('child_process') = require('child_process');
const env: { PROJECT_ROOT: string } = require('../../../packages/core/lib/env');
const { isInsideLab }: { isInsideLab: (cwd: string) => boolean } = require('./worktree-lab');

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
  /[;&|><`$()\r\n]/,
  /(^|\s)\.\.(?:\/|\\|\s|$)/,
  /(^|\s)\/path\/to(?:\/|\s|$)/i,
];
const ALLOWED_EXECUTABLES = new Set(['node', 'npm', 'test', 'true', 'false', 'printf']);
const SAFE_NPM_SCRIPT = /^(?:test|smoke|check|typecheck|lint|build)(?::[A-Za-z0-9._-]+)*$/;

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
  const tokens = parseCommandTokens(command);
  if (!tokens || tokens.length === 0) return 'command_parse_failed';
  const executable = tokens[0];
  if (!ALLOWED_EXECUTABLES.has(executable)) return 'executable_not_allowed';
  if (tokens.slice(1).some((token) => {
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
    return path.isAbsolute(value) || value.split(/[\\/]/).includes('..');
  })) return 'path_escape_not_allowed';
  if (executable === 'node') {
    if (tokens[1] !== '--check' || tokens.length !== 3) return 'node_mode_not_allowed';
    if (tokens.slice(2).some((token) => token.startsWith('-'))) return 'node_argument_not_allowed';
  }
  if (executable === 'npm') {
    const npmError = validateNpmCommand(tokens);
    if (npmError) return npmError;
  }
  return null;
}

function validateNpmCommand(tokens: string[]): string | null {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--prefix') {
      if (!tokens[index + 1]) return 'npm_prefix_missing';
      index += 2;
      continue;
    }
    if (token.startsWith('--prefix=')) {
      index += 1;
      continue;
    }
    if (token === '-s' || token === '--silent') {
      index += 1;
      continue;
    }
    break;
  }

  const operation = tokens[index];
  if (operation === 'test') {
    return tokens.slice(index + 1).every((token) => token === '-s' || token === '--silent')
      ? null
      : 'npm_test_arguments_not_allowed';
  }
  if (operation !== 'run') return 'npm_operation_not_allowed';
  index += 1;
  while (tokens[index] === '-s' || tokens[index] === '--silent') index += 1;
  const script = tokens[index];
  if (!script || !SAFE_NPM_SCRIPT.test(script)) return 'npm_script_not_allowed';
  return index === tokens.length - 1 ? null : 'npm_script_arguments_not_allowed';
}

function parseCommandTokens(command: string): string[] | null {
  const tokens: string[] = [];
  const matcher = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  let consumed = '';
  while ((match = matcher.exec(command)) !== null) {
    const gap = command.slice(consumed.length, match.index);
    if (gap && !/^\s+$/.test(gap)) return null;
    const token = match[1] !== undefined
      ? match[1].replace(/\\(["\\])/g, '$1')
      : match[2] !== undefined
        ? match[2]
        : match[3];
    tokens.push(token);
    consumed = command.slice(0, matcher.lastIndex);
  }
  if (command.slice(consumed.length).trim()) return null;
  return tokens;
}

function commandPathContainmentError(command: string, cwd: string): string | null {
  const tokens = parseCommandTokens(command) || [];
  let target = '';
  if (tokens[0] === 'node') target = tokens[2] || '';
  if (tokens[0] === 'npm') {
    const prefixIndex = tokens.indexOf('--prefix');
    if (prefixIndex >= 0) target = tokens[prefixIndex + 1] || '';
    if (!target) {
      const prefixArg = tokens.find((token) => token.startsWith('--prefix='));
      if (prefixArg) target = prefixArg.slice('--prefix='.length);
    }
  }
  if (!target) return null;
  try {
    const realCwd = fs.realpathSync(cwd);
    const realTarget = fs.realpathSync(path.resolve(realCwd, target));
    if (realTarget !== realCwd && !realTarget.startsWith(`${realCwd}${path.sep}`)) {
      return 'command_path_outside_lab';
    }
    return null;
  } catch {
    return 'command_path_missing';
  }
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
  const pathError = safetyError ? null : commandPathContainmentError(assertion.command, cwd);
  if (safetyError || pathError) {
    return {
      name: assertion.name,
      command: assertion.command,
      ok: false,
      durationMs: 0,
      exitCode: null,
      stdout: '',
      stderr: '',
      error: safetyError || pathError,
      expect: assertion.expect,
    };
  }

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    const [executable, ...args] = parseCommandTokens(assertion.command) || [];
    stdout = String(execFileSync(executable, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME || '',
        TMPDIR: process.env.TMPDIR || '/tmp',
        NODE_ENV: 'test',
        CI: '1',
        NO_COLOR: '1',
      },
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
  options: { cwd: string; now?: () => number; verifyLab?: boolean } = { cwd: env.PROJECT_ROOT }
) {
  let executableLab = false;
  try {
    const realCwd = fs.realpathSync(options.cwd);
    executableLab = isInsideLab(realCwd) && fs.existsSync(path.join(realCwd, '.git'));
  } catch {}
  if (options.verifyLab !== false && !executableLab) {
    return {
      ok: false,
      validation: { ok: false, predicate: null, errors: ['lab_cwd_required'] },
      predicate: null,
      assertionResults: [],
      predicate_results: [],
      budget: null,
      failureReason: 'lab_cwd_required',
    };
  }
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
    'Commands run from the Darwin lab cwd. Use one command per assertion; no cd, shell operators, absolute paths, network calls, DB, launchd, git, or secrets.',
    'Allowed forms only: node --check <relative-file>, npm [--prefix <relative-dir>] run [-s] <test|smoke|check|typecheck|lint|build script>, npm test, test, true, false, printf.',
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
