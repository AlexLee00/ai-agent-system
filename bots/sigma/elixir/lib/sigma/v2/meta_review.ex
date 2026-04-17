defmodule Sigma.V2.MetaReview do
  @moduledoc """
  주간 메타리뷰 — GStack /retro 패턴 (What Worked/Didn't/Try).
  5차원 집계: 분석가·팀·피드백타입·요일·시간대.
  매주 금요일 ESPL 진화 트리거.
  참조: bots/sigma/docs/PLAN.md §6 Phase 4
  """

  require Logger

  @doc "주간 메타리뷰 실행 + Telegram 보고 + ESPL 트리거(금요일)."
  def weekly do
    today = Date.utc_today()

    report = %{
      period: %{from: Date.add(today, -7), to: today},
      by_analyst: group_by_analyst(),
      by_team: group_by_target_team(),
      by_feedback_type: group_by_feedback_type(),
      by_weekday: group_by_weekday(),
      by_time_bucket: group_by_time_bucket(),
      what_worked: top_successes(5),
      what_didnt: top_failures(5),
      what_to_try: generate_suggestions()
    }

    Sigma.V2.TelegramBridge.notify_meta_review(report)
    store_to_memory(report)
    trigger_espl_if_friday(today)

    {:ok, report}
  rescue
    e ->
      Logger.error("[sigma/meta_review] 오류: #{inspect(e)}")
      {:error, e}
  end

  # ---

  defp group_by_analyst do
    run_group_query(
      "principle_check_result->>'analyst'",
      "analyst"
    )
  end

  defp group_by_target_team do
    run_group_query("team", "team")
  end

  defp group_by_feedback_type do
    run_group_query(
      "principle_check_result->>'feedback_type'",
      "feedback_type"
    )
  end

  defp group_by_weekday do
    sql = """
    SELECT
      EXTRACT(DOW FROM executed_at)::int AS dow,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE outcome IN ('signal_sent', 'tier2_applied'))::int AS positive
    FROM sigma_v2_directive_audit
    WHERE executed_at >= NOW() - interval '7 days'
    GROUP BY dow ORDER BY dow
    """
    run_raw_query(sql, fn [dow, total, pos] ->
      %{weekday: dow, total: total, positive: pos,
        rate: if(total > 0, do: Float.round(pos / total * 1.0, 3), else: 0.0)}
    end)
  end

  defp group_by_time_bucket do
    sql = """
    SELECT
      (EXTRACT(HOUR FROM executed_at)::int / 6) AS bucket,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE outcome IN ('signal_sent', 'tier2_applied'))::int AS positive
    FROM sigma_v2_directive_audit
    WHERE executed_at >= NOW() - interval '7 days'
    GROUP BY bucket ORDER BY bucket
    """
    run_raw_query(sql, fn [bucket, total, pos] ->
      label = case bucket do
        0 -> "0-6"
        1 -> "6-12"
        2 -> "12-18"
        _ -> "18-24"
      end
      %{bucket: label, total: total, positive: pos,
        rate: if(total > 0, do: Float.round(pos / total * 1.0, 3), else: 0.0)}
    end)
  end

  defp top_successes(limit) do
    sql = """
    SELECT team, action, executed_at
    FROM sigma_v2_directive_audit
    WHERE outcome IN ('signal_sent', 'tier2_applied')
      AND executed_at >= NOW() - interval '7 days'
    ORDER BY executed_at DESC
    LIMIT $1
    """
    run_raw_query(sql, fn [team, action, ts] ->
      %{team: team, action: action, executed_at: ts}
    end, [limit])
  end

  defp top_failures(limit) do
    sql = """
    SELECT team, action, executed_at, outcome
    FROM sigma_v2_directive_audit
    WHERE outcome IN ('failure', 'blocked', 'rollback')
      AND executed_at >= NOW() - interval '7 days'
    ORDER BY executed_at DESC
    LIMIT $1
    """
    run_raw_query(sql, fn [team, action, ts, outcome] ->
      %{team: team, action: action, executed_at: ts, outcome: outcome}
    end, [limit])
  end

  defp generate_suggestions do
    # 실패 패턴에서 제안 생성 (stub — 실제 LLM 사용은 Phase 5+)
    failures = top_failures(3)
    Enum.map(failures, fn f ->
      "#{f[:team]}팀에서 #{f[:outcome]} 패턴 반복 — 접근 방식 재검토 권장"
    end)
  end

  defp store_to_memory(report) do
    Sigma.V2.Memory.store(:semantic,
      "weekly_meta_review: #{inspect(report.by_analyst)}",
      importance: 0.6
    )
  end

  defp trigger_espl_if_friday(today) do
    if Date.day_of_week(today) == 5 do
      Logger.info("[sigma/meta_review] 금요일 — ESPL 진화 트리거")
      spawn(fn -> Sigma.V2.ESPL.evolve_weekly() end)
    end
  end

  defp run_group_query(field, label) do
    sql = """
    SELECT
      #{field} AS grp,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE outcome IN ('signal_sent', 'tier2_applied'))::int AS positive
    FROM sigma_v2_directive_audit
    WHERE executed_at >= NOW() - interval '7 days'
    GROUP BY grp ORDER BY total DESC
    """
    run_raw_query(sql, fn [grp, total, pos] ->
      %{
        String.to_atom(label) => grp || "unknown",
        :total => total,
        :positive => pos,
        :rate => if(total > 0, do: Float.round(pos / total * 1.0, 3), else: 0.0)
      }
    end)
  end

  defp run_raw_query(sql, mapper, params \\ []) do
    case TeamJay.Repo.query(sql, params) do
      {:ok, %{rows: rows}} -> Enum.map(rows, mapper)
      _ -> []
    end
  rescue
    _ -> []
  end
end
