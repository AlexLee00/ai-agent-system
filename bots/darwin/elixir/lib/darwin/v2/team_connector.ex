defmodule Darwin.V2.TeamConnector do
  @moduledoc """
  다윈팀 V2 팀 커넥터 — KPI 수집 + 연구 결과 전파.

  Jay TeamConnector가 darwin KPI 수집 시 호출.
  """

  require Logger
  alias Jay.Core.Repo

  @spec get_status() :: map()
  def get_status do
    %{
      forwarded_count: 0,
      target_teams: [:luna, :blog, :claude, :ska, :jay],
      status: :ready
    }
  end

  @spec collect_kpi() :: map()
  def collect_kpi do
    autonomy_level =
      try do
        Darwin.V2.Lead.get_autonomy_level()
      rescue
        _ -> 3
      end

    if rag_research_available?() do
      case Repo.query(kpi_query(), []) do
        {:ok, %{rows: [[papers, high, avg, last_at]]}} ->
          %{
            metric_type: :research_ops,
            papers_7d: papers || 0,
            high_quality_7d: high || 0,
            avg_score: avg || 0.0,
            last_scan_at: last_at,
            autonomy_level: autonomy_level
          }

        _ ->
          default_kpi(autonomy_level)
      end
    else
      default_kpi(autonomy_level)
    end
  end

  defp kpi_query do
    if rag_research_has_score_column?() do
      """
      SELECT
        COUNT(*)::int AS papers_7d,
        COUNT(*) FILTER (WHERE score >= 6)::int AS high_quality_7d,
        COALESCE(AVG(score), 0)::numeric(4,1) AS avg_score,
        MAX(created_at) AS last_scan_at
      FROM reservation.rag_research
      WHERE created_at >= NOW() - INTERVAL '7 days'
      """
    else
      """
      SELECT
        COUNT(*)::int AS papers_7d,
        0::int AS high_quality_7d,
        0::numeric(4,1) AS avg_score,
        MAX(created_at) AS last_scan_at
      FROM reservation.rag_research
      WHERE created_at >= NOW() - INTERVAL '7 days'
      """
    end
  end

  defp default_kpi(autonomy_level) do
    %{
      metric_type: :research_ops,
      papers_7d: 0,
      high_quality_7d: 0,
      avg_score: 0.0,
      last_scan_at: nil,
      autonomy_level: autonomy_level
    }
  end

  defp rag_research_available? do
    case Repo.query("SELECT to_regclass('reservation.rag_research')", []) do
      {:ok, %{rows: [[nil]]}} -> false
      {:ok, %{rows: [[_rel]]}} -> true
      _ -> false
    end
  end

  defp rag_research_has_score_column? do
    case Repo.query(
           """
           SELECT EXISTS (
             SELECT 1
             FROM information_schema.columns
             WHERE table_schema = 'reservation'
               AND table_name = 'rag_research'
               AND column_name = 'score'
           )
           """,
           []
         ) do
      {:ok, %{rows: [[true]]}} -> true
      _ -> false
    end
  end
end
