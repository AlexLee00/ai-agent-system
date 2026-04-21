defmodule Darwin.V2.Monitoring do
  @moduledoc """
  다윈팀 통합 모니터링 집계기 (Phase M).

  daily/weekly 리포트 스크립트에서 호출하는 집계 API.
  모든 함수는 DB 없이도 :ok 또는 빈 맵을 반환 (무해 실패).
  """

  require Logger

  @doc "24시간 통합 요약 — 주간 운영 리포트 보조 집계 및 MapeKLoop 호출용."
  @spec daily_summary() :: map()
  def daily_summary do
    %{
      cycles: cycle_stats(hours: 24),
      costs: cost_by_period(hours: 24),
      papers: papers_by_stage(hours: 24),
      promotions: promotion_candidates(),
      violations: recent_violations(hours: 24),
      shadow: shadow_daily_stats()
    }
  end

  @doc "주간 통합 요약 — weekly-review 스크립트 호출용."
  @spec weekly_summary() :: map()
  def weekly_summary do
    %{
      cycles: cycle_stats(days: 7),
      costs: cost_by_period(days: 7),
      papers: papers_by_stage(days: 7),
      shadow: Darwin.V2.ShadowCompare.weekly_aggregate(),
      dpo: dpo_weekly_stats(),
      autonomy_level: current_autonomy_level()
    }
  end

  # ─────────────────────────���───────────────────────
  # Private 집계 함수
  # ─────────────────────────────────────────────────

  defp cycle_stats(opts) do
    interval = build_interval(opts)
    sql = """
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'success') AS successes,
      COUNT(*) FILTER (WHERE status = 'failure') AS failures,
      COUNT(*) FILTER (WHERE stage = 'applied') AS applied
    FROM darwin_cycle_history
    WHERE inserted_at >= NOW() - INTERVAL '#{interval}'
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[total, s, f, a]]}} ->
        %{total: to_int(total), successes: to_int(s), failures: to_int(f), applied: to_int(a)}

      _ -> %{total: 0, successes: 0, failures: 0, applied: 0}
    end
  rescue
    _ -> %{total: 0, successes: 0, failures: 0, applied: 0}
  end

  defp cost_by_period(opts) do
    interval = build_interval(opts)
    sql = """
    SELECT COALESCE(SUM(cost_usd), 0) AS total_cost
    FROM darwin_v2_llm_cost_log
    WHERE logged_at >= NOW() - INTERVAL '#{interval}'
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[cost]]}} -> %{total_usd: to_float(cost)}
      _ -> %{total_usd: 0.0}
    end
  rescue
    _ -> %{total_usd: 0.0}
  end

  defp papers_by_stage(opts) do
    interval = build_interval(opts)
    sql = """
    SELECT stage, COUNT(*) AS cnt
    FROM darwin_research_registry
    WHERE updated_at >= NOW() - INTERVAL '#{interval}'
    GROUP BY stage
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} -> Map.new(rows, fn [stage, cnt] -> {stage, to_int(cnt)} end)
      _ -> %{}
    end
  rescue
    _ -> %{}
  end

  defp promotion_candidates do
    sql = """
    SELECT from_level, to_level, stats, inserted_at
    FROM darwin_autonomy_promotion_log
    WHERE approver = 'candidate' AND approved_at IS NULL
    ORDER BY inserted_at DESC
    LIMIT 3
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} -> length(rows)
      _ -> 0
    end
  rescue
    _ -> 0
  end

  defp recent_violations(opts) do
    interval = build_interval(opts)
    sql = """
    SELECT COUNT(*) AS cnt
    FROM darwin_principle_violations
    WHERE inserted_at >= NOW() - INTERVAL '#{interval}'
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[cnt]]}} -> to_int(cnt)
      _ -> 0
    end
  rescue
    _ -> 0
  end

  defp shadow_daily_stats do
    case Jay.Core.Repo.query("""
    SELECT COUNT(*) AS runs, AVG(match_score) AS avg_match
    FROM darwin_v2_shadow_runs
    WHERE run_at >= NOW() - INTERVAL '24 hours'
    """, []) do
      {:ok, %{rows: [[runs, avg]]}} ->
        %{runs: to_int(runs), avg_match: to_float(avg)}
      _ -> %{runs: 0, avg_match: nil}
    end
  rescue
    _ -> %{runs: 0, avg_match: nil}
  end

  defp dpo_weekly_stats do
    case Jay.Core.Repo.query("""
    SELECT
      COUNT(*) FILTER (WHERE category = 'preferred') AS preferred,
      COUNT(*) FILTER (WHERE category = 'rejected') AS rejected,
      COUNT(*) AS total
    FROM darwin_dpo_preference_pairs
    WHERE inserted_at >= NOW() - INTERVAL '7 days'
    """, []) do
      {:ok, %{rows: [[p, r, t]]}} ->
        %{preferred: to_int(p), rejected: to_int(r), total: to_int(t)}
      _ -> %{preferred: 0, rejected: 0, total: 0}
    end
  rescue
    _ -> %{preferred: 0, rejected: 0, total: 0}
  end

  defp current_autonomy_level do
    try do
      Darwin.V2.AutonomyLevel.level()
    rescue
      _ -> 3
    end
  end

  defp build_interval(hours: h), do: "#{h} hours"
  defp build_interval(days: d), do: "#{d} days"
  defp build_interval(_), do: "24 hours"

  defp to_int(nil), do: 0
  defp to_int(v) when is_integer(v), do: v
  defp to_int(v) when is_float(v), do: round(v)
  defp to_int(v) when is_binary(v), do: String.to_integer(v)
  defp to_int(_), do: 0

  defp to_float(nil), do: 0.0
  defp to_float(v) when is_float(v), do: Float.round(v, 4)
  defp to_float(v) when is_integer(v), do: v * 1.0
  defp to_float(v) when is_binary(v) do
    case Float.parse(v) do
      {f, _} -> Float.round(f, 4)
      :error -> 0.0
    end
  end
  defp to_float(_), do: 0.0
end
