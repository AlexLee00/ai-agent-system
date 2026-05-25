/**
 * darwin-weekly-ops-report.ts
 * 매주 일요일 06:30 KST 실행 — ai.darwin.weekly-ops-report launchd plist
 *
 * 지난 7일 운영 스냅샷 + Research Registry 진행 상황을 수집해
 * 공용 postAlarm 경로로 Telegram 발송.
 */

const fs: typeof import("fs") = require("fs");
const path: typeof import("path") = require("path");
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const AUTONOMY_STATE_FILE = path.join(PROJECT_ROOT, "bots/darwin/sandbox/darwin-autonomy-level.json");

const { query } = require(
  path.join(PROJECT_ROOT, "packages/core/lib/pg-pool")
);
const { postAlarm } = require(path.join(PROJECT_ROOT, "packages/core/lib/hub-alarm-client"));

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

interface WeeklyOpsStats {
  date: string;
  total_cycles: number;
  successes: number;
  failures: number;
  applied: number;
  success_rate: string;
  llm_cost_usd: number;
  autonomy_level: number;
  autonomy_source: string;
  autonomy_promotion_ready: boolean;
  autonomy_blocker: string;
  autonomy_consecutive_successes: number;
  autonomy_applied_successes: number;
  new_papers: number;
  evaluated: number;
  planned: number;
  violations: number;
  scanner_runs: number;
  scanner_collected: number;
  scanner_evaluated: number;
  scanner_stored: number;
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
  scanner_avg_duration_sec: number;
}

interface CliOptions {
  dryRun: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  return {
    dryRun: argv.includes("--dry-run") || process.env.DARWIN_WEEKLY_OPS_DRY_RUN === "1",
    json: argv.includes("--json") || process.env.DARWIN_WEEKLY_OPS_JSON === "1",
  };
}

function log(options: CliOptions, message: string): void {
  if (!options.json) console.log(message);
}

function normalizeRows(result: QueryResult | QueryResultRow[] | null | undefined): QueryResultRow[] {
  if (Array.isArray(result)) return result;
  return result?.rows ?? [];
}

function asBool(value: unknown): boolean {
  return ["true", "1", "yes"].includes(String(value || "").trim().toLowerCase());
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

function normalizeAutonomyLevel(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(3, Math.min(5, Math.trunc(value)));
  }
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "L5" || normalized === "5") return 5;
  if (normalized === "L4" || normalized === "4") return 4;
  return 3;
}

function collectAutonomyState(): {
  level: number;
  source: string;
  promotionReady: boolean;
  blocker: string;
  consecutiveSuccesses: number;
  appliedSuccesses: number;
} {
  const envLevel = String(process.env.DARWIN_AUTONOMY_LEVEL || "").trim();
  let state: Record<string, unknown> = {};
  let source = "default";

  if (fs.existsSync(AUTONOMY_STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(AUTONOMY_STATE_FILE, "utf8"));
      source = "state_file";
    } catch {
      state = {};
      source = "state_file_unreadable";
    }
  }

  const level = normalizeAutonomyLevel(envLevel || state.level);
  if (envLevel) source = "env";

  const consecutiveSuccesses = Number(
    process.env.DARWIN_AUTONOMY_CONSECUTIVE_SUCCESSES
      ?? state.consecutiveSuccesses
      ?? state.consecutive_successes
      ?? 0
  );
  const appliedSuccesses = Number(
    process.env.DARWIN_AUTONOMY_APPLIED_SUCCESSES
      ?? state.appliedSuccesses
      ?? state.applied_successes
      ?? 0
  );
  const killSwitchOn = String(process.env.DARWIN_KILL_SWITCH || "false").trim().toLowerCase() === "true";
  const blockers = [];
  if (level < 5) blockers.push(`level L${level}/L5`);
  if (killSwitchOn) blockers.push("kill_switch_on");
  if (consecutiveSuccesses < 5) blockers.push(`L4_successes ${consecutiveSuccesses}/5`);
  if (consecutiveSuccesses < 10) blockers.push(`L5_successes ${consecutiveSuccesses}/10`);
  if (appliedSuccesses < 3) blockers.push(`L5_applied ${appliedSuccesses}/3`);
  const promotionReady = level >= 5 && blockers.length === 0;

  return {
    level,
    source,
    promotionReady,
    blocker: blockers.length > 0 ? blockers.join(", ") : "none",
    consecutiveSuccesses: Number.isFinite(consecutiveSuccesses) ? consecutiveSuccesses : 0,
    appliedSuccesses: Number.isFinite(appliedSuccesses) ? appliedSuccesses : 0,
  };
}

async function collectStats(): Promise<WeeklyOpsStats> {
  const autonomy = collectAutonomyState();
  const [cycleRows, registryRows, violationRows, scannerRows] = await Promise.allSettled([
    firstSuccessfulRow("public", [
      `
      SELECT
        COUNT(*) AS total_cycles,
        COUNT(*) FILTER (WHERE status = 'success') AS successes,
        COUNT(*) FILTER (WHERE status = 'failure') AS failures,
        COUNT(*) FILTER (WHERE stage = 'applied') AS applied,
        COALESCE(SUM(llm_cost_usd), 0) AS llm_cost_usd
      FROM darwin_cycle_history
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
      `,
      `
      SELECT
        COUNT(*) AS total_cycles,
        COUNT(*) FILTER (WHERE verification_status IN ('success', 'passed', 'verified')) AS successes,
        COUNT(*) FILTER (WHERE verification_status IN ('failure', 'failed')) AS failures,
        0 AS applied,
        0 AS llm_cost_usd
      FROM darwin_cycle_results
      WHERE COALESCE(completed_at, inserted_at) >= NOW() - INTERVAL '7 days'
      `,
    ]),
    queryRows("public", `
      SELECT stage, COUNT(*) AS count
      FROM darwin_research_registry
      WHERE updated_at >= NOW() - INTERVAL '7 days'
      GROUP BY stage
    `),
    firstSuccessfulRow("public", [
      `
      SELECT COUNT(*) AS count
      FROM darwin_v2_principle_violations
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
      `,
      `
      SELECT COUNT(*) AS count
      FROM darwin_principle_violations
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
      `,
    ]),
    queryRows("reservation", `
      SELECT
        COUNT(*) AS scanner_runs,
        COALESCE(SUM(NULLIF(metadata->>'total_collected', '')::numeric), 0) AS scanner_collected,
        COALESCE(SUM(NULLIF(metadata->>'evaluated', '')::numeric), 0) AS scanner_evaluated,
        COALESCE(SUM(NULLIF(metadata->>'stored', '')::numeric), 0) AS scanner_stored,
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
        COALESCE(SUM(NULLIF(metadata->>'proposals_verified', '')::numeric), 0) AS scanner_verified,
        COALESCE(AVG(NULLIF(metadata->>'duration_sec', '')::numeric), 0) AS scanner_avg_duration_sec
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
      ? (registryRows as SettledRowsResult).value ?? []
      : [];
  const violations =
    (violationRows as SettledRowResult).status === "fulfilled"
      ? (violationRows as SettledRowResult).value?.count ?? 0
      : 0;
  const scanner =
    (scannerRows as SettledRowsResult).status === "fulfilled"
      ? (scannerRows as SettledRowsResult).value?.[0] ?? {}
      : {};

  const total = Number(cycle.total_cycles ?? 0);
  const successes = Number(cycle.successes ?? 0);
  const successRate = total > 0 ? ((successes / total) * 100).toFixed(1) : "N/A";

  const regMap: Record<string, number> = {};
  for (const r of registry) {
    regMap[String(r.stage || "")] = Number(r.count);
  }

  return {
    date: new Date().toISOString().slice(0, 10),
    total_cycles: total,
    successes,
    failures: Number(cycle.failures ?? 0),
    applied: Number(cycle.applied ?? 0),
    success_rate: successRate,
    llm_cost_usd: parseFloat(Number(cycle.llm_cost_usd ?? 0).toFixed(4)),
    autonomy_level: autonomy.level,
    autonomy_source: autonomy.source,
    autonomy_promotion_ready: autonomy.promotionReady,
    autonomy_blocker: autonomy.blocker,
    autonomy_consecutive_successes: autonomy.consecutiveSuccesses,
    autonomy_applied_successes: autonomy.appliedSuccesses,
    new_papers: regMap["discovered"] ?? 0,
    evaluated: regMap["evaluated"] ?? 0,
    planned: regMap["planned"] ?? 0,
    violations: Number(violations),
    scanner_runs: Number(scanner.scanner_runs ?? 0),
    scanner_collected: Number(scanner.scanner_collected ?? 0),
    scanner_evaluated: Number(scanner.scanner_evaluated ?? 0),
    scanner_stored: Number(scanner.scanner_stored ?? 0),
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
    scanner_avg_duration_sec: Math.round(Number(scanner.scanner_avg_duration_sec ?? 0)),
  };
}

async function main(options: CliOptions = parseArgs(process.argv.slice(2))): Promise<void> {
  log(options, "[darwin-weekly-ops-report] 주간 운영 리포트 수집 시작");
  const stats = await collectStats();

  const msg = `
📊 다윈 주간 운영 리포트 (${stats.date})

🔬 지난 7일 사이클:
  총 ${stats.total_cycles}회 | 성공: ${stats.successes} (${stats.success_rate}%) | 실패: ${stats.failures}
  적용: ${stats.applied}건

💰 지난 7일 LLM 비용: $${stats.llm_cost_usd}

🎯 Autonomy:
  level: L${stats.autonomy_level} (${stats.autonomy_source}) | promotionReady: ${stats.autonomy_promotion_ready ? "true" : "false"}
  successes: ${stats.autonomy_consecutive_successes} | applied: ${stats.autonomy_applied_successes}
  blocker: ${stats.autonomy_blocker}

📚 지난 7일 Research Registry:
  신규 발견: ${stats.new_papers} | 평가 완료: ${stats.evaluated} | 구현 대기: ${stats.planned}

📡 Scanner evidence:
  실행: ${stats.scanner_runs}회 | 수집: ${stats.scanner_collected} | 평가: ${stats.scanner_evaluated} | 저장: ${stats.scanner_stored}
  7점+ 후보: ${stats.scanner_high_relevance} | 평가 실패: ${stats.scanner_evaluation_failures} | 후보 알림 실패: ${stats.scanner_alarm_failures} | observe-only 알림 생략: ${stats.scanner_alarm_bypassed}
  최신 알림 상태: high=${stats.scanner_latest_high_relevance}, sent=${stats.scanner_latest_alarm_sent ? "true" : "false"}, bypassed=${stats.scanner_latest_alarm_bypassed ? "true" : "false"}, failure=${stats.scanner_latest_alarm_failure || "N/A"}
  후보 알림 실패 사유: ${stats.scanner_alarm_failure_reasons || "N/A"}
  주간 summary 실패: ${stats.scanner_summary_alarm_failures} | Registry sync: ${stats.scanner_registry_synced}/${stats.scanner_registry_sync_failures}
  제안/검증: ${stats.scanner_proposals}/${stats.scanner_verified} | 평균 소요: ${stats.scanner_avg_duration_sec}초

⚠️ 지난 7일 원칙 위반: ${stats.violations}회
`.trim();

  const payload = {
    message: msg,
    team: "darwin",
    fromBot: "darwin-weekly-ops",
    alertLevel: 2,
  };

  if (!options.dryRun) {
    await postAlarm(payload);
    log(options, "[darwin-weekly-ops-report] 발송 완료");
  } else {
    log(options, "[darwin-weekly-ops-report][dry-run] 실제 알림 발송 생략");
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
    console.error("[darwin-weekly-ops-report] 오류:", err);
    process.exit(1);
  });
}

module.exports = { collectStats, main };
