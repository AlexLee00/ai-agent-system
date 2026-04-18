defmodule TeamJay.Ska.Skill.PersistCycleMetrics do
  @moduledoc """
  에이전트 사이클 KPI를 DB 저장하는 스킬 — 모든 에이전트 공통.

  입력: %{agent: :andy, success: true, duration_ms: 1200, items_processed: 5}
  출력: {:ok, %{persisted: true}}
  """

  @behaviour TeamJay.Ska.Skill

  @impl true
  def metadata do
    %{
      name: :persist_cycle_metrics,
      domain: :common,
      version: "1.0",
      description: "에이전트 사이클 KPI를 DB 저장",
      input_schema: %{
        agent: :atom,
        success: :boolean,
        duration_ms: :integer,
        items_processed: :integer
      },
      output_schema: %{persisted: :boolean}
    }
  end

  @impl true
  def run(params, _context) do
    sql = """
    INSERT INTO ska_cycle_metrics (agent, success, duration_ms, items_processed, metadata, inserted_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    """

    args = [
      to_string(params[:agent] || "unknown"),
      params[:success] == true,
      params[:duration_ms] || 0,
      params[:items_processed] || 0,
      Jason.encode!(params[:metadata] || %{})
    ]

    case Jay.Core.Repo.query(sql, args) do
      {:ok, _} -> {:ok, %{persisted: true}}
      {:error, reason} -> {:error, reason}
    end
  end
end
