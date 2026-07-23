'use strict';

const path: typeof import('path') = require('path');
const { execFileSync }: typeof import('child_process') = require('child_process');
const env: { PROJECT_ROOT: string } = require('../../../packages/core/lib/env');
const proposalStore = require('./proposal-store.ts');
const { createLab, removeLab } = require('./worktree-lab.ts');
const gitOps = require('../../claude/lib/git-ops.ts');

interface ProposalRecord {
  id: string;
  title?: string;
  status?: string;
  branch?: string;
  korean_summary?: string;
  proposal?: string;
  successPredicate?: Record<string, unknown>;
  measurement?: Record<string, unknown>;
  changed_files?: string[];
  files?: string[];
  [key: string]: unknown;
}

interface AdoptCandidate {
  proposal: ProposalRecord;
  changedFiles: string[];
  predicateResults: Array<Record<string, unknown>>;
  blocked: boolean;
  blockedReason: string | null;
  denylistMatches: Array<{ file: string; pattern: string }>;
}

const DEFAULT_WEEKLY_CAP = 2;
const DEFAULT_CLAUDE_REFACTOR_MCP = 'http://127.0.0.1:8774';
const DEFAULT_DENYLIST = [
  'bots/investment/**',
  'bots/reservation/**',
  'bots/hub/**',
  'scripts/deploy*',
  '**/launchd/**',
  '*.plist',
];

function runGit(args: string[], cwd = env.PROJECT_ROOT): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  }).trim();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readDenylist(envObj: NodeJS.ProcessEnv = process.env): string[] {
  const extra = String(envObj.DARWIN_ADOPT_DENYLIST || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return [...DEFAULT_DENYLIST, ...extra];
}

function readWeeklyCap(envObj: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(envObj.DARWIN_ADOPT_WEEKLY_CAP);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_WEEKLY_CAP;
}

function normalizeFile(file: unknown): string {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchesPattern(file: string, pattern: string): boolean {
  const normalized = normalizeFile(file);
  if (pattern === '*.plist') return normalized.endsWith('.plist');
  if (pattern === '**/launchd/**') return normalized.includes('/launchd/') || normalized.startsWith('launchd/');
  if (pattern.endsWith('/**')) return normalized.startsWith(pattern.slice(0, -3));
  if (pattern.endsWith('*')) return normalized.startsWith(pattern.slice(0, -1));
  return normalized === pattern || normalized.startsWith(`${pattern}/`);
}

function findDenylistMatches(files: string[], patterns = readDenylist()) {
  const matches: Array<{ file: string; pattern: string }> = [];
  for (const file of files.map(normalizeFile).filter(Boolean)) {
    const hit = patterns.find((pattern) => matchesPattern(file, pattern));
    if (hit) matches.push({ file, pattern: hit });
  }
  return matches;
}

function getChangedFiles(proposal: ProposalRecord): string[] {
  const files = [
    ...asArray(proposal.changed_files),
    ...asArray(proposal.files),
    ...asArray((proposal.measurement || {}).files),
  ].map(normalizeFile).filter(Boolean);
  return Array.from(new Set(files));
}

function getPredicateResults(proposal: ProposalRecord): Array<Record<string, unknown>> {
  const measurement = proposal.measurement && typeof proposal.measurement === 'object' ? proposal.measurement : {};
  return asArray((measurement as Record<string, unknown>).predicate_results)
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item));
}

function budgetWithin(proposal: ProposalRecord): boolean {
  const measurement = proposal.measurement && typeof proposal.measurement === 'object' ? proposal.measurement as Record<string, unknown> : {};
  const budget = measurement.budget && typeof measurement.budget === 'object' ? measurement.budget as Record<string, unknown> : {};
  return budget.withinWallBudget !== false && budget.withinLlmBudget !== false;
}

function evaluateAdoptCandidate(proposal: ProposalRecord, patterns = readDenylist()): AdoptCandidate {
  const changedFiles = getChangedFiles(proposal);
  const predicateResults = getPredicateResults(proposal);
  const denylistMatches = findDenylistMatches(changedFiles, patterns);
  let blockedReason: string | null = null;
  if (proposalStore.normalizeProposalState(proposal.status) !== 'measured') blockedReason = 'not_measured';
  else if (!proposal.branch) blockedReason = 'branch_missing';
  else if (changedFiles.length === 0) blockedReason = 'changed_files_missing';
  else if (predicateResults.length === 0 || predicateResults.some((item) => item.ok !== true)) blockedReason = 'predicate_not_all_passed';
  else if (!budgetWithin(proposal)) blockedReason = 'budget_exceeded';
  else if (denylistMatches.length > 0) blockedReason = 'denylist_match';
  return {
    proposal,
    changedFiles,
    predicateResults,
    blocked: blockedReason !== null,
    blockedReason,
    denylistMatches,
  };
}

function selectAdoptCandidates(options: { cap?: number; proposals?: ProposalRecord[]; env?: NodeJS.ProcessEnv } = {}) {
  const patterns = readDenylist(options.env);
  const cap = options.cap || readWeeklyCap(options.env);
  const proposals: ProposalRecord[] = options.proposals || proposalStore.listProposals();
  const evaluated: AdoptCandidate[] = proposals.map((proposal: ProposalRecord) => evaluateAdoptCandidate(proposal, patterns));
  const candidates = evaluated.filter((item: AdoptCandidate) => !item.blocked).slice(0, cap);
  return {
    ok: true,
    cap,
    denylist: patterns,
    total: evaluated.length,
    candidates,
    blocked: evaluated.filter((item: AdoptCandidate) => item.blocked),
  };
}

function buildPrSpec(candidate: AdoptCandidate, branchName: string) {
  const proposal = candidate.proposal;
  const title = `darwin: adopt ${String(proposal.title || proposal.id || '').slice(0, 80)}`;
  const metric = proposal.successPredicate?.targetMetric || {};
  const body = [
    '# Darwin Findings',
    '',
    `Proposal: ${proposal.id}`,
    `Source branch: ${proposal.branch}`,
    '',
    '## Korean Summary',
    String(proposal.korean_summary || proposal.title || '').slice(0, 1400),
    '',
    '## Predicate Evidence',
    `- assertions: ${candidate.predicateResults.length}`,
    `- passed: ${candidate.predicateResults.filter((item) => item.ok === true).length}`,
    `- target metric: ${String((metric as any).description || 'N/A')}`,
    `- metric source: ${String((metric as any).source || 'N/A')}`,
    '',
    '## Changed Files',
    ...candidate.changedFiles.map((file) => `- ${file}`),
    '',
    'Merge is master-gated. Darwin does not auto-merge this PR.',
  ].join('\n');
  return {
    title,
    body,
    head: branchName,
    base: 'main',
  };
}

function createAdoptBranchName(proposalId: string): string {
  return `darwin-adopt/${String(proposalId || 'unknown').replace(/[^A-Za-z0-9._/-]+/g, '-').slice(0, 96)}`;
}

function passField(value: unknown): boolean {
  if (value === true) return true;
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.ok === true || record.pass === true || ['pass', 'passed', 'ok', 'success'].includes(String(record.status || '').toLowerCase());
}

function buildClaudeQualityGateInput(candidate: AdoptCandidate, pr: Record<string, unknown>) {
  const proposal = candidate.proposal;
  const syntaxChecks = asArray(proposal.syntax_checks)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  const verification = proposal.verification_report && typeof proposal.verification_report === 'object'
    ? proposal.verification_report as Record<string, unknown>
    : {};
  const builderOk = proposal.syntax_passed === true
    && syntaxChecks.length > 0
    && syntaxChecks.every((item) => item.ok === true);
  const reviewerOk = ['syntax', 'style', 'diff'].every((key) => passField(verification[key]));
  const guardianOk = passField(verification.security) && candidate.denylistMatches.length === 0;
  return {
    prNumber: pr.number,
    files: candidate.changedFiles,
    builder: { ok: builderOk, checks: syntaxChecks.length },
    reviewer: { ok: reviewerOk },
    guardian: { ok: guardianOk },
    test_runner: {
      ok: candidate.predicateResults.length > 0 && candidate.predicateResults.every((item) => item.ok === true),
      total: candidate.predicateResults.length,
      failed: candidate.predicateResults.filter((item) => item.ok !== true).length,
    },
    task: {
      id: proposal.id,
      files: candidate.changedFiles,
      prNumber: pr.number,
    },
  };
}

function qualityGateOutput(raw: unknown): Record<string, unknown> {
  let current = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  for (const key of ['result', 'output', 'score']) {
    const nested = current[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const record = nested as Record<string, unknown>;
      if (record.status || record.verdict || record.pass !== undefined) return qualityGateOutput(record);
    }
  }
  return current;
}

function isClaudeQualityGateApproved(raw: unknown): boolean {
  const root = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const output = qualityGateOutput(root);
  return root.ok !== false
    && output.ok !== false
    && output.pass === true
    && output.status === 'promotion_ready'
    && output.verdict === 'approve_candidate';
}

function validateActualAdoptDiff(candidate: AdoptCandidate, actualFiles: string[]) {
  const actual = Array.from(new Set(actualFiles.map(normalizeFile).filter(Boolean))).sort();
  const denylistMatches = findDenylistMatches(actual);
  if (denylistMatches.length > 0) {
    return { ok: false, reason: 'actual_diff_denylist_match', actualFiles: actual, denylistMatches };
  }
  const expected = [...candidate.changedFiles].map(normalizeFile).filter(Boolean).sort();
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    return { ok: false, reason: 'actual_diff_metadata_mismatch', actualFiles: actual, expectedFiles: expected, denylistMatches: [] };
  }
  return { ok: true, reason: null, actualFiles: actual, expectedFiles: expected, denylistMatches: [] };
}

async function callClaudeQualityGate(
  candidate: AdoptCandidate,
  pr: Record<string, unknown>,
  prSpec: ReturnType<typeof buildPrSpec>,
  options: { baseUrl?: string; fetchFn?: typeof fetch; runGh?: typeof gitOps.runGh } = {}
) {
  const baseUrl = options.baseUrl || process.env.DARWIN_CLAUDE_REFACTOR_MCP_URL || DEFAULT_CLAUDE_REFACTOR_MCP;
  const fetchFn = options.fetchFn || fetch;
  const runGh = options.runGh || gitOps.runGh;
  try {
    const toolsRes = await fetchFn(`${baseUrl}/tools`, { signal: AbortSignal.timeout(5000) });
    const tools = await toolsRes.json();
    const names = Array.isArray(tools.tools) ? tools.tools.map((tool: Record<string, unknown>) => tool.name) : [];
    if (!toolsRes.ok || !names.includes('quality_gate')) {
      return { ok: false, skipped: true, reason: 'quality_gate_tool_unavailable' };
    }

    const scoreRes = await fetchFn(`${baseUrl}/tools/quality_gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildClaudeQualityGateInput(candidate, pr)),
      signal: AbortSignal.timeout(8000),
    });
    const score = await scoreRes.json();
    if (scoreRes.ok && pr.number) {
      try {
        runGh([
          'pr',
          'comment',
          String(pr.number),
          '--body',
          [
            'Darwin adopt quality gate:',
            '',
            `- verdict: ${score.verdict || score.output?.verdict || 'unknown'}`,
            `- totalScore: ${score.totalScore || score.output?.totalScore || 'unknown'}`,
            `- head: ${prSpec.head}`,
          ].join('\n'),
        ], { timeout: 30_000 });
      } catch {}
    }
    return { ok: scoreRes.ok, score };
  } catch (error) {
    return { ok: false, skipped: true, reason: 'quality_gate_call_failed', error: String((error as Error)?.message || error) };
  }
}

async function runAdoptForCandidate(
  candidate: AdoptCandidate,
  options: {
    enabled?: boolean;
    dryRun?: boolean;
    createPR?: typeof gitOps.createPR;
    pushHeadToBranch?: typeof gitOps.pushHeadToBranch;
    runGit?: typeof runGit;
    qualityGate?: (candidate: AdoptCandidate, pr: Record<string, unknown>, prSpec: ReturnType<typeof buildPrSpec>) => Promise<Record<string, unknown>>;
  } = {}
) {
  const enabled = options.enabled === true || process.env.DARWIN_ADOPT_ENABLED === 'true';
  const dryRun = options.dryRun !== false || !enabled;
  const runGitFn = options.runGit || runGit;
  if (candidate.blocked) {
    return {
      ok: false,
      dryRun,
      enabled,
      blocked: true,
      blockedReason: candidate.blockedReason,
      denylistMatches: candidate.denylistMatches,
    };
  }
  const branchName = createAdoptBranchName(candidate.proposal.id);
  const lab = createLab(branchName);
  let prSpec: ReturnType<typeof buildPrSpec> | null = null;
  try {
    runGitFn(['cherry-pick', String(candidate.proposal.branch)], lab.path);
    const actualFiles = String(runGitFn(['diff', '--name-only', 'main...HEAD'], lab.path) || '')
      .split('\n')
      .map((file) => file.trim())
      .filter(Boolean);
    const diffValidation = validateActualAdoptDiff(candidate, actualFiles);
    if (!diffValidation.ok) {
      return {
        ok: false,
        dryRun,
        enabled,
        blocked: true,
        blockedReason: diffValidation.reason,
        diffValidation,
      };
    }
    prSpec = buildPrSpec(candidate, branchName);
    if (dryRun) {
      return { ok: true, dryRun: true, enabled, labPath: lab.path, prSpec, pr: null, diffValidation };
    }
    const pushHeadToBranch = options.pushHeadToBranch || gitOps.pushHeadToBranch;
    const createPR = options.createPR || gitOps.createPR;
    pushHeadToBranch(branchName, { cwd: lab.path, timeout: 120_000 });
    const pr = createPR(prSpec, { cwd: lab.path, timeout: 120_000 });
    let claudeScoring: Record<string, unknown> | null = null;
    let adopted = false;
    if (pr?.ok === true) {
      const qualityGate = options.qualityGate || callClaudeQualityGate;
      claudeScoring = await qualityGate(candidate, pr, prSpec);
      if (isClaudeQualityGateApproved(claudeScoring)) {
        proposalStore.transitionProposal(candidate.proposal.id, 'adopted', {
          reason: 'adopt_pr_opened_quality_approved',
          adopted_via: 'darwin_adopt_pipeline',
          pr_number: pr.number || null,
          pr_url: pr.url || null,
          pr_head: prSpec.head,
          pr_base: prSpec.base,
          actual_changed_files: diffValidation.actualFiles,
          claude_scoring: claudeScoring,
        });
        adopted = true;
      }
    }
    return {
      ok: pr?.ok === true,
      adopted,
      dryRun: false,
      enabled,
      labPath: lab.path,
      prSpec,
      pr,
      diffValidation,
      claudeScoring,
    };
  } catch (error) {
    return {
      ok: false,
      dryRun,
      enabled,
      labPath: lab.path,
      prSpec,
      error: String((error as Error)?.message || error),
    };
  } finally {
    try { removeLab(lab.path); } catch {}
    try { runGitFn(['branch', '-D', branchName], env.PROJECT_ROOT); } catch {}
  }
}

module.exports = {
  DEFAULT_DENYLIST,
  DEFAULT_WEEKLY_CAP,
  readDenylist,
  readWeeklyCap,
  matchesPattern,
  findDenylistMatches,
  getChangedFiles,
  getPredicateResults,
  budgetWithin,
  evaluateAdoptCandidate,
  selectAdoptCandidates,
  buildPrSpec,
  createAdoptBranchName,
  buildClaudeQualityGateInput,
  isClaudeQualityGateApproved,
  validateActualAdoptDiff,
  callClaudeQualityGate,
  runAdoptForCandidate,
};
