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

const ROOT = env.PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..');
const DEFAULT_TARGET = 'bots/claude';
const DEFAULT_REFACTOR_TYPE = 'ts_nocheck';
const DEFAULT_MCP_BASE = process.env.REFACTOR_MCP_URL || 'http://localhost:8774';
const DEFAULT_HUB_BASE = process.env.HUB_URL || 'http://localhost:7788';
const AUTOFIX_SELECTOR_KEY = 'claude.refactorer.code_refactor';
const AUTOFIX_FILE_MAX_LINES = 1200;
const AUTOFIX_FILE_MAX_BYTES = 60 * 1024;
const AUTOFIX_TIMEOUT_MS = 120000;
const PLAN_DIR = path.join(ROOT, 'docs', 'codex', 'refactor-plans');
const PATCH_DIR = path.join(PLAN_DIR, 'patches');
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
  '.next',
  '.turbo',
  'venv',
  '__pycache__',
]);

const PROTECTED_TARGET_FRAGMENTS = [
  'bots/investment/markets/',
  'bots/investment/launchd/ai.luna',
  'bots/investment/scripts/runtime-luna-live',
  'bots/investment/scripts/runtime-luna-approved-signal-executor',
  'bots/investment/scripts/crypto-holding-monitor',
  'bots/investment/shared/binance',
  'bots/investment/shared/kis',
  'bots/hub/secrets',
  'secrets-store.json',
  '/.git/',
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

function activeAutocommitEnabled(value = process.env.REFACTORER_ACTIVE_AUTOCOMMIT) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

function autofixEnabled(value = process.env.REFACTORER_AUTOFIX_ENABLED) {
  return activeAutocommitEnabled(value);
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
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const withSlash = normalized.endsWith('/') ? normalized : `${normalized}/`;
  return PROTECTED_TARGET_FRAGMENTS.some((fragment) => normalized.includes(fragment) || withSlash.includes(fragment));
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

function buildCandidate(filePath, refactorType, lines, reason) {
  return {
    file: relPath(filePath),
    lines,
    refactorType,
    reason,
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
    candidates.push(buildCandidate(item.filePath, 'ts_nocheck', item.lines, 'small_ts_nocheck_leaf_first'));
  }
  for (const item of largeFiles.slice(0, 5)) {
    if (!candidates.some((candidate) => candidate.file === relPath(item.filePath))) {
      candidates.push(buildCandidate(item.filePath, 'split', item.lines, 'large_file_split_candidate'));
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
  const text = [
    status === 429 ? '429' : '',
    json.error,
    json.message,
    json.reason,
    errorText,
  ].filter(Boolean).join(' ').toLowerCase();
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

function buildFixerSystemPrompt() {
  return [
    'You are Claude team refactorer code fixer.',
    'Fix TypeScript type errors exposed by removing // @ts-nocheck.',
    'Return only the complete revised file content.',
    'Do not wrap the answer in Markdown fences and do not include explanations.',
    'Make the smallest change required for tsc/reviewer to pass.',
    'Do not add features, change runtime behavior, or edit unrelated code.',
    'Do not reinsert @ts-nocheck.',
  ].join(' ');
}

function buildFixerPrompt({ fileRel, currentContent, builderError, reviewerFindings, attempt }) {
  return [
    `file: ${fileRel}`,
    `attempt: ${attempt}`,
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
    'Return the complete revised file content only.',
  ].join('\n');
}

async function attemptTypeFix(context, { fileRel, currentContent, builderError, reviewerFindings, attempt }) {
  try {
    if (lineCount(currentContent) > AUTOFIX_FILE_MAX_LINES || byteLength(currentContent) > AUTOFIX_FILE_MAX_BYTES) {
      return { ok: false, fixedContent: null, error: 'too_large' };
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
          prompt: buildFixerPrompt({ fileRel, currentContent, builderError, reviewerFindings, attempt }),
          systemPrompt: buildFixerSystemPrompt(),
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

function selectActiveCandidates(analysis, requestedType = DEFAULT_REFACTOR_TYPE, maxFiles = 1, avoidedFiles = new Set()) {
  const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
  const preferred = candidates.filter((candidate) => candidate.refactorType === requestedType);
  const ordered = [...preferred, ...candidates.filter((candidate) => candidate.refactorType !== requestedType)];
  const selected = [];
  for (const candidate of ordered) {
    if (!candidate?.file || selected.some((item) => item.file === candidate.file)) continue;
    if (avoidedFiles.has(candidate.file)) continue;
    if (isProtectedTarget(candidate.file)) continue;
    selected.push(candidate);
    if (selected.length >= maxFiles) break;
  }
  return selected;
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

async function fetchRefactorVaultFeedback(context, candidate) {
  if (context.noVaultFeedback) return { ok: true, skipped: true, reason: 'no_vault_feedback' };
  if (context.dryRun) return { ok: true, skipped: true, reason: 'dry_run' };

  const query = [
    'refactor',
    candidate?.refactorType || context.refactorType,
    candidate?.file || context.target.relativePath,
    'shadow plan outcome feedback',
  ].filter(Boolean).join(' ');

  try {
    const modulePath = path.join(ROOT, 'bots', 'sigma', 'vault', 'vault-search.ts');
    const { searchVault } = await import(pathToFileURL(modulePath).href);
    if (typeof searchVault !== 'function') {
      return { ok: false, query, warning: 'searchVault_not_exported', results: [] };
    }
    const mapResults = (search) => Array.isArray(search?.results) ? search.results.map((item) => {
      const meta = item.meta || {};
      const payload = meta.payload || {};
      const payloadMeta = payload.meta || {};
      return {
        title: item.title,
        source: item.source || null,
        similarity: item.similarity,
        cycleId: payloadMeta.cycleId || payload.cycleId || meta.cycleId || null,
        refactorType: payloadMeta.refactorType || payload.refactorType || meta.refactorType || null,
        target: payloadMeta.target || payload.target || meta.target || null,
        file: payloadMeta.file || payload.file || null,
        candidateFiles: Array.isArray(payloadMeta.candidateFiles) ? payloadMeta.candidateFiles : [],
        changedFiles: Array.isArray(payloadMeta.changedFiles) ? payloadMeta.changedFiles : [],
        errorSummary: payloadMeta.errorSummary || payload.errorSummary || null,
        outcome: payload.outcome || null,
        stage: payload.stage || null,
      };
    }) : [];
    const refactorSearch = await searchVault(query, {
      topK: 3,
      sourceKinds: ['claude_refactor'],
    });
    const refactorResults = mapResults(refactorSearch);
    if (refactorSearch?.ok && refactorResults.length > 0) {
      return {
        ok: true,
        query,
        sourcePriority: 'claude_refactor',
        warning: null,
        results: refactorResults,
      };
    }

    const legacySearch = await searchVault(query, {
      topK: 3,
      sourceKinds: ['claude_auto_dev'],
    });
    const legacyResults = mapResults(legacySearch);
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
  const lines = String(content).split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*\/\/\s*@ts-nocheck\s*$/.test(line));
  if (index < 0) return { changed: false, content };
  lines.splice(index, 1);
  return { changed: true, content: lines.join('\n') };
}

function runGit(args = [], options = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function gitStatusShort() {
  try {
    return runGit(['status', '--short']).trim();
  } catch (error) {
    return `git_status_failed:${error?.message || String(error)}`;
  }
}

function gitStatusLines(statusText = '') {
  return String(statusText || '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function pathFromStatusLine(line = '') {
  const text = String(line || '');
  if (text.includes(' -> ')) return text;
  return text.slice(3).trim();
}

function unexpectedMutationLines(currentStatus, baselineStatus, allowedFiles = []) {
  const baseline = new Set(gitStatusLines(baselineStatus));
  const allowed = new Set(allowedFiles.map((file) => String(file || '').replace(/\\/g, '/')));
  return gitStatusLines(currentStatus).filter((line) => {
    if (baseline.has(line)) return false;
    const statusPath = pathFromStatusLine(line).replace(/\\/g, '/');
    return !allowed.has(statusPath);
  });
}

function cleanupUnexpectedUntracked(lines = [], baselineStatus = '') {
  const baseline = new Set(gitStatusLines(baselineStatus));
  for (const line of lines) {
    if (baseline.has(line) || !line.startsWith('?? ')) continue;
    const rel = pathFromStatusLine(line);
    const absolutePath = path.resolve(ROOT, rel);
    const relativePath = relPath(absolutePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || isProtectedTarget(relativePath)) continue;
    fs.rmSync(absolutePath, { recursive: true, force: true });
  }
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

function normalizeReviewHighCount(reviewResult) {
  const summary = reviewResult?.summary || {};
  return Number(summary.high || 0) + Number(summary.critical || 0);
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

function resolveVerifierModules(context) {
  return {
    builder: context.builderModule || require('../src/builder'),
    reviewer: context.reviewerModule || require('../src/reviewer'),
  };
}

async function verifyChangedFiles(context, changedFiles) {
  const { builder, reviewer } = resolveVerifierModules(context);
  const verifyOptions = { files: changedFiles, force: true, test: true };
  const builderResult = await builder.runBuildCheck(verifyOptions);
  const reviewerResult = await reviewer.runReview(verifyOptions);
  const reviewerHigh = normalizeReviewHighCount(reviewerResult);
  const builderSkipped = Boolean(builderResult?.skipped);
  const reviewerSkipped = Boolean(reviewerResult?.skipped);
  return {
    ok: builderResult?.pass !== false && reviewerHigh === 0 && !builderSkipped && !reviewerSkipped,
    builder: builderResult,
    reviewer: reviewerResult,
    builderPass: builderResult?.pass !== false,
    builderSkipped,
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
  const builderMessage = String(verify?.builder?.message || '').replace(/\s+/g, ' ').slice(0, 240);
  const reviewerMessage = String(verify?.reviewer?.message || '').replace(/\s+/g, ' ').slice(0, 240);
  return [
    `stage=${stage}`,
    `file=${file}`,
    `builder_pass=${builderPass}`,
    `builder_skipped=${builderSkipped}`,
    `reviewer_high=${reviewerHigh}`,
    `reviewer_skipped=${reviewerSkipped}`,
    builderMessage ? `builder=${builderMessage}` : null,
    reviewerMessage ? `reviewer=${reviewerMessage}` : null,
  ].filter(Boolean).join('; ');
}

function buildActiveDocumentContent(context, analysis, active) {
  const summary = analysis?.summary || {};
  const feedback = active.vaultFeedback || {};
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
    `- generated_at: ${context.startedAt}`,
    `- autocommit: ${context.activeAutocommit ? 'true' : 'false'}`,
    `- max_files: ${context.activeMaxFiles}`,
    '',
    '## Analysis',
    `- source: ${analysis?.source || 'unknown'}`,
    `- total_ts_files: ${summary.totalTsFiles ?? 'unknown'}`,
    `- ts_nocheck_count: ${summary.tsNocheckCount ?? 'unknown'}`,
    `- ts_nocheck_ratio: ${summary.tsNocheckRatio ?? 'unknown'}`,
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
    `- deferred: ${deferred.length}`,
    `- changed_files: ${changedFiles.length ? changedFiles.join(', ') : 'none'}`,
    `- patch_path: ${active.patchRelPath || 'none'}`,
    `- worktree_restored: ${active.worktreeRestored === true}`,
    `- final_git_status: ${active.finalGitStatus || 'unknown'}`,
    '',
    '## Seven-Step Cycle Status',
    '1. Analyze: complete',
    '2. Plan: complete',
    `3. Refactor: ${changedFiles.length ? 'complete' : 'no_change'}`,
    `4. Verify: ${successful.length ? 'pass' : 'deferred'}`,
    `5. Fix: ${activeFixStepStatus(active)}`,
    `6. Commit: ${successful.length ? 'ready_for_review_autocommit_false' : 'not_ready'}`,
    '7. Document: complete',
    '',
    '## Verification Summary',
    ...active.results.map((item, index) => [
      `### Candidate ${index + 1}: ${item.candidate?.file || 'unknown'}`,
      `- stage: ${item.stage}`,
      `- builder_pass: ${item.verify?.builderPass ?? false}`,
      `- builder_skipped: ${item.verify?.builderSkipped ?? false}`,
      `- reviewer_high: ${item.verify?.reviewerHigh ?? 'unknown'}`,
      `- reviewer_skipped: ${item.verify?.reviewerSkipped ?? false}`,
      `- autofix_attempts: ${item.autofixAttempts || 0}`,
      item.model ? `- autofix_model: ${item.model}` : null,
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

async function runAutofixLoop(context, candidate, absolutePath, initialVerify, snapshots) {
  const fileRel = relPath(absolutePath);
  let verify = initialVerify;
  let lastFix = null;
  const attempts = [];
  if (context.autofixBillingStopped) {
    return {
      stage: 'active_deferred_unfixable',
      verify,
      autofixAttempts: 0,
      errorSummary: formatErrorSummary({ stage: 'autofix', candidate, error: 'billing_guard_stopped' }),
    };
  }

  for (let attempt = 1; attempt <= context.autofixMaxAttempts; attempt++) {
    const beforeFixStatus = gitStatusShort();
    const currentContent = fs.readFileSync(absolutePath, 'utf8');
    const fix = await callAutofixer(context, {
      fileRel,
      currentContent,
      builderError: builderErrorText(verify),
      reviewerFindings: reviewerHighFindings(verify),
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
      gitStatusShort(),
      beforeFixStatus,
      [fileRel]
    );
    if (unexpectedAfterFixer.length > 0) {
      cleanupUnexpectedUntracked(unexpectedAfterFixer, beforeFixStatus);
      restoreFileSnapshot(snapshots, absolutePath);
      return {
        stage: 'active_deferred_unfixable',
        verify,
        autofixAttempts: attempt,
        autofix: attempts,
        errorSummary: formatErrorSummary({
          stage: 'autofix',
          candidate,
          error: `autofix_unexpected_mutation:${unexpectedAfterFixer.join('|')}`,
        }),
      };
    }
    if (fix.billingGuard) context.autofixBillingStopped = true;
    if (!fix.ok || !fix.fixedContent) break;

    fs.writeFileSync(absolutePath, fix.fixedContent, 'utf8');
    const unexpectedAfterWrite = unexpectedMutationLines(
      gitStatusShort(),
      context.initialGitStatus || '',
      [fileRel]
    );
    if (unexpectedAfterWrite.length > 0) {
      cleanupUnexpectedUntracked(unexpectedAfterWrite, context.initialGitStatus || '');
      restoreFileSnapshot(snapshots, absolutePath);
      return {
        stage: 'active_deferred_unfixable',
        verify,
        autofixAttempts: attempt,
        autofix: attempts,
        errorSummary: formatErrorSummary({
          stage: 'autofix',
          candidate,
          error: `autofix_unexpected_mutation:${unexpectedAfterWrite.join('|')}`,
        }),
      };
    }

    try {
      verify = await verifyChangedFiles(context, [fileRel]);
    } catch (error) {
      return {
        stage: 'active_deferred_unfixable',
        verify,
        autofixAttempts: attempt,
        autofix: attempts,
        errorSummary: formatErrorSummary({ stage: 'autofix_verify', candidate, error }),
      };
    }
    if (verify.ok) {
      return {
        stage: 'active_autofixed_ready_for_commit',
        verify,
        autofixAttempts: attempt,
        autofix: attempts,
        model: fix.model || null,
        provider: fix.provider || null,
      };
    }
    if (context.autofixBillingStopped) break;
  }

  restoreFileSnapshot(snapshots, absolutePath);
  return {
    stage: 'active_deferred_unfixable',
    verify,
    autofixAttempts: attempts.length,
    autofix: attempts,
    errorSummary: formatErrorSummary({
      stage: 'autofix',
      candidate,
      error: lastFix?.error || `verify_failed_after_${attempts.length}_attempts`,
    }),
  };
}

async function runActiveRefactor(context, analysis, candidates) {
  const targetFiles = candidates.map(candidateAbsolutePath).filter(Boolean);
  const snapshots = snapshotFiles(targetFiles);
  const results = [];
  const changedFiles = [];
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
          restoreFileSnapshot(snapshots, absolutePath);
          results.push({
            candidate,
            stage: 'active_deferred',
            verify,
            errorSummary: formatErrorSummary({ stage: 'verify', candidate, verify }),
          });
        }
      }
    }
    const successfulFiles = results
      .filter(isReadyResult)
      .map((item) => item.candidate?.file)
      .filter(Boolean);
    patchText = successfulFiles.length > 0 ? gitDiffForFiles(successfulFiles) : '';
    const hasReady = results.some(isReadyResult);
    const hasDeferred = results.some((item) => !isReadyResult(item));
    const hasUnfixable = results.some((item) => item.stage === 'active_deferred_unfixable');
    const readyResults = results.filter(isReadyResult);
    const allReadyAutofixed = readyResults.length > 0
      && readyResults.every((item) => item.stage === 'active_autofixed_ready_for_commit');
    const totalFixAttempts = results.reduce((sum, item) => sum + Number(item.autofixAttempts || 0), 0);
    return {
      ok: hasReady,
      stage: hasReady
        ? (hasDeferred ? 'active_partial' : allReadyAutofixed ? 'active_autofixed_ready_for_commit' : 'active_verified_ready_for_commit')
        : hasUnfixable ? 'active_deferred_unfixable' : 'active_deferred',
      changedFiles,
      mutationStarted,
      patchText,
      results,
      totalFixAttempts,
      autofixedCount: results.filter((item) => item.stage === 'active_autofixed_ready_for_commit').length,
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
  const firstErrorSummary = verifyResults.find((item) => item.errorSummary)?.errorSummary || null;
  const testPass = isActive
    ? verifyResults.some(isReadyResult)
    : null;
  const autofixModels = [...new Set(verifyResults.map((item) => item.model).filter(Boolean))];
  const autofixMeta = isActive ? {
    enabled: Boolean(context.autofixEnabled),
    attempts: verifyResults.reduce((sum, item) => sum + Number(item.autofixAttempts || 0), 0),
    autofixed: verifyResults.filter((item) => item.stage === 'active_autofixed_ready_for_commit').length,
    unfixable: verifyResults.filter((item) => item.stage === 'active_deferred_unfixable').length,
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
    refactorType: result.plan?.candidate?.refactorType || context.refactorType,
    cycleId: context.cycleId,
    source: 'claude-refactorer',
    candidateFiles,
    changedFiles,
    errorSummary: firstErrorSummary,
    autofix: autofixMeta,
    meta: {
      kind: 'refactor',
      refactorType: result.plan?.candidate?.refactorType || context.refactorType,
      cycleId: context.cycleId,
      mode: context.mode,
      target: context.target.relativePath,
      planPath: result.plan?.relPath || null,
      patchPath: result.plan?.patchRelPath || null,
      analysisSource: result.analysis?.source || null,
      vaultFeedbackOk: result.plan?.vaultFeedback?.ok ?? null,
      vaultFeedbackCount: Array.isArray(result.plan?.vaultFeedback?.results) ? result.plan.vaultFeedback.results.length : 0,
      phase: isActive ? 'phase3' : 'phase1',
      stage,
      candidateFiles,
      changedFiles,
      builderPass: verifyResults.length ? verifyResults.every((item) => item.verify?.builderPass !== false) : null,
      reviewerFindings: verifyResults.reduce((sum, item) => sum + Number(item.verify?.reviewerHigh || 0), 0),
      autocommit: Boolean(context.activeAutocommit),
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
    durationMs: Date.now() - context.startedAtMs,
    ...meta,
  });
}

function buildCycleContext(options = {}) {
  const mode = normalizeCycleMode(options.mode);
  const target = resolveTarget(options.target || DEFAULT_TARGET);
  const seed = `${nowIso()}:${target.relativePath || options.target || DEFAULT_TARGET}`;
  const cycleId = `refactor-${cycleStamp()}-${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8)}`;
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
    noHeartbeat: Boolean(options.noHeartbeat),
    noWriteOutcome: Boolean(options.noWriteOutcome),
    allowDirtyWorktreeForTest: Boolean(options.allowDirtyWorktreeForTest),
    activeMaxFiles: activeMaxFiles(options.activeMaxFiles ?? process.env.REFACTORER_ACTIVE_MAX_FILES),
    activeAutocommit: activeAutocommitEnabled(options.activeAutocommit ?? process.env.REFACTORER_ACTIVE_AUTOCOMMIT),
    autofixEnabled: mode === 'active' && autofixEnabled(options.autofixEnabled ?? process.env.REFACTORER_AUTOFIX_ENABLED),
    autofixMaxAttempts: autofixMaxAttempts(options.autofixMaxAttempts ?? process.env.REFACTORER_AUTOFIX_MAX_ATTEMPTS),
    autofixBillingStopped: false,
    fixerFn: options.fixerFn || null,
    hubBaseUrl: String(options.hubBaseUrl || DEFAULT_HUB_BASE).replace(/\/+$/, ''),
    avoidThreshold: parsePositiveInt(options.avoidThreshold ?? process.env.REFACTORER_AVOID_THRESHOLD, 2, 20),
    builderModule: options.builderModule || null,
    reviewerModule: options.reviewerModule || null,
  };
}

async function runRefactorCycle(options = {}) {
  const context = buildCycleContext(options);
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
      if (context.activeAutocommit) {
        const result = { ok: false, blocked: true, reason: 'active_autocommit_not_supported_phase3', mode: context.mode };
        result.heartbeat = await writeRefactorHeartbeat(context, 'error', { stage: 'blocked', reason: result.reason });
        return result;
      }
      const initialGitStatus = gitStatusShort();
      context.initialGitStatus = initialGitStatus;
      if (initialGitStatus && !context.allowDirtyWorktreeForTest) {
        const result = { ok: false, blocked: true, reason: 'dirty_worktree', mode: context.mode, gitStatus: initialGitStatus };
        result.heartbeat = await writeRefactorHeartbeat(context, 'error', { stage: 'blocked', reason: result.reason });
        return result;
      }
    }

    const analysis = await analyzeStep(context);

    if (context.mode === 'active') {
      const vaultFeedback = await fetchRefactorVaultFeedback(context, {
        file: context.target.relativePath,
        refactorType: context.refactorType,
      });
      const avoidedFiles = deriveAvoidedFilesFromFeedback(vaultFeedback, context.avoidThreshold);
      const candidates = selectActiveCandidates(analysis, context.refactorType, context.activeMaxFiles, avoidedFiles);
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
            vaultFeedback,
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
        result.heartbeat = await writeRefactorHeartbeat(context, 'error', { stage: 'active_deferred', reason: result.reason });
        return result;
      }

      const active = await runActiveRefactor(context, analysis, candidates);
      active.vaultFeedback = vaultFeedback;
      active.finalGitStatus = gitStatusShort();
      active.worktreeRestored = context.allowDirtyWorktreeForTest ? true : active.finalGitStatus === '';
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
          vaultFeedback,
        },
        steps: [
          { id: 'analyze', status: 'complete', mutates: false },
          { id: 'plan', status: artifacts.wrote ? 'complete' : 'dry_run', mutates: Boolean(artifacts.wrote) },
          { id: 'refactor', status: active.mutationStarted ? 'complete_restored' : 'no_change', mutates: true, restored: active.worktreeRestored },
          { id: 'verify', status: active.ok ? 'complete' : 'failed', mutates: false },
          { id: 'fix', status: activeFixStepStatus(active), mutates: false },
          { id: 'commit', status: active.ok ? 'ready_for_review_autocommit_false' : 'not_ready', mutates: false },
          { id: 'document', status: artifacts.wrote ? 'complete' : 'dry_run', mutates: Boolean(artifacts.wrote) },
        ],
      };
      result.outcome = await recordRefactorOutcome(context, result);
      result.heartbeat = await writeRefactorHeartbeat(context, active.ok ? 'ok' : 'error', {
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
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[refactor-cycle] fatal:', error?.message || error);
    process.exit(1);
  });
}

module.exports = {
  analyzeLocalTechDebt,
  buildCycleContext,
  buildPlanContent,
  cycleStamp,
  isProtectedTarget,
  normalizeCycleMode,
  parseArgs,
  planStep,
  resolveTarget,
  runRefactorCycle,
  selectCandidate,
  fetchRefactorVaultFeedback,
};
