'use strict';

/**
 * 다윈 연구 제안서 저장소
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const env: { PROJECT_ROOT: string } = require('../../../packages/core/lib/env');
const { validateSuccessPredicate }: {
  validateSuccessPredicate: (raw: unknown) => { ok: boolean };
} = require('./success-predicate.ts');

interface ProposalRecord {
  id: string;
  status?: string;
  updated_at?: string;
  arxiv_id?: string;
  title?: string;
  created_at?: string;
  implementation_started_at?: string;
  state_transitions?: ProposalTransition[];
  [key: string]: unknown;
}

type ProposalLifecycleState = 'proposed' | 'implementing' | 'measured' | 'adopted' | 'archived';

interface ProposalTransition {
  from: ProposalLifecycleState;
  to: ProposalLifecycleState;
  from_status: string;
  at: string;
  evidence: Record<string, unknown>;
}

interface TriageAction {
  id: string;
  file: string;
  previousStatus: string;
  state: ProposalLifecycleState;
  to: 'archived';
  reason: 'triage_stale' | 'triage_unstarted';
  ageDays: number;
  anchorField: string;
  anchorAt: string;
}

const SANDBOX_DIR = path.join(env.PROJECT_ROOT, 'bots/darwin/sandbox/prototypes');
const PROPOSALS_DIR = path.join(env.PROJECT_ROOT, 'docs/research/proposals');

function ensureDirs() {
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
  return { sandboxDir: SANDBOX_DIR, proposalsDir: PROPOSALS_DIR };
}

function buildProposalId(paper: { arxiv_id?: string; title?: string }): string {
  const safeId = String(paper.arxiv_id || paper.title || 'proposal')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160);
  return `${safeId || 'proposal'}_${Date.now()}`;
}

function validateProposalId(proposalId: unknown): string {
  const value = String(proposalId || '').trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,199}$/u.test(value) || value.includes('..')) {
    throw new Error(`invalid_proposal_id:${value}`);
  }
  return value;
}

function saveProposal(proposalData: ProposalRecord): string {
  ensureDirs();
  const proposalId = validateProposalId(proposalData.id);
  const proposalFile = path.join(PROPOSALS_DIR, `${proposalId}.json`);
  fs.writeFileSync(proposalFile, JSON.stringify(proposalData, null, 2), 'utf8');
  return proposalFile;
}

function _findProposalFile(proposalId: string): string | null {
  ensureDirs();
  const safeProposalId = validateProposalId(proposalId);
  const exact = path.join(PROPOSALS_DIR, `${safeProposalId}.json`);
  if (fs.existsSync(exact)) return exact;
  return null;
}

function loadProposal(proposalId: string): ProposalRecord | null {
  const proposalFile = _findProposalFile(proposalId);
  if (!proposalFile) return null;
  return JSON.parse(fs.readFileSync(proposalFile, 'utf8')) as ProposalRecord;
}

function normalizeProposalState(status: unknown): ProposalLifecycleState {
  const value = String(status || '').trim();
  if (value === 'implementing' || value === 'verifying') return 'implementing';
  if (value === 'measured' || value === 'implemented' || value === 'verified') return 'measured';
  if (value === 'adopted' || value === 'merged') return 'adopted';
  if (
    value === 'archived'
    || value === 'needs_review'
    || value === 'manual_review'
    || value === 'rejected'
    || value === 'implementation_failed'
    || value === 'verification_failed'
  ) return 'archived';
  return 'proposed';
}

function normalizedPaperKey(paper: { arxiv_id?: unknown; title?: unknown } = {}): string {
  const arxivId = String(paper.arxiv_id || '').trim().replace(/v\d+$/i, '').toLowerCase();
  if (arxivId) return `arxiv:${arxivId}`;
  const title = String(paper.title || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return title ? `title:${title}` : '';
}

function findActiveProposalForPaper(paper: { arxiv_id?: unknown; title?: unknown }): (ProposalRecord & { __file: string }) | null {
  const key = normalizedPaperKey(paper);
  if (!key) return null;
  return listProposals()
    .filter((proposal) => normalizeProposalState(proposal.status) !== 'archived')
    .filter((proposal) => normalizedPaperKey({ arxiv_id: proposal.arxiv_id, title: proposal.title }) === key)
    .sort((left, right) => {
      const rightAt = Date.parse(String(right.updated_at || right.created_at || ''));
      const leftAt = Date.parse(String(left.updated_at || left.created_at || ''));
      return (Number.isFinite(rightAt) ? rightAt : 0) - (Number.isFinite(leftAt) ? leftAt : 0);
    })[0] || null;
}

function isTransitionAllowed(from: ProposalLifecycleState, to: ProposalLifecycleState): boolean {
  if (from === to) return true;
  const allowed: Record<ProposalLifecycleState, ProposalLifecycleState[]> = {
    proposed: ['implementing', 'archived'],
    implementing: ['measured', 'archived'],
    measured: ['adopted', 'archived'],
    adopted: [],
    archived: [],
  };
  return allowed[from].includes(to);
}

function transitionEvidenceErrors(proposal: ProposalRecord, to: ProposalLifecycleState, evidence: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (to === 'implementing') {
    const branch = String(evidence.branch || proposal.branch || '').trim();
    if (!branch) errors.push('branch_missing');
    if (!validateSuccessPredicate(proposal.successPredicate).ok) errors.push('success_predicate_invalid');
  }
  if (to === 'measured') {
    const results = Array.isArray(evidence.predicate_results) ? evidence.predicate_results as Array<Record<string, unknown>> : [];
    const predicate = proposal.successPredicate && typeof proposal.successPredicate === 'object'
      ? proposal.successPredicate as Record<string, unknown>
      : {};
    const assertions = Array.isArray(predicate.assertions) ? predicate.assertions : [];
    const resultsMatchAssertions = results.length === assertions.length
      && results.every((result, index) => {
        const assertion = assertions[index] && typeof assertions[index] === 'object'
          ? assertions[index] as Record<string, unknown>
          : {};
        return result?.ok === true && String(result?.name || '') === String(assertion.name || '');
      });
    if (results.length === 0 || !resultsMatchAssertions) {
      errors.push('predicate_results_incomplete');
    }
  }
  if (to === 'adopted') {
    if (!evidence.pr_number && !evidence.pr_url) errors.push('adopt_pr_evidence_missing');
  }
  return errors;
}

function transitionProposal(
  proposalId: string,
  to: ProposalLifecycleState,
  evidence: Record<string, unknown> = {}
): ProposalRecord | null {
  const proposalFile = _findProposalFile(proposalId);
  if (!proposalFile) return null;
  const proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8')) as ProposalRecord;
  const fromStatus = String(proposal.status || 'proposed');
  const from = normalizeProposalState(fromStatus);
  if (!isTransitionAllowed(from, to)) {
    throw new Error(`invalid_proposal_transition:${proposalId}:${from}->${to}`);
  }
  const evidenceErrors = transitionEvidenceErrors(proposal, to, evidence || {});
  if (evidenceErrors.length > 0) {
    throw new Error(`proposal_transition_evidence_invalid:${proposalId}:${to}:${evidenceErrors.join(',')}`);
  }

  const now = new Date().toISOString();
  const { status: _ignoredStatus, ...safeEvidence } = evidence || {};
  Object.assign(proposal, safeEvidence);
  proposal.status = to;
  proposal.updated_at = now;
  proposal.state_transitions = Array.isArray(proposal.state_transitions) ? proposal.state_transitions : [];
  proposal.state_transitions.push({
    from,
    to,
    from_status: fromStatus,
    at: now,
    evidence: safeEvidence,
  });

  if (to === 'measured') {
    proposal.measured_at = proposal.measured_at || now;
    proposal.measurement = {
      ...(proposal.measurement && typeof proposal.measurement === 'object' ? proposal.measurement as Record<string, unknown> : {}),
      predicate_results: Array.isArray((safeEvidence as { predicate_results?: unknown }).predicate_results)
        ? (safeEvidence as { predicate_results: unknown[] }).predicate_results
        : [],
      metrics_evidence: Array.isArray((safeEvidence as { metrics_evidence?: unknown }).metrics_evidence)
        ? (safeEvidence as { metrics_evidence: unknown[] }).metrics_evidence
        : [],
      budget: safeEvidence.budget || (proposal.measurement && typeof proposal.measurement === 'object'
        ? (proposal.measurement as Record<string, unknown>).budget
        : null),
      pending_d3_predicate: !Array.isArray((safeEvidence as { predicate_results?: unknown }).predicate_results)
        || (safeEvidence as { predicate_results: unknown[] }).predicate_results.length === 0,
      updated_at: now,
    };
  }

  if (to === 'archived') {
    proposal.archived_at = proposal.archived_at || now;
    proposal.archive_reason = String(safeEvidence.reason || proposal.archive_reason || 'archived');
  }

  if (to === 'adopted') {
    proposal.adopted_at = proposal.adopted_at || now;
  }

  fs.writeFileSync(proposalFile, JSON.stringify(proposal, null, 2), 'utf8');
  if (to === 'adopted' || to === 'archived') {
    try {
      const sigmaHook = require('./sigma-findings-hook.ts');
      Promise.resolve(
        sigmaHook.contributeSigmaFinding(proposal, to, {
          transition: {
            from,
            to,
            from_status: fromStatus,
            evidence: safeEvidence,
          },
        })
      ).catch(() => null);
    } catch {
      // Sigma hook is advisory; proposal lifecycle must not depend on it.
    }
  }
  return proposal;
}

function _listProposalFiles(): string[] {
  ensureDirs();
  return fs.readdirSync(PROPOSALS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.join(PROPOSALS_DIR, file));
}

function listProposals(): Array<ProposalRecord & { __file: string }> {
  return _listProposalFiles().flatMap((filePath) => {
    try {
      const proposal = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ProposalRecord;
      return [{ ...proposal, __file: filePath }];
    } catch {
      return [];
    }
  });
}

function auditProposalConsistency(options: { now?: Date | string | number; staleHours?: number } = {}) {
  const proposals = listProposals();
  const nowMs = options.now == null ? Date.now() : new Date(options.now).getTime();
  const staleHours = Number.isFinite(Number(options.staleHours)) && Number(options.staleHours) > 0
    ? Number(options.staleHours)
    : 24;
  const activeByPaper = new Map<string, Array<ProposalRecord & { __file: string }>>();
  const implementingWithoutBranch: Array<Record<string, unknown>> = [];
  const staleImplementations: Array<Record<string, unknown>> = [];

  for (const proposal of proposals) {
    const state = normalizeProposalState(proposal.status);
    if (state !== 'archived') {
      const paperKey = normalizedPaperKey({ arxiv_id: proposal.arxiv_id, title: proposal.title });
      if (paperKey) activeByPaper.set(paperKey, [...(activeByPaper.get(paperKey) || []), proposal]);
    }
    if (state !== 'implementing') continue;
    if (!String(proposal.branch || '').trim()) {
      implementingWithoutBranch.push({ id: proposal.id, status: proposal.status || null });
    }
    const anchor = String(
      proposal.implementation_progress_at
      || proposal.implemented_at
      || proposal.verification_started_at
      || proposal.implementation_started_at
      || proposal.updated_at
      || proposal.created_at
      || ''
    );
    const anchorMs = Date.parse(anchor);
    const ageHours = Number.isFinite(anchorMs) ? Math.floor((nowMs - anchorMs) / 3_600_000) : null;
    if (ageHours !== null && ageHours > staleHours) {
      staleImplementations.push({ id: proposal.id, branch: proposal.branch || null, anchorAt: anchor, ageHours });
    }
  }

  const activeDuplicatePapers = Array.from(activeByPaper.entries())
    .filter(([, items]) => items.length > 1)
    .map(([paperKey, items]) => ({
      paperKey,
      count: items.length,
      proposalIds: items.map((item) => item.id),
    }));
  return {
    ok: true,
    staleHours,
    activeDuplicatePapers,
    implementingWithoutBranch,
    staleImplementations,
  };
}

function _ageDays(nowMs: number, at: string): number {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return 0;
  return Math.floor((nowMs - time) / 86_400_000);
}

function _anchorForTriage(proposal: ProposalRecord, state: ProposalLifecycleState): { field: string; value: string } | null {
  if (state === 'implementing') {
    const value = proposal.implementation_started_at || proposal.updated_at || proposal.created_at;
    if (!value) return null;
    return {
      field: proposal.implementation_started_at ? 'implementation_started_at' : proposal.updated_at ? 'updated_at' : 'created_at',
      value,
    };
  }
  if (state === 'proposed') {
    const value = proposal.created_at || proposal.updated_at;
    if (!value) return null;
    return {
      field: proposal.created_at ? 'created_at' : 'updated_at',
      value,
    };
  }
  return null;
}

function planProposalTriage(options: { now?: Date | string | number } = {}): TriageAction[] {
  const nowMs = options.now == null ? Date.now() : new Date(options.now).getTime();
  const actions: TriageAction[] = [];
  for (const proposal of listProposals()) {
    const previousStatus = String(proposal.status || 'proposed');
    const state = normalizeProposalState(previousStatus);
    if (state !== 'implementing' && state !== 'proposed') continue;
    const anchor = _anchorForTriage(proposal, state);
    if (!anchor) continue;
    const ageMs = nowMs - Date.parse(anchor.value);
    if (!Number.isFinite(ageMs)) continue;

    const thresholdMs = state === 'implementing' ? 14 * 86_400_000 : 21 * 86_400_000;
    if (ageMs <= thresholdMs) continue;
    const reason = state === 'implementing' ? 'triage_stale' : 'triage_unstarted';
    actions.push({
      id: proposal.id,
      file: proposal.__file,
      previousStatus,
      state,
      to: 'archived',
      reason,
      ageDays: _ageDays(nowMs, anchor.value),
      anchorField: anchor.field,
      anchorAt: anchor.value,
    });
  }
  return actions;
}

function runProposalTriage(options: { dryRun?: boolean; now?: Date | string | number } = {}) {
  const actions = planProposalTriage({ now: options.now });
  if (!options.dryRun) {
    for (const action of actions) {
      transitionProposal(action.id, 'archived', {
        reason: action.reason,
        triage: {
          previous_status: action.previousStatus,
          previous_state: action.state,
          age_days: action.ageDays,
          anchor_field: action.anchorField,
          anchor_at: action.anchorAt,
        },
      });
    }
  }
  return {
    ok: true,
    dryRun: Boolean(options.dryRun),
    archived: options.dryRun ? 0 : actions.length,
    actions,
  };
}

function updateStatus(
  proposalId: string,
  status: string,
  extra: Record<string, unknown> = {}
): ProposalRecord | null {
  const proposalFile = _findProposalFile(proposalId);
  if (!proposalFile) return null;
  const proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8')) as ProposalRecord;
  const from = normalizeProposalState(proposal.status);
  const to = normalizeProposalState(status);
  if (from !== to) {
    throw new Error(`proposal_lifecycle_transition_requires_transitionProposal:${proposalId}:${from}->${to}`);
  }
  proposal.status = status;
  proposal.updated_at = new Date().toISOString();
  Object.assign(proposal, extra || {});
  fs.writeFileSync(proposalFile, JSON.stringify(proposal, null, 2), 'utf8');
  return proposal;
}

module.exports = {
  SANDBOX_DIR,
  PROPOSALS_DIR,
  ensureDirs,
  buildProposalId,
  validateProposalId,
  normalizedPaperKey,
  findActiveProposalForPaper,
  saveProposal,
  loadProposal,
  updateStatus,
  transitionProposal,
  normalizeProposalState,
  isTransitionAllowed,
  listProposals,
  auditProposalConsistency,
  planProposalTriage,
  runProposalTriage,
};
