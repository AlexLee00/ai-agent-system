#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * Refactorer cycle runner.
 *
 * Safe contract:
 * - default mode is off
 * - shadow mode runs analyze + plan only
 * - active mode is opt-in and restores mutations before exit
 */

process.env.PG_DIRECT = process.env.PG_DIRECT || 'true';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

const env = require('../../../packages/core/lib/env');
const { writeClaudeHeartbeat, errorHeartbeatMeta } = require('../lib/agent-heartbeat');
const { recordAutoDevOutcome } = require('../lib/auto-dev-pipeline');
const gitOps = require('../lib/git-ops.ts');
const { isProtectedTargetPath } = require('../lib/protected-targets.ts');

const ROOT = env.PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..');
const DEFAULT_TARGET = 'bots/claude';
const DEFAULT_REFACTOR_TYPE = 'ts_nocheck';
const DEFAULT_MCP_BASE = process.env.REFACTOR_MCP_URL || 'http://localhost:8774';
const DEFAULT_HUB_BASE = process.env.HUB_URL || 'http://localhost:7788';
const AUTOFIX_SELECTOR_KEY = 'claude.refactorer.code_refactor';
const AUTOFIX_FILE_MAX_LINES = 1200;
const AUTOFIX_FILE_MAX_BYTES = 60 * 1024;
const AUTOFIX_TIMEOUT_MS = 120000;
const AUTOFIX_ESTIMATED_COST_LIMIT = Number(process.env.REFACTORER_AUTOFIX_ESTIMATED_COST_LIMIT || 0.25) || 0.25;
const PLAN_DIR = path.join(ROOT, 'docs', 'codex', 'refactor-plans');
const PATCH_DIR = path.join(PLAN_DIR, 'patches');
const REFACTORER_LOCK_PATH = path.join(ROOT, '.refactorer-active.lock');
const REFACTORER_LOCK_STALE_MS = 10 * 60 * 1000;
const REFACTORER_HISTORY_SCAN_LIMIT = Math.max(1, Number(process.env.REFACTORER_HISTORY_SCAN_LIMIT || 80) || 80);
const MAX_SCAN_FILES = Math.max(1, Number(process.env.REFACTORER_MAX_SCAN_FILES || 5000) || 5000);
const MAX_LARGE_FILES = Math.max(1, Number(process.env.REFACTORER_MAX_LARGE_FILES || 10) || 10);

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'output',
  'archive',
  // Test fixtures may intentionally contain @ts-nocheck to exercise the
  // refactorer; production scans should never select those files.
  '__tests__',
  '.next',
  '.turbo',
  'venv',
  '__pycache__',
]);

const NON_PRODUCTION_CANDIDATE_FRAGMENTS = [
  '/__tests__/',
  '/fixtures/',
  '/tmp-refactor-',
];

function nowIso() {
  return new Date().toISOString();
}

function cycleStamp(date = new Date()) {
  const kst = new Date(date.getTime() + (9 * 60 * 60 * 1000));
  return kst.toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
}

function normalizeCycleMode(value = process.env.REFACTORER_CYCLE_MODE) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'shadow' || normalized === 'active') return normalized;
  return 'off';
}

function parsePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function activeMaxFiles(value = process.env.REFACTORER_ACTIVE_MAX_FILES) {
  return parsePositiveInt(value, 1, 3);
}

function booleanEnvEnabled(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

function booleanEnvEnabledByDefault(value, fallback = true) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function applyEnabled(value = process.env.REFACTORER_APPLY_ENABLED) {
  return booleanEnvEnabled(value);
}

function applyPushEnabled(value = process.env.REFACTORER_APPLY_PUSH) {
  return booleanEnvEnabledByDefault(value, true);
}

function applyStrictGateEnabled(value = process.env.REFACTORER_APPLY_STRICT_GATE) {
  return booleanEnvEnabledByDefault(value, true);
}

function strictGateBaselineEnabled(value = process.env.REFACTORER_STRICT_GATE_BASELINE) {
  return booleanEnvEnabledByDefault(value, true);
}

function applyMaxPerCycle(value = process.env.REFACTORER_APPLY_MAX_PER_CYCLE) {
  return parsePositiveInt(value, 3, 10);
}

function normalizeDirtyScope(value = process.env.REFACTORER_DIRTY_SCOPE) {
  const scope = String(value || '').trim().toLowerCase();
  return ['file', 'workspace', 'tree'].includes(scope) ? scope : 'workspace';
}

function autofixEnabled(value = process.env.REFACTORER_AUTOFIX_ENABLED) {
  return booleanEnvEnabled(value);
}

function strictAutofixEnabled(value = process.env.REFACTORER_STRICT_AUTOFIX_ENABLED) {
  return booleanEnvEnabledByDefault(value, true);
}

function autofixMaxAttempts(value = process.env.REFACTORER_AUTOFIX_MAX_ATTEMPTS) {
  return parsePositiveInt(value, 1, 2);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    target: DEFAULT_TARGET,
    refactorType: DEFAULT_REFACTOR_TYPE,
    mode: process.env.REFACTORER_CYCLE_MODE,
    dryRun: false,
    json: false,
    noMcp: false,
    noVaultFeedback: false,
    noHeartbeat: false,
    noWriteOutcome: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i] || '');
    if (arg === '--json') options.json = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-mcp') options.noMcp = true;
    else if (arg === '--no-vault-feedback') options.noVaultFeedback = true;
    else if (arg === '--no-heartbeat') options.noHeartbeat = true;
    else if (arg === '--no-write-outcome') options.noWriteOutcome = true;
    else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length);
    else if (arg === '--mode') options.mode = argv[++i];
    else if (arg.startsWith('--target=')) options.target = arg.slice('--target='.length);
    else if (arg === '--target') options.target = argv[++i] || DEFAULT_TARGET;
    else if (arg.startsWith('--refactor-type=')) options.refactorType = arg.slice('--refactor-type='.length);
    else if (arg === '--refactor-type') options.refactorType = argv[++i] || DEFAULT_REFACTOR_TYPE;
  }
  return options;
}

function relPath(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function resolveTarget(target = DEFAULT_TARGET) {
  const absolutePath = path.resolve(ROOT, String(target || DEFAULT_TARGET));
  const relativePath = relPath(absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return { ok: false, absolutePath, relativePath, reason: 'target_outside_project_root' };
  }
  if (!fs.existsSync(absolutePath)) {
    return { ok: false, absolutePath, relativePath, reason: 'target_not_found' };
  }
  return { ok: true, absolutePath, relativePath };
}

function isProtectedTarget(relativePath = '') {
  return isProtectedTargetPath(relativePath);
}

function isNonProductionRefactorCandidate(relativePath = '') {
  const normalized = `/${String(relativePath || '').replace(/\\/g, '/')}`;
  return NON_PRODUCTION_CANDIDATE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function safeRead(filePath, limit = 2_000_000) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > limit) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function countLines(filePath) {
  const content = safeRead(filePath);
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

function listTsFiles(rootPath, result = []) {
  if (result.length >= MAX_SCAN_FILES) return result;
  if (isProtectedTarget(relPath(rootPath))) return result;
  let stat = null;
  try {
    stat = fs.statSync(rootPath);
  } catch {
    return result;
  }
  if (stat.isFile()) {
    if (rootPath.endsWith('.ts') && !isProtectedTarget(relPath(rootPath))) result.push(rootPath);
    return result;
  }
  if (!stat.isDirectory()) return result;
  let entries = [];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (result.length >= MAX_SCAN_FILES) break;
    const fullPath = path.join(rootPath, entry.name);
    if (isProtectedTarget(relPath(fullPath))) continue;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) listTsFiles(fullPath, result);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      result.push(fullPath);
    }
  }
  return result;
}

function estimateAutofixCost({ lines = 0, bytes = 0, errorCount = 0 } = {}) {
  const estimated = (Number(lines || 0) * 0.00012)
    + (Number(bytes || 0) / 1024 * 0.0018)
    + (Number(errorCount || 0) * 0.018);
  return Number(estimated.toFixed(6));
}

function candidateRiskLevel({ lines = 0, bytes = 0, nodeExecutable = false, estimatedCost = 0 } = {}) {
  if (estimatedCost > AUTOFIX_ESTIMATED_COST_LIMIT || lines > 900 || bytes > 45 * 1024) return 'high';
  if (nodeExecutable || lines > 350 || bytes > 20 * 1024) return 'medium';
  return 'low';
}

function scoreRefactorCandidate({ lines = 0, bytes = 0, nodeExecutable = false, estimatedCost = 0, refactorType = DEFAULT_REFACTOR_TYPE } = {}) {
  let score = refactorType === 'ts_nocheck' ? 100 : 20;
  score -= Math.min(35, Math.floor(Number(lines || 0) / 25));
  score -= Math.min(25, Math.floor(Number(bytes || 0) / 2048));
  if (nodeExecutable) score -= 8;
  if (estimatedCost > AUTOFIX_ESTIMATED_COST_LIMIT) score -= 45;
  return Math.max(0, Math.min(100, score));
}

function buildCandidate(filePath, refactorType, lines, reason, content = null) {
  const body = content === null ? safeRead(filePath) : String(content || '');
  const bytes = byteLength(body);
  const nodeExecutable = isNodeExecutableFile(relPath(filePath), body);
  const estimatedCost = estimateAutofixCost({ lines, bytes, errorCount: 1 });
  const riskLevel = candidateRiskLevel({ lines, bytes, nodeExecutable, estimatedCost });
  const preflightReasons = [
    nodeExecutable ? 'node_executable_jsdoc_only' : null,
    estimatedCost > AUTOFIX_ESTIMATED_COST_LIMIT ? 'estimated_cost_over_limit' : null,
    lines > 500 ? 'large_file' : null,
  ].filter(Boolean);
  return {
    file: relPath(filePath),
    lines,
    bytes,
    refactorType,
    reason,
    score: scoreRefactorCandidate({ lines, bytes, nodeExecutable, estimatedCost, refactorType }),
    riskLevel,
    nodeExecutable,
    estimatedCost,
    preflightReasons,
  };
}

function analyzeLocalTechDebt(target) {
  const files = listTsFiles(target.absolutePath);
  const details = files.map((filePath) => {
    const content = safeRead(filePath);
    return {
      filePath,
      lines: content ? content.split(/\r?\n/).length : 0,
      tsNocheck: content.includes('@ts-nocheck'),
    };
  });
  const tsNocheck = details.filter((item) => item.tsNocheck);
  const largeFiles = details
    .filter((item) => item.lines > 500)
    .sort((a, b) => b.lines - a.lines)
    .slice(0, MAX_LARGE_FILES);
  const smallNocheck = tsNocheck
    .slice()
    .sort((a, b) => a.lines - b.lines)
    .slice(0, 5);

  const candidates = [];
  for (const item of smallNocheck) {
    const content = safeRead(item.filePath);
    candidates.push(buildCandidate(item.filePath, 'ts_nocheck', item.lines, 'small_ts_nocheck_leaf_first', content));
  }
  for (const item of largeFiles.slice(0, 5)) {
    if (!candidates.some((candidate) => candidate.file === relPath(item.filePath))) {
      const content = safeRead(item.filePath);
      candidates.push(buildCandidate(item.filePath, 'split', item.lines, 'large_file_split_candidate', content));
    }
  }

  return {
    ok: true,
    source: 'local-static',
    target: target.relativePath,
    summary: {
      totalTsFiles: files.length,
      tsNocheckCount: tsNocheck.length,
      tsNocheckRatio: files.length ? `${((tsNocheck.length / files.length) * 100).toFixed(1)}%` : '0.0%',
      largeFilesCount: largeFiles.length,
    },
    largeFiles: largeFiles.map((item) => ({ file: relPath(item.filePath), lines: item.lines })),
    candidates,
    priorities: [
      { rank: 1, area: '@ts-nocheck recovery', count: tsNocheck.length, strategy: 'start with small leaf modules' },
      { rank: 2, area: 'large file split', count: largeFiles.length, strategy: 'split one responsibility per cycle' },
      { rank: 3, area: 'dedup', count: null, strategy: 'defer to targeted duplicate analysis in later phases' },
    ],
  };
}

async function callRefactorMcp(tool, params, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.REFACTORER_MCP_TIMEOUT_MS || 15000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${options.baseUrl || DEFAULT_MCP_BASE}/tools/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function byteLength(value = '') {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function lineCount(value = '') {
  return String(value || '').split(/\r?\n/).length;
}

function stripMarkdownFence(value = '') {
  let text = String(value || '').trim();
  const fenced = text.match(/^```[a-zA-Z0-9_.-]*\s*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();
  return text;
}

function extractHubText(json = {}) {
  return stripMarkdownFence(
    json.text
      || json.outputText
      || json.output
      || json.result?.text
      || json.data?.text
      || ''
  );
}

function isBillingGuardError(status, json = {}, errorText = '') {
  const structuredError = json.error && typeof json.error === 'object'
    ? [json.error.code, json.error.message].filter(Boolean).join(' ')
    : json.error;
  const text = [
    status === 429 ? '429' : '',
    structuredError,
    json.message,
    json.reason,
    errorText,
  ].filter(Boolean).join(' ').toLowerCase();
  const errorCode = String(json.error?.code || json.code || structuredError || '').trim().toLowerCase();
  const admissionBackpressure = json.limiterBackpressure === true
    || errorCode.startsWith('shared_limiter_')
    || ['queue_full', 'queue_timeout', 'admission_rejected'].includes(errorCode);
  if (admissionBackpressure) return false;
  return status === 429 || /budget|billing|quota|insufficient[_ -]?credit|payment/.test(text);
}

function builderErrorText(verify) {
  const builder = verify?.builder || {};
  const resultErrors = Array.isArray(builder.results)
    ? builder.results.map((item) => item.error || item.warning || item.message).filter(Boolean)
    : [];
  return [
    builder.error,
    builder.message,
    ...resultErrors,
  ].filter(Boolean).join('\n').slice(0, 6000);
}

function parseTypeScriptErrorCodes(errorText = '') {
  const codes = new Set();
  const pattern = /\bTS(\d{4})\b/g;
  let match = pattern.exec(String(errorText || ''));
  while (match) {
    codes.add(`TS${match[1]}`);
    match = pattern.exec(String(errorText || ''));
  }
  return [...codes].sort();
}

function isLocallySupportedTs2339(errorText = '') {
  const text = String(errorText || '');
  return /TS2339[\s\S]*does not exist on type ['"`](unknown|\{\})['"`]/.test(text)
    || /TS2339[\s\S]*Object\.values/i.test(text);
}

function classifyFixerCapability({ errorText = '', lines = 0, bytes = 0 } = {}) {
  const errorCodes = parseTypeScriptErrorCodes(errorText);
  const estimatedCost = estimateAutofixCost({ lines, bytes, errorCount: Math.max(1, errorCodes.length) });
  if (estimatedCost > AUTOFIX_ESTIMATED_COST_LIMIT || lines > AUTOFIX_FILE_MAX_LINES || bytes > AUTOFIX_FILE_MAX_BYTES) {
    return {
      errorCodes,
      estimatedCost,
      fixerCapability: 'budget_blocked',
      failureClass: 'budget_blocked',
      nextAction: 'reduce_file_scope_or_raise_budget',
    };
  }
  const localSupported = new Set(['TS7006', 'TS7031', 'TS7053', 'TS18046']);
  const unsupported = errorCodes.filter((code) => !localSupported.has(code) && !(code === 'TS2339' && isLocallySupportedTs2339(errorText)));
  const manualCodes = new Set(['TS2365']);
  const hasUnsupportedShapeTs2339 = unsupported.includes('TS2339');
  if (hasUnsupportedShapeTs2339 || unsupported.some((code) => manualCodes.has(code))) {
    return {
      errorCodes,
      estimatedCost,
      fixerCapability: 'manual_required',
      failureClass: 'autofix_capability_gap',
      nextAction: 'add_targeted_local_fixer_or_manual_type_repair',
    };
  }
  if (errorCodes.length > 0 && unsupported.length === 0) {
    return {
      errorCodes,
      estimatedCost,
      fixerCapability: 'local_supported',
      failureClass: 'local_autofix_available',
      nextAction: 'run_local_autofix',
    };
  }
  return {
    errorCodes,
    estimatedCost,
    fixerCapability: 'llm_required',
    failureClass: 'llm_autofix_required',
    nextAction: 'run_llm_autofix',
  };
}

function reviewerHighFindings(verify) {
  const findings = Array.isArray(verify?.reviewer?.findings) ? verify.reviewer.findings : [];
  return findings
    .filter((item) => ['high', 'critical'].includes(String(item.severity || '').toLowerCase()))
    .map((item) => ({
      file: item.file || null,
      line: item.line || null,
      severity: item.severity || null,
      desc: item.desc || item.message || item.title || null,
    }))
    .slice(0, 20);
}

function isNodeExecutableContent(content) {
  const firstLine = String(content || '').split(/\r?\n/, 1)[0] || '';
  return /^#!.*\bnode\b/.test(firstLine)
    || /\brequire\s*\(/.test(content)
    || /\bmodule\.exports\b/.test(content)
    || /\bexports\./.test(content);
}

function isNodeExecutableFile(fileRel, content) {
  return String(fileRel || '').endsWith('.ts') && isNodeExecutableContent(String(content || ''));
}

function runNodeCheckForFile(fileRel) {
  const absPath = path.resolve(ROOT, fileRel);
  try {
    execFileSync(process.execPath, ['--check', absPath], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { pass: true, skipped: false, message: 'node --check pass', error: null };
  } catch (error) {
    return {
      pass: false,
      skipped: false,
      message: 'node --check failed',
      error: String(error?.stderr || error?.stdout || error?.message || error).slice(0, 6000),
    };
  }
}

function runNodeCheckGate(changedFiles) {
  const results = [];
  for (const fileRel of changedFiles || []) {
    const absPath = path.resolve(ROOT, fileRel);
    if (!fs.existsSync(absPath)) continue;
    const content = fs.readFileSync(absPath, 'utf8');
    if (!isNodeExecutableFile(fileRel, content)) {
      results.push({ file: fileRel, pass: true, skipped: true, message: 'not_node_executable' });
      continue;
    }
    results.push({ file: fileRel, ...runNodeCheckForFile(fileRel) });
  }
  const failed = results.filter((item) => item.skipped !== true && item.pass !== true);
  return {
    pass: failed.length === 0,
    failed,
    results,
    message: failed.length === 0 ? 'node-check pass' : 'node-check failed',
  };
}

function nodeExecutableAutofixInstruction(nodeExecutable) {
  if (!nodeExecutable) return null;
  return [
    'This file is executed or checked by raw Node.',
    'Never add inline TypeScript type annotations such as `x: Type`, `): Type`, `as Type`, or interface/type declarations that raw Node cannot parse.',
    'Use JSDoc only for types, for example `/** @param {string} name */` and `/** @returns {boolean} */`.',
    'The revised file must pass `node --check` as well as TypeScript verification.',
  ].join(' ');
}

function buildFixerSystemPrompt(options = {}) {
  return [
    'You are Claude team refactorer code fixer.',
    'Fix TypeScript type errors exposed by removing // @ts-nocheck.',
    'Return only the complete revised file content.',
    'Do not wrap the answer in Markdown fences and do not include explanations.',
    'Make the smallest change required for tsc/reviewer to pass.',
    'Do not add features, change runtime behavior, or edit unrelated code.',
    'Do not reinsert @ts-nocheck.',
    nodeExecutableAutofixInstruction(options.nodeExecutable),
  ].join(' ');
}

function buildFixerPrompt({ fileRel, currentContent, builderError, reviewerFindings, priorErrors, attempt, nodeExecutable = isNodeExecutableFile(fileRel, currentContent) }) {
  return [
    `file: ${fileRel}`,
    `attempt: ${attempt}`,
    nodeExecutable ? 'node_executable: true — use JSDoc only; inline TypeScript syntax is forbidden because raw Node must parse this file.' : 'node_executable: false',
    '',
    'Current file content:',
    currentContent,
    '',
    'Builder/TypeScript error text:',
    builderError || '(none)',
    '',
    'Reviewer high-severity findings:',
    JSON.stringify(reviewerFindings || [], null, 2),
    '',
    'Prior failures for THIS file in past cycles (do NOT reintroduce these errors; fix the root cause):',
    (Array.isArray(priorErrors) && priorErrors.length > 0)
      ? priorErrors.map((item, index) => `${index + 1}. ${item}`).join('\n')
      : '(none)',
    '',
    'Return the complete revised file content only.',
  ].join('\n');
}

function ts7006ImplicitAnyParameters(errorText) {
  const params = new Set();
  const text = String(errorText || '');
  const patterns = [
    /TS7006:[^\n]*Parameter\s+'([^']+)'\s+implicitly has an 'any' type/gi,
    /TS7006:[^\n]*Parameter\s+"([^"]+)"\s+implicitly has an "any" type/gi,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(match[1])) params.add(match[1]);
      match = pattern.exec(text);
    }
  }
  return params;
}

function ts7031BindingElements(errorText) {
  const params = new Set();
  const text = String(errorText || '');
  const pattern = /TS7031:[^\n]*Binding element\s+'([^']+)'\s+implicitly has an 'any' type/gi;
  let match = pattern.exec(text);
  while (match) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(match[1])) params.add(match[1]);
    match = pattern.exec(text);
  }
  return params;
}

function normalizeFunctionParamName(param) {
  const cleaned = String(param || '')
    .trim()
    .replace(/^\.\.\./, '')
    .replace(/\s*=.*$/, '')
    .trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cleaned)) return null;
  return cleaned;
}

function previousNonEmptyLine(lines, index) {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const line = String(lines[cursor] || '').trim();
    if (line) return line;
  }
  return '';
}

function jsdocForParams(indent, params) {
  return [
    `${indent}/**`,
    ...params.map((param) => `${indent} * @param {any} ${param}`),
    `${indent} */`,
  ];
}

function addNodeExecutableImplicitAnyJsdoc(currentContent, builderError = '') {
  const implicitAnyParams = ts7006ImplicitAnyParameters(builderError);
  if (implicitAnyParams.size === 0) return { ok: false, fixedContent: null, error: 'no_ts7006_parameters' };

  const hadTsNocheck = /@ts-nocheck/.test(String(currentContent || ''));
  const lines = String(currentContent || '')
    .split(/\r?\n/)
    .filter((line) => !/@ts-nocheck/.test(line));
  const output = [];
  let changed = hadTsNocheck;
  let coveredImplicitAnyFunction = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = line.match(/^(\s*)(?:(?:module\.)?exports(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?\s*=\s*)?(?:async\s+)?function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(([^)]*)\)/)
      || line.match(/^(\s*)(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(([^)]*)\)/);
    if (match) {
      const indent = match[1] || '';
      const allParams = String(match[2] || '')
        .split(',')
        .map(normalizeFunctionParamName)
        .filter(Boolean);
      const params = allParams.some((param) => implicitAnyParams.has(param))
        ? allParams
        : [];
      const alreadyDocumented = /\*\/$/.test(previousNonEmptyLine(output, output.length));
      if (params.length > 0 && !alreadyDocumented) {
        output.push(...jsdocForParams(indent, params));
        changed = true;
        coveredImplicitAnyFunction = true;
      } else if (params.length > 0 && alreadyDocumented) {
        coveredImplicitAnyFunction = true;
      }
    }
    output.push(line);
  }

  if (!changed || !coveredImplicitAnyFunction) return { ok: false, fixedContent: null, error: 'no_local_jsdoc_change' };
  return {
    ok: true,
    fixedContent: output.join('\n'),
    model: 'local-jsdoc-ts7006',
    provider: 'local',
  };
}

function implicitAnyDefaultForParam(param) {
  const name = String(param || '').trim();
  if (/^(items|entries|jobs|missing|active|historical)$/i.test(name)) return '[]';
  if (/^selector$/i.test(name)) return 'JSON.stringify';
  if (/^db$/i.test(name)) return "{ exec: console.log, prepare: (sql = '') => ({ run: console.log }) }";
  if (/^data$/i.test(name)) return '{ bugs: [] }';
  if (/^(root|relPath|file|fileRel|path|id|state|stage|status|reason)$/i.test(name)) return "''";
  if (/^filePath$/i.test(name)) return "''";
  return null;
}

function addNodeExecutableImplicitAnyDefaults(currentContent, builderError = '') {
  const implicitAnyParams = ts7006ImplicitAnyParameters(builderError);
  if (implicitAnyParams.size === 0) return { ok: false, fixedContent: null, error: 'no_ts7006_parameters' };

  const hadTsNocheck = /@ts-nocheck/.test(String(currentContent || ''));
  const lines = String(currentContent || '')
    .split(/\r?\n/)
    .filter((line) => !/@ts-nocheck/.test(line));
  let changed = hadTsNocheck;
  const fixedLines = lines.map((line) => line.replace(
    /^(\s*(?:(?:module\.)?exports(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?\s*=\s*)?(?:async\s+)?function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*)\(([^)]*)\)/,
    (match, prefix, rawParams) => {
      const rawParamList = String(rawParams || '').split(',');
      const normalizedParams = rawParamList.map((param) => normalizeFunctionParamName(param.trim())).filter(Boolean);
      const shouldRewriteFunction = normalizedParams.some((param) => implicitAnyParams.has(param));
      const params = rawParamList.map((param) => {
        const trimmed = param.trim();
        const normalized = normalizeFunctionParamName(trimmed);
        if (!normalized || !shouldRewriteFunction || /=/.test(trimmed)) return trimmed;
        const defaultValue = implicitAnyDefaultForParam(normalized);
        if (!defaultValue) return trimmed;
        changed = true;
        return `${normalized} = ${defaultValue}`;
      });
      return `${prefix}(${params.join(', ')})`;
    }
  ));
  const fixedContent = fixedLines.join('\n');
  if (!changed || fixedContent === String(currentContent || '')) {
    return { ok: false, fixedContent: null, error: 'no_local_implicit_any_default_change' };
  }
  return {
    ok: true,
    fixedContent,
    model: 'local-implicit-any-defaults-ts7006',
    provider: 'local',
  };
}

function addNodeExecutableDestructuredParamDefaults(currentContent, builderError = '') {
  const bindingElements = ts7031BindingElements(builderError);
  if (bindingElements.size === 0) return { ok: false, fixedContent: null, error: 'no_ts7031_binding_elements' };

  const hadTsNocheck = /@ts-nocheck/.test(String(currentContent || ''));
  let fixedContent = String(currentContent || '')
    .split(/\r?\n/)
    .filter((line) => !/@ts-nocheck/.test(line))
    .join('\n');
  let changed = hadTsNocheck;
  fixedContent = fixedContent.replace(
    /(\b(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*)\(\s*\{([^}]*)\}\s*(=\s*\{\s*\})?\s*\)/g,
    (_match, prefix, rawFields, existingDefault) => {
      const fields = String(rawFields || '').split(',').map((field) => {
        const trimmed = field.trim();
        if (!trimmed) return trimmed;
        const name = normalizeFunctionParamName(trimmed);
        if (!name || !bindingElements.has(name) || /=/.test(trimmed)) return trimmed;
        changed = true;
        return `${name} = ''`;
      });
      if (!existingDefault) changed = true;
      return `${prefix}({ ${fields.join(', ')} } = {})`;
    }
  );
  if (!changed || fixedContent === String(currentContent || '')) {
    return { ok: false, fixedContent: null, error: 'no_local_destructured_default_change' };
  }
  return {
    ok: true,
    fixedContent,
    model: 'local-destructured-defaults-ts7031',
    provider: 'local',
  };
}

function ts18046UnknownVariables(errorText) {
  const variables = new Set();
  const text = String(errorText || '');
  const patterns = [
    /TS18046:[^\n]*'([^']+)'\s+is of type 'unknown'/gi,
    /TS18046:[^\n]*"([^"]+)"\s+is of type "unknown"/gi,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(match[1])) variables.add(match[1]);
      match = pattern.exec(text);
    }
  }
  return variables;
}

function ts2339ObjectMessageVariables(content, errorText) {
  if (!/TS2339:[^\n]*Property\s+'message'\s+does not exist on type '\{\}'/i.test(String(errorText || ''))) {
    return new Set();
  }
  const variables = new Set();
  const pattern = /\b([A-Za-z_$][A-Za-z0-9_$]*)\.message\b/g;
  let match = pattern.exec(String(content || ''));
  while (match) {
    variables.add(match[1]);
    match = pattern.exec(String(content || ''));
  }
  return variables;
}

function addNodeExecutableUnknownGuard(currentContent, builderError = '') {
  const unknownVariables = ts18046UnknownVariables(builderError);
  for (const variable of ts2339ObjectMessageVariables(currentContent, builderError)) {
    unknownVariables.add(variable);
  }
  if (unknownVariables.size === 0) return { ok: false, fixedContent: null, error: 'no_ts18046_variables' };

  const hadTsNocheck = /@ts-nocheck/.test(String(currentContent || ''));
  let fixedContent = String(currentContent || '')
    .split(/\r?\n/)
    .filter((line) => !/@ts-nocheck/.test(line))
    .join('\n');
  let changed = hadTsNocheck;
  let guarded = false;

  for (const variable of unknownVariables) {
    const messageAccess = new RegExp(`\\b${variable}\\.message\\b`, 'g');
    if (!messageAccess.test(fixedContent)) continue;
    fixedContent = fixedContent.replace(
      messageAccess,
      `(${variable} && ${variable}.message ? ${variable}.message : String(${variable}))`
    );
    changed = true;
    guarded = true;
  }

  if (!changed || !guarded) return { ok: false, fixedContent: null, error: 'no_local_unknown_guard_change' };
  return {
    ok: true,
    fixedContent,
    model: 'local-unknown-guard-ts18046',
    provider: 'local',
  };
}

function ts2339UnknownProperties(errorText) {
  const properties = new Set();
  const text = String(errorText || '');
  const pattern = /TS2339:[^\n]*Property\s+'([^']+)'\s+does not exist on type 'unknown'/gi;
  let match = pattern.exec(text);
  while (match) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(match[1])) properties.add(match[1]);
    match = pattern.exec(text);
  }
  return properties;
}

function addNodeExecutableUnknownPropertyGuard(currentContent, builderError = '') {
  const unknownProperties = ts2339UnknownProperties(builderError);
  if (unknownProperties.size === 0) return { ok: false, fixedContent: null, error: 'no_ts2339_unknown_properties' };

  const hadTsNocheck = /@ts-nocheck/.test(String(currentContent || ''));
  const lines = String(currentContent || '')
    .split(/\r?\n/)
    .filter((line) => !/@ts-nocheck/.test(line));
  const textWithoutTsNocheck = lines.join('\n');
  const unknownVariables = new Set();
  for (const property of unknownProperties) {
    const accessPattern = new RegExp(`\\b([A-Za-z_$][A-Za-z0-9_$]*)\\.${property}\\b`, 'g');
    let match = accessPattern.exec(textWithoutTsNocheck);
    while (match) {
      unknownVariables.add(match[1]);
      match = accessPattern.exec(textWithoutTsNocheck);
    }
  }
  if (unknownVariables.size === 0) return { ok: false, fixedContent: null, error: 'no_unknown_property_variable' };

  const output = [];
  let guarded = false;
  for (const line of lines) {
    let rewritten = false;
    for (const variable of unknownVariables) {
      const entriesPattern = new RegExp(`^(\\s*)for\\s*\\(\\s*const\\s*\\[\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*,\\s*${variable}\\s*\\]\\s+of\\s+Object\\.entries\\((.+)\\)\\s*\\)\\s*\\{\\s*$`);
      const match = line.match(entriesPattern);
      if (!match) continue;
      const indent = match[1] || '';
      const keyName = match[2];
      const expression = match[3].trim();
      const entriesName = `${variable}Entries`;
      output.push(`${indent}const ${entriesName} = JSON.parse(JSON.stringify(${expression} || {}));`);
      output.push(`${indent}for (const ${keyName} of Object.keys(${entriesName})) {`);
      output.push(`${indent}  const ${variable} = ${entriesName}[${keyName}];`);
      guarded = true;
      rewritten = true;
      break;
    }
    if (!rewritten) output.push(line);
  }
  if (!guarded) return { ok: false, fixedContent: null, error: 'no_local_unknown_property_guard_change' };

  const fixedContent = output.join('\n');
  if (!hadTsNocheck && fixedContent === String(currentContent || '')) {
    return { ok: false, fixedContent: null, error: 'no_local_unknown_property_guard_change' };
  }
  return {
    ok: true,
    fixedContent,
    model: 'local-unknown-property-ts2339',
    provider: 'local',
  };
}

function addNodeExecutableObjectValuesGuard(currentContent, builderError = '') {
  const unknownProperties = ts2339UnknownProperties(builderError);
  if (unknownProperties.size === 0 && !hasTs7053IndexError(builderError)) {
    return { ok: false, fixedContent: null, error: 'no_ts2339_unknown_properties' };
  }

  const hadTsNocheck = /@ts-nocheck/.test(String(currentContent || ''));
  let fixedContent = String(currentContent || '')
    .split(/\r?\n/)
    .filter((line) => !/@ts-nocheck/.test(line))
    .join('\n');
  let changed = hadTsNocheck;
  fixedContent = fixedContent.replace(
    /^(\s*)(const\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*)Object\.values\(([^;\n]+)\);/gm,
    (_match, indent, declaration, expression) => {
      changed = true;
      return `${indent}/** @type {any[]} */\n${indent}${declaration}JSON.parse(JSON.stringify(Object.values(${expression})));`;
    }
  );
  if (!changed || fixedContent === String(currentContent || '')) {
    return { ok: false, fixedContent: null, error: 'no_local_object_values_guard_change' };
  }
  return {
    ok: true,
    fixedContent,
    model: 'local-object-values-ts2339',
    provider: 'local',
  };
}

function addNodeExecutableFilterLoopRewrite(currentContent, builderError = '') {
  if (ts7006ImplicitAnyParameters(builderError).size === 0) {
    return { ok: false, fixedContent: null, error: 'no_ts7006_parameters' };
  }
  const lines = String(currentContent || '')
    .split(/\r?\n/)
    .filter((line) => !/@ts-nocheck/.test(line));
  const output = [];
  let changed = /@ts-nocheck/.test(String(currentContent || ''));
  for (const line of lines) {
    const match = line.match(/^(\s*)const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_$][A-Za-z0-9_$.]*)\.filter\(\(([A-Za-z_$][A-Za-z0-9_$]*)\)\s*=>\s*(.+)\);\s*$/);
    if (match) {
      const indent = match[1] || '';
      const outName = match[2];
      const sourceName = match[3];
      const itemName = match[4];
      const condition = match[5];
      output.push(`${indent}const ${outName} = [];`);
      output.push(`${indent}for (const ${itemName} of ${sourceName} || []) {`);
      output.push(`${indent}  if (${condition}) ${outName}.push(${itemName});`);
      output.push(`${indent}}`);
      changed = true;
      continue;
    }
    output.push(line);
  }
  const fixedContent = output.join('\n');
  if (!changed || fixedContent === String(currentContent || '')) {
    return { ok: false, fixedContent: null, error: 'no_local_filter_loop_change' };
  }
  return {
    ok: true,
    fixedContent,
    model: 'local-filter-loop-ts7006',
    provider: 'local',
  };
}

function addNodeExecutableArrowParamDefaults(currentContent, builderError = '') {
  const implicitAnyParams = ts7006ImplicitAnyParameters(builderError);
  if (implicitAnyParams.size === 0) return { ok: false, fixedContent: null, error: 'no_ts7006_parameters' };

  const defaults = {
    b: "{ id: '', title: '', status: '' }",
    bug: "{ id: '', title: '', status: '' }",
    entry: "{ id: '', title: '', status: '', relPath: '', state: '', reason: '' }",
    job: "{ id: '', relPath: '', status: '', stage: '', updatedAt: '', error: '', lastError: '' }",
  };
  let fixedContent = String(currentContent || '')
    .split(/\r?\n/)
    .filter((line) => !/@ts-nocheck/.test(line))
    .join('\n');
  let changed = /@ts-nocheck/.test(String(currentContent || ''));
  for (const [param, defaultValue] of Object.entries(defaults)) {
    if (!implicitAnyParams.has(param)) continue;
    const pattern = new RegExp(`(?<![A-Za-z0-9_$])${param}\\s*=>`, 'g');
    fixedContent = fixedContent.replace(pattern, () => {
      changed = true;
      return `(${param} = ${defaultValue}) =>`;
    });
  }
  if (!changed || fixedContent === String(currentContent || '')) {
    return { ok: false, fixedContent: null, error: 'no_local_arrow_default_change' };
  }
  return {
    ok: true,
    fixedContent,
    model: 'local-arrow-defaults-ts7006',
    provider: 'local',
  };
}

function hasTs7053IndexError(errorText) {
  return /TS7053:[^\n]*Element implicitly has an 'any' type/i.test(String(errorText || ''));
}

function addNodeExecutableRecordIndexJsdoc(currentContent, builderError = '') {
  if (!hasTs7053IndexError(builderError)) {
    return { ok: false, fixedContent: null, error: 'no_ts7053_index_error' };
  }

  const hadTsNocheck = /@ts-nocheck/.test(String(currentContent || ''));
  const lines = String(currentContent || '')
    .split(/\r?\n/)
    .filter((line) => !/@ts-nocheck/.test(line));
  const textWithoutTsNocheck = lines.join('\n');
  const indexedObjects = new Set();
  const indexPattern = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\[[^\]\n]+\]/g;
  let indexMatch = indexPattern.exec(textWithoutTsNocheck);
  while (indexMatch) {
    indexedObjects.add(indexMatch[1]);
    indexMatch = indexPattern.exec(textWithoutTsNocheck);
  }
  if (indexedObjects.size === 0) {
    return { ok: false, fixedContent: null, error: 'no_indexed_objects' };
  }

  let fixedText = textWithoutTsNocheck;
  for (const objectName of indexedObjects) {
    const escaped = objectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const countPattern = new RegExp(
      `\\b${escaped}\\s*\\[\\s*([^\\]\\n]+?)\\s*\\]\\s*=\\s*\\(\\s*${escaped}\\s*\\[\\s*\\1\\s*\\]\\s*\\|\\|\\s*0\\s*\\)\\s*\\+\\s*1\\s*;`,
      'g'
    );
    fixedText = fixedText.replace(countPattern, (_match, keyExpression) => {
      const key = String(keyExpression || '').trim();
      return `${objectName}.set(${key}, (${objectName}.get(${key}) || 0) + 1);`;
    });
    fixedText = fixedText.replace(
      new RegExp(`^(\\s*)const\\s+${escaped}\\s*=\\s*\\{\\s*\\};\\s*$`, 'gm'),
      `$1const ${objectName} = new Map();`
    );
    fixedText = fixedText.replace(
      new RegExp(`\\breturn\\s+${escaped}\\s*;`, 'g'),
      `return Object.fromEntries(${objectName}.entries());`
    );
  }
  if (fixedText !== textWithoutTsNocheck) {
    return {
      ok: true,
      fixedContent: fixedText,
      model: 'local-record-index-ts7053',
      provider: 'local',
    };
  }

  const output = [];
  let changed = hadTsNocheck;
  for (const line of lines) {
    const match = line.match(/^(\s*)const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\{\s*\};\s*$/);
    if (match && indexedObjects.has(match[2])) {
      const previous = previousNonEmptyLine(output, output.length);
      if (!/@type\s+\{Record<string,\s*any>\}/.test(previous)) {
        output.push(`${match[1]}/** @type {Record<string, any>} */`);
        changed = true;
      }
    }
    output.push(line);
  }

  const fixedContent = output.join('\n');
  if (!changed || fixedContent === String(currentContent || '')) {
    return { ok: false, fixedContent: null, error: 'no_local_record_index_jsdoc_change' };
  }
  return {
    ok: true,
    fixedContent,
    model: 'local-record-index-ts7053',
    provider: 'local',
  };
}

function attemptNodeExecutableLocalTypeFix(currentContent, builderError = '') {
  let fixedContent = String(currentContent || '');
  const models = [];
  const defaultsFix = addNodeExecutableImplicitAnyDefaults(fixedContent, builderError);
  if (defaultsFix.ok === true) {
    fixedContent = defaultsFix.fixedContent;
    models.push(defaultsFix.model);
  }
  const jsdocFix = addNodeExecutableImplicitAnyJsdoc(fixedContent, builderError);
  if (jsdocFix.ok === true) {
    fixedContent = jsdocFix.fixedContent;
    models.push(jsdocFix.model);
  }
  const destructuredDefaultsFix = addNodeExecutableDestructuredParamDefaults(fixedContent, builderError);
  if (destructuredDefaultsFix.ok === true) {
    fixedContent = destructuredDefaultsFix.fixedContent;
    models.push(destructuredDefaultsFix.model);
  }
  const unknownGuardFix = addNodeExecutableUnknownGuard(fixedContent, builderError);
  if (unknownGuardFix.ok === true) {
    fixedContent = unknownGuardFix.fixedContent;
    models.push(unknownGuardFix.model);
  }
  const unknownPropertyFix = addNodeExecutableUnknownPropertyGuard(fixedContent, builderError);
  if (unknownPropertyFix.ok === true) {
    fixedContent = unknownPropertyFix.fixedContent;
    models.push(unknownPropertyFix.model);
  }
  const objectValuesFix = addNodeExecutableObjectValuesGuard(fixedContent, builderError);
  if (objectValuesFix.ok === true) {
    fixedContent = objectValuesFix.fixedContent;
    models.push(objectValuesFix.model);
  }
  const filterLoopFix = addNodeExecutableFilterLoopRewrite(fixedContent, builderError);
  if (filterLoopFix.ok === true) {
    fixedContent = filterLoopFix.fixedContent;
    models.push(filterLoopFix.model);
  }
  const arrowDefaultsFix = addNodeExecutableArrowParamDefaults(fixedContent, builderError);
  if (arrowDefaultsFix.ok === true) {
    fixedContent = arrowDefaultsFix.fixedContent;
    models.push(arrowDefaultsFix.model);
  }
  const recordIndexFix = addNodeExecutableRecordIndexJsdoc(fixedContent, builderError);
  if (recordIndexFix.ok === true) {
    fixedContent = recordIndexFix.fixedContent;
    models.push(recordIndexFix.model);
  }
  if (models.length === 0) return { ok: false, fixedContent: null, error: 'no_local_type_fix' };
  return {
    ok: true,
    fixedContent,
    model: models.join('+'),
    provider: 'local',
  };
}

async function attemptTypeFix(context, { fileRel, currentContent, builderError, reviewerFindings, priorErrors, attempt }) {
  try {
    if (lineCount(currentContent) > AUTOFIX_FILE_MAX_LINES || byteLength(currentContent) > AUTOFIX_FILE_MAX_BYTES) {
      return { ok: false, fixedContent: null, error: 'too_large' };
    }
    if (isNodeExecutableFile(fileRel, currentContent)) {
      const localFix = attemptNodeExecutableLocalTypeFix(currentContent, builderError);
      if (localFix.ok === true) return localFix;
    }
    const token = String(process.env.HUB_AUTH_TOKEN || '').trim();
    if (!token) return { ok: false, fixedContent: null, error: 'missing_hub_auth_token' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTOFIX_TIMEOUT_MS);
    try {
      const res = await fetch(`${context.hubBaseUrl || DEFAULT_HUB_BASE}/hub/llm/call`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          callerTeam: 'claude',
          agent: 'refactorer',
          abstractModel: 'anthropic_sonnet',
          selectorKey: AUTOFIX_SELECTOR_KEY,
          taskType: 'code_refactor',
          tokenBudgetProfile: 'code_refactor',
          prompt: buildFixerPrompt({ fileRel, currentContent, builderError, reviewerFindings, priorErrors, attempt }),
          systemPrompt: buildFixerSystemPrompt({ nodeExecutable: isNodeExecutableFile(fileRel, currentContent) }),
          maxTokens: 8192,
          temperature: 0.1,
          timeoutMs: AUTOFIX_TIMEOUT_MS,
        }),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok !== true) {
        return {
          ok: false,
          fixedContent: null,
          status: res.status,
          billingGuard: isBillingGuardError(res.status, json),
          error: String(json.error || json.message || `http_${res.status}`),
        };
      }
      const fixedContent = extractHubText(json);
      if (!fixedContent) return { ok: false, fixedContent: null, error: 'empty_fixer_output' };
      if (/@ts-nocheck/.test(fixedContent)) return { ok: false, fixedContent: null, error: 'ts_nocheck_reinserted' };
      return {
        ok: true,
        fixedContent,
        model: json.model || json.result?.model || null,
        provider: json.provider || json.result?.provider || null,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message = String(error?.message || error);
    return {
      ok: false,
      fixedContent: null,
      billingGuard: isBillingGuardError(null, {}, message),
      error: message,
    };
  }
}

async function analyzeStep(context) {
  const local = analyzeLocalTechDebt(context.target);
  if (context.noMcp) {
    return { ...local, mcp: { skipped: true, reason: 'no_mcp' } };
  }
  const mcp = await callRefactorMcp('analyze_tech_debt', { path: context.target.absolutePath });
  return {
    ...local,
    source: mcp.ok && mcp.data?.ok ? 'mcp+local-static' : local.source,
    mcp: mcp.ok ? mcp.data : { ok: false, error: mcp.error || `http_${mcp.status || 'unknown'}` },
  };
}

function selectCandidate(analysis, requestedType = DEFAULT_REFACTOR_TYPE) {
  const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
  return candidates.find((candidate) => candidate.refactorType === requestedType)
    || candidates[0]
    || {
      file: analysis?.target || DEFAULT_TARGET,
      lines: null,
      refactorType: requestedType,
      reason: 'no_specific_candidate_available',
    };
}

function tsExtensionImportUnsupportedForTargetedTsc(content) {
  return /^\s*import\s+.+?\s+from\s+['"][^'"]+\.ts['"]/m.test(String(content || ''));
}

function candidateCurrentRefactorState(candidate, requestedType = DEFAULT_REFACTOR_TYPE) {
  const refactorType = String(candidate?.refactorType || requestedType || '');
  if (refactorType !== 'ts_nocheck') return { matches: true, reason: null };
  const absolutePath = candidateAbsolutePath(candidate);
  if (!absolutePath || !fs.existsSync(absolutePath)) return { matches: false, reason: 'candidate_missing' };
  const content = fs.readFileSync(absolutePath, 'utf8');
  if (!/^\s*\/\/\s*@ts-nocheck\s*$/m.test(content)) return { matches: false, reason: 'current_state_mismatch' };
  if (tsExtensionImportUnsupportedForTargetedTsc(content)) return { matches: false, reason: 'unsupported_ts_extension_import' };
  return { matches: true, reason: null };
}

function candidateMatchesCurrentRefactorState(candidate, requestedType = DEFAULT_REFACTOR_TYPE) {
  return candidateCurrentRefactorState(candidate, requestedType).matches;
}

function selectActiveCandidatesDetailed(analysis, requestedType = DEFAULT_REFACTOR_TYPE, maxFiles = 1, avoidedFiles = new Set(), options = {}) {
  const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
  const preferred = candidates.filter((candidate) => candidate.refactorType === requestedType);
  const byScore = (a, b) => {
    const scoreDelta = Number(b?.score || 0) - Number(a?.score || 0);
    if (scoreDelta !== 0) return scoreDelta;
    return Number(a?.lines || 0) - Number(b?.lines || 0);
  };
  const ordered = [
    ...preferred.slice().sort(byScore),
    ...candidates.filter((candidate) => candidate.refactorType !== requestedType).sort(byScore),
  ];
  const allowNonProductionCandidates = Boolean(options.allowNonProductionCandidates);
  const validateCurrentState = Boolean(options.validateCurrentState);
  const selected = [];
  const skipped = [];
  const skip = (candidate, reason) => {
    skipped.push({
      file: candidate?.file || null,
      refactorType: candidate?.refactorType || null,
      reason,
    });
  };
  for (const candidate of ordered) {
    if (!candidate?.file) {
      skip(candidate, 'missing_file');
      continue;
    }
    if (selected.some((item) => item.file === candidate.file)) {
      skip(candidate, 'duplicate');
      continue;
    }
    if (avoidedFiles.has(candidate.file)) {
      skip(candidate, 'sigma_feedback_avoided');
      continue;
    }
    if (isProtectedTarget(candidate.file)) {
      skip(candidate, 'protected_target');
      continue;
    }
    if (!allowNonProductionCandidates && isNonProductionRefactorCandidate(candidate.file)) {
      skip(candidate, 'non_production_candidate');
      continue;
    }
    if (validateCurrentState) {
      const state = candidateCurrentRefactorState(candidate, requestedType);
      if (!state.matches) {
        skip(candidate, state.reason || 'current_state_mismatch');
        continue;
      }
    }
    selected.push(candidate);
    if (selected.length >= maxFiles) break;
  }
  const skippedByReason = skipped.reduce((acc, item) => {
    acc[item.reason] = Number(acc[item.reason] || 0) + 1;
    return acc;
  }, {});
  return {
    selected,
    skipped,
    diagnostics: {
      total: ordered.length,
      selected: selected.length,
      skipped: skipped.length,
      skippedByReason,
      staleSkipped: Number(skippedByReason.current_state_mismatch || 0),
    },
  };
}

function selectActiveCandidates(analysis, requestedType = DEFAULT_REFACTOR_TYPE, maxFiles = 1, avoidedFiles = new Set(), options = {}) {
  return selectActiveCandidatesDetailed(analysis, requestedType, maxFiles, avoidedFiles, options).selected;
}

function deriveAvoidedFilesFromFeedback(feedback, threshold = 2) {
  const results = Array.isArray(feedback?.results) ? feedback.results : [];
  const counts = new Map();
  for (const item of results) {
    const status = `${item.stage || ''}:${item.outcome || ''}`.toLowerCase();
    if (!/(deferred|failed|error)/.test(status)) continue;
    const weight = status.includes('active_deferred_unfixable') ? 2 : 1;
    const files = [
      item.file,
      item.target,
      ...(Array.isArray(item.candidateFiles) ? item.candidateFiles : []),
      ...(Array.isArray(item.changedFiles) ? item.changedFiles : []),
    ].filter(Boolean);
    for (const file of files) {
      counts.set(file, (counts.get(file) || 0) + weight);
    }
  }
  const avoided = new Set();
  for (const [file, count] of counts.entries()) {
    if (count >= threshold) avoided.add(file);
  }
  return avoided;
}

function parseRefactorHistoryPlan(content = '') {
  const lines = String(content || '').split(/\r?\n/);
  const failedCandidates = [];
  let currentFile = null;
  let currentSection = [];

  const flush = () => {
    if (!currentFile) return;
    const section = currentSection.join('\n');
    const failed = /- stage:\s+active_deferred/i.test(section)
      || /- applied:\s+false/i.test(section)
      || /error_summary:\s+.*(?:strict_failed|verify_failed|token_budget_exceeded|unfixable|apply_failed)/i.test(section);
    if (failed) failedCandidates.push(currentFile);
  };

  for (const line of lines) {
    const candidateMatch = String(line || '').match(/^### Candidate \d+:\s+(.+)$/);
    if (candidateMatch) {
      flush();
      currentFile = normalizeScopePath(candidateMatch[1]);
      currentSection = [];
      continue;
    }
    if (currentFile && /^##\s+/.test(String(line || ''))) {
      flush();
      currentFile = null;
      currentSection = [];
      continue;
    }
    if (currentFile) currentSection.push(line);
  }
  flush();
  return failedCandidates;
}

function deriveAvoidedFilesFromLocalHistory(options = {}) {
  const historyDir = options.historyDir || PLAN_DIR;
  const threshold = parsePositiveInt(options.threshold, 2, 20);
  const scanLimit = parsePositiveInt(options.scanLimit, REFACTORER_HISTORY_SCAN_LIMIT, 500);
  const counts = new Map();
  try {
    if (!fs.existsSync(historyDir)) return new Set();
    const entries = fs.readdirSync(historyDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^REFACTOR_ACTIVE_.*\.md$/.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(historyDir, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {
          // Ignore files that disappear while the runner is scanning history.
        }
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, scanLimit);

    for (const entry of entries) {
      const content = safeRead(entry.fullPath, 500_000);
      for (const file of parseRefactorHistoryPlan(content)) {
        counts.set(file, (counts.get(file) || 0) + 1);
      }
    }
  } catch {
    return new Set();
  }

  const avoided = new Set();
  for (const [file, count] of counts.entries()) {
    if (count >= threshold) avoided.add(file);
  }
  return avoided;
}

function mergeAvoidedFiles(...sets) {
  const merged = new Set();
  for (const set of sets) {
    if (!set || typeof set[Symbol.iterator] !== 'function') continue;
    for (const file of set) {
      const normalized = normalizeScopePath(file);
      if (normalized) merged.add(normalized);
    }
  }
  return merged;
}

function summarizePriorError(value = '') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const builderMatch = normalized.match(/builder=([^;]+)/i);
  const summary = (builderMatch?.[1] || normalized).trim();
  return summary.slice(0, 240);
}

function deriveFilePriorErrors(vaultFeedback, fileRel, cap = 3) {
  const target = normalizeScopePath(fileRel);
  if (!target) return [];
  const results = Array.isArray(vaultFeedback?.results) ? vaultFeedback.results : [];
  const seen = new Set();
  const priorErrors = [];
  const maxItems = parsePositiveInt(cap, 3, 20);
  for (const item of results) {
    const status = `${item?.stage || ''}:${item?.outcome || ''}`.toLowerCase();
    if (!/(deferred|failed|error)/.test(status)) continue;
    const files = [
      item?.file,
      item?.target,
      ...(Array.isArray(item?.candidateFiles) ? item.candidateFiles : []),
      ...(Array.isArray(item?.changedFiles) ? item.changedFiles : []),
    ].map(normalizeScopePath).filter(Boolean);
    if (!files.includes(target)) continue;
    const summary = summarizePriorError(item?.errorSummary);
    if (!summary || seen.has(summary)) continue;
    seen.add(summary);
    priorErrors.push(summary);
    if (priorErrors.length >= maxItems) break;
  }
  return priorErrors;
}

function sanitizeSegment(value) {
  return String(value || 'target')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'target';
}

function buildPlanContent(context, analysis, candidate) {
  const summary = analysis?.summary || {};
  const feedback = context.vaultFeedback || {};
  const feedbackLines = Array.isArray(feedback.results) && feedback.results.length > 0
    ? feedback.results.map((item, index) => {
      const similarity = Number.isFinite(Number(item.similarity)) ? Number(item.similarity).toFixed(4) : 'n/a';
      const source = item.source ? ` source=${item.source}` : '';
      const cycle = item.cycleId ? ` cycle=${item.cycleId}` : '';
      return `- ${index + 1}. similarity=${similarity}${source}${cycle}: ${item.title || 'untitled'}`;
    })
    : [`- ${feedback.skipped ? `skipped: ${feedback.reason || 'not_available'}` : feedback.warning ? `warning: ${feedback.warning}` : 'no similar refactor outcomes found'}`];
  return [
    `# Refactor Shadow Plan — ${context.cycleId}`,
    '',
    '- mode: shadow',
    '- phase: 1',
    `- target: ${context.target.relativePath}`,
    `- candidate: ${candidate.file}`,
    `- refactor_type: ${candidate.refactorType}`,
    `- reason: ${candidate.reason || 'n/a'}`,
    `- generated_at: ${context.startedAt}`,
    '',
    '## Analysis',
    `- source: ${analysis?.source || 'unknown'}`,
    `- total_ts_files: ${summary.totalTsFiles ?? 'unknown'}`,
    `- ts_nocheck_count: ${summary.tsNocheckCount ?? 'unknown'}`,
    `- ts_nocheck_ratio: ${summary.tsNocheckRatio ?? 'unknown'}`,
    `- large_files_count: ${summary.largeFilesCount ?? 'unknown'}`,
    '',
    '## Sigma Feedback',
    `- status: ${feedback.ok ? 'ready' : feedback.skipped ? 'skipped' : 'unavailable'}`,
    `- query: ${feedback.query || 'n/a'}`,
    `- source_priority: ${feedback.sourcePriority || 'n/a'}`,
    ...feedbackLines,
    '',
    '## Seven-Step Cycle Status',
    '1. Analyze: complete',
    '2. Plan: complete',
    '3. Refactor: pending_phase3_active',
    '4. Verify: pending_phase3_active',
    '5. Fix: pending_phase3_active',
    '6. Commit: pending_phase3_active',
    '7. Document: pending_phase3_active',
    '',
    '## Proposed Safety Contract',
    '- No source mutation in Phase 1 shadow.',
    '- Builder validates with target-scoped testScope when active mode is approved.',
    '- Reviewer reviews the refactor diff before commit.',
    '- Doctor handles verify-loop recovery or rollback planning.',
    '- Protected Luna/crypto targets remain excluded.',
    '',
    '## Next Phase Gate',
    '- Phase 2 may register launchd in shadow only.',
    '- Phase 3 is required before any refactorStep implementation.',
    '',
  ].join('\n');
}

async function fetchRefactorVaultFeedback(context, candidate, deps = {}) {
  if (context.noVaultFeedback) return { ok: true, skipped: true, reason: 'no_vault_feedback' };
  if (context.dryRun) return { ok: true, skipped: true, reason: 'dry_run' };

  const query = [
    'refactor',
    candidate?.refactorType || context.refactorType,
    candidate?.file || context.target.relativePath,
    'shadow plan outcome feedback',
  ].filter(Boolean).join(' ');

  try {
    let searchVault = deps.searchVault;
    if (typeof searchVault !== 'function') {
      const modulePath = path.join(ROOT, 'bots', 'sigma', 'vault', 'vault-search.ts');
      ({ searchVault } = await import(pathToFileURL(modulePath).href));
    }
    if (typeof searchVault !== 'function') {
      return { ok: false, query, warning: 'searchVault_not_exported', results: [] };
    }
    const mapResults = (search, allowedSources) => {
      const direct = Array.isArray(search?.results) ? search.results : [];
      const expanded = Array.isArray(search?.knowledgeGraph?.results) ? search.knowledgeGraph.results : [];
      const seen = new Set();
      return [...direct, ...expanded].flatMap((item, index) => {
        const source = item.source || null;
        if (allowedSources.length > 0 && !allowedSources.includes(source)) return [];
        const key = String(item.id || `${source || 'unknown'}:${item.title || index}`);
        if (seen.has(key)) return [];
        seen.add(key);
        const meta = item.meta || {};
        const payload = meta.payload || {};
        const payloadMeta = payload.meta || {};
        return [{
          id: item.id || null,
          title: item.title,
          source,
          similarity: item.similarity ?? item.confidence,
          graphHop: item.hop || null,
          graphConfidence: item.confidence ?? null,
          cycleId: payloadMeta.cycleId || payload.cycleId || meta.cycleId || null,
          refactorType: payloadMeta.refactorType || payload.refactorType || meta.refactorType || null,
          target: payloadMeta.target || payload.target || meta.target || null,
          file: payloadMeta.file || payload.file || null,
          candidateFiles: Array.isArray(payloadMeta.candidateFiles) ? payloadMeta.candidateFiles : [],
          changedFiles: Array.isArray(payloadMeta.changedFiles) ? payloadMeta.changedFiles : [],
          errorSummary: payloadMeta.errorSummary || payload.errorSummary || null,
          outcome: payload.outcome || null,
          stage: payload.stage || null,
        }];
      });
    };
    const refactorSources = ['claude_refactor'];
    const refactorSearch = await searchVault(query, {
      topK: 3,
      sourceKinds: refactorSources,
      graphExpansionEnabled: true,
    });
    const refactorResults = mapResults(refactorSearch, refactorSources);
    if (refactorSearch?.ok && refactorResults.length > 0) {
      return {
        ok: true,
        query,
        sourcePriority: 'claude_refactor',
        warning: null,
        results: refactorResults,
      };
    }

    const legacySources = ['claude_auto_dev'];
    const legacySearch = await searchVault(query, {
      topK: 3,
      sourceKinds: legacySources,
      graphExpansionEnabled: true,
    });
    const legacyResults = mapResults(legacySearch, legacySources);
    return {
      ok: Boolean(refactorSearch?.ok || legacySearch?.ok),
      query,
      sourcePriority: legacyResults.length > 0 ? 'claude_auto_dev_fallback' : 'none',
      warning: refactorSearch?.warning || legacySearch?.warning || null,
      results: legacyResults,
    };
  } catch (error) {
    return { ok: false, query, warning: `vault_feedback_failed:${error?.message || String(error)}`, results: [] };
  }
}

function planStep(context, analysis, options = {}) {
  const candidate = options.candidate || selectCandidate(analysis, context.refactorType);
  const vaultFeedback = options.vaultFeedback || context.vaultFeedback || { ok: true, skipped: true, reason: 'not_requested' };
  const planContext = { ...context, vaultFeedback };
  const targetSegment = sanitizeSegment(candidate.file.replace(/\//g, '_'));
  const fileName = `REFACTOR_${targetSegment}_${context.cycleId}.md`;
  const planPath = path.join(PLAN_DIR, fileName);
  const content = buildPlanContent(planContext, analysis, candidate);
  if (!context.dryRun) {
    fs.mkdirSync(PLAN_DIR, { recursive: true });
    fs.writeFileSync(planPath, content, 'utf8');
  }
  return {
    ok: true,
    candidate,
    planPath,
    relPath: relPath(planPath),
    wrote: !context.dryRun,
    content,
    vaultFeedback,
  };
}

function pendingStep(id) {
  return { id, status: 'pending_phase3_active', mutates: false };
}

function candidateAbsolutePath(candidate) {
  const file = String(candidate?.file || '').trim();
  if (!file) return null;
  const absolutePath = path.resolve(ROOT, file);
  const relativePath = relPath(absolutePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
  return absolutePath;
}

function snapshotFiles(files = []) {
  const snapshots = new Map();
  for (const file of files) {
    const absolutePath = path.resolve(file);
    snapshots.set(absolutePath, {
      existed: fs.existsSync(absolutePath),
      content: fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : null,
    });
  }
  return snapshots;
}

function restoreFileSnapshots(snapshots) {
  for (const [file, snapshot] of snapshots.entries()) {
    if (snapshot.existed) {
      fs.writeFileSync(file, snapshot.content, 'utf8');
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

function restoreFileSnapshot(snapshots, file) {
  const absolutePath = path.resolve(file);
  const snapshot = snapshots.get(absolutePath);
  if (!snapshot) return;
  restoreFileSnapshots(new Map([[absolutePath, snapshot]]));
}

function removeTsNocheckLine(content = '') {
  const text = String(content);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*\/\/\s*@ts-nocheck\s*$/.test(line));
  if (index < 0) return { changed: false, content };
  lines.splice(index, 1);
  return { changed: true, content: lines.join(newline) };
}

function runGit(args = [], options = {}) {
  return gitOps.runGit(args, { cwd: ROOT, ...options });
}

function gitStatusShort() {
  try {
    return gitOps.statusShort(ROOT);
  } catch (error) {
    return `git_status_failed:${error?.message || String(error)}`;
  }
}

function normalizeScopePath(value = '') {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function safeBranchSlug(value, fallback = 'refactor') {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\/+/g, '-')
    .slice(0, 80);
  return slug || fallback;
}

function refactorPrBranch(file = '', cycleId = '') {
  const fileSlug = safeBranchSlug(path.basename(String(file || 'target'), path.extname(String(file || 'target'))));
  const cycle = safeBranchSlug(cycleId || cycleStamp(), 'cycle');
  return `claude/refactor-${fileSlug}-${cycle}`;
}

function defaultCommitFile(relFile, message, gitFn = runGit) {
  const normalized = normalizeScopePath(relFile);
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`invalid_commit_path:${relFile || 'empty'}`);
  }
  if (isProtectedTarget(normalized)) {
    throw new Error(`protected_commit_path:${normalized}`);
  }
  try {
    return gitOps.commitFile(normalized, message, gitFn, { cwd: ROOT });
  } catch (error) {
    try {
      gitFn(['reset', '--', normalized], { cwd: ROOT });
    } catch {
      // Best-effort index cleanup; caller still restores the file snapshot.
    }
    throw error;
  }
}

function localBin(name) {
  return path.join(ROOT, 'node_modules', '.bin', name);
}

function currentGitHead(gitFn = runGit) {
  return gitOps.currentHead(gitFn, { cwd: ROOT });
}

function defaultPushHead(gitFn = runGit) {
  gitOps.pushRef('HEAD', gitFn, { cwd: ROOT });
  return { ok: true };
}

function defaultPushRefactorPr({ commit = '', file = '', context = {} } = {}, gitFn = runGit) {
  const branch = refactorPrBranch(file, context.cycleId);
  gitOps.pushHeadToBranch(branch, gitFn, { cwd: ROOT, timeout: 120000 });
  const title = `refactor: ${file}`;
  const body = [
    'Claude refactor-cycle PR workflow shadow artifact.',
    '',
    `- cycle: ${context.cycleId || 'unknown'}`,
    `- file: ${file || 'unknown'}`,
    `- commit: ${commit || 'unknown'}`,
  ].join('\n');
  const pr = gitOps.createPR({ head: branch, base: 'main', title, body }, { cwd: ROOT, timeout: 120000 });
  if (!pr?.ok) {
    let branchCleanup = null;
    try {
      gitFn(['push', 'origin', '--delete', branch], { cwd: ROOT, timeout: 120000 });
      branchCleanup = { attempted: true, deleted: true };
    } catch (cleanupError) {
      branchCleanup = {
        attempted: true,
        deleted: false,
        error: String(cleanupError?.message || cleanupError).slice(0, 1000),
      };
    }
    return { ok: false, branch, branchCleanup, error: pr?.error || 'pr_create_failed' };
  }
  return { ok: true, branch, prNumber: pr.number || null, prUrl: pr.url || null, pr };
}

function defaultOriginContainsCommit(sha, gitFn = runGit) {
  return gitOps.originContains(sha, gitFn);
}

function defaultRollbackToHead(head, relFile = null, gitFn = runGit) {
  if (!head) throw new Error('rollback_head_missing');
  const normalized = normalizeScopePath(relFile || '');
  const safeFile = normalized && !normalized.startsWith('..') && !path.isAbsolute(normalized)
    ? normalized
    : null;
  return gitOps.rollbackToHead(head, safeFile, gitFn);
}

function strictGateTimeoutMs(value = process.env.REFACTORER_STRICT_GATE_TIMEOUT_MS) {
  return parsePositiveInt(value, 120000, 600000);
}

function strictGateCommand() {
  return 'tsc -p tsconfig.strict.json --noEmit';
}

function parseStrictErrorSignatures(output = '') {
  const signatures = new Set();
  const rootPrefix = ROOT.replace(/\\/g, '/').replace(/\/+$/, '');
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    if (!/error TS\d+:/i.test(rawLine)) continue;
    let line = rawLine.trim().replace(/\\/g, '/');
    if (line.startsWith(`${rootPrefix}/`)) line = line.slice(rootPrefix.length + 1);
    line = line.replace(/\s+/g, ' ');
    if (line) signatures.add(line);
  }
  return signatures;
}

function runStrictTsc() {
  const tscBin = fs.existsSync(localBin('tsc')) ? localBin('tsc') : 'tsc';
  const command = strictGateCommand();
  try {
    const output = execFileSync(tscBin, ['-p', 'tsconfig.strict.json', '--noEmit'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: strictGateTimeoutMs(),
    });
    return { ok: true, output: String(output || ''), command };
  } catch (error) {
    const output = `${error?.stdout || ''}\n${error?.stderr || ''}`.trim();
    const signatures = parseStrictErrorSignatures(output);
    const message = output || error?.message || String(error);
    const infraError = signatures.size === 0 || isStrictInfraFailure(error, output);
    return {
      ok: false,
      output: message,
      command,
      infraError,
      error: message,
    };
  }
}

function strictRunResultSignatures(result) {
  return parseStrictErrorSignatures(result?.output || result?.error || result?.message || '');
}

function isStrictInfraFailure(error, output = '') {
  const errorText = `${error?.message || ''}\n${error?.code || ''}\n${error?.signal || ''}`.toLowerCase();
  return Boolean(
    error?.killed
    || error?.signal
    || ['ETIMEDOUT', 'ENOENT'].includes(String(error?.code || ''))
    || /timed out|timeout|spawn.*enoent|no such file or directory/.test(errorText)
    || /error TS(5058|5083|18003):/i.test(String(output || ''))
  );
}

function captureStrictBaseline({ context } = {}) {
  const runner = context?.strictRunFn || runStrictTsc;
  const result = runner({ stage: 'baseline', context });
  const signatures = strictRunResultSignatures(result);
  if (result?.ok === true) return signatures;
  if (signatures.size > 0 && !result?.infraError) return signatures;
  return null;
}

function defaultStrictCheck({ file = null, context = {} } = {}) {
  const runner = context?.strictRunFn || runStrictTsc;
  if (!strictGateBaselineEnabled(context.strictGateBaselineEnabled)) {
    const result = runner({ stage: 'legacy', file, context });
    return {
      pass: result?.ok === true,
      skipped: false,
      command: result?.command || strictGateCommand(),
      reason: result?.ok === true ? null : 'strict_legacy_failed',
      error: result?.ok === true ? null : (result?.error || result?.output || result?.message || 'strict_gate_failed'),
    };
  }

  const baseline = context?.strictBaseline instanceof Set ? context.strictBaseline : null;
  if (!baseline) {
    return {
      pass: false,
      skipped: false,
      command: strictGateCommand(),
      reason: 'strict_baseline_unavailable',
      error: context?.strictBaselineError || 'strict_baseline_unavailable',
    };
  }

  const result = runner({ stage: 'after', file, context });
  const after = strictRunResultSignatures(result);
  if (result?.ok !== true && (result?.infraError || after.size === 0)) {
    return {
      pass: false,
      skipped: false,
      command: result?.command || strictGateCommand(),
      reason: 'strict_after_infra_error',
      error: result?.error || result?.output || result?.message || 'strict_after_infra_error',
    };
  }

  const newErrors = [...after].filter((signature) => !baseline.has(signature));
  return {
    pass: newErrors.length === 0,
    skipped: false,
    command: result?.command || strictGateCommand(),
    reason: newErrors.length === 0 ? null : 'strict_new_errors',
    baselineErrorCount: baseline.size,
    afterErrorCount: after.size,
    newErrorCount: newErrors.length,
    newErrors: newErrors.slice(0, 20),
    error: newErrors.length === 0 ? null : `new strict errors:\n${newErrors.slice(0, 5).join('\n')}`,
  };
}

function refactorScopePrefixes(targetRelPath = '', scope = 'workspace') {
  const normalizedScope = normalizeDirtyScope(scope);
  const target = normalizeScopePath(targetRelPath);
  if (!target || normalizedScope === 'tree') return [];
  if (normalizedScope === 'file') return [target];

  const parts = target.split('/').filter(Boolean);
  if (parts.length >= 2 && ['packages', 'bots', 'elixir'].includes(parts[0])) {
    return [`${parts[0]}/${parts[1]}`];
  }
  return parts[0] ? [parts[0]] : [];
}

function gitStatusScoped(prefixes = []) {
  const scopePrefixes = (Array.isArray(prefixes) ? prefixes : [])
    .map(normalizeScopePath)
    .filter(Boolean);
  if (scopePrefixes.length === 0) return gitStatusShort();
  try {
    return String(runGit(['status', '--short', '--', ...scopePrefixes]) || '').trimEnd();
  } catch (error) {
    return `git_status_failed:${error?.message || String(error)}`;
  }
}

function gitStatusLines(statusText = '') {
  return String(statusText || '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function pathFromStatusLine(line = '') {
  return String(line || '').slice(3).trim();
}

function pathMatchesPrefix(filePath = '', prefix = '') {
  const file = normalizeScopePath(filePath);
  const scopePrefix = normalizeScopePath(prefix);
  return Boolean(file && scopePrefix && (file === scopePrefix || file.startsWith(`${scopePrefix}/`)));
}

function statusLinePaths(line = '') {
  return pathFromStatusLine(line)
    .split(' -> ')
    .map(normalizeScopePath)
    .filter(Boolean);
}

function statusLineInScope(line = '', scopePrefixes = []) {
  const prefixes = (Array.isArray(scopePrefixes) ? scopePrefixes : [])
    .map(normalizeScopePath)
    .filter(Boolean);
  if (prefixes.length === 0) return true;
  const paths = statusLinePaths(line);
  return paths.some((statusPath) => prefixes.some((prefix) => pathMatchesPrefix(statusPath, prefix)));
}

function unexpectedMutationLines(currentStatus, baselineStatus, allowedFiles = [], scopePrefixes = []) {
  const baseline = new Set(gitStatusLines(baselineStatus));
  const allowed = new Set(allowedFiles.map(normalizeScopePath).filter(Boolean));
  return gitStatusLines(currentStatus).filter((line) => {
    if (!statusLineInScope(line, scopePrefixes)) return false;
    if (baseline.has(line)) return false;
    const statusPath = normalizeScopePath(pathFromStatusLine(line));
    return !allowed.has(statusPath);
  });
}

function cleanupUnexpectedUntracked(lines = [], baselineStatus = '', scopePrefixes = []) {
  const baseline = new Set(gitStatusLines(baselineStatus));
  for (const line of lines) {
    if (!statusLineInScope(line, scopePrefixes)) continue;
    if (baseline.has(line) || !line.startsWith('?? ')) continue;
    const rel = pathFromStatusLine(line);
    const absolutePath = path.resolve(ROOT, rel);
    const relativePath = relPath(absolutePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || isProtectedTarget(relativePath)) continue;
    fs.rmSync(absolutePath, { recursive: true, force: true });
  }
}

function readRefactorLock(lockPath = REFACTORER_LOCK_PATH, nowMs = Date.now()) {
  try {
    const stat = fs.statSync(lockPath);
    const ageMs = nowMs - stat.mtimeMs;
    return {
      exists: true,
      stale: ageMs >= REFACTORER_LOCK_STALE_MS,
      ageMs,
      path: lockPath,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, stale: false, ageMs: null, path: lockPath };
    return { exists: true, stale: false, ageMs: null, path: lockPath, error: error?.message || String(error) };
  }
}

function acquireRefactorLock(lockPath = REFACTORER_LOCK_PATH, meta = {}) {
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: nowIso(),
    cycleId: meta?.context?.cycleId || null,
  }) + '\n';
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, payload, 'utf8');
    fs.closeSync(fd);
    return { ok: true, path: lockPath, staleReplaced: false };
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      return { ok: false, reason: 'lock_create_failed', error: error?.message || String(error), path: lockPath };
    }
    const lock = readRefactorLock(lockPath);
    if (lock.exists && !lock.stale) {
      return { ok: false, reason: 'another_cycle_active', lock };
    }
    try {
      fs.rmSync(lockPath, { force: true });
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, payload, 'utf8');
      fs.closeSync(fd);
      return { ok: true, path: lockPath, staleReplaced: true, previous: lock };
    } catch (replaceError) {
      return {
        ok: false,
        reason: 'lock_replace_failed',
        error: replaceError?.message || String(replaceError),
        path: lockPath,
        previous: lock,
      };
    }
  }
}

function releaseRefactorLock(lock, _meta = {}) {
  const lockPath = typeof lock === 'string' ? lock : lock?.path;
  if (!lockPath) return { ok: true, skipped: true, reason: 'missing_lock_path' };
  try {
    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (payload?.pid && Number(payload.pid) !== process.pid) {
      return { ok: true, skipped: true, reason: 'lock_not_owned', path: lockPath };
    }
  } catch {
    // Remove malformed locks created by this process path best-effort.
  }
  fs.rmSync(lockPath, { force: true });
  return { ok: true, path: lockPath };
}

function gitDiffForFiles(files = []) {
  const relFiles = files.map((file) => {
    const absolutePath = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
    return relPath(absolutePath);
  }).filter(Boolean);
  if (relFiles.length === 0) return '';
  try {
    return runGit(['diff', '--', ...relFiles]);
  } catch (error) {
    return `git_diff_failed:${error?.message || String(error)}`;
  }
}

function snapshotDiffForFiles(files = [], snapshots = new Map()) {
  const relFiles = files.map((file) => {
    const absolutePath = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
    return { rel: relPath(absolutePath), absolutePath };
  }).filter((item) => item.rel);
  const chunks = [];
  for (const item of relFiles) {
    const snapshot = snapshots.get(item.absolutePath);
    if (!snapshot || !snapshot.existed || !fs.existsSync(item.absolutePath)) continue;
    const next = fs.readFileSync(item.absolutePath, 'utf8');
    if (snapshot.content === next) continue;
    const beforeLines = String(snapshot.content || '').split(/\r?\n/);
    const afterLines = String(next || '').split(/\r?\n/);
    chunks.push(`diff --git a/${item.rel} b/${item.rel}`);
    chunks.push(`--- a/${item.rel}`);
    chunks.push(`+++ b/${item.rel}`);
    chunks.push(`@@ -1,${beforeLines.length} +1,${afterLines.length} @@`);
    chunks.push(...beforeLines.map((line) => `-${line}`));
    chunks.push(...afterLines.map((line) => `+${line}`));
  }
  return chunks.length > 0 ? `${chunks.join('\n')}\n` : '';
}

function patchForSuccessfulFiles(files = [], snapshots = new Map()) {
  const snapshotPatch = snapshotDiffForFiles(files, snapshots);
  if (String(snapshotPatch || '').trim()) return snapshotPatch;
  return gitDiffForFiles(files);
}

function normalizeReviewHighCount(reviewResult) {
  const summary = reviewResult?.summary || {};
  return Number(summary.high || 0) + Number(summary.critical || 0);
}

function builderSkipReason(builderResult) {
  const results = Array.isArray(builderResult?.results) ? builderResult.results : [];
  if (Boolean(builderResult?.skipped) && results.length === 0) return 'no_build_plan';
  if (results.length === 0) return 'no_build_plan';
  const ranAnyPlan = results.some((item) => item && item.skipped === false);
  if (!ranAnyPlan) return 'build_not_executed';
  if (Boolean(builderResult?.skipped)) return 'build_not_executed';
  return null;
}

function mergeAutofixAttempts(existing, next) {
  return [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(next) ? next : []),
  ];
}

const READY_STAGES = new Set([
  'active_verified_ready_for_commit',
  'active_autofixed_ready_for_commit',
]);

function isReadyResult(item) {
  return READY_STAGES.has(item?.stage);
}

function activeFixStepStatus(active) {
  if (!active) return 'none';
  if (Number(active.autofixedCount || 0) > 0) return 'autofix_complete';
  if (Number(active.unfixableCount || 0) > 0) return 'active_deferred_unfixable';
  return active.ok ? 'none' : 'active_deferred_no_auto_fix';
}

function activeRefactorStepStatus(active) {
  if (!active) return 'no_change';
  if (active.applied) return 'complete_applied';
  return active.mutationStarted ? 'complete_restored' : 'no_change';
}

function activeCommitStepStatus(active) {
  const commits = (active?.applyResults || [])
    .filter((item) => item.applied)
    .map((item) => item.commit)
    .filter(Boolean);
  if (commits.length > 0) return `committed:${commits.join(',')}`;
  return active?.ok ? 'ready_for_review_apply_disabled' : 'not_ready';
}

function activeOperationalStatus(active, options = {}) {
  const applyResults = Array.isArray(active?.applyResults) ? active.applyResults : [];
  const appliedResults = applyResults.filter((item) => item?.applied === true);
  const commits = appliedResults.map((item) => item.commit).filter(Boolean);
  const pushedCommits = appliedResults.filter((item) => item.pushed === true).map((item) => item.commit).filter(Boolean);
  const originVerifiedCommits = appliedResults
    .filter((item) => item.originContains === true)
    .map((item) => item.commit)
    .filter(Boolean);
  const pushRequired = options.pushRequired !== false;
  const applied = appliedResults.length > 0;
  const pushedOk = !pushRequired || appliedResults.every((item) => item.pushed === true);
  const originOk = !pushRequired || appliedResults.every((item) => item.originContains === true);
  const success = Boolean(applied && pushedOk && originOk);
  const hasReady = Array.isArray(active?.results) && active.results.some(isReadyResult);
  const hasApplyFailure = applyResults.some((item) => item?.applied === false);
  const outcomeClass = success
    ? 'operational_success'
    : hasApplyFailure
      ? 'apply_failed'
      : hasReady
        ? 'verified_not_applied'
        : 'deferred';
  return {
    success,
    outcomeClass,
    applied,
    pushRequired,
    commitCount: commits.length,
    pushedCount: pushedCommits.length,
    originVerifiedCount: originVerifiedCommits.length,
    commits,
    pushedCommits,
    originVerifiedCommits,
  };
}

function firstResultValue(results, key) {
  const found = (Array.isArray(results) ? results : []).find((item) => item && item[key] !== undefined && item[key] !== null);
  return found ? found[key] : null;
}

function firstResultCandidate(results) {
  const found = (Array.isArray(results) ? results : []).find((item) => item?.candidate);
  return found ? found.candidate : null;
}

function resolveVerifierModules(context) {
  return {
    builder: context.builderModule || require('../src/builder'),
    reviewer: context.reviewerModule || require('../src/reviewer.ts'),
  };
}

async function verifyChangedFiles(context, changedFiles) {
  const { builder, reviewer } = resolveVerifierModules(context);
  const verifyOptions = { files: changedFiles, force: true, test: true };
  const builderResult = await builder.runTargetedTypeCheck(changedFiles, verifyOptions);
  const reviewerResult = await reviewer.runReview(verifyOptions);
  const nodeCheck = runNodeCheckGate(changedFiles);
  const reviewerHigh = normalizeReviewHighCount(reviewerResult);
  const builderSkipReasonValue = builderSkipReason(builderResult);
  const builderSkipped = builderSkipReasonValue !== null;
  const reviewerSkipped = Boolean(reviewerResult?.skipped);
  return {
    ok: builderResult?.pass !== false && reviewerHigh === 0 && nodeCheck.pass === true && !builderSkipped && !reviewerSkipped,
    builder: builderResult,
    reviewer: reviewerResult,
    nodeCheck,
    builderPass: builderResult?.pass !== false,
    nodeCheckPass: nodeCheck.pass === true,
    builderSkipped,
    builderSkipReason: builderSkipReasonValue,
    reviewerHigh,
    reviewerSkipped,
    options: verifyOptions,
  };
}

async function callAutofixer(context, params) {
  const fixer = context.fixerFn || attemptTypeFix;
  try {
    const result = await fixer(context, params);
    if (!result || result.ok !== true) {
      return {
        ...result,
        ok: false,
        fixedContent: null,
        error: result?.error || 'fixer_failed',
      };
    }
    if (!result.fixedContent || /@ts-nocheck/.test(String(result.fixedContent))) {
      return {
        ...result,
        ok: false,
        fixedContent: null,
        error: !result.fixedContent ? 'empty_fixer_output' : 'ts_nocheck_reinserted',
      };
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      fixedContent: null,
      error: String(error?.message || error),
    };
  }
}

function formatErrorSummary({ stage, candidate, verify, error }) {
  const file = candidate?.file || 'unknown';
  if (error) return `stage=${stage}; file=${file}; error=${String(error?.message || error).slice(0, 500)}`;
  const builderPass = verify?.builderPass !== false;
  const reviewerHigh = Number(verify?.reviewerHigh || 0);
  const builderSkipped = Boolean(verify?.builderSkipped);
  const reviewerSkipped = Boolean(verify?.reviewerSkipped);
  const nodeCheckPass = verify?.nodeCheckPass !== false;
  const nodeCheckError = String(verify?.nodeCheck?.failed?.[0]?.error || '').replace(/\s+/g, ' ').slice(0, 240);
  const builderMessage = String(verify?.builder?.message || '').replace(/\s+/g, ' ').slice(0, 240);
  const reviewerMessage = String(verify?.reviewer?.message || '').replace(/\s+/g, ' ').slice(0, 240);
  return [
    `stage=${stage}`,
    `file=${file}`,
    `builder_pass=${builderPass}`,
    `node_check_pass=${nodeCheckPass}`,
    `builder_skipped=${builderSkipped}`,
    `reviewer_high=${reviewerHigh}`,
    `reviewer_skipped=${reviewerSkipped}`,
    nodeCheckError ? `node_check=${nodeCheckError}` : null,
    builderMessage ? `builder=${builderMessage}` : null,
    reviewerMessage ? `reviewer=${reviewerMessage}` : null,
  ].filter(Boolean).join('; ');
}

function buildActiveDocumentContent(context, analysis, active) {
  const summary = analysis?.summary || {};
  const feedback = active.vaultFeedback || {};
  const operational = active.operational || activeOperationalStatus(active, {
    pushRequired: Boolean(context.applyPushEnabled),
  });
  const candidateDiagnostics = active.candidateDiagnostics || {};
  const successful = active.results.filter(isReadyResult);
  const autofixed = active.results.filter((item) => item.stage === 'active_autofixed_ready_for_commit');
  const unfixable = active.results.filter((item) => item.stage === 'active_deferred_unfixable');
  const deferred = active.results.filter((item) => !isReadyResult(item));
  const changedFiles = active.changedFiles || [];
  const feedbackLines = Array.isArray(feedback.results) && feedback.results.length > 0
    ? feedback.results.map((item, index) => {
      const similarity = Number.isFinite(Number(item.similarity)) ? Number(item.similarity).toFixed(4) : 'n/a';
      const source = item.source ? ` source=${item.source}` : '';
      const stage = item.stage ? ` stage=${item.stage}` : '';
      const file = item.file || item.target ? ` file=${item.file || item.target}` : '';
      return `- ${index + 1}. similarity=${similarity}${source}${stage}${file}: ${item.title || 'untitled'}`;
    })
    : [`- ${feedback.skipped ? `skipped: ${feedback.reason || 'not_available'}` : feedback.warning ? `warning: ${feedback.warning}` : 'no similar refactor outcomes found'}`];
  const lines = [
    `# Refactor Active Cycle — ${context.cycleId}`,
    '',
    '- mode: active',
    '- phase: 3',
    `- target: ${context.target.relativePath}`,
    `- refactor_type: ${context.refactorType}`,
    `- dirty_scope: ${context.dirtyScope}`,
    `- scope_prefixes: ${(context.refactorScopePrefixes || []).join(', ') || 'tree'}`,
    `- generated_at: ${context.startedAt}`,
    `- apply_enabled: ${context.applyEnabled ? 'true' : 'false'}`,
    `- max_files: ${context.activeMaxFiles}`,
    '',
    '## Analysis',
    `- source: ${analysis?.source || 'unknown'}`,
    `- total_ts_files: ${summary.totalTsFiles ?? 'unknown'}`,
    `- ts_nocheck_count: ${summary.tsNocheckCount ?? 'unknown'}`,
    `- ts_nocheck_ratio: ${summary.tsNocheckRatio ?? 'unknown'}`,
    `- candidate_total: ${candidateDiagnostics.total ?? 'unknown'}`,
    `- candidate_selected: ${candidateDiagnostics.selected ?? 'unknown'}`,
    `- candidate_skipped: ${candidateDiagnostics.skipped ?? 'unknown'}`,
    `- stale_candidate_skipped: ${candidateDiagnostics.staleSkipped ?? 0}`,
    `- candidate_skip_reasons: ${JSON.stringify(candidateDiagnostics.skippedByReason || {})}`,
    '',
    '## Sigma Feedback',
    `- status: ${feedback.ok ? 'ready' : feedback.skipped ? 'skipped' : 'unavailable'}`,
    `- query: ${feedback.query || 'n/a'}`,
    `- avoid_threshold: ${context.avoidThreshold}`,
    ...feedbackLines,
    '',
    '## Active Results',
    `- verified_ready_for_commit: ${successful.length}`,
    `- autofixed_ready_for_commit: ${autofixed.length}`,
    `- unfixable: ${unfixable.length}`,
    `- autofix_enabled: ${context.autofixEnabled === true}`,
    `- autofix_attempts_total: ${active.totalFixAttempts || 0}`,
    `- strict_autofixed_ready_for_commit: ${active.strictAutofixedCount || 0}`,
    `- deferred: ${deferred.length}`,
    `- changed_files: ${changedFiles.length ? changedFiles.join(', ') : 'none'}`,
    `- applied: ${active.applied === true}`,
    `- apply_commits: ${(active.applyResults || []).filter((item) => item.applied).map((item) => item.commit).filter(Boolean).join(', ') || 'none'}`,
    `- operational_success: ${operational.success === true}`,
    `- outcome_class: ${operational.outcomeClass || 'unknown'}`,
    `- pushed_commits: ${(operational.pushedCommits || []).join(', ') || 'none'}`,
    `- origin_verified_commits: ${(operational.originVerifiedCommits || []).join(', ') || 'none'}`,
    `- patch_path: ${active.patchRelPath || 'none'}`,
    `- worktree_restored: ${active.worktreeRestored === true}`,
    `- final_git_status: ${active.finalGitStatus || 'unknown'}`,
    `- final_scoped_status: ${active.finalScopedStatus || 'clean'}`,
    `- target_git_status: ${active.targetGitStatus || 'clean'}`,
    '',
    '## Seven-Step Cycle Status',
    '1. Analyze: complete',
    '2. Plan: complete',
    `3. Refactor: ${changedFiles.length ? 'complete' : 'no_change'}`,
    `4. Verify: ${successful.length ? 'pass' : 'deferred'}`,
    `5. Fix: ${activeFixStepStatus(active)}`,
    `6. Commit: ${activeCommitStepStatus(active)}`,
    '7. Document: complete',
    '',
    '## Verification Summary',
    ...active.results.map((item, index) => [
      `### Candidate ${index + 1}: ${item.candidate?.file || 'unknown'}`,
      `- stage: ${item.stage}`,
      `- candidate_score: ${item.candidate?.score ?? 'unknown'}`,
      `- risk_level: ${item.candidate?.riskLevel || 'unknown'}`,
      `- estimated_cost: ${item.estimatedCost ?? item.candidate?.estimatedCost ?? 'unknown'}`,
      `- error_codes: ${Array.isArray(item.errorCodes) && item.errorCodes.length ? item.errorCodes.join(', ') : 'none'}`,
      item.fixerCapability ? `- fixer_capability: ${item.fixerCapability}` : null,
      item.failureClass ? `- failure_class: ${item.failureClass}` : null,
      item.nextAction ? `- next_action: ${item.nextAction}` : null,
      `- builder_pass: ${item.verify?.builderPass ?? false}`,
      `- builder_skipped: ${item.verify?.builderSkipped ?? false}`,
      item.verify?.builderSkipReason ? `- builder_skip_reason: ${item.verify.builderSkipReason}` : null,
      `- node_check_pass: ${item.verify?.nodeCheckPass ?? false}`,
      `- reviewer_high: ${item.verify?.reviewerHigh ?? 'unknown'}`,
      `- reviewer_skipped: ${item.verify?.reviewerSkipped ?? false}`,
      `- autofix_attempts: ${item.autofixAttempts || 0}`,
      item.model ? `- autofix_model: ${item.model}` : null,
      item.applied !== undefined ? `- applied: ${item.applied === true}` : null,
      item.commit ? `- commit: ${item.commit}` : null,
      item.pushed !== undefined ? `- pushed: ${item.pushed === true}` : null,
      item.originContains !== undefined && item.originContains !== null ? `- origin_contains: ${item.originContains === true}` : null,
      item.errorSummary ? `- error_summary: ${item.errorSummary}` : null,
      '',
    ].filter(Boolean).join('\n')),
  ];
  if (active.patchText) {
    lines.push('## Verified Patch', '', '```diff', active.patchText.trimEnd(), '```', '');
  }
  return lines.join('\n');
}

function writeActiveArtifacts(context, analysis, active) {
  if (context.dryRun) return { wrote: false, skipped: true, reason: 'dry_run' };
  fs.mkdirSync(PLAN_DIR, { recursive: true });
  fs.mkdirSync(PATCH_DIR, { recursive: true });
  const targetSegment = sanitizeSegment((active.changedFiles[0] || context.target.relativePath).replace(/\//g, '_'));
  const planPath = path.join(PLAN_DIR, `REFACTOR_ACTIVE_${targetSegment}_${context.cycleId}.md`);
  const patchPath = path.join(PATCH_DIR, `${context.cycleId}.patch`);
  if (active.patchText) fs.writeFileSync(patchPath, active.patchText, 'utf8');
  const content = buildActiveDocumentContent(context, analysis, {
    ...active,
    patchRelPath: active.patchText ? relPath(patchPath) : null,
  });
  fs.writeFileSync(planPath, content, 'utf8');
  return {
    wrote: true,
    planPath,
    patchPath: active.patchText ? patchPath : null,
    relPath: relPath(planPath),
    patchRelPath: active.patchText ? relPath(patchPath) : null,
    content,
  };
}

async function runAutofixLoop(context, candidate, absolutePath, initialVerify, snapshots, options = {}) {
  const fileRel = relPath(absolutePath);
  const reverifyMode = options.reverify === 'strict' ? 'strict' : 'targeted';
  const priorErrors = deriveFilePriorErrors(context.vaultFeedback, fileRel);
  const initialContent = fs.readFileSync(absolutePath, 'utf8');
  const initialErrorText = builderErrorText(initialVerify);
  const initialClassification = classifyFixerCapability({
    errorText: initialErrorText,
    lines: lineCount(initialContent),
    bytes: byteLength(initialContent),
  });
  let verify = initialVerify;
  let lastFix = null;
  let lastStrict = null;
  const attempts = [];
  if (initialClassification.fixerCapability === 'budget_blocked') {
    restoreFileSnapshot(snapshots, absolutePath);
    return {
      stage: 'active_deferred_unfixable',
      verify,
      autofixAttempts: 0,
      priorErrorCount: priorErrors.length,
      ...initialClassification,
      errorSummary: formatErrorSummary({
        stage: 'autofix',
        candidate,
        error: `budget_blocked: estimated_cost=${initialClassification.estimatedCost}`,
      }),
    };
  }
  if (context.autofixBillingStopped) {
    return {
      stage: 'active_deferred_unfixable',
      verify,
      autofixAttempts: 0,
      priorErrorCount: priorErrors.length,
      ...initialClassification,
      errorSummary: formatErrorSummary({ stage: 'autofix', candidate, error: 'billing_guard_stopped' }),
    };
  }

  for (let attempt = 1; attempt <= context.autofixMaxAttempts; attempt++) {
    const beforeFixStatus = context.gitStatusShortFn();
    const currentContent = fs.readFileSync(absolutePath, 'utf8');
    const fix = await callAutofixer(context, {
      fileRel,
      currentContent,
      builderError: builderErrorText(verify),
      reviewerFindings: reviewerHighFindings(verify),
      priorErrors,
      attempt,
    });
    lastFix = fix;
    attempts.push({
      attempt,
      ok: Boolean(fix?.ok),
      error: fix?.error || null,
      model: fix?.model || null,
      provider: fix?.provider || null,
      billingGuard: Boolean(fix?.billingGuard),
    });
    const unexpectedAfterFixer = unexpectedMutationLines(
      context.gitStatusShortFn(),
      beforeFixStatus,
      [fileRel],
      context.refactorScopePrefixes || []
    );
    if (unexpectedAfterFixer.length > 0) {
      cleanupUnexpectedUntracked(unexpectedAfterFixer, beforeFixStatus, context.refactorScopePrefixes || []);
      restoreFileSnapshot(snapshots, absolutePath);
      return {
        stage: 'active_deferred_unfixable',
        verify,
        autofixAttempts: attempt,
        autofix: attempts,
        priorErrorCount: priorErrors.length,
        ...initialClassification,
        errorSummary: formatErrorSummary({
          stage: 'autofix',
          candidate,
          error: `autofix_unexpected_mutation:${unexpectedAfterFixer.join('|')}`,
        }),
      };
    }
    if (fix.billingGuard) context.autofixBillingStopped = true;
    if (!fix.ok || !fix.fixedContent) break;

    const originalFinalNewline = currentContent.endsWith('\r\n')
      ? '\r\n'
      : currentContent.endsWith('\n')
        ? '\n'
        : '';
    const fixedToWrite = originalFinalNewline && !fix.fixedContent.endsWith('\n')
      ? `${fix.fixedContent}${originalFinalNewline}`
      : fix.fixedContent;
    fs.writeFileSync(absolutePath, fixedToWrite, 'utf8');
    const unexpectedAfterWrite = unexpectedMutationLines(
      context.gitStatusShortFn(),
      beforeFixStatus,
      [fileRel],
      context.refactorScopePrefixes || []
    );
    if (unexpectedAfterWrite.length > 0) {
      cleanupUnexpectedUntracked(unexpectedAfterWrite, beforeFixStatus, context.refactorScopePrefixes || []);
      restoreFileSnapshot(snapshots, absolutePath);
      return {
        stage: 'active_deferred_unfixable',
        verify,
        autofixAttempts: attempt,
        autofix: attempts,
        priorErrorCount: priorErrors.length,
        ...initialClassification,
        errorSummary: formatErrorSummary({
          stage: 'autofix',
          candidate,
          error: `autofix_unexpected_mutation:${unexpectedAfterWrite.join('|')}`,
        }),
      };
    }

    if (reverifyMode === 'strict') {
      try {
        lastStrict = await context.strictCheckFn({ file: fileRel, context });
      } catch (error) {
        return {
          stage: 'active_deferred_unfixable',
          verify,
          strict: lastStrict || { pass: false, error: String(error?.message || error) },
          autofixAttempts: attempt,
          autofix: attempts,
          priorErrorCount: priorErrors.length,
          ...initialClassification,
          errorSummary: formatErrorSummary({ stage: 'autofix_strict_verify', candidate, error }),
        };
      }
      if (lastStrict && lastStrict.pass === true) {
        try {
          verify = await verifyChangedFiles(context, [fileRel]);
        } catch (error) {
          return {
            stage: 'active_deferred_unfixable',
            verify,
            strict: lastStrict,
            autofixAttempts: attempt,
            autofix: attempts,
            priorErrorCount: priorErrors.length,
            ...initialClassification,
            errorSummary: formatErrorSummary({ stage: 'autofix_verify', candidate, error }),
          };
        }
        if (verify.ok) {
          return {
            stage: 'active_autofixed_ready_for_commit',
            verify,
            strict: lastStrict,
            autofixAttempts: attempt,
            autofix: attempts,
            priorErrorCount: priorErrors.length,
            ...initialClassification,
            model: fix.model || null,
            provider: fix.provider || null,
          };
        }
      } else {
        verify = {
          ok: false,
          builder: {
            pass: false,
            skipped: false,
            error: String(lastStrict?.error || lastStrict?.message || 'strict_new_errors'),
            results: [{
              pass: false,
              skipped: false,
              error: String(lastStrict?.error || lastStrict?.message || 'strict_new_errors'),
            }],
          },
          reviewer: { pass: true, skipped: false, summary: { high: 0, critical: 0 }, findings: [] },
          builderPass: false,
          builderSkipped: false,
          builderSkipReason: null,
          reviewerHigh: 0,
          reviewerSkipped: false,
        };
      }
    } else {
      try {
        verify = await verifyChangedFiles(context, [fileRel]);
      } catch (error) {
        return {
          stage: 'active_deferred_unfixable',
          verify,
          autofixAttempts: attempt,
          autofix: attempts,
          priorErrorCount: priorErrors.length,
          ...initialClassification,
          errorSummary: formatErrorSummary({ stage: 'autofix_verify', candidate, error }),
        };
      }
    }
    if (verify.ok) {
      return {
        stage: 'active_autofixed_ready_for_commit',
        verify,
        autofixAttempts: attempt,
        autofix: attempts,
        priorErrorCount: priorErrors.length,
        ...initialClassification,
        model: fix.model || null,
        provider: fix.provider || null,
      };
    }
    if (context.autofixBillingStopped) break;
  }

  restoreFileSnapshot(snapshots, absolutePath);
  const finalContent = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : initialContent;
  const finalClassification = classifyFixerCapability({
    errorText: builderErrorText(verify),
    lines: lineCount(finalContent),
    bytes: byteLength(finalContent),
  });
  return {
    stage: 'active_deferred_unfixable',
    verify,
    strict: lastStrict,
    autofixAttempts: attempts.length,
    autofix: attempts,
    priorErrorCount: priorErrors.length,
    ...finalClassification,
    errorSummary: formatErrorSummary({
      stage: 'autofix',
      candidate,
      error: lastFix?.error || `verify_failed_after_${attempts.length}_attempts`,
    }),
  };
}

async function runActiveRefactor(context, analysis, candidates, candidateDiagnostics = null) {
  const targetFiles = candidates.map(candidateAbsolutePath).filter(Boolean);
  const snapshots = snapshotFiles(targetFiles);
  const results = [];
  const changedFiles = [];
  const applyResults = [];
  let patchText = '';
  let mutationStarted = false;
  try {
    for (const candidate of candidates) {
      const absolutePath = candidateAbsolutePath(candidate);
      if (!absolutePath || !fs.existsSync(absolutePath) || isProtectedTarget(candidate.file)) {
        results.push({
          candidate,
          stage: 'active_deferred',
          errorSummary: formatErrorSummary({ stage: 'refactor', candidate, error: 'candidate_unavailable_or_protected' }),
        });
        continue;
      }
      const before = fs.readFileSync(absolutePath, 'utf8');
      const removed = removeTsNocheckLine(before);
      if (!removed.changed) {
        results.push({
          candidate,
          stage: 'active_deferred',
          errorSummary: formatErrorSummary({ stage: 'refactor', candidate, error: 'ts_nocheck_not_found' }),
        });
        continue;
      }
      fs.writeFileSync(absolutePath, removed.content, 'utf8');
      mutationStarted = true;
      const fileRel = relPath(absolutePath);

      let verify = null;
      try {
        verify = await verifyChangedFiles(context, [fileRel]);
      } catch (error) {
        restoreFileSnapshot(snapshots, absolutePath);
        results.push({
          candidate,
          stage: 'active_deferred',
          verify,
          errorSummary: formatErrorSummary({ stage: 'verify', candidate, error }),
        });
        continue;
      }

      if (verify.ok) {
        if (!changedFiles.includes(fileRel)) changedFiles.push(fileRel);
        results.push({
          candidate,
          stage: 'active_verified_ready_for_commit',
          verify,
        });
      } else {
        if (context.autofixEnabled) {
          const fixed = await runAutofixLoop(context, candidate, absolutePath, verify, snapshots);
          if (isReadyResult(fixed)) {
            if (!changedFiles.includes(fileRel)) changedFiles.push(fileRel);
            results.push({
              candidate,
              ...fixed,
            });
          } else {
            restoreFileSnapshot(snapshots, absolutePath);
            results.push({
              candidate,
              ...fixed,
            });
          }
        } else {
          const classification = classifyFixerCapability({
            errorText: builderErrorText(verify),
            lines: lineCount(removed.content),
            bytes: byteLength(removed.content),
          });
          restoreFileSnapshot(snapshots, absolutePath);
          results.push({
            candidate,
            stage: 'active_deferred',
            verify,
            ...classification,
            errorSummary: formatErrorSummary({ stage: 'verify', candidate, verify }),
          });
        }
      }
    }
    const successfulFiles = results
      .filter(isReadyResult)
      .map((item) => item.candidate?.file)
      .filter(Boolean);
    patchText = successfulFiles.length > 0 ? patchForSuccessfulFiles(successfulFiles, snapshots) : '';
    if (context.applyEnabled && !context.dryRun) {
      let appliedCount = 0;
      for (const item of results.filter(isReadyResult)) {
        const relFile = item.candidate?.file;
        if (!relFile) continue;
        if (appliedCount >= context.applyMaxPerCycle) {
          item.stage = 'active_deferred_rate_limited';
          item.applied = false;
          item.errorSummary = formatErrorSummary({ stage: 'rate_limited', candidate: item.candidate, error: `apply_max_per_cycle:${context.applyMaxPerCycle}` });
          applyResults.push({ file: relFile, applied: false, reason: 'rate_limited' });
          continue;
        }
        if (context.applyStrictGateEnabled) {
          let strict = await context.strictCheckFn({ file: relFile, results, context });
          if (
            (!strict || strict.pass !== true)
            && context.autofixEnabled
            && context.strictAutofixEnabled
            && !context.autofixBillingStopped
          ) {
            const absStrict = path.resolve(ROOT, relFile);
            const strictError = String(strict?.error || strict?.message || 'strict_new_errors');
            const seedVerify = {
              ok: false,
              builder: {
                pass: false,
                skipped: false,
                error: strictError,
                results: [{ pass: false, skipped: false, error: strictError }],
              },
              reviewer: { pass: true, skipped: false, summary: { high: 0, critical: 0 }, findings: [] },
              builderPass: false,
              builderSkipped: false,
              builderSkipReason: null,
              reviewerHigh: 0,
              reviewerSkipped: false,
            };
            const fixed = await runAutofixLoop(context, item.candidate, absStrict, seedVerify, snapshots, { reverify: 'strict' });
            item.autofixAttempts = Number(item.autofixAttempts || 0) + Number(fixed.autofixAttempts || 0);
            if (isReadyResult(fixed)) {
              item.stage = 'active_autofixed_ready_for_commit';
              item.strictAutofixed = true;
              item.verify = item.verify || fixed.verify;
              item.autofix = mergeAutofixAttempts(item.autofix, fixed.autofix);
              item.priorErrorCount = fixed.priorErrorCount;
              item.model = fixed.model || item.model || null;
              item.provider = fixed.provider || item.provider || null;
              strict = fixed.strict || await context.strictCheckFn({ file: relFile, results, context });
            } else {
              item.verify = fixed.verify || item.verify;
              item.autofix = mergeAutofixAttempts(item.autofix, fixed.autofix);
              item.priorErrorCount = fixed.priorErrorCount;
              item.model = fixed.model || item.model || null;
              item.provider = fixed.provider || item.provider || null;
              strict = {
                pass: false,
                error: fixed.errorSummary || strict?.error || strict?.message || 'strict_autofix_failed',
              };
            }
          }
          if (!strict || strict.pass !== true) {
            const errorMessage = String(strict?.error || strict?.message || 'strict_gate_failed').slice(0, 300);
            const classification = classifyFixerCapability({
              errorText: errorMessage,
              lines: item.candidate?.lines || 0,
              bytes: item.candidate?.bytes || 0,
            });
            item.stage = 'active_deferred_strict_failed';
            item.applied = false;
            item.strict = strict || { pass: false };
            item.errorCodes = classification.errorCodes;
            item.estimatedCost = classification.estimatedCost;
            item.fixerCapability = classification.fixerCapability;
            item.failureClass = classification.failureClass;
            item.nextAction = classification.nextAction;
            item.errorSummary = formatErrorSummary({ stage: 'strict_gate', candidate: item.candidate, error: errorMessage });
            applyResults.push({ file: relFile, applied: false, reason: 'strict_failed', error: errorMessage });
            continue;
          }
          item.strict = strict;
        }
        const nodeCheck = runNodeCheckGate([relFile]);
        if (!nodeCheck.pass) {
          const errorMessage = String(nodeCheck.failed?.[0]?.error || nodeCheck.message || 'node_check_failed').slice(0, 300);
          item.stage = 'active_deferred_node_check_failed';
          item.applied = false;
          item.nodeCheck = nodeCheck;
          item.errorSummary = formatErrorSummary({ stage: 'node_check_gate', candidate: item.candidate, error: errorMessage });
          applyResults.push({ file: relFile, applied: false, reason: 'node_check_failed', error: errorMessage });
          continue;
        }
        item.nodeCheck = nodeCheck;
        const beforeCommitHead = String(await context.currentHeadFn({ file: relFile, context }) || '').trim();
        try {
          const commit = await context.commitFileFn(
            relFile,
            `refactor(ts): drop @ts-nocheck from ${relFile} [refactorer ${context.cycleId}]`
          );
          let pushed = false;
          let originContains = null;
          let prWorkflow = null;
          if (context.applyPushEnabled) {
            const pushResult = context.prWorkflowEnabled
              ? await context.pushPrFn({ commit, file: relFile, context })
              : await context.pushFn({ commit, file: relFile, context });
            if (pushResult && pushResult.ok === false) {
              throw new Error(pushResult.error || 'push_failed');
            }
            prWorkflow = context.prWorkflowEnabled ? pushResult : null;
            if (context.prWorkflowEnabled) {
              originContains = true;
            } else {
              originContains = await context.originContainsFn(commit, { file: relFile, context });
              if (!originContains) throw new Error(`push_verify_failed:${commit}`);
            }
            pushed = true;
          }
          snapshots.delete(path.resolve(ROOT, relFile));
          item.applied = true;
          item.commit = commit;
          item.pushed = pushed;
          item.originContains = originContains;
          appliedCount += 1;
          const appliedResult = { file: relFile, applied: true, commit, pushed, originContains };
          if (prWorkflow) appliedResult.prWorkflow = prWorkflow;
          applyResults.push(appliedResult);
        } catch (error) {
          const errorMessage = String(error?.message || error).slice(0, 300);
          try {
            await context.rollbackFn(beforeCommitHead, { file: relFile, context });
          } catch (rollbackError) {
            item.rollbackError = String(rollbackError?.message || rollbackError).slice(0, 300);
          }
          item.stage = 'active_apply_failed';
          item.applied = false;
          item.errorSummary = formatErrorSummary({ stage: 'apply_failed', candidate: item.candidate, error: errorMessage });
          applyResults.push({ file: relFile, applied: false, error: errorMessage });
        }
      }
      changedFiles.length = 0;
      for (const file of results.filter(isReadyResult).map((item) => item.candidate?.file).filter(Boolean)) {
        if (!changedFiles.includes(file)) changedFiles.push(file);
      }
    }
    const applied = applyResults.some((item) => item.applied);
    const hasReady = results.some(isReadyResult);
    const hasDeferred = results.some((item) => !isReadyResult(item));
    const hasUnfixable = results.some((item) => item.stage === 'active_deferred_unfixable');
    const readyResults = results.filter(isReadyResult);
    const allReadyAutofixed = readyResults.length > 0
      && readyResults.every((item) => item.stage === 'active_autofixed_ready_for_commit');
    const totalFixAttempts = results.reduce((sum, item) => sum + Number(item.autofixAttempts || 0), 0);
    const operational = activeOperationalStatus({ results, applyResults }, {
      pushRequired: Boolean(context.applyPushEnabled),
    });
    return {
      ok: hasReady,
      stage: hasReady
        ? (hasDeferred ? 'active_partial' : allReadyAutofixed ? 'active_autofixed_ready_for_commit' : 'active_verified_ready_for_commit')
        : hasUnfixable ? 'active_deferred_unfixable' : 'active_deferred',
      changedFiles,
      mutationStarted,
      patchText,
      results,
      applied,
      applyResults,
      operational,
      candidateDiagnostics,
      totalFixAttempts,
      autofixedCount: results.filter((item) => item.stage === 'active_autofixed_ready_for_commit').length,
      strictAutofixedCount: results.filter((item) => item.strictAutofixed === true).length,
      unfixableCount: results.filter((item) => item.stage === 'active_deferred_unfixable').length,
      autofixBillingStopped: Boolean(context.autofixBillingStopped),
    };
  } finally {
    restoreFileSnapshots(snapshots);
  }
}

async function recordRefactorOutcome(context, result) {
  if (context.noWriteOutcome) return { ok: true, skipped: true, reason: 'no_write_outcome' };
  if (typeof recordAutoDevOutcome !== 'function') return { ok: false, skipped: true, reason: 'missing_recordAutoDevOutcome' };
  const active = result.active || null;
  const isActive = context.mode === 'active';
  const stage = isActive ? (active?.stage || 'active_deferred') : 'refactor_shadow_plan';
  const changedFiles = Array.isArray(active?.changedFiles) ? active.changedFiles : [];
  const candidateFiles = Array.isArray(result.plan?.candidates)
    ? result.plan.candidates.map((candidate) => candidate?.file).filter(Boolean)
    : [result.plan?.candidate?.file].filter(Boolean);
  const verifyResults = Array.isArray(active?.results) ? active.results : [];
  const operational = isActive
    ? activeOperationalStatus(active, { pushRequired: Boolean(context.applyPushEnabled) })
    : null;
  const firstErrorSummary = verifyResults.find((item) => item.errorSummary)?.errorSummary || null;
  const outcomeCandidate = result.plan?.candidate || firstResultCandidate(verifyResults) || null;
  const testPass = isActive
    ? verifyResults.some(isReadyResult)
    : null;
  const autofixModels = [...new Set(verifyResults.map((item) => item.model).filter(Boolean))];
  const autofixMeta = isActive ? {
    enabled: Boolean(context.autofixEnabled),
    attempts: verifyResults.reduce((sum, item) => sum + Number(item.autofixAttempts || 0), 0),
    autofixed: verifyResults.filter((item) => item.stage === 'active_autofixed_ready_for_commit').length,
    strictAutofixed: verifyResults.filter((item) => item.strictAutofixed === true).length,
    unfixable: verifyResults.filter((item) => item.stage === 'active_deferred_unfixable').length,
    priorErrorCount: verifyResults.reduce((sum, item) => sum + Number(item.priorErrorCount || 0), 0),
    model: autofixModels[0] || null,
    models: autofixModels,
    billingStopped: Boolean(active?.autofixBillingStopped),
  } : null;
  return recordAutoDevOutcome({
    id: context.cycleId,
    relPath: result.plan?.relPath || `docs/codex/refactor-plans/${context.cycleId}.md`,
    stage,
    profile: isActive ? 'refactor-active' : 'refactor-shadow',
    targetTeam: 'claude',
    writeScope: [context.target.relativePath],
    riskTier: 'normal',
    reason: isActive ? 'refactor-cycle-active' : 'refactor-cycle-shadow',
  }, isActive ? stage : (result.ok ? 'completed' : 'failed'), {
    stage,
    attempts: 1,
    testPass,
    durationMs: Date.now() - context.startedAtMs,
    kind: 'refactor',
    refactorType: outcomeCandidate?.refactorType || context.refactorType,
    cycleId: context.cycleId,
    source: 'claude-refactorer',
    candidateFiles,
    changedFiles,
    avoidedFiles: Array.isArray(result.plan?.avoidedFiles) ? result.plan.avoidedFiles : [],
    localHistoryAvoidedFiles: Array.isArray(result.plan?.localHistoryAvoidedFiles) ? result.plan.localHistoryAvoidedFiles : [],
    failureClass: firstResultValue(verifyResults, 'failureClass'),
    errorCodes: firstResultValue(verifyResults, 'errorCodes') || [],
    fixerCapability: firstResultValue(verifyResults, 'fixerCapability'),
    candidateScore: outcomeCandidate?.score ?? null,
    estimatedCost: firstResultValue(verifyResults, 'estimatedCost') ?? outcomeCandidate?.estimatedCost ?? null,
    nextAction: firstResultValue(verifyResults, 'nextAction'),
    candidateDiagnostics: active?.candidateDiagnostics || result.plan?.candidateDiagnostics || null,
    errorSummary: firstErrorSummary,
    operational,
    autofix: autofixMeta,
    apply: isActive ? {
      enabled: Boolean(context.applyEnabled),
      applied: Boolean(active?.applied),
      results: active?.applyResults || [],
      commits: (active?.applyResults || []).filter((item) => item.applied).map((item) => item.commit).filter(Boolean),
    } : null,
    dirtyScope: context.dirtyScope,
    refactorScopePrefixes: context.refactorScopePrefixes || [],
    meta: {
      kind: 'refactor',
      refactorType: outcomeCandidate?.refactorType || context.refactorType,
      cycleId: context.cycleId,
      mode: context.mode,
      target: context.target.relativePath,
      dirtyScope: context.dirtyScope,
      refactorScopePrefixes: context.refactorScopePrefixes || [],
      planPath: result.plan?.relPath || null,
      patchPath: result.plan?.patchRelPath || null,
      analysisSource: result.analysis?.source || null,
      vaultFeedbackOk: result.plan?.vaultFeedback?.ok ?? null,
      vaultFeedbackCount: Array.isArray(result.plan?.vaultFeedback?.results) ? result.plan.vaultFeedback.results.length : 0,
      avoidedFiles: Array.isArray(result.plan?.avoidedFiles) ? result.plan.avoidedFiles : [],
      localHistoryAvoidedFiles: Array.isArray(result.plan?.localHistoryAvoidedFiles) ? result.plan.localHistoryAvoidedFiles : [],
      failureClass: firstResultValue(verifyResults, 'failureClass'),
      errorCodes: firstResultValue(verifyResults, 'errorCodes') || [],
      fixerCapability: firstResultValue(verifyResults, 'fixerCapability'),
      candidateScore: outcomeCandidate?.score ?? null,
      estimatedCost: firstResultValue(verifyResults, 'estimatedCost') ?? outcomeCandidate?.estimatedCost ?? null,
      nextAction: firstResultValue(verifyResults, 'nextAction'),
      phase: isActive ? 'phase3' : 'phase1',
      stage,
      candidateFiles,
      changedFiles,
      candidateDiagnostics: active?.candidateDiagnostics || null,
      builderPass: verifyResults.length ? verifyResults.every((item) => item.verify?.builderPass !== false) : null,
      reviewerFindings: verifyResults.reduce((sum, item) => sum + Number(item.verify?.reviewerHigh || 0), 0),
      operational,
      apply: isActive ? {
        enabled: Boolean(context.applyEnabled),
        applied: Boolean(active?.applied),
        results: active?.applyResults || [],
        commits: (active?.applyResults || []).filter((item) => item.applied).map((item) => item.commit).filter(Boolean),
      } : null,
      autofix: autofixMeta,
    },
  });
}

async function writeRefactorHeartbeat(context, status, meta = {}) {
  if (context.noHeartbeat) return { ok: true, skipped: true, reason: 'no_heartbeat' };
  return writeClaudeHeartbeat('claude-refactorer', status, {
    source: 'refactor-cycle-runner',
    cycleId: context.cycleId,
    mode: context.mode,
    target: context.target?.relativePath || null,
    refactorType: context.refactorType,
    dirtyScope: context.dirtyScope,
    refactorScopePrefixes: context.refactorScopePrefixes || [],
    durationMs: Date.now() - context.startedAtMs,
    ...meta,
  });
}

function isSafeDeferredCycleResult(result) {
  if (!result || result.mode !== 'active') return false;
  if (result.reason === 'no_active_candidates') return true;
  if (result.blocked === true && result.reason === 'dirty_worktree_in_scope') return true;

  const active = result.active;
  if (!active || active.applied) return false;
  if (active.worktreeRestored !== true) return false;

  const stage = String(active.stage || '');
  return stage === 'active_deferred' || stage === 'active_deferred_unfixable';
}

function heartbeatStatusForCycleResult(result) {
  if (result?.ok) return 'ok';
  if (isSafeDeferredCycleResult(result)) return 'warn';
  return 'error';
}

function exitCodeForCycleResult(result) {
  return result?.ok || isSafeDeferredCycleResult(result) ? 0 : 1;
}

function buildCycleContext(options = {}) {
  const mode = normalizeCycleMode(options.mode);
  const target = resolveTarget(options.target || DEFAULT_TARGET);
  const seed = `${nowIso()}:${target.relativePath || options.target || DEFAULT_TARGET}`;
  const cycleId = `refactor-${cycleStamp()}-${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8)}`;
  const dirtyScope = normalizeDirtyScope(options.dirtyScope ?? process.env.REFACTORER_DIRTY_SCOPE);
  const scopePrefixes = refactorScopePrefixes(target.relativePath || '', dirtyScope);
  return {
    mode,
    target,
    cycleId,
    startedAt: nowIso(),
    startedAtMs: Date.now(),
    refactorType: String(options.refactorType || DEFAULT_REFACTOR_TYPE).trim() || DEFAULT_REFACTOR_TYPE,
    dryRun: Boolean(options.dryRun),
    noMcp: Boolean(options.noMcp),
    noVaultFeedback: Boolean(options.noVaultFeedback),
    vaultFeedback: options.vaultFeedback || null,
    noHeartbeat: Boolean(options.noHeartbeat),
    noWriteOutcome: Boolean(options.noWriteOutcome),
    allowDirtyWorktreeForTest: Boolean(options.allowDirtyWorktreeForTest),
    allowNonProductionCandidatesForTest: Boolean(options.allowNonProductionCandidatesForTest),
    dirtyScope,
    refactorScopePrefixes: scopePrefixes,
    gitStatusShortFn: options.gitStatusShortFn || gitStatusShort,
    gitStatusScopedFn: options.gitStatusScopedFn || gitStatusScoped,
    activeMaxFiles: activeMaxFiles(options.activeMaxFiles ?? process.env.REFACTORER_ACTIVE_MAX_FILES),
    applyEnabled: mode === 'active' && applyEnabled(options.applyEnabled ?? process.env.REFACTORER_APPLY_ENABLED),
    applyPushEnabled: applyPushEnabled(options.applyPushEnabled ?? process.env.REFACTORER_APPLY_PUSH),
    prWorkflowEnabled: booleanEnvEnabled(options.prWorkflowEnabled ?? process.env.CLAUDE_PR_WORKFLOW_ENABLED),
    applyStrictGateEnabled: applyStrictGateEnabled(options.applyStrictGateEnabled ?? process.env.REFACTORER_APPLY_STRICT_GATE),
    strictGateBaselineEnabled: strictGateBaselineEnabled(options.strictGateBaselineEnabled ?? process.env.REFACTORER_STRICT_GATE_BASELINE),
    applyMaxPerCycle: applyMaxPerCycle(options.applyMaxPerCycle ?? process.env.REFACTORER_APPLY_MAX_PER_CYCLE),
    autofixEnabled: mode === 'active' && autofixEnabled(options.autofixEnabled ?? process.env.REFACTORER_AUTOFIX_ENABLED),
    strictAutofixEnabled: strictAutofixEnabled(options.strictAutofixEnabled ?? process.env.REFACTORER_STRICT_AUTOFIX_ENABLED),
    autofixMaxAttempts: autofixMaxAttempts(options.autofixMaxAttempts ?? process.env.REFACTORER_AUTOFIX_MAX_ATTEMPTS),
    autofixBillingStopped: false,
    fixerFn: options.fixerFn || null,
    hubBaseUrl: String(options.hubBaseUrl || DEFAULT_HUB_BASE).replace(/\/+$/, ''),
    avoidThreshold: parsePositiveInt(options.avoidThreshold ?? process.env.REFACTORER_AVOID_THRESHOLD, 2, 20),
    refactorHistoryDir: options.refactorHistoryDir || PLAN_DIR,
    localHistoryAvoidanceEnabled: options.localHistoryAvoidanceEnabled === true,
    builderModule: options.builderModule || null,
    reviewerModule: options.reviewerModule || null,
    commitFileFn: options.commitFileFn || defaultCommitFile,
    pushFn: options.pushFn || (() => defaultPushHead()),
    pushPrFn: options.pushPrFn || ((params) => defaultPushRefactorPr(params)),
    originContainsFn: options.originContainsFn || ((sha) => defaultOriginContainsCommit(sha)),
    rollbackFn: options.rollbackFn || ((head, meta) => defaultRollbackToHead(head, meta?.file)),
    currentHeadFn: options.currentHeadFn || (() => currentGitHead()),
    strictCheckFnProvided: typeof options.strictCheckFn === 'function',
    strictRunFn: options.strictRunFn || runStrictTsc,
    captureStrictBaselineFn: options.captureStrictBaselineFn || captureStrictBaseline,
    strictCheckFn: options.strictCheckFn || ((params) => defaultStrictCheck(params)),
    lockPath: options.lockPath || REFACTORER_LOCK_PATH,
    acquireLockFn: options.acquireLockFn || acquireRefactorLock,
    releaseLockFn: options.releaseLockFn || releaseRefactorLock,
  };
}

async function runRefactorCycle(options = {}) {
  const context = buildCycleContext(options);
  let activeLock = null;
  try {
    if (context.mode === 'off') {
      const result = { ok: true, skipped: true, reason: 'cycle_mode_off', mode: context.mode };
      result.heartbeat = await writeRefactorHeartbeat(context, 'ok', { stage: 'disabled_idle', skipped: true });
      return result;
    }
    if (!context.target.ok) {
      const result = { ok: false, blocked: true, reason: context.target.reason, mode: context.mode };
      result.heartbeat = await writeRefactorHeartbeat(context, 'error', { stage: 'blocked', reason: result.reason });
      return result;
    }
    if (isProtectedTarget(context.target.relativePath)) {
      const result = { ok: false, blocked: true, reason: 'protected_target', target: context.target.relativePath, mode: context.mode };
      result.heartbeat = await writeRefactorHeartbeat(context, 'error', { stage: 'blocked', reason: result.reason });
      return result;
    }
    if (context.mode === 'active') {
      const initialGitStatus = context.gitStatusShortFn();
      context.initialGitStatus = initialGitStatus;
      const scopePrefixes = refactorScopePrefixes(context.target.relativePath, context.dirtyScope);
      context.refactorScopePrefixes = scopePrefixes;
      const scopedDirty = context.gitStatusScopedFn(scopePrefixes);
      context.initialScopedGitStatus = scopedDirty;
      if (scopedDirty && !context.allowDirtyWorktreeForTest) {
        const result = {
          ok: false,
          blocked: true,
          reason: 'dirty_worktree_in_scope',
          mode: context.mode,
          dirtyScope: context.dirtyScope,
          scope: scopePrefixes,
          gitStatus: scopedDirty,
          fullGitStatus: initialGitStatus,
        };
        result.heartbeat = await writeRefactorHeartbeat(context, 'warn', {
          stage: 'blocked',
          reason: result.reason,
          dirtyScope: context.dirtyScope,
          scope: scopePrefixes,
        });
        return result;
      }
      if (context.applyEnabled) {
        const lock = await context.acquireLockFn(context.lockPath, { context });
        if (!lock?.ok) {
          const result = {
            ok: true,
            skipped: true,
            reason: lock?.reason || 'another_cycle_active',
            mode: context.mode,
            cycleId: context.cycleId,
            target: context.target.relativePath,
            lock,
          };
          result.heartbeat = await writeRefactorHeartbeat(context, 'ok', {
            stage: 'skipped_active_lock',
            reason: result.reason,
            lockAgeMs: lock?.lock?.ageMs ?? null,
          });
          return result;
        }
        activeLock = lock;
      }
    }

    const analysis = await analyzeStep(context);

    if (context.mode === 'active') {
      const vaultFeedback = context.vaultFeedback || await fetchRefactorVaultFeedback(context, {
        file: context.target.relativePath,
        refactorType: context.refactorType,
      });
      context.vaultFeedback = vaultFeedback;
      const feedbackAvoidedFiles = deriveAvoidedFilesFromFeedback(vaultFeedback, context.avoidThreshold);
      const shouldUseLocalHistoryAvoidance = context.localHistoryAvoidanceEnabled
        || (!context.allowDirtyWorktreeForTest && context.applyEnabled && !context.dryRun);
      const localHistoryAvoidedFiles = shouldUseLocalHistoryAvoidance
        ? deriveAvoidedFilesFromLocalHistory({
          historyDir: context.refactorHistoryDir,
          threshold: context.avoidThreshold,
        })
        : new Set();
      const avoidedFiles = mergeAvoidedFiles(feedbackAvoidedFiles, localHistoryAvoidedFiles);
      const candidateSelection = selectActiveCandidatesDetailed(analysis, context.refactorType, context.activeMaxFiles, avoidedFiles, {
        allowNonProductionCandidates: context.allowNonProductionCandidatesForTest || context.allowDirtyWorktreeForTest,
        validateCurrentState: true,
      });
      const candidates = candidateSelection.selected;
      if (candidates.length === 0) {
        const result = {
          ok: false,
          mode: context.mode,
          cycleId: context.cycleId,
          target: context.target.relativePath,
          dryRun: context.dryRun,
          blocked: true,
          reason: 'no_active_candidates',
          analysis,
          plan: {
            ok: false,
            relPath: null,
            wrote: false,
            candidate: null,
            candidates: [],
            candidateDiagnostics: candidateSelection.diagnostics,
            vaultFeedback,
            avoidedFiles: [...avoidedFiles],
            localHistoryAvoidedFiles: [...localHistoryAvoidedFiles],
          },
          steps: [
            { id: 'analyze', status: 'complete', mutates: false },
            { id: 'plan', status: 'skipped_no_candidate', mutates: false },
            { id: 'refactor', status: 'skipped_no_candidate', mutates: false },
            { id: 'verify', status: 'skipped_no_candidate', mutates: false },
            { id: 'fix', status: 'none', mutates: false },
            { id: 'commit', status: 'not_ready', mutates: false },
            { id: 'document', status: 'skipped_no_candidate', mutates: false },
          ],
        };
        result.outcome = await recordRefactorOutcome(context, result);
        result.heartbeat = await writeRefactorHeartbeat(context, heartbeatStatusForCycleResult(result), { stage: 'active_deferred', reason: result.reason });
        return result;
      }

      if (
        context.applyEnabled
        && !context.dryRun
        && context.applyStrictGateEnabled
        && context.strictGateBaselineEnabled
        && !context.strictCheckFnProvided
        && context.strictBaseline === undefined
      ) {
        try {
          const baseline = await context.captureStrictBaselineFn({ context });
          context.strictBaseline = baseline instanceof Set ? baseline : null;
        } catch (error) {
          context.strictBaseline = null;
          context.strictBaselineError = error?.message || String(error);
        }
      }

      const active = await runActiveRefactor(context, analysis, candidates, candidateSelection.diagnostics);
      active.vaultFeedback = vaultFeedback;
      active.avoidedFiles = [...avoidedFiles];
      active.localHistoryAvoidedFiles = [...localHistoryAvoidedFiles];
      active.finalGitStatus = context.gitStatusShortFn();
      active.finalScopedStatus = context.gitStatusScopedFn(context.refactorScopePrefixes || []);
      active.targetGitStatus = context.gitStatusScopedFn([context.target.relativePath]);
      active.worktreeRestored = context.allowDirtyWorktreeForTest ? true : active.targetGitStatus.trim() === '';
      const artifacts = writeActiveArtifacts(context, analysis, active);
      const result = {
        ok: active.ok,
        mode: context.mode,
        cycleId: context.cycleId,
        target: context.target.relativePath,
        dryRun: context.dryRun,
        analysis,
        active: {
          ...active,
          patchRelPath: artifacts.patchRelPath || null,
          planRelPath: artifacts.relPath || null,
        },
        plan: {
          ok: true,
          relPath: artifacts.relPath || null,
          patchRelPath: artifacts.patchRelPath || null,
          wrote: Boolean(artifacts.wrote),
          candidate: candidates[0],
          candidates,
          candidateDiagnostics: candidateSelection.diagnostics,
          vaultFeedback,
          avoidedFiles: [...avoidedFiles],
          localHistoryAvoidedFiles: [...localHistoryAvoidedFiles],
        },
        steps: [
          { id: 'analyze', status: 'complete', mutates: false },
          { id: 'plan', status: artifacts.wrote ? 'complete' : 'dry_run', mutates: Boolean(artifacts.wrote) },
          { id: 'refactor', status: activeRefactorStepStatus(active), mutates: true, restored: active.worktreeRestored },
          { id: 'verify', status: active.ok ? 'complete' : 'failed', mutates: false },
          { id: 'fix', status: activeFixStepStatus(active), mutates: false },
          { id: 'commit', status: activeCommitStepStatus(active), mutates: Boolean(active.applied) },
          { id: 'document', status: artifacts.wrote ? 'complete' : 'dry_run', mutates: Boolean(artifacts.wrote) },
        ],
      };
      result.outcome = await recordRefactorOutcome(context, result);
      result.heartbeat = await writeRefactorHeartbeat(context, heartbeatStatusForCycleResult(result), {
        stage: active.ok ? 'active_complete' : 'active_deferred',
        changedFiles: active.changedFiles,
        patchPath: artifacts.patchRelPath || null,
        builderPass: active.results.every((item) => item.verify?.builderPass !== false),
        reviewerFindings: active.results.reduce((sum, item) => sum + Number(item.verify?.reviewerHigh || 0), 0),
        autofixEnabled: Boolean(context.autofixEnabled),
        autofixedCount: active.autofixedCount || 0,
        unfixableCount: active.unfixableCount || 0,
        totalFixAttempts: active.totalFixAttempts || 0,
        autofixBillingStopped: Boolean(active.autofixBillingStopped),
        applyEnabled: Boolean(context.applyEnabled),
        applied: Boolean(active.applied),
        applyCommits: (active.applyResults || []).filter((item) => item.applied).map((item) => item.commit).filter(Boolean),
        applyResults: active.applyResults || [],
        worktreeRestored: active.worktreeRestored,
        outcomeOk: Boolean(result.outcome?.ok),
      });
      return result;
    }

    const candidate = selectCandidate(analysis, context.refactorType);
    const vaultFeedback = await fetchRefactorVaultFeedback(context, candidate);
    const plan = planStep(context, analysis, { candidate, vaultFeedback });
    const result = {
      ok: true,
      mode: context.mode,
      cycleId: context.cycleId,
      target: context.target.relativePath,
      dryRun: context.dryRun,
      analysis,
      plan: {
        ok: plan.ok,
        relPath: plan.relPath,
        wrote: plan.wrote,
        candidate: plan.candidate,
        vaultFeedback: plan.vaultFeedback,
      },
      steps: [
        { id: 'analyze', status: 'complete', mutates: false },
        { id: 'plan', status: 'complete', mutates: plan.wrote },
        pendingStep('refactor'),
        pendingStep('verify'),
        pendingStep('fix'),
        pendingStep('commit'),
        pendingStep('document'),
      ],
    };
    result.outcome = await recordRefactorOutcome(context, result);
    result.heartbeat = await writeRefactorHeartbeat(context, 'ok', {
      stage: 'shadow_complete',
      planPath: result.plan.relPath,
      candidate: result.plan.candidate?.file || null,
      vaultFeedbackOk: result.plan.vaultFeedback?.ok ?? null,
      vaultFeedbackCount: Array.isArray(result.plan.vaultFeedback?.results) ? result.plan.vaultFeedback.results.length : 0,
      outcomeOk: Boolean(result.outcome?.ok),
    });
    return result;
  } catch (error) {
    const result = {
      ok: false,
      error: String(error?.message || error),
      mode: context.mode,
      cycleId: context.cycleId,
    };
    result.heartbeat = await writeRefactorHeartbeat(context, 'error', errorHeartbeatMeta(error, { stage: 'fatal' }));
    return result;
  } finally {
    if (activeLock) {
      try {
        await context.releaseLockFn(activeLock, { context });
      } catch {
        // Cycle result should not be masked by a best-effort lock cleanup failure.
      }
    }
  }
}

async function main() {
  const options = parseArgs();
  const result = await runRefactorCycle(options);
  const text = JSON.stringify(result, null, 2);
  if (options.json) {
    console.log(text);
  } else {
    console.log(`[refactor-cycle] ${result.ok ? 'ok' : 'failed'} mode=${result.mode || 'unknown'} reason=${result.reason || 'n/a'}`);
    console.log(text);
  }
  process.exit(exitCodeForCycleResult(result));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[refactor-cycle] fatal:', error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  analyzeLocalTechDebt,
  buildFixerSystemPrompt,
  buildCycleContext,
  buildFixerPrompt,
  buildPlanContent,
  cycleStamp,
  addNodeExecutableImplicitAnyJsdoc,
  addNodeExecutableUnknownGuard,
  attemptNodeExecutableLocalTypeFix,
  deriveFilePriorErrors,
  estimateAutofixCost,
  classifyFixerCapability,
  parseTypeScriptErrorCodes,
  isProtectedTarget,
  isNonProductionRefactorCandidate,
  normalizeCycleMode,
  parseArgs,
  planStep,
  resolveTarget,
  runRefactorCycle,
  selectCandidate,
  selectActiveCandidates,
  selectActiveCandidatesDetailed,
  parseRefactorHistoryPlan,
  deriveAvoidedFilesFromLocalHistory,
  mergeAvoidedFiles,
  fetchRefactorVaultFeedback,
  cleanupUnexpectedUntracked,
  captureStrictBaseline,
  defaultCommitFile,
  defaultPushRefactorPr,
  defaultOriginContainsCommit,
  refactorPrBranch,
  runNodeCheckForFile,
  defaultStrictCheck,
  acquireRefactorLock,
  releaseRefactorLock,
  gitStatusScoped,
  isNodeExecutableContent,
  isNodeExecutableFile,
  isBillingGuardError,
  exitCodeForCycleResult,
  heartbeatStatusForCycleResult,
  applyEnabled,
  applyPushEnabled,
  applyStrictGateEnabled,
  strictAutofixEnabled,
  parseStrictErrorSignatures,
  isStrictInfraFailure,
  runStrictTsc,
  strictGateBaselineEnabled,
  normalizeDirtyScope,
  refactorScopePrefixes,
  unexpectedMutationLines,
};
