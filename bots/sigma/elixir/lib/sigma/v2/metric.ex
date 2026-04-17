defmodule Sigma.V2.Metric do
  @moduledoc """
  시그마 효과 지표 집계 헬퍼.
  Phase 4 ESPL 진화 엔진에서 사용.
  참조: bots/sigma/docs/PLAN.md §6 Phase 4
  """

  @doc "분석가별 주간 효과 점수 집계."
  def weekly_effectiveness_by_analyst do
    sql = """
    SELECT
      principle_check_result->>'analyst' AS analyst,
      COUNT(*)::float AS total,
      COUNT(*) FILTER (WHERE outcome IN ('signal_sent', 'tier2_applied'))::float AS positive
    FROM sigma_v2_directive_audit
    WHERE executed_at >= NOW() - interval '7 days'
      AND principle_check_result IS NOT NULL
      AND principle_check_result->>'analyst' IS NOT NULL
    GROUP BY principle_check_result->>'analyst'
    """

    case TeamJay.Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Enum.map(rows, fn [analyst, total, positive] ->
          score = if total > 0, do: Float.round(positive / total, 3), else: 0.0
          %{name: analyst || "unknown", score: score, total: trunc(total), positive: trunc(positive)}
        end)

      _ ->
        []
    end
  rescue
    _ -> []
  end

  @doc "현재 최대 세대 번호 + 1."
  def next_generation_number do
    case TeamJay.Repo.query(
           "SELECT COALESCE(MAX(generation), 0) + 1 FROM sigma_analyst_prompts",
           []
         ) do
      {:ok, %{rows: [[n]]}} -> n || 1
      _ -> 1
    end
  rescue
    _ -> 1
  end
end
