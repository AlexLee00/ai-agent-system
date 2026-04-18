defmodule TeamJay.Ska.Skill.ForecastDemand do
  @moduledoc """
  수요 예측 스킬 — Python forecast.py (PortBridge 경유) 호출.

  입력: %{horizon_days: 7, granularity: :daily}
  출력: {:ok, %{forecasts: list, confidence_interval: map}}

  Kill Switch: SKA_PYTHON_SKILL_ENABLED=true (기본 false)
  """
  @behaviour TeamJay.Ska.Skill
  require Logger

  @impl true
  def metadata do
    %{
      name: :forecast_demand,
      domain: :analytics,
      version: "1.0",
      description: "Prophet/ARIMA 기반 수요 예측 (7~30일 앞)",
      input_schema: %{horizon_days: :integer, granularity: :atom},
      output_schema: %{forecasts: :list, confidence_interval: :map}
    }
  end

  @impl true
  def run(params, _context) do
    unless python_skill_enabled?() do
      {:error, :python_skill_disabled}
    else
      horizon = params[:horizon_days] || 7
      granularity = params[:granularity] || :daily

      case TeamJay.Ska.PortBridge.PythonPort.call("forecast.py", %{
             action: "predict",
             horizon_days: horizon,
             granularity: to_string(granularity)
           }) do
        {:ok, result} ->
          {:ok, result}

        {:error, :python_skill_disabled} ->
          {:error, :python_skill_disabled}

        {:error, reason} ->
          Logger.warning("[ForecastDemand] 예측 실패: #{inspect(reason)}")
          {:error, {:forecast_failed, reason}}
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
