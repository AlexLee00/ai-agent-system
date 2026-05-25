/**
 * darwin-weekly-review.ts
 * 매주 일요일 19:00 KST 실행 — ai.darwin.weekly-review launchd plist
 *
 * 지난 7일간 사이클 요약 + Research Registry 변화 + Shadow Mode 비교 결과를
 * Hub 경유 Telegram으로 발송.
 */

const path: typeof import("path") = require("path");
const PROJECT_ROOT = path.resolve(__dirname, "../../..");

const { query } = require(
  path.join(PROJECT_ROOT, "packages/core/lib/pg-pool")
);
const { postAlarm } = require(path.join(PROJECT_ROOT, "packages/core/lib/hub-alarm-client"));

const SHADOW_MIN_RUNS = 20;
const SHADOW_MIN_DAYS = 7;
const SHADOW_MIN_MATCH = 0.95;
const SHADOW_RECENT_LIMIT = 200;

interface QueryResultRow {
  [key: string]: unknown;
}

interface QueryResult {
  rows?: QueryResultRow[];
}

interface SettledRowsResult {
  status: "fulfilled" | "rejected";
  value?: QueryResultRow[];
}

interface SettledRowResult {
  status: "fulfilled" | "rejected";
  value?: QueryResultRow;
}

interface WeeklyReviewStats {
  week: string;
  total_cycles: number;
  success_rate: string;
  applied: number;
  new_papers: number;
  applied_papers: number;
  preferred_pairs: number;
  rejected_pairs: number;
  shadow_match_rate: string;
  shadow_total_runs: number;
  shadow_distinct_days: number;
  shadow_min_match_rate: string;
  shadow_regressions: number;
  shadow_recent_runs: number;
  shadow_recent_match_rate: string;
  shadow_recent_avg_delta: string;
  shadow_recent_within_2_rate: string;
  shadow_recent_regressions: number;
  shadow_promotion_ready: boolean;
  shadow_blocker: string;
  weekly_cost_usd: number;
  scanner_runs: number;
  scanner_collected: number;
  scanner_high_relevance: number;
  scanner_evaluation_failures: number;
  scanner_alarm_failures: number;
  scanner_alarm_bypassed: number;
  scanner_alarm_failure_reasons: string;
  scanner_latest_metric_at: string;
  scanner_latest_high_relevance: number;
  scanner_latest_alarm_sent: boolean;
  scanner_latest_alarm_bypassed: boolean;
  scanner_latest_alarm_failure: string;
  scanner_summary_alarm_failures: number;
  scanner_registry_synced: number;
  scanner_registry_sync_failures: number;
  scanner_proposals: number;
  scanner_verified: number;
}

interface CliOptions {
  dryRun: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  return {
    dryRun: argv.includes("--dry-run") || process.env.DARWIN_WEEKLY_REVIEW_DRY_RUN === "1",
    json: argv.includes("--json") || process.env.DARWIN_WEEKLY_REVIEW_JSON === "1",
  };
}

function log(options: CliOptions, message: string): void {
  if (!options.json) console.log(message);
}

function getWeekString(): string {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - 7);
  return `${start.toISOString().slice(0, 10)} ~ ${now.toISOString().slice(0, 10)}`;
}

function buildShadowBlocker(totalRuns: number, distinctDays: number, avgMatch: number | null): string {
  const blockers: string[] = [];
  if (totalRuns < SHADOW_MIN_RUNS) blockers.push(`runs ${totalRuns}/${SHADOW_MIN_RUNS}`);
  if (distinctDays < SHADOW_MIN_DAYS) blockers.push(`days ${distinctDays}/${SHADOW_MIN_DAYS}`);
  if (avgMatch == null || !Number.isFinite(avgMatch)) {
    blockers.push("avg_match N/A");
  } else if (avgMatch < SHADOW_MIN_MATCH) {
    blockers.push(`avg_match ${(avgMatch * 100).toFixed(1)}%/${(SHADOW_MIN_MATCH * 100).toFixed(0)}%`);
  }
  return blockers.length > 0 ? blockers.join(", ") : "none";
}

function buildShadowBlockerWithRecent(
  totalRuns: number,
  distinctDays: number,
  avgMatch: number | null,
  recent: ReturnType<typeof buildRecentShadowStats>,
): string {
  const blockers = buildShadowBlocker(totalRuns, distinctDays, avgMatch);
  const blockerList = blockers === "none" ? [] : blockers.split(", ");
  const recentMinRuns = Math.min(SHADOW_MIN_RUNS, SHADOW_RECENT_LIMIT);

  if (recent.runs < recentMinRuns) {
    blockerList.push(`recent_runs ${recent.runs}/${recentMinRuns}`);
  }
  if (recent.avgMatch == null || !Number.isFinite(recent.avgMatch)) {
    blockerList.push("recent_match N/A");
  } else if (recent.avgMatch < SHADOW_MIN_MATCH) {
    blockerList.push(`recent_match ${(recent.avgMatch * 100).toFixed(1)}%/${(SHADOW_MIN_MATCH * 100).toFixed(0)}%`);
  }

  return blockerList.length > 0 ? blockerList.join(", ") : "none";
}

function normalizeRows(result: QueryResult | QueryResultRow[] | null | undefined): QueryResultRow[] {
  if (Array.isArray(result)) return result;
  return result?.rows ?? [];
}

function asBool(value: unknown): boolean {
  return ["true", "1", "yes"].includes(String(value || "").trim().toLowerCase());
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseShadowScores(row: QueryResultRow): { v1: number; v2: number; delta: number } | null {
  const cycle = parseJsonObject(row.cycle_result);
  const v1 = Number(cycle.v1_score);
  const v2 = Number(cycle.v2_score);
  if (Number.isFinite(v1) && Number.isFinite(v2)) return { v1, v2, delta: Math.abs(v1 - v2) };

  const match = String(row.notes || '').match(/v1=([0-9.]+)\s+v2=([0-9.]+)/);
  if (!match) return null;
  const noteV1 = Number(match[1]);
  const noteV2 = Number(match[2]);
  if (!Number.isFinite(noteV1) || !Number.isFinite(noteV2)) return null;
  return { v1: noteV1, v2: noteV2, delta: Math.abs(noteV1 - noteV2) };
}

function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return (value * 100).toFixed(1);
}

function formatNumber(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return value.toFixed(2);
}

function buildRecentShadowStats(rows: QueryResultRow[]): {
  runs: number;
  matchRate: string;
  avgMatch: number | null;
  avgDelta: string;
  within2Rate: string;
  within2RateValue: number | null;
  regressions: number;
} {
  const runs = rows.length;
  const matchScores = rows
    .map((row) => Number(row.match_score))
    .filter((value) => Number.isFinite(value));
  const avgMatch = matchScores.length > 0
    ? matchScores.reduce((sum, value) => sum + value, 0) / matchScores.length
    : null;
  const regressions = matchScores.filter((value) => value < 0.8).length;
  const scoreRows = rows.map(parseShadowScores).filter((item): item is { v1: number; v2: number; delta: number } => item !== null);
  const avgDelta = scoreRows.length > 0
    ? scoreRows.reduce((sum, row) => sum + row.delta, 0) / scoreRows.length
    : null;
  const within2Rate = scoreRows.length > 0
    ? scoreRows.filter((row) => row.delta <= 2).length / scoreRows.length
    : null;

  return {
    runs,
    matchRate: formatPct(avgMatch),
    avgMatch,
    avgDelta: formatNumber(avgDelta),
    within2Rate: formatPct(within2Rate),
    within2RateValue: within2Rate,
    regressions,
  };
}

async function queryRows(schema: string, sql: string): Promise<QueryResultRow[]> {
  return normalizeRows(await query(schema, sql));
}

async function firstSuccessfulRow(schema: string, sqlStatements: string[]): Promise<QueryResultRow> {
  for (const sql of sqlStatements) {
    try {
      return (await queryRows(schema, sql))[0] ?? {};
    } catch {
      // Try the next known historical schema variant.
    }
  }
  return {};
}

async function collectWeeklyStats(): Promise<WeeklyReviewStats> {
  const [cycleRows, registryRows, dpoRows, shadowRows, shadowRecentRows, costRows, scannerRows] =
    await Promise.allSettled([
      firstSuccessfulRow("public", [
        `
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'success') AS successes,
          COUNT(*) FILTER (WHERE stage = 'applied') AS applied
        FROM darwin_cycle_history
        WHERE inserted_at >= NOW() - INTERVAL '7 days'
        `,
        `
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE verification_status IN ('success', 'passed', 'verified')) AS successes,
          0 AS applied
        FROM darwin_cycle_results
        WHERE COALESCE(completed_at, inserted_at) >= NOW() - INTERVAL '7 days'
        `,
      ]),
      queryRows("public", `
        SELECT
          COUNT(*) FILTER (WHERE stage = 'discovered') AS new_papers,
          COUNT(*) FILTER (WHERE stage = 'applied') AS applied_papers
        FROM darwin_research_registry
        WHERE updated_at >= NOW() - INTERVAL '7 days'
      `),
      queryRows("public", `
        SELECT
          COUNT(*) FILTER (WHERE category = 'preferred') AS preferred,
          COUNT(*) FILTER (WHERE category = 'rejected') AS rejected
        FROM darwin_dpo_preference_pairs
        WHERE inserted_at >= NOW() - INTERVAL '7 days'
      `),
      queryRows("public", `
        SELECT
          COUNT(*) AS shadow_total_runs,
          COUNT(DISTINCT run_date) AS shadow_distinct_days,
          AVG(match_score) AS avg_match,
          MIN(match_score) AS shadow_min_match,
          COUNT(*) FILTER (WHERE match_score < 0.8) AS shadow_regressions
        FROM darwin_v2_shadow_runs
        WHERE inserted_at >= NOW() - INTERVAL '7 days'
      `),
      queryRows("public", `
        SELECT inserted_at, match_score, notes, cycle_result
        FROM darwin_v2_shadow_runs
        WHERE inserted_at >= NOW() - INTERVAL '7 days'
        ORDER BY inserted_at DESC
        LIMIT ${SHADOW_RECENT_LIMIT}
      `),
      firstSuccessfulRow("public", [
        `
          SELECT COALESCE(SUM(cost_usd), 0) AS weekly_cost
          FROM darwin_llm_cost_tracking
          WHERE inserted_at >= NOW() - INTERVAL '7 days'
        `,
        `
          SELECT COALESCE(SUM(cost_usd), 0) AS weekly_cost
          FROM darwin_llm_cost_tracking
          WHERE logged_at >= NOW() - INTERVAL '7 days'
        `,
        `
          SELECT COALESCE(SUM(cost_usd), 0) AS weekly_cost
          FROM darwin_llm_cost_tracking
          WHERE call_date >= CURRENT_DATE - INTERVAL '7 days'
        `,
        `
          SELECT COALESCE(SUM(cost_usd), 0) AS weekly_cost
          FROM darwin_llm_cost_tracking
          WHERE date >= CURRENT_DATE - INTERVAL '7 days'
        `,
        `
          SELECT COALESCE(SUM(cost_usd), 0) AS weekly_cost
          FROM darwin_v2_llm_cost_log
          WHERE logged_at >= NOW() - INTERVAL '7 days'
        `,
      ]),
      queryRows("reservation", `
        SELECT
          COUNT(*) AS scanner_runs,
          COALESCE(SUM(NULLIF(metadata->>'total_collected', '')::numeric), 0) AS scanner_collected,
          COALESCE(SUM(NULLIF(metadata->>'high_relevance', '')::numeric), 0) AS scanner_high_relevance,
          COALESCE(SUM(NULLIF(metadata->>'evaluation_failures', '')::numeric), 0) AS scanner_evaluation_failures,
          COUNT(*) FILTER (
            WHERE COALESCE(metadata->>'alarm_sent', 'false') = 'false'
              AND COALESCE(metadata->>'alarm_bypassed', 'false') != 'true'
              AND COALESCE(NULLIF(metadata->>'high_relevance', '')::numeric, 0) > 0
          ) AS scanner_alarm_failures,
          COUNT(*) FILTER (
            WHERE COALESCE(metadata->>'alarm_bypassed', 'false') = 'true'
              AND COALESCE(NULLIF(metadata->>'high_relevance', '')::numeric, 0) > 0
          ) AS scanner_alarm_bypassed,
          COALESCE(STRING_AGG(DISTINCT NULLIF(metadata->>'alarm_failure', ''), ', ') FILTER (
            WHERE COALESCE(metadata->>'alarm_sent', 'false') = 'false'
              AND COALESCE(metadata->>'alarm_bypassed', 'false') != 'true'
              AND COALESCE(NULLIF(metadata->>'high_relevance', '')::numeric, 0) > 0
          ), '') AS scanner_alarm_failure_reasons,
          COALESCE((ARRAY_AGG(created_at ORDER BY created_at DESC))[1]::text, '') AS scanner_latest_metric_at,
          COALESCE((ARRAY_AGG(COALESCE(NULLIF(metadata->>'high_relevance', '')::numeric, 0) ORDER BY created_at DESC))[1], 0) AS scanner_latest_high_relevance,
          COALESCE((ARRAY_AGG(COALESCE(metadata->>'alarm_sent', 'false') ORDER BY created_at DESC))[1], 'false') AS scanner_latest_alarm_sent,
          COALESCE((ARRAY_AGG(COALESCE(metadata->>'alarm_bypassed', 'false') ORDER BY created_at DESC))[1], 'false') AS scanner_latest_alarm_bypassed,
          COALESCE((ARRAY_AGG(
            CASE
              WHEN COALESCE(NULLIF(metadata->>'high_relevance', '')::numeric, 0) > 0
              THEN COALESCE(metadata->>'alarm_failure', '')
              ELSE ''
            END
            ORDER BY created_at DESC
          ))[1], '') AS scanner_latest_alarm_failure,
          COUNT(*) FILTER (
            WHERE COALESCE(metadata->>'weekly_summary_alarm_failure', '') != ''
          ) AS scanner_summary_alarm_failures,
          COALESCE(SUM(NULLIF(metadata->>'registry_synced', '')::numeric), 0) AS scanner_registry_synced,
          COALESCE(SUM(NULLIF(metadata->>'registry_sync_failures', '')::numeric), 0) AS scanner_registry_sync_failures,
          COALESCE(SUM(NULLIF(metadata->>'proposals_generated', '')::numeric), 0) AS scanner_proposals,
          COALESCE(SUM(NULLIF(metadata->>'proposals_verified', '')::numeric), 0) AS scanner_verified
        FROM reservation.rag_research
        WHERE created_at >= NOW() - INTERVAL '7 days'
          AND metadata->>'type' = 'daily_metrics'
      `),
    ]);

  const cycle =
    (cycleRows as SettledRowResult).status === "fulfilled"
      ? (cycleRows as SettledRowResult).value ?? {}
      : {};
  const registry =
    (registryRows as SettledRowsResult).status === "fulfilled"
      ? (registryRows as SettledRowsResult).value?.[0] ?? {}
      : {};
  const dpo =
    (dpoRows as SettledRowsResult).status === "fulfilled"
      ? (dpoRows as SettledRowsResult).value?.[0] ?? {}
      : {};
  const shadow =
    (shadowRows as SettledRowsResult).status === "fulfilled"
      ? (shadowRows as SettledRowsResult).value?.[0] ?? {}
      : {};
  const shadowRecent =
    (shadowRecentRows as SettledRowsResult).status === "fulfilled"
      ? buildRecentShadowStats((shadowRecentRows as SettledRowsResult).value ?? [])
      : buildRecentShadowStats([]);
  const cost =
    (costRows as SettledRowResult).status === "fulfilled"
      ? (costRows as SettledRowResult).value ?? {}
      : {};
  const scanner =
    (scannerRows as SettledRowsResult).status === "fulfilled"
      ? (scannerRows as SettledRowsResult).value?.[0] ?? {}
      : {};

  const total = Number(cycle.total ?? 0);
  const successes = Number(cycle.successes ?? 0);
  const successRate = total > 0 ? ((successes / total) * 100).toFixed(1) : "N/A";
  const shadowMatch = shadow.avg_match != null
    ? (Number(shadow.avg_match) * 100).toFixed(1)
    : "N/A";
  const shadowAvgMatch = shadow.avg_match == null ? null : Number(shadow.avg_match);
  const shadowTotalRuns = Number(shadow.shadow_total_runs ?? 0);
  const shadowDistinctDays = Number(shadow.shadow_distinct_days ?? 0);
  const shadowPromotionReady = Boolean(
    shadowAvgMatch != null
      && shadowTotalRuns >= SHADOW_MIN_RUNS
      && shadowDistinctDays >= SHADOW_MIN_DAYS
      && shadowAvgMatch >= SHADOW_MIN_MATCH
      && shadowRecent.runs >= Math.min(SHADOW_MIN_RUNS, SHADOW_RECENT_LIMIT)
      && shadowRecent.avgMatch != null
      && shadowRecent.avgMatch >= SHADOW_MIN_MATCH
  );

  return {
    week: getWeekString(),
    total_cycles: total,
    success_rate: successRate,
    applied: Number(cycle.applied ?? 0),
    new_papers: Number(registry.new_papers ?? 0),
    applied_papers: Number(registry.applied_papers ?? 0),
    preferred_pairs: Number(dpo.preferred ?? 0),
    rejected_pairs: Number(dpo.rejected ?? 0),
    shadow_match_rate: shadowMatch,
    shadow_total_runs: shadowTotalRuns,
    shadow_distinct_days: shadowDistinctDays,
    shadow_min_match_rate: shadow.shadow_min_match == null
      ? "N/A"
      : (Number(shadow.shadow_min_match) * 100).toFixed(1),
    shadow_regressions: Number(shadow.shadow_regressions ?? 0),
    shadow_recent_runs: shadowRecent.runs,
    shadow_recent_match_rate: shadowRecent.matchRate,
    shadow_recent_avg_delta: shadowRecent.avgDelta,
    shadow_recent_within_2_rate: shadowRecent.within2Rate,
    shadow_recent_regressions: shadowRecent.regressions,
    shadow_promotion_ready: shadowPromotionReady,
    shadow_blocker: buildShadowBlockerWithRecent(shadowTotalRuns, shadowDistinctDays, shadowAvgMatch, shadowRecent),
    weekly_cost_usd: parseFloat(Number(cost.weekly_cost ?? 0).toFixed(4)),
    scanner_runs: Number(scanner.scanner_runs ?? 0),
    scanner_collected: Number(scanner.scanner_collected ?? 0),
    scanner_high_relevance: Number(scanner.scanner_high_relevance ?? 0),
    scanner_evaluation_failures: Number(scanner.scanner_evaluation_failures ?? 0),
    scanner_alarm_failures: Number(scanner.scanner_alarm_failures ?? 0),
    scanner_alarm_bypassed: Number(scanner.scanner_alarm_bypassed ?? 0),
    scanner_alarm_failure_reasons: String(scanner.scanner_alarm_failure_reasons ?? ''),
    scanner_latest_metric_at: String(scanner.scanner_latest_metric_at ?? ''),
    scanner_latest_high_relevance: Number(scanner.scanner_latest_high_relevance ?? 0),
    scanner_latest_alarm_sent: asBool(scanner.scanner_latest_alarm_sent),
    scanner_latest_alarm_bypassed: asBool(scanner.scanner_latest_alarm_bypassed),
    scanner_latest_alarm_failure: String(scanner.scanner_latest_alarm_failure ?? ''),
    scanner_summary_alarm_failures: Number(scanner.scanner_summary_alarm_failures ?? 0),
    scanner_registry_synced: Number(scanner.scanner_registry_synced ?? 0),
    scanner_registry_sync_failures: Number(scanner.scanner_registry_sync_failures ?? 0),
    scanner_proposals: Number(scanner.scanner_proposals ?? 0),
    scanner_verified: Number(scanner.scanner_verified ?? 0),
  };
}

async function main(options: CliOptions = parseArgs(process.argv.slice(2))): Promise<void> {
  log(options, "[darwin-weekly-review] 주간 리뷰 수집 시작");
  const stats = await collectWeeklyStats();

  const msg = `
📅 다윈 주간 리뷰 (${stats.week})

🔬 사이클 요약:
  총 ${stats.total_cycles}회 | 성공률: ${stats.success_rate}%
  적용 완료: ${stats.applied}건

📚 Research Registry 변화:
  신규 논문: ${stats.new_papers} | 적용된 논문: ${stats.applied_papers}

📡 Scanner evidence:
  실행: ${stats.scanner_runs}회 | 수집: ${stats.scanner_collected} | 7점+ 후보: ${stats.scanner_high_relevance}
  평가 실패: ${stats.scanner_evaluation_failures} | 후보 알림 실패: ${stats.scanner_alarm_failures} | observe-only 생략: ${stats.scanner_alarm_bypassed} | 주간 summary 실패: ${stats.scanner_summary_alarm_failures}
  최신 알림 상태: high=${stats.scanner_latest_high_relevance}, sent=${stats.scanner_latest_alarm_sent ? "true" : "false"}, bypassed=${stats.scanner_latest_alarm_bypassed ? "true" : "false"}, failure=${stats.scanner_latest_alarm_failure || "N/A"}
  후보 알림 실패 사유: ${stats.scanner_alarm_failure_reasons || "N/A"}
  Registry sync: ${stats.scanner_registry_synced}/${stats.scanner_registry_sync_failures} | 제안/검증: ${stats.scanner_proposals}/${stats.scanner_verified}

🧠 Self-Rewarding DPO:
  preferred: ${stats.preferred_pairs} | rejected: ${stats.rejected_pairs}

🔄 Shadow Mode (V1 vs V2):
  일치율: ${stats.shadow_match_rate}% | 실행: ${stats.shadow_total_runs}건/${stats.shadow_distinct_days}일
  최저: ${stats.shadow_min_match_rate}% | regression(<80%): ${stats.shadow_regressions}
  최근 ${stats.shadow_recent_runs}건: match=${stats.shadow_recent_match_rate}% | avg_delta=${stats.shadow_recent_avg_delta} | within±2=${stats.shadow_recent_within_2_rate}% | regression=${stats.shadow_recent_regressions}
  promotionReady: ${stats.shadow_promotion_ready ? "true" : "false"} | blocker: ${stats.shadow_blocker}

💰 주간 LLM 비용: $${stats.weekly_cost_usd}
`.trim();

  const payload = {
    message: msg,
    team: "darwin",
    fromBot: "darwin-weekly-review",
    alertLevel: 2,
    alarmType: "report",
    visibility: "digest",
    actionability: "none",
    eventType: "darwin_weekly_review",
    incidentKey: `darwin:weekly-review:${new Date().toISOString().slice(0, 10)}`,
    title: "다윈 주간 리뷰",
  };

  if (!options.dryRun) {
    await postAlarm({
      ...payload,
      message: payload.message,
      team: payload.team,
      fromBot: payload.fromBot,
      alertLevel: payload.alertLevel,
      alarmType: payload.alarmType,
      visibility: payload.visibility,
      eventType: payload.eventType,
      incidentKey: payload.incidentKey,
    });
    log(options, "[darwin-weekly-review] 발송 완료");
  } else {
    log(options, "[darwin-weekly-review][dry-run] 실제 알림 발송 생략");
  }

  if (options.json) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: options.dryRun,
      stats,
      payload,
      alarmSent: !options.dryRun,
    }, null, 2));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[darwin-weekly-review] 오류:", err);
    process.exit(1);
  });
}

module.exports = { collectWeeklyStats, getWeekString, main };
