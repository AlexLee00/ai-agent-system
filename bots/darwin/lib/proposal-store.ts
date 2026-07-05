'use strict';

/**
 * 다윈 연구 제안서 저장소
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const env: { PROJECT_ROOT: string } = require('../../../packages/core/lib/env');

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
    .replace(/[/.:\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${safeId}_${Date.now()}`;
}

function saveProposal(proposalData: ProposalRecord): string {
  ensureDirs();
  const proposalFile = path.join(PROPOSALS_DIR, `${proposalData.id}.json`);
  fs.writeFileSync(proposalFile, JSON.stringify(proposalData, null, 2), 'utf8');
  return proposalFile;
}

function _findProposalFile(proposalId: string): string | null {
  ensureDirs();
  const exact = path.join(PROPOSALS_DIR, `${proposalId}.json`);
  if (fs.existsSync(exact)) return exact;
  const files = fs.readdirSync(PROPOSALS_DIR).filter((file) => file.includes(proposalId));
  if (files.length === 0) return null;
  return path.join(PROPOSALS_DIR, files[0]);
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
    || value === 'implementation_failed'
    || value === 'verification_failed'
  ) return 'archived';
  return 'proposed';
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
      pending_d3_predicate: true,
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
  saveProposal,
  loadProposal,
  updateStatus,
  transitionProposal,
  normalizeProposalState,
  isTransitionAllowed,
  listProposals,
  planProposalTriage,
  runProposalTriage,
};
