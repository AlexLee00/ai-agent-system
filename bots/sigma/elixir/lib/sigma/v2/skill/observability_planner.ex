defmodule Sigma.V2.Skill.ObservabilityPlanner do
  @moduledoc """
  ObservabilityPlanner — OTel 기반 관찰 가능성 계획.
  TS packages/core/lib/skills/sigma/observability-planner.ts 1:1 포팅.
  """

  use Jido.Action,
    name: "sigma_v2_observability_planner",
    description: "Plan OTel spans, metrics, and alert thresholds for sigma directives",
    schema: Zoi.object(%{
      system: Zoi.default(Zoi.string(), "unknown"),
      service: Zoi.default(Zoi.string(), ""),
      failure_modes: Zoi.default(Zoi.list(Zoi.string()), []),
      existing_metrics: Zoi.default(Zoi.any(), nil),
      alert_channels: Zoi.default(Zoi.any(), nil)
    })

  @impl Jido.Action
  def run(params, _ctx) do
    system =
      Map.get(params, :system) ||
        Map.get(params, :service) ||
        "unknown"
    failure_modes = Map.get(params, :failure_modes, []) || []
    existing_metrics = Map.get(params, :existing_metrics, []) || []
    alert_channels = Map.get(params, :alert_channels, []) || []

    base_metrics = ["latency", "error_rate", "throughput"]
    dashboards = ["#{system}-health", "#{system}-quality"]

    # Merge existing metrics with recommendations
    _ = {existing_metrics, alert_channels}

    {metrics, alerts, gaps} =
      {base_metrics, [], []}
      |> handle_data_stale(failure_modes)
      |> handle_cost_spike(failure_modes)
      |> handle_quality_drop(failure_modes)

    all_metrics = Enum.uniq(metrics)
    new_metrics = all_metrics -- existing_metrics
    covered = length(existing_metrics)
    total = max(length(all_metrics), 1)
    coverage_score = Float.round(covered / total * 10.0, 1)

    {:ok, %{
      metrics: all_metrics,
      recommended_metrics: new_metrics,
      alerts: Enum.uniq(alerts),
      dashboards: dashboards,
      gaps: gaps,
      coverage_score: coverage_score
    }}
  end

  defp handle_data_stale({metrics, alerts, gaps}, failure_modes) do
    if "data_stale" in failure_modes do
      {metrics ++ ["freshness"], alerts ++ ["freshness threshold breach"], gaps}
    else
      {metrics, alerts, gaps ++ ["freshness metric not specified"]}
    end
  end

  defp handle_cost_spike({metrics, alerts, gaps}, failure_modes) do
    if "cost_spike" in failure_modes do
      {metrics ++ ["cost_per_run"], alerts ++ ["cost spike"], gaps}
    else
      {metrics, alerts, gaps}
    end
  end

  defp handle_quality_drop({metrics, alerts, gaps}, failure_modes) do
    if "quality_drop" in failure_modes do
      {metrics ++ ["quality_score"], alerts ++ ["quality drop"], gaps}
    else
      {metrics, alerts, gaps ++ ["quality guardrail not specified"]}
    end
  end
end
