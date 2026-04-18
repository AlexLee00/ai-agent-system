defmodule Sigma.V2.Monitoring do
  @moduledoc """
  시그마팀 통합 모니터링 집계기 (Phase O).

  daily/weekly 리포트 및 MapeKLoop에서 호출하는 집계 API.
  모든 함수는 DB 없이도 :ok 또는 빈 맵을 반환 (무해 실패).
  """

  require Logger

  @doc "일일 통합 요약."
  @spec daily_summary() :: map()
  def daily_summary do
    %{
      date: Date.to_iso8601(Date.utc_today()),
      cycles: cycle_stats(hours: 24),
      directives: directive_stats(hours: 24),
      costs: cost_by_period(hours: 24),
      pod_performance: pod_stats(hours: 24),
      violations: recent_violations(hours: 24),
      llm_cost_usd: total_llm_cost(hours: 24)
    }
  end

  @doc "주간 통합 요약."
  @spec weekly_summary() :: map()
  def weekly_summary do
    %{
      week: week_label(),
      cycles: cycle_stats(days: 7),
      directives: directive_stats(days: 7),
      costs: cost_by_period(days: 7),
      pod_performance: pod_stats(days: 7),
      dpo: dpo_weekly_stats(),
      espl: espl_weekly_stats(),
      weekly_cost_usd: total_llm_cost(days: 7),
      acceptance_rate: directive_acceptance_rate(days: 7)
    }
  end

  # ─────────────────────────────────────────────────
  # Private — 집계 함수
  # ─────────────────────────────────────────────────

  defp cycle_stats(opts) do
    interval = build_interval(opts)
    sql = """
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE outcome = 'success') AS success_count,
      COUNT(*) FILTER (WHERE outcome = 'failure') AS error_count
    FROM sigma_v2_directive_audit
    WHERE executed_at >= NOW() - INTERVAL '#{interval}'
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[total, s, e]]}} ->
        %{total: to_int(total), success_count: to_int(s), error_count: to_int(e)}
      _ -> %{total: 0, success_count: 0, error_count: 0}
    end
  rescue
    _ -> %{total: 0, success_count: 0, error_count: 0}
  end

  defp directive_stats(opts) do
    interval = build_interval(opts)
    sql = """
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE tier = 2) AS tier2_count,
      COUNT(*) FILTER (WHERE outcome = 'success') AS accepted
    FROM sigma_v2_directive_audit
    WHERE executed_at >= NOW() - INTERVAL '#{interval}'
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[total, tier2, accepted]]}} ->
        %{
          total: to_int(total),
          tier2_applied: to_int(tier2),
          accepted: to_int(accepted)
        }
      _ -> %{total: 0, tier2_applied: 0, accepted: 0}
    end
  rescue
    _ -> %{total: 0, tier2_applied: 0, accepted: 0}
  end

  defp pod_stats(opts) do
    interval = build_interval(opts)
    sql = """
    SELECT pod_name, AVG(accuracy)::float AS avg_accuracy, COUNT(*) AS evaluations
    FROM sigma_pod_performance
    WHERE evaluated_at >= NOW() - INTERVAL '#{interval}'
    GROUP BY pod_name
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Map.new(rows, fn [pod, acc, cnt] ->
          {pod, %{accuracy: to_float(acc), evaluations: to_int(cnt)}}
        end)
      _ -> %{}
    end
  rescue
    _ -> %{}
  end

  defp cost_by_period(opts) do
    interval = build_interval(opts)
    sql = """
    SELECT COALESCE(SUM(cost_usd), 0)::float AS total_cost
    FROM sigma_llm_cost_tracking
    WHERE tracked_at >= NOW() - INTERVAL '#{interval}'
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[cost]]}} -> %{total_usd: to_float(cost)}
      _ -> %{total_usd: 0.0}
    end
  rescue
    _ -> %{total_usd: 0.0}
  end

  defp total_llm_cost(opts) do
    %{total_usd: usd} = cost_by_period(opts)
    usd
  end

  defp recent_violations(opts) do
    interval = build_interval(opts)
    sql = """
    SELECT COUNT(*) AS cnt
    FROM sigma_v2_directive_audit
    WHERE outcome = 'blocked' AND executed_at >= NOW() - INTERVAL '#{interval}'
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[cnt]]}} -> to_int(cnt)
      _ -> 0
    end
  rescue
    _ -> 0
  end

  defp dpo_weekly_stats do
    case Jay.Core.Repo.query("""
    SELECT
      COUNT(*) FILTER (WHERE category = 'preferred') AS preferred,
      COUNT(*) FILTER (WHERE category = 'rejected') AS rejected,
      COUNT(*) AS total
    FROM sigma_dpo_preference_pairs
    WHERE inserted_at >= NOW() - INTERVAL '7 days'
    """, []) do
      {:ok, %{rows: [[p, r, t]]}} ->
        %{preferred_pairs: to_int(p), rejected_pairs: to_int(r), total: to_int(t)}
      _ -> %{preferred_pairs: 0, rejected_pairs: 0, total: 0}
    end
  rescue
    _ -> %{preferred_pairs: 0, rejected_pairs: 0, total: 0}
  end

  defp espl_weekly_stats do
    case Jay.Core.Repo.query("""
    SELECT MAX(generation) AS max_gen, MAX(max_fitness) AS max_fit
    FROM sigma_analyst_prompts
    WHERE created_at >= NOW() - INTERVAL '7 days'
    """, []) do
      {:ok, %{rows: [[gen, fit]]}} ->
        %{espl_generation: to_int(gen), espl_max_fitness: to_float(fit)}
      _ -> %{espl_generation: 0, espl_max_fitness: 0.0}
    end
  rescue
    _ -> %{espl_generation: 0, espl_max_fitness: 0.0}
  end

  defp directive_acceptance_rate(opts) do
    interval = build_interval(opts)
    sql = """
    SELECT
      COUNT(*) FILTER (WHERE outcome = 'success')::float / NULLIF(COUNT(*), 0) AS rate
    FROM sigma_v2_directive_audit
    WHERE executed_at >= NOW() - INTERVAL '#{interval}'
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[rate]]}} when not is_nil(rate) ->
        Float.round(to_float(rate) * 100, 1)
      _ -> 0.0
    end
  rescue
    _ -> 0.0
  end

  defp build_interval(hours: h), do: "#{h} hours"
  defp build_interval(days: d), do: "#{d} days"
  defp build_interval(_), do: "24 hours"

  defp week_label do
    today = Date.utc_today()
    start_of_week = Date.add(today, -(Date.day_of_week(today) - 1))
    "#{Date.to_iso8601(start_of_week)} ~ #{Date.to_iso8601(today)}"
  end

  defp to_int(nil), do: 0
  defp to_int(v) when is_integer(v), do: v
  defp to_int(v) when is_float(v), do: round(v)
  defp to_int(v) when is_binary(v) do
    case Integer.parse(v) do
      {n, _} -> n
      :error -> 0
    end
  end
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
