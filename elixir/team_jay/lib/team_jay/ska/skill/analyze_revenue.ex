defmodule TeamJay.Ska.Skill.AnalyzeRevenue do
  @moduledoc """
  매출 분석 스킬 — Python rebecca.py (PortBridge 경유) 호출.

  입력: %{period_days: 7, compare_mode: :week_over_week}
  출력: {:ok, %{summary: map, anomalies: list, growth_rate: float}}

  Kill Switch: SKA_PYTHON_SKILL_ENABLED=true (기본 false)
  """
  @behaviour TeamJay.Ska.Skill
  require Logger

  @impl true
  def metadata do
    %{
      name: :analyze_revenue,
      domain: :analytics,
      version: "1.0",
      description: "매출 추이/이상 감지/성장률 분석 (rebecca.py 경유)",
      input_schema: %{period_days: :integer, compare_mode: :atom},
      output_schema: %{summary: :map, anomalies: :list, growth_rate: :float}
    }
  end

  @impl true
  def run(params, _context) do
    unless python_skill_enabled?() do
      {:error, :python_skill_disabled}
    else
      period = params[:period_days] || 7
      compare = params[:compare_mode] || :week_over_week

      case TeamJay.Ska.PortBridge.PythonPort.call("rebecca.py", %{
             action: "analyze",
             period_days: period,
             compare_mode: to_string(compare)
           }) do
        {:ok, result} ->
          {:ok, result}

        {:error, reason} ->
          Logger.warning("[AnalyzeRevenue] 분석 실패: #{inspect(reason)}")
          {:error, {:revenue_analysis_failed, reason}}
      end
    end
  end

  @impl true
  def health_check do
    if python_skill_enabled?(), do: :ok, else: {:error, :python_skill_disabled}
  end

  defp python_skill_enabled? do
    System.get_env("SKA_PYTHON_SKILL_ENABLED", "false") == "true"
  end
end
