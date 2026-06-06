#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * Phase 1 refactorer cycle runner.
 *
 * Safe contract:
 * - default mode is off
 * - shadow mode runs analyze + plan only
 * - active mode is explicitly blocked until a later phase
 */

process.env.PG_DIRECT = process.env.PG_DIRECT || 'true';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const env = require('../../../packages/core/lib/env');
const { writeClaudeHeartbeat, errorHeartbeatMeta } = require('../lib/agent-heartbeat');
const { recordAutoDevOutcome } = require('../lib/auto-dev-pipeline');

const ROOT = env.PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..');
const DEFAULT_TARGET = 'bots/claude';
const DEFAULT_REFACTOR_TYPE = 'ts_nocheck';
const DEFAULT_MCP_BASE = process.env.REFACTOR_MCP_URL || 'http://localhost:8774';
const PLAN_DIR = path.join(ROOT, 'docs', 'codex', 'refactor-plans');
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

function normalizeCycleMode(value = process.env.REFACTORER_CYCLE_MODE) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'shadow' || normalized === 'active') return normalized;
  return 'off';
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

async function recordRefactorOutcome(context, result) {
  if (context.noWriteOutcome) return { ok: true, skipped: true, reason: 'no_write_outcome' };
  if (typeof recordAutoDevOutcome !== 'function') return { ok: false, skipped: true, reason: 'missing_recordAutoDevOutcome' };
  return recordAutoDevOutcome({
    id: context.cycleId,
    relPath: result.plan?.relPath || `docs/codex/refactor-plans/${context.cycleId}.md`,
    stage: 'refactor_shadow_plan',
    profile: 'refactor-shadow',
    targetTeam: 'claude',
    writeScope: [context.target.relativePath],
    riskTier: 'normal',
    reason: 'refactor-cycle-shadow',
  }, result.ok ? 'completed' : 'failed', {
    stage: 'refactor_shadow_plan',
    attempts: 1,
    testPass: null,
    durationMs: Date.now() - context.startedAtMs,
    kind: 'refactor',
    refactorType: result.plan?.candidate?.refactorType || context.refactorType,
    cycleId: context.cycleId,
    source: 'claude-refactorer',
    meta: {
      kind: 'refactor',
      refactorType: result.plan?.candidate?.refactorType || context.refactorType,
      cycleId: context.cycleId,
      mode: context.mode,
      target: context.target.relativePath,
      planPath: result.plan?.relPath || null,
      analysisSource: result.analysis?.source || null,
      vaultFeedbackOk: result.plan?.vaultFeedback?.ok ?? null,
      vaultFeedbackCount: Array.isArray(result.plan?.vaultFeedback?.results) ? result.plan.vaultFeedback.results.length : 0,
      phase: 'phase1',
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
  const cycleId = `refactor-${nowIso().replace(/[-:TZ.]/g, '').slice(0, 12)}-${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 8)}`;
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
      const result = { ok: false, blocked: true, reason: 'active_not_implemented_phase1', mode: context.mode };
      result.heartbeat = await writeRefactorHeartbeat(context, 'error', { stage: 'blocked', reason: result.reason });
      return result;
    }

    const analysis = await analyzeStep(context);
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
  isProtectedTarget,
  normalizeCycleMode,
  parseArgs,
  planStep,
  resolveTarget,
  runRefactorCycle,
  selectCandidate,
  fetchRefactorVaultFeedback,
};
