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

interface QueryResultRow {
  [key: string]: unknown;
}

interface QueryResult {
  rows?: QueryResultRow[];
}

interface SettledQueryResult {
  status: "fulfilled" | "rejected";
  value?: QueryResult;
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
  weekly_cost_usd: number;
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

async function firstSuccessfulRow(sqlStatements: string[]): Promise<Record<string, unknown>> {
  for (const sql of sqlStatements) {
    try {
      const result = await query(sql);
      return result?.rows?.[0] ?? {};
    } catch {
      // Try the next known historical schema variant.
    }
  }
  return {};
}

async function collectWeeklyStats(): Promise<WeeklyReviewStats> {
  const [cycleRows, registryRows, dpoRows, shadowRows, costRows] =
    await Promise.allSettled([
      query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'success') AS successes,
          COUNT(*) FILTER (WHERE stage = 'applied') AS applied
        FROM darwin_cycle_history
        WHERE inserted_at >= NOW() - INTERVAL '7 days'
      `),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE stage = 'discovered') AS new_papers,
          COUNT(*) FILTER (WHERE stage = 'applied') AS applied_papers
        FROM darwin_research_registry
        WHERE updated_at >= NOW() - INTERVAL '7 days'
      `),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE category = 'preferred') AS preferred,
          COUNT(*) FILTER (WHERE category = 'rejected') AS rejected
        FROM darwin_dpo_preference_pairs
        WHERE inserted_at >= NOW() - INTERVAL '7 days'
      `),
      query(`
        SELECT AVG(match_score) AS avg_match
        FROM darwin_v2_shadow_runs
        WHERE inserted_at >= NOW() - INTERVAL '7 days'
      `),
      firstSuccessfulRow([
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
    ]);

  const cycle =
    (cycleRows as SettledQueryResult).status === "fulfilled"
      ? (cycleRows as SettledQueryResult).value?.rows?.[0] ?? {}
      : {};
  const registry =
    (registryRows as SettledQueryResult).status === "fulfilled"
      ? (registryRows as SettledQueryResult).value?.rows?.[0] ?? {}
      : {};
  const dpo =
    (dpoRows as SettledQueryResult).status === "fulfilled"
      ? (dpoRows as SettledQueryResult).value?.rows?.[0] ?? {}
      : {};
  const shadow =
    (shadowRows as SettledQueryResult).status === "fulfilled"
      ? (shadowRows as SettledQueryResult).value?.rows?.[0] ?? {}
      : {};
  const cost =
    (costRows as SettledRowResult).status === "fulfilled"
      ? (costRows as SettledRowResult).value ?? {}
      : {};

  const total = Number(cycle.total ?? 0);
  const successes = Number(cycle.successes ?? 0);
  const successRate = total > 0 ? ((successes / total) * 100).toFixed(1) : "N/A";
  const shadowMatch = shadow.avg_match != null
    ? (Number(shadow.avg_match) * 100).toFixed(1)
    : "N/A";

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
    weekly_cost_usd: parseFloat(Number(cost.weekly_cost ?? 0).toFixed(4)),
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

🧠 Self-Rewarding DPO:
  preferred: ${stats.preferred_pairs} | rejected: ${stats.rejected_pairs}

🔄 Shadow Mode (V1 vs V2):
  일치율: ${stats.shadow_match_rate}%

💰 주간 LLM 비용: $${stats.weekly_cost_usd}
`.trim();

  const payload = {
    message: msg,
    team: "darwin",
    fromBot: "darwin-weekly-review",
    alertLevel: 2,
  };

  if (!options.dryRun) {
    await postAlarm(payload);
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
