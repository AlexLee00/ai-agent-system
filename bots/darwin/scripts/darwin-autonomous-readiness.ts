/**
 * darwin-autonomous-readiness.ts
 *
 * Dry-run only readiness gate for Darwin full autonomous operation.
 * It does not publish, resend alerts, mutate secrets, or change launchd state.
 */

const path: typeof import("path") = require("path");
const PROJECT_ROOT = path.resolve(__dirname, "../../..");

const opsReport = require(path.join(PROJECT_ROOT, "bots/darwin/scripts/darwin-weekly-ops-report.ts"));
const weeklyReview = require(path.join(PROJECT_ROOT, "bots/darwin/scripts/darwin-weekly-review.ts"));

interface ReadinessCheck {
  ok: boolean;
  detail: string;
}

interface ReadinessResult {
  ok: boolean;
  dryRun: true;
  promotionReady: boolean;
  checks: Record<string, ReadinessCheck>;
  blockers: string[];
  warnings: string[];
  evidence: Record<string, unknown>;
}

interface CliOptions {
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  return { json: argv.includes("--json") };
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function check(ok: boolean, detail: string): ReadinessCheck {
  return { ok, detail };
}

function pushBlocker(blockers: string[], name: string, checkResult: ReadinessCheck): void {
  if (!checkResult.ok) blockers.push(`${name}: ${checkResult.detail}`);
}

function buildReadiness(opsStats: Record<string, unknown>, reviewStats: Record<string, unknown>): ReadinessResult {
  const scannerRuns = Number(opsStats.scanner_runs || 0);
  const scannerCollected = Number(opsStats.scanner_collected || 0);
  const scannerEvaluated = Number(opsStats.scanner_evaluated || 0);
  const scannerStored = Number(opsStats.scanner_stored || 0);
  const scannerEvaluationFailures = Number(opsStats.scanner_evaluation_failures || 0);
  const scannerAlarmFailures = Number(opsStats.scanner_alarm_failures || 0);
  const scannerSummaryAlarmFailures = Number(opsStats.scanner_summary_alarm_failures || 0);
  const latestHighRelevance = Number(opsStats.scanner_latest_high_relevance || 0);
  const latestAlarmSent = opsStats.scanner_latest_alarm_sent === true;
  const latestAlarmBypassed = opsStats.scanner_latest_alarm_bypassed === true;
  const latestAlarmFailure = String(opsStats.scanner_latest_alarm_failure || '');
  const scannerRegistrySynced = Number(opsStats.scanner_registry_synced || 0);
  const scannerRegistrySyncFailures = Number(opsStats.scanner_registry_sync_failures || 0);
  const scannerProposals = Number(opsStats.scanner_proposals || 0);
  const scannerVerified = Number(opsStats.scanner_verified || 0);
  const autonomyReady = opsStats.autonomy_promotion_ready === true;
  const shadowReady = reviewStats.shadow_promotion_ready === true;
  const shadowDetail = [
    String(reviewStats.shadow_blocker || `match_rate=${reviewStats.shadow_match_rate || "N/A"}%`),
    `recent_runs=${reviewStats.shadow_recent_runs || "N/A"}`,
    `recent_match=${reviewStats.shadow_recent_match_rate || "N/A"}%`,
    `recent_avg_delta=${reviewStats.shadow_recent_avg_delta || "N/A"}`,
    `recent_within_2=${reviewStats.shadow_recent_within_2_rate || "N/A"}%`,
  ].join(", ");
  const evaluationFailureRate = pct(scannerEvaluationFailures, Math.max(1, scannerEvaluated));
  const proposalPassRate = pct(scannerVerified, Math.max(1, scannerProposals));

  const checks: Record<string, ReadinessCheck> = {
    scanner_pipeline: check(
      scannerRuns > 0 && scannerCollected > 0 && scannerEvaluated > 0 && scannerStored > 0,
      `runs=${scannerRuns}, collected=${scannerCollected}, evaluated=${scannerEvaluated}, stored=${scannerStored}`,
    ),
    evaluation_stability: check(
      evaluationFailureRate <= 10,
      `evaluation_failure_rate=${evaluationFailureRate}% (${scannerEvaluationFailures}/${scannerEvaluated})`,
    ),
    alarm_delivery: check(
      !(latestHighRelevance > 0 && !latestAlarmSent && !latestAlarmBypassed) && scannerSummaryAlarmFailures === 0,
      `latest_high=${latestHighRelevance}, latest_sent=${latestAlarmSent}, latest_bypassed=${latestAlarmBypassed}, latest_failure=${latestAlarmFailure || "N/A"}, weekly_candidate_failures=${scannerAlarmFailures}, weekly_summary_failures=${scannerSummaryAlarmFailures}`,
    ),
    registry_sync: check(
      scannerRegistrySyncFailures === 0 && scannerRegistrySynced > 0,
      `synced=${scannerRegistrySynced}, failures=${scannerRegistrySyncFailures}`,
    ),
    proposal_verification: check(
      scannerProposals === 0 || proposalPassRate >= 80,
      `proposals=${scannerProposals}, verified=${scannerVerified}, pass_rate=${proposalPassRate}%`,
    ),
    shadow_gate: check(
      shadowReady,
      shadowDetail,
    ),
    autonomy_gate: check(
      autonomyReady,
      String(opsStats.autonomy_blocker || `level=L${opsStats.autonomy_level || "?"}`),
    ),
  };

  const blockers: string[] = [];
  for (const [name, checkResult] of Object.entries(checks)) {
    pushBlocker(blockers, name, checkResult);
  }

  const warnings: string[] = [];
  if (Number(opsStats.total_cycles || 0) === 0) {
    warnings.push("cycle_history: no completed cycles in last 7 days");
  }
  if (scannerAlarmFailures > 0) {
    warnings.push(`alarm_delivery: historical candidate failures in weekly window=${scannerAlarmFailures}`);
  }
  if (scannerRegistrySynced === 0 && scannerRegistrySyncFailures === 0) {
    warnings.push("registry_sync: no post-change non-dry-run evidence yet");
  }

  return {
    ok: true,
    dryRun: true,
    promotionReady: blockers.length === 0,
    checks,
    blockers,
    warnings,
    evidence: {
      ops: opsStats,
      review: reviewStats,
    },
  };
}

async function collectReadiness(): Promise<ReadinessResult> {
  const [opsStats, reviewStats] = await Promise.all([
    opsReport.collectStats(),
    weeklyReview.collectWeeklyStats(),
  ]);
  return buildReadiness(opsStats, reviewStats);
}

async function main(options: CliOptions = parseArgs(process.argv.slice(2))): Promise<void> {
  const result = await collectReadiness();
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Darwin autonomous readiness: ${result.promotionReady ? "READY" : "BLOCKED"}`);
  for (const blocker of result.blockers) {
    console.log(`- ${blocker}`);
  }
  for (const warning of result.warnings) {
    console.log(`- warning: ${warning}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[darwin-autonomous-readiness] 오류:", err);
    process.exit(1);
  });
}

module.exports = {
  buildReadiness,
  collectReadiness,
  main,
};
