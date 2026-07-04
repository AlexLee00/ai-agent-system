// @ts-nocheck
'use strict';

const gitOps = require('./git-ops.ts');
const {
  protectedTargetMatches,
} = require('./protected-targets.ts');
const {
  buildCycleBudgetReport,
} = require('../../hub/lib/llm/cycle-budget.ts');

const DEFAULT_PR_MERGE_THRESHOLD = 90;
const SELF_TRIGGER_PATTERNS = [
  /^github-actions\[bot\]$/i,
  /^claude(?:$|[-_\s\[])/i,
  /^codex(?:$|[-_\s\[])/i,
];

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeChangedFiles(files = []) {
  return (Array.isArray(files) ? files : [files])
    .map((file) => String(file || '').replace(/\\/g, '/').replace(/^\.\//, '').trim())
    .filter(Boolean);
}

function isSelfTriggerActor(actor = '') {
  const normalized = String(actor || '').trim();
  return Boolean(normalized && SELF_TRIGGER_PATTERNS.some((pattern) => pattern.test(normalized)));
}

function thresholdValue(input = {}) {
  return Math.max(1, Math.floor(n(input.threshold ?? process.env.CLAUDE_PR_MERGE_THRESHOLD, DEFAULT_PR_MERGE_THRESHOLD)));
}

function budgetBlockers(report = null, maxBudgetUsd = null) {
  const blockers = [];
  if (!report || report.skipped) return blockers;
  for (const blocker of report.blockers || []) {
    blockers.push({ ...blocker, source: 'cycle_budget' });
  }
  const limit = n(maxBudgetUsd, 0);
  const costUsd = n(report.metrics?.costUsd, 0);
  if (limit > 0 && costUsd > limit) {
    blockers.push({ type: 'max_budget_usd', costUsd, limit, source: 'pr_automerge_gate' });
  }
  return blockers;
}

function buildPrAutomergeAlert(result = {}, input = {}) {
  if (!result.blockedReason) return null;
  return {
    from_bot: 'claude-pr-automerge-gate',
    team: 'claude',
    event_type: 'pr_automerge_gate',
    alert_level: result.blockedReason === 'blocked_protected' ? 3 : 2,
    message: [
      `Claude PR automerge blocked: ${result.blockedReason}`,
      `pr: ${input.prNumber || 'unknown'}`,
      `score: ${result.audit?.score ?? 'n/a'}`,
      `ci_green: ${result.audit?.ciGreen ?? 'n/a'}`,
    ].join('\n'),
    payload: {
      prNumber: input.prNumber || null,
      verdict: result.verdict,
      blockedReason: result.blockedReason,
      protectedMatches: result.protectedMatches || [],
      budgetBlockers: result.budgetBlockers || [],
      actor: input.actor || null,
      cycleId: input.cycleId || null,
    },
  };
}

async function maybeNotify(result, input, deps = {}) {
  const alert = buildPrAutomergeAlert(result, input);
  if (!alert || typeof deps.notifyFn !== 'function') return { alert, notify: { skipped: true, reason: 'notify_fn_missing' } };
  try {
    const sent = await deps.notifyFn(alert);
    return { alert, notify: { ok: true, sent } };
  } catch (error) {
    return { alert, notify: { ok: false, error: String(error?.message || error).slice(0, 500) } };
  }
}

function baseResult(input = {}, extra = {}) {
  const files = normalizeChangedFiles(input.changedFiles || input.files);
  const threshold = thresholdValue(input);
  return {
    ok: true,
    verdict: extra.verdict || 'blocked',
    mergeEligible: false,
    blockedReason: extra.blockedReason || null,
    protectedMatches: extra.protectedMatches || [],
    budgetBlockers: extra.budgetBlockers || [],
    mergeResult: null,
    audit: {
      source: 'claude_pr_automerge_gate',
      prNumber: input.prNumber || null,
      actor: input.actor || null,
      cycleId: input.cycleId || null,
      changedFiles: files,
      score: n(input.score ?? input.totalScore, 0),
      threshold,
      ciGreen: input.ciGreen === true,
      selfApprovalSeparated: true,
      mergeExecutor: 'claude-pr-automerge-gate',
      scorer: input.scorer || input.scoredBy || null,
      liveMutation: false,
      ...extra.audit,
    },
  };
}

async function resolveBudgetReport(input = {}, deps = {}) {
  if (input.cycleBudgetReport) return input.cycleBudgetReport;
  if (!input.cycleId) return null;
  const fn = deps.buildCycleBudgetReportFn || buildCycleBudgetReport;
  return await fn(input.cycleId);
}

async function finalizeBlocked(result, input, deps) {
  const notification = await maybeNotify(result, input, deps);
  return {
    ...result,
    alert: notification.alert,
    notify: notification.notify,
  };
}

async function evaluatePrAutomergeGate(input = {}, deps = {}) {
  const files = normalizeChangedFiles(input.changedFiles || input.files);
  const protectedMatches = protectedTargetMatches(files);
  if (protectedMatches.length > 0) {
    return finalizeBlocked(baseResult(input, {
      verdict: 'blocked_protected',
      blockedReason: 'blocked_protected',
      protectedMatches,
      audit: { blockedAt: 'protected_targets' },
    }), input, deps);
  }

  if (isSelfTriggerActor(input.actor)) {
    return finalizeBlocked(baseResult(input, {
      verdict: 'blocked_self_trigger',
      blockedReason: 'blocked_self_trigger',
      audit: { blockedAt: 'self_trigger_actor' },
    }), input, deps);
  }

  const cycleBudgetReport = await resolveBudgetReport(input, deps);
  const blockers = budgetBlockers(cycleBudgetReport, input.maxBudgetUsd);
  if (blockers.length > 0) {
    return finalizeBlocked(baseResult(input, {
      verdict: 'blocked_budget',
      blockedReason: 'blocked_budget',
      budgetBlockers: blockers,
      audit: { blockedAt: 'budget', cycleBudget: cycleBudgetReport },
    }), input, deps);
  }

  const score = n(input.score ?? input.totalScore, 0);
  const threshold = thresholdValue(input);
  if (score < threshold) {
    return finalizeBlocked(baseResult(input, {
      verdict: 'blocked_threshold',
      blockedReason: 'blocked_threshold',
      audit: { blockedAt: 'threshold' },
    }), input, deps);
  }

  if (input.ciGreen !== true) {
    return finalizeBlocked(baseResult(input, {
      verdict: 'blocked_ci',
      blockedReason: 'blocked_ci',
      audit: { blockedAt: 'ci' },
    }), input, deps);
  }

  const prNumber = Math.floor(n(input.prNumber, 0));
  if (!prNumber) {
    return finalizeBlocked(baseResult(input, {
      verdict: 'blocked_missing_pr_number',
      blockedReason: 'blocked_missing_pr_number',
      audit: { blockedAt: 'pr_number' },
    }), input, deps);
  }

  const mergeFn = deps.mergePR || gitOps.mergePR;
  const mergeResult = await mergeFn(prNumber, { method: input.method || 'squash' }, deps.ghFn || deps.ghOptions || {});
  const mergeFailed = mergeResult?.ok === false;
  const result = {
    ...baseResult(input, {
      verdict: mergeFailed ? 'merge_failed' : (mergeResult?.merged ? 'merged' : 'merge_noop'),
      blockedReason: mergeFailed ? 'merge_failed' : null,
      audit: {
        mergeAttempted: true,
        blockedAt: mergeFailed ? 'merge_execution' : null,
        cycleBudget: cycleBudgetReport,
      },
    }),
    mergeEligible: true,
    mergeResult,
    audit: {
      ...baseResult(input).audit,
      mergeAttempted: true,
      cycleBudget: cycleBudgetReport,
      liveMutation: Boolean(mergeResult?.merged),
    },
  };
  if (mergeFailed) return finalizeBlocked(result, input, deps);
  return result;
}

async function maybeCreateRollbackRevertPR(input = {}, deps = {}) {
  if (!input.mergeResult?.merged) {
    return { ok: true, skipped: true, reason: 'merge_not_applied' };
  }
  if (!input.postMergeFailure) {
    return { ok: true, skipped: true, reason: 'post_merge_failure_missing' };
  }
  const createRevertPR = deps.createRevertPR || gitOps.createRevertPR;
  return createRevertPR({
    mergeCommit: input.mergeCommit,
    branch: input.branch,
    base: input.base || 'main',
    title: input.title,
    body: input.body,
    reason: input.reason || input.postMergeFailure?.reason || 'post_merge_failure',
  }, deps.gitOps || deps);
}

module.exports = {
  DEFAULT_PR_MERGE_THRESHOLD,
  SELF_TRIGGER_PATTERNS,
  normalizeChangedFiles,
  isSelfTriggerActor,
  budgetBlockers,
  buildPrAutomergeAlert,
  evaluatePrAutomergeGate,
  maybeCreateRollbackRevertPR,
};
