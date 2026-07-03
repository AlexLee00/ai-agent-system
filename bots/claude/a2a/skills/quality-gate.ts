import { createRequire } from 'module';
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';
import { buildSafety, completed } from './symphony-common.ts';

const require = createRequire(__filename);
const { buildSymphonyValidationPlan } = require('../../lib/symphony/validation-adapter.ts');
const pgPool = require('../../../../packages/core/lib/pg-pool.js');
const { isProtectedTargetPath } = require('../../lib/protected-targets.ts');

const DEFAULT_PR_MERGE_THRESHOLD = 90;

function passValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object') {
    if ((value as any).pass !== undefined) return Boolean((value as any).pass);
    if ((value as any).ok !== undefined) return Boolean((value as any).ok);
    if ((value as any).status !== undefined) return ['pass', 'passed', 'ok', 'success'].includes(String((value as any).status).toLowerCase());
  }
  return false;
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function arr(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function protectedFiles(params: Record<string, unknown>): string[] {
  const files = [
    ...arr(params.files),
    ...arr(params.changedFiles),
    ...arr(params.writeScope),
    ...arr((params.task as any)?.files),
    ...arr((params.task as any)?.writeScope),
  ].map((file) => String(file || '').trim()).filter(Boolean);
  return files.filter((file) => isProtectedTargetPath(file));
}

function scoreBuilder(value: unknown): { score: number; blocking: boolean; reason: string | null } {
  const pass = passValue(value);
  return { score: pass ? 40 : 0, blocking: !pass, reason: pass ? null : 'builder_failed' };
}

function scoreReviewer(review: unknown, test: unknown): { score: number; blocking: boolean; reason: string | null } {
  const reviewPass = passValue(review);
  const testPass = passValue(test);
  const testObj = test && typeof test === 'object' ? test as any : {};
  const beforeFailures = num(testObj.before_failures ?? testObj.beforeFailures, 0);
  const afterFailures = num(testObj.after_failures ?? testObj.afterFailures, testPass ? 0 : 1);
  const regression = Boolean(testObj.regression) || afterFailures > beforeFailures;
  const total = Math.max(1, num(testObj.total ?? testObj.tests ?? testObj.after_tests ?? testObj.afterTests, 1));
  const failed = Math.max(0, num(testObj.failed ?? testObj.failures ?? afterFailures, testPass ? 0 : 1));
  const passRate = Math.max(0, Math.min(1, (total - failed) / total));
  let score = Math.round(35 * passRate);
  if (!reviewPass) score = Math.min(score, 12);
  if (regression) score = Math.max(0, score - 20);
  return { score, blocking: false, reason: regression ? 'test_regression' : null };
}

function countSeverity(value: unknown, key: string): number {
  if (!value || typeof value !== 'object') return 0;
  const obj = value as any;
  if (Array.isArray(obj[key])) return obj[key].length;
  return num(obj[key], 0);
}

function scoreGuardian(value: unknown): { score: number; blocking: boolean; reason: string | null } {
  const pass = passValue(value);
  const critical = countSeverity(value, 'critical');
  const high = countSeverity(value, 'high');
  const secrets = countSeverity(value, 'secrets') + countSeverity(value, 'secretFindings');
  const blocking = !pass || critical > 0 || secrets > 0;
  if (blocking) return { score: 0, blocking: true, reason: critical > 0 || secrets > 0 ? 'guardian_critical_or_secret' : 'guardian_failed' };
  return { score: high > 0 ? 10 : 25, blocking: false, reason: high > 0 ? 'guardian_high_findings' : null };
}

async function persistPrReviewScore(params: Record<string, unknown>, scores: Record<string, unknown>) {
  const prNumber = Math.floor(num(params.prNumber ?? params.pr_number ?? (params.task as any)?.prNumber ?? (params.task as any)?.pr_number, 0));
  if (!prNumber || typeof pgPool.run !== 'function') return { ok: false, skipped: true, reason: 'missing_pr_number_or_pg_run' };
  try {
    await pgPool.run('claude', `
      INSERT INTO claude.pr_review_scores (
        pr_number, build_score, review_score, guard_score, total, verdict
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      prNumber,
      scores.builder,
      scores.reviewer,
      scores.guardian,
      scores.total,
      scores.verdict,
    ]);
    return { ok: true, prNumber };
  } catch (error) {
    return { ok: false, skipped: true, reason: 'pr_review_scores_unavailable', error: error?.message || String(error) };
  }
}

export async function runQualityGate(params: unknown): Promise<A2ATaskResult> {
  const p = params && typeof params === 'object' ? params as any : {};
  const task = p.task || { id: p.taskId || 'unpersisted-task' };
  const validationPlan = buildSymphonyValidationPlan(task);
  const checks = {
    reviewer: passValue(p.reviewer || p.review),
    guardian: passValue(p.guardian || p.security),
    builder: passValue(p.builder || p.build),
    test_runner: passValue(p.test_runner || p.tests || p.test),
  };
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  const protectedMatches = protectedFiles(p);
  const builderScore = scoreBuilder(p.builder || p.build);
  const reviewerScore = scoreReviewer(p.reviewer || p.review, p.test_runner || p.tests || p.test);
  const guardianScore = scoreGuardian(p.guardian || p.security);
  const threshold = Math.max(1, Number(process.env.CLAUDE_PR_MERGE_THRESHOLD || DEFAULT_PR_MERGE_THRESHOLD) || DEFAULT_PR_MERGE_THRESHOLD);
  const scores = {
    builder: builderScore.score,
    reviewer: reviewerScore.score,
    guardian: guardianScore.score,
  };
  const totalScore = scores.builder + scores.reviewer + scores.guardian;
  const blockedReason = protectedMatches.length > 0
    ? 'blocked_protected'
    : builderScore.reason || guardianScore.reason || reviewerScore.reason || null;
  const verdict = protectedMatches.length > 0
    ? 'blocked_protected'
    : builderScore.blocking || guardianScore.blocking
      ? 'blocked'
      : totalScore >= threshold
        ? 'approve_candidate'
        : 'blocked';
  const status = failed.length === 0 && verdict === 'approve_candidate' ? 'promotion_ready' : 'promotion_blocked';
  const persisted = await persistPrReviewScore(p, { ...scores, total: totalScore, verdict });

  return completed('quality-gate', {
    mode: 'promotion_gate',
    status,
    pass: failed.length === 0 && verdict === 'approve_candidate',
    failed,
    checks,
    scores,
    totalScore,
    verdict,
    threshold,
    blockedReason,
    protectedFiles: protectedMatches,
    prReviewScorePersisted: persisted,
    validationPlan,
    safety: buildSafety(true),
  });
}

export function registerQualityGateSkill(): void {
  registerSkillHandler('quality-gate', runQualityGate);
}
