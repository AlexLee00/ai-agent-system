/**
 * darwin-weekly-review.ts
 * 매주 일요일 19:00 KST 실행 — ai.darwin.weekly-review launchd plist
 *
 * 지난 7일간 사이클 요약 + Research Registry 변화 + Shadow Mode 비교 결과를
 * Hub 경유 Telegram으로 발송.
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const path = require("path");
const PROJECT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../.."
);

const { query } = require(
  path.join(PROJECT_ROOT, "packages/core/lib/pg-pool")
);
const { postAlarm } = require(path.join(PROJECT_ROOT, "packages/core/lib/openclaw-client"));

function getWeekString() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - 7);
  return `${start.toISOString().slice(0, 10)} ~ ${now.toISOString().slice(0, 10)}`;
}

async function collectWeeklyStats() {
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
        WHERE run_at >= NOW() - INTERVAL '7 days'
      `),
      query(`
        SELECT COALESCE(SUM(cost_usd), 0) AS weekly_cost
        FROM darwin_v2_llm_cost_log
        WHERE logged_at >= NOW() - INTERVAL '7 days'
      `),
    ]);

  const cycle = cycleRows.status === "fulfilled" ? cycleRows.value?.rows?.[0] : {};
  const registry = registryRows.status === "fulfilled" ? registryRows.value?.rows?.[0] : {};
  const dpo = dpoRows.status === "fulfilled" ? dpoRows.value?.rows?.[0] : {};
  const shadow = shadowRows.status === "fulfilled" ? shadowRows.value?.rows?.[0] : {};
  const cost = costRows.status === "fulfilled" ? costRows.value?.rows?.[0] : {};

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

async function main() {
  console.log("[darwin-weekly-review] 주간 리뷰 수집 시작");
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

  await postAlarm({
    message: msg,
    team: "darwin",
    fromBot: "darwin-weekly-review",
    alertLevel: 2,
  });
  console.log("[darwin-weekly-review] 발송 완료");
}

main().catch((err) => {
  console.error("[darwin-weekly-review] 오류:", err);
  process.exit(1);
});
