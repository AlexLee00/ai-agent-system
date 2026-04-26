/**
 * darwin-weekly-ops-report.ts
 * 매주 일요일 06:30 KST 실행 — ai.darwin.weekly-ops-report launchd plist
 *
 * 지난 7일 운영 스냅샷 + Research Registry 진행 상황을 수집해
 * 공용 postAlarm 경로로 Telegram 발송.
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

interface WeeklyOpsStats {
  date: string;
  total_cycles: number;
  successes: number;
  failures: number;
  applied: number;
  success_rate: string;
  llm_cost_usd: number;
  autonomy_level: number;
  new_papers: number;
  evaluated: number;
  planned: number;
  violations: number;
}

async function collectStats(): Promise<WeeklyOpsStats> {
  const [cycleRows, registryRows, violationRows] = await Promise.allSettled([
    query(`
      SELECT
        COUNT(*) AS total_cycles,
        COUNT(*) FILTER (WHERE status = 'success') AS successes,
        COUNT(*) FILTER (WHERE status = 'failure') AS failures,
        COUNT(*) FILTER (WHERE stage = 'applied') AS applied,
        COALESCE(SUM(llm_cost_usd), 0) AS llm_cost_usd
      FROM darwin_cycle_history
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
    `),
    query(`
      SELECT stage, COUNT(*) AS count
      FROM darwin_research_registry
      WHERE updated_at >= NOW() - INTERVAL '7 days'
      GROUP BY stage
    `),
    query(`
      SELECT COUNT(*) AS count
      FROM darwin_principle_violations
      WHERE inserted_at >= NOW() - INTERVAL '7 days'
    `),
  ]);

  const cycle =
    (cycleRows as SettledQueryResult).status === "fulfilled"
      ? (cycleRows as SettledQueryResult).value?.rows?.[0] ?? {}
      : {};
  const registry =
    (registryRows as SettledQueryResult).status === "fulfilled"
      ? (registryRows as SettledQueryResult).value?.rows ?? []
      : [];
  const violations =
    (violationRows as SettledQueryResult).status === "fulfilled"
      ? (violationRows as SettledQueryResult).value?.rows?.[0]?.count ?? 0
      : 0;

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
    autonomy_level: 3, // AutonomyLevel.level()은 Elixir 경유 필요
    new_papers: regMap["discovered"] ?? 0,
    evaluated: regMap["evaluated"] ?? 0,
    planned: regMap["planned"] ?? 0,
    violations: Number(violations),
  };
}

async function main(): Promise<void> {
  console.log("[darwin-weekly-ops-report] 주간 운영 리포트 수집 시작");
  const stats = await collectStats();

  const msg = `
📊 다윈 주간 운영 리포트 (${stats.date})

🔬 지난 7일 사이클:
  총 ${stats.total_cycles}회 | 성공: ${stats.successes} (${stats.success_rate}%) | 실패: ${stats.failures}
  적용: ${stats.applied}건

💰 지난 7일 LLM 비용: $${stats.llm_cost_usd}

📚 지난 7일 Research Registry:
  신규 발견: ${stats.new_papers} | 평가 완료: ${stats.evaluated} | 구현 대기: ${stats.planned}

⚠️ 지난 7일 원칙 위반: ${stats.violations}회
`.trim();

  await postAlarm({
    message: msg,
    team: "darwin",
    fromBot: "darwin-weekly-ops",
    alertLevel: 2,
  });
  console.log("[darwin-weekly-ops-report] 발송 완료");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[darwin-weekly-ops-report] 오류:", err);
    process.exit(1);
  });
}

module.exports = { collectStats, main };
